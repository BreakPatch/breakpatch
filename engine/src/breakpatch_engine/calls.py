"""Set-up and clean-up calls (spec §11; security review A4), Call steps (issue #44) and the "Try it"
button (`call.try`).

A call is one HTTP request, `{method, url, headers?, body?, allowOtherHosts?}`, made before or after
a run, or by a Call step in the middle of one. Tests are shared files, so a call must not be able to
reach whatever this Mac (or a runner, or a CI machine) can. The rules:

- https only. http only to a loopback address, and only when the app itself is on one (local dev).
- No redirects: a 3xx reply fails the call.
- Methods: GET, POST, PUT, PATCH, DELETE.
- The host must belong to the app: its base URL's host, or another host under the same parent
  domain (`api.acme.com` for an app at `app.acme.com`). Hosting domains shared by many customers
  (`github.io`, `vercel.app`, `co.uk`...) count as the host alone.
- After DNS, every address must be public: no loopback, private, link-local, CGNAT, unique local,
  multicast or reserved address (IPv4 or IPv6, mapped IPv4 too), unless the app itself resolves to
  such addresses (a local or intranet app). The connection goes to the checked address, so DNS
  can't change between the check and the request. Through a proxy (the system's, net.py), the
  tunnel is opened to that checked address too, never to the name, so the proxy can't resolve it
  somewhere else; this Mac must still be able to look the name up itself.
- https checks the certificate against the system's trust store (net.py: the macOS Keychain, so a
  company's TLS-inspection certificate installed there is trusted). Verification is never off.
- `allowOtherHosts: true` (the test's "Allow other hosts") lifts the host and address rules. Cloud
  metadata addresses (169.254.169.254 and friends) stay blocked even then.
- Headers may take their value from a saved secret (`{name, secretRef}`), under the same site rule
  as typing one: the secret must be allowed on the call's origin.
- Logs show the address without its query string, and never a header value, a body, a reply or a
  secret.

A Call step also says which replies count as a pass (`passStatus`, "2xx" by default; a 3xx is never
one, since redirects aren't followed) and may keep one value from a JSON reply (`keep`: `{path:
"$.code", name}`) for a later Write step. The reply's body is read only for that, and never shown
or logged.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import http.client
import ipaddress
import json
import logging
import re
import socket
import ssl
import time
from dataclasses import dataclass, field
from urllib.parse import urlsplit

from . import net
from .actions import Secret
from .sites import origin_of, site_name

log = logging.getLogger("breakpatch.calls")

METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE")

# Parents that many unrelated customers share: an app on one of them only trusts its own host.
SHARED_PARENTS = frozenset({
    "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp", "ne.jp",
    "com.br", "com.cn", "com.hk", "com.sg", "co.in", "co.za", "com.mx", "co.kr", "com.tr", "com.tw",
    "github.io", "gitlab.io", "vercel.app", "netlify.app", "herokuapp.com", "web.app", "firebaseapp.com",
    "azurewebsites.net", "cloudfront.net", "appspot.com", "pages.dev", "workers.dev", "onrender.com",
    "fly.dev", "amplifyapp.com", "ngrok.io", "ngrok-free.app", "blob.core.windows.net", "s3.amazonaws.com",
})

# Cloud instance metadata: never reachable from a call, whatever the test says.
METADATA = frozenset(ipaddress.ip_address(a) for a in (
    "169.254.169.254", "169.254.170.2", "169.254.169.253", "100.100.100.200", "fd00:ec2::254", "fd00:ec2::23"))

_HEADER_NAME = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$")
_FORBIDDEN_HEADERS = frozenset({"host", "content-length", "transfer-encoding", "connection"})

BODY_MAX = 64 * 1024              # bytes a call may send
REPLY_READ = 64 * 1024            # bytes of a reply read when nothing is kept from it
KEEP_READ = 1024 * 1024           # bytes of a reply read to keep a value from it
VALUE_MAX = 1000                  # characters of a kept value
STEP_TIMEOUT_MAX = 120.0          # seconds a Call step may wait for its reply
DEFAULT_PASS = "2xx"
VALUE_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,39}$")


class CallRefused(Exception):
    """The call breaks a rule and wasn't made. `message` is a plain sentence."""

    def __init__(self, message: str, kind: str = "refused"):
        super().__init__(message)
        self.message = message
        self.kind = kind


@dataclass
class Reply:
    ok: bool
    status: int | None = None
    ms: int | None = None
    error: str | None = None          # "invalid" | "refused" | "redirect" | "unreachable" | "timeout" | "secret" | "status" | "keep"
    message: str | None = None        # plain sentence when it didn't work
    info: str = ""                    # for the log: redacted
    # The value a Call step keeps from the reply (`keep`). Never in to_json, a log or an event.
    kept: str | None = field(default=None, repr=False)

    def to_json(self) -> dict:
        return {k: v for k, v in {"ok": self.ok, "status": self.status, "ms": self.ms, "error": self.error,
                                  "message": self.message}.items() if v is not None}

    def shown(self) -> dict:
        """What a run's report shows of it: the status and the time, never the body."""
        return {k: v for k, v in {"status": self.status, "ms": self.ms}.items() if v is not None}


@dataclass
class Plan:
    method: str
    url: str
    scheme: str
    host: str
    port: int
    target: str                        # path and query
    address: str                       # the checked IP address to connect to
    headers: dict[str, str] = field(default_factory=dict)
    proxy: str | None = None           # the http proxy to tunnel through (https only), or None
    # Every checked address, `address` first: tried in turn, so "localhost" reaches a server that
    # listens on 127.0.0.1 only when ::1 comes first (macOS, Ubuntu).
    addresses: list[str] = field(default_factory=list)
    body: bytes | None = field(default=None, repr=False)   # what's sent; never logged

    def tried(self) -> list[str]:
        return self.addresses or [self.address]


# ---------------------------------------------------------------- the rules

def redact(url: str, secrets: list[str] | tuple[str, ...] = ()) -> str:
    """An address as it may appear in a log: no user info, no query string or fragment, and no
    secret values."""
    try:
        u = urlsplit(url or "")
        host = u.hostname or ""
        port = f":{u.port}" if u.port else ""
    except ValueError:
        return "(an address that couldn't be read)"
    out = f"{u.scheme}://{host}{port}{u.path}" + ("?…" if u.query else "")
    for s in secrets:
        if s and len(s) >= 3:
            out = out.replace(s, "•••")
    return out


def _ip(addr: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    try:
        ip = ipaddress.ip_address(addr.split("%", 1)[0])
    except ValueError:
        return None
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        return ip.ipv4_mapped
    return ip


def is_public(addr: str) -> bool:
    ip = _ip(addr)
    return ip is not None and ip.is_global and not ip.is_multicast


def is_metadata(addr: str) -> bool:
    ip = _ip(addr)
    return ip is not None and ip in METADATA


def is_loopback_host(host: str) -> bool:
    h = host.lower().strip("[]")
    if h == "localhost" or h.endswith(".localhost"):
        return True
    ip = _ip(h)
    return ip is not None and ip.is_loopback


def related_hosts(app_host: str) -> tuple[str, str | None]:
    """(the app's host, the parent domain whose subdomains also count, or None)."""
    h = app_host.lower().rstrip(".")
    if _ip(h.strip("[]")) is not None or "." not in h:
        return h, None
    labels = h.split(".")
    if len(labels) < 3:
        return h, h                      # acme.com: acme.com and *.acme.com
    parent = ".".join(labels[1:])
    if parent in SHARED_PARENTS or len(labels[1:]) < 2:
        return h, None
    return h, parent


def host_allowed(host: str, app_host: str) -> bool:
    h = host.lower().rstrip(".")
    own, parent = related_hosts(app_host)
    return h == own or (parent is not None and (h == parent or h.endswith("." + parent)))


def resolve(host: str, port: int) -> list[str]:
    infos = socket.getaddrinfo(host.strip("[]"), port, type=socket.SOCK_STREAM)
    out: list[str] = []
    for info in infos:
        a = info[4][0]
        if a not in out:
            out.append(a)
    return out


def parse_statuses(text: str | None) -> list[tuple[int, int]]:
    """The replies a Call step counts as a pass: "2xx" (the default), "200, 201", "200-204, 404".
    Each a status from 200 to 599, a class ("2xx", "4xx", "5xx") or a range. A 3xx is never one:
    redirects aren't followed. Raises CallRefused."""
    raw = str(text if text is not None else DEFAULT_PASS).strip() or DEFAULT_PASS
    out: list[tuple[int, int]] = []
    for item in re.split(r"[,\s]+", raw):
        if not item:
            continue
        m = re.fullmatch(r"([1-5])xx", item, flags=re.I)
        r = re.fullmatch(r"(\d{3})(?:-(\d{3}))?", item)
        if m:
            lo, hi = int(m.group(1)) * 100, int(m.group(1)) * 100 + 99
        elif r:
            lo = int(r.group(1))
            hi = int(r.group(2)) if r.group(2) else lo
        else:
            raise CallRefused("Statuses that pass look like 200, 2xx or 200-204.", "invalid")
        if lo > hi or lo < 200 or hi > 599:
            raise CallRefused("Statuses that pass are between 200 and 599, like 200, 2xx or 200-204.", "invalid")
        if lo <= 399 and hi >= 300:
            raise CallRefused("A redirect (3xx) can't count as a pass: calls don't follow redirects.", "invalid")
        out.append((lo, hi))
    if len(out) > 20:
        raise CallRefused("List at most 20 statuses that pass.", "invalid")
    return out


def passes(status: int, statuses: list[tuple[int, int]]) -> bool:
    return any(lo <= status <= hi for lo, hi in statuses)


def step_timeout(timeout_ms, default: float) -> float:
    """A Call step's wait for its reply, in seconds: its own (1 to STEP_TIMEOUT_MAX), else the default."""
    if isinstance(timeout_ms, (int, float)) and not isinstance(timeout_ms, bool) and timeout_ms > 0:
        return max(1.0, min(STEP_TIMEOUT_MAX, float(timeout_ms) / 1000))
    return default


def with_run_values(call: dict, i: int, now: dt.datetime | None = None) -> dict:
    """The call with `{i}`, `{time}`, `{date}` and `{timestamp}` in its address and body filled in,
    as a Write step's text is (actions.substitute)."""
    from .actions import substitute
    now = now or dt.datetime.now()
    out = dict(call)
    for k in ("url", "body"):
        if isinstance(out.get(k), str):
            out[k] = substitute(out[k], i, now)
    return out


_PATH_PART = re.compile(r"""\.([A-Za-z_$][\w$-]*)|\[(\d+)\]|\[["']([^"']*)["']\]""")


def parse_path(path: str) -> list[str | int]:
    """`$.data.items[0].code`, `$['one-time code']` or `code`: the keys and indexes, in order.
    Raises CallRefused."""
    p = str(path or "").strip()
    if p.startswith("$"):
        p = p[1:]
    elif p and not p.startswith(("[", ".")):
        p = "." + p
    out: list[str | int] = []
    pos = 0
    while pos < len(p):
        m = _PATH_PART.match(p, pos)
        if not m:
            raise CallRefused("Write where the value is like $.code or $.data.items[0].id.", "invalid")
        out.append(m.group(1) if m.group(1) is not None else int(m.group(2)) if m.group(2) is not None else m.group(3))
        pos = m.end()
    if not out or len(out) > 20:
        raise CallRefused("Write where the value is like $.code or $.data.items[0].id.", "invalid")
    return out


def pick(body: bytes, path: str) -> str:
    """One value from a JSON reply, as text. Raises CallRefused (kind "keep") with a plain sentence
    that never quotes the reply."""
    parts = parse_path(path)
    try:
        data = json.loads(body.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError):
        raise CallRefused(f"The reply isn't JSON, so {path} couldn't be read from it.", "keep") from None
    for part in parts:
        if isinstance(part, int) and isinstance(data, list) and part < len(data):
            data = data[part]
        elif isinstance(part, str) and isinstance(data, dict) and part in data:
            data = data[part]
        else:
            raise CallRefused(f"The reply has nothing at {path}.", "keep")
    if isinstance(data, bool):
        value = "true" if data else "false"
    elif isinstance(data, (int, float, str)):
        value = str(data)
    else:
        raise CallRefused(f"{path} in the reply is a list or an object, not one value.", "keep")
    if len(value) > VALUE_MAX or "\n" in value or "\r" in value:
        raise CallRefused(f"{path} in the reply is too long, or has line breaks, to type.", "keep")
    return value


def call_secret_refs(call: dict | None) -> list[str]:
    """Names of the saved secrets a call's headers use."""
    if not isinstance(call, dict):
        return []
    return [str(h["secretRef"]) for h in (call.get("headers") or [])
            if isinstance(h, dict) and h.get("secretRef")]


def plan(call: dict, app_url: str | None, secrets: dict[str, Secret], resolver=resolve,
         proxy_finder: net.Finder = net.proxy_for) -> Plan:
    """Checks a call against the rules and works out where it connects. Raises CallRefused."""
    if not isinstance(call, dict):
        raise CallRefused("The call couldn't be read.", "invalid")
    method = str(call.get("method") or "GET").upper()
    if method not in METHODS:
        raise CallRefused("Calls can be GET, POST, PUT, PATCH or DELETE.", "invalid")
    url = str(call.get("url") or "").strip()
    try:
        u = urlsplit(url)
        port = u.port
    except ValueError:
        raise CallRefused("Enter a full address, starting with https://", "invalid") from None
    scheme = u.scheme.lower()
    host = (u.hostname or "").lower().rstrip(".")
    if scheme not in ("http", "https") or not host:
        raise CallRefused("Enter a full address, starting with https://", "invalid")
    app = urlsplit(app_url or "")
    app_host = (app.hostname or "").lower().rstrip(".")
    local_app = bool(app_host) and is_loopback_host(app_host)
    if scheme == "http" and not (local_app and is_loopback_host(host)):
        raise CallRefused("Calls must use https://. Plain http:// is only for an app on this Mac (localhost).")
    others = bool(call.get("allowOtherHosts"))
    if not others and not (app_host and host_allowed(host, app_host)):
        where = site_name(origin_of(app_url)) if app_host else "the app"
        raise CallRefused(f"This call goes to {host}, which isn't part of {where}. "
                          "Turn on Allow other hosts for this test to call it.")
    port = port or (443 if scheme == "https" else 80)
    try:
        literal = host.strip("[]")
        addrs = [literal] if _ip(literal) is not None else resolver(host, port)
    except (OSError, UnicodeError) as e:
        raise CallRefused(f"Couldn't find {host}. Check the address.", "unreachable") from e
    if not addrs:
        raise CallRefused(f"Couldn't find {host}. Check the address.", "unreachable")
    if any(is_metadata(a) for a in addrs):
        raise CallRefused(f"{host} is a cloud metadata address, which calls never reach.")
    if not others and not all(is_public(a) for a in addrs):
        # A local or intranet app may call its own local addresses; anything else may not.
        app_local = local_app
        if not app_local and app_host:
            try:
                h = app_host.strip("[]")
                app_local = not all(is_public(a) for a in ([h] if _ip(h) else resolver(app_host, app.port or 443)))
            except (OSError, UnicodeError):
                app_local = False
        if not app_local:
            raise CallRefused(f"{host} is a private or local address. Turn on Allow other hosts for this "
                              "test to call it.")
    headers = _headers(call, origin_of(url), secrets)
    body = _body(call, method, headers)
    target = (u.path or "/") + (f"?{u.query}" if u.query else "")
    proxy = proxy_finder(url) if scheme == "https" and not is_loopback_host(host) else None
    return Plan(method, url, scheme, host, port, target, addrs[0], headers, proxy, list(addrs), body)


def _body(call: dict, method: str, headers: dict[str, str]) -> bytes | None:
    """The body to send (a Call step's), with a Content-Type when the headers have none: JSON when
    it reads as JSON, else plain text. None when there is none."""
    text = call.get("body")
    if text is None or text == "":
        return None
    if not isinstance(text, str):
        raise CallRefused("The call's body couldn't be read.", "invalid")
    if method == "GET":
        raise CallRefused("A GET call can't have a body. Use POST, PUT, PATCH or DELETE.", "invalid")
    data = text.encode("utf-8")
    if len(data) > BODY_MAX:
        raise CallRefused(f"The body is too long: calls send at most {BODY_MAX // 1024} KB.", "invalid")
    if not any(k.lower() == "content-type" for k in headers):
        try:
            json.loads(text)
            headers["Content-Type"] = "application/json"
        except ValueError:
            headers["Content-Type"] = "text/plain; charset=utf-8"
    return data


def _headers(call: dict, origin: str | None, secrets: dict[str, Secret]) -> dict[str, str]:
    out: dict[str, str] = {}
    for h in call.get("headers") or []:
        if not isinstance(h, dict):
            continue
        name = str(h.get("name") or "").strip()
        if not name:
            continue
        if not _HEADER_NAME.match(name) or name.lower() in _FORBIDDEN_HEADERS:
            raise CallRefused(f"{name[:40]} can't be used as a header name.", "invalid")
        if h.get("secretRef"):
            ref = str(h["secretRef"])
            s = secrets.get(ref)
            if s is None:
                raise CallRefused(f"The saved secret {ref} isn't on this Mac.", "secret")
            if s.refused:
                raise CallRefused(s.refused, "secret")
            if not s.allows(origin):
                raise CallRefused(f"{ref} isn't allowed on {site_name(origin)}.", "secret")
            value = s.value
        else:
            value = str(h.get("value") or "")
        if "\r" in value or "\n" in value:
            raise CallRefused(f"The {name} header has a line break in it.", "invalid")
        out[name] = value
    return out


# ---------------------------------------------------------------- making the call

# A proxy's answers that refuse the connection by policy (a password it wants, a web filter): the
# same for every address of the host, so the next one isn't tried. Any other answer (502 or 504
# when that address doesn't answer it, or none at all) is about that address.
PROXY_POLICY_REFUSALS = frozenset({401, 403, 407, 451})


def _connect_any(addresses: list[str], port: int, timeout: float, open_one) -> socket.socket:
    """Opens the first of the checked addresses that answers (as create_connection does for a name).
    A refused or unreachable address moves on to the next, through a proxy too; the last error is
    raised. A proxy's policy refusal is raised at once."""
    last: OSError | None = None
    for a in addresses:
        try:
            return open_one(a)
        except net.ProxyError as e:
            if e.status in PROXY_POLICY_REFUSALS:
                raise
            last = e
        except OSError as e:
            last = e
    raise last or OSError("no address to connect to")


class _Pinned(http.client.HTTPConnection):
    def __init__(self, host, port, address, timeout):
        super().__init__(host, port, timeout=timeout)
        self._addresses = address if isinstance(address, list) else [address]

    def connect(self):
        self.sock = _connect_any(self._addresses, self.port, self.timeout,
                                 lambda a: socket.create_connection((a, self.port), self.timeout))


class _PinnedTLS(http.client.HTTPSConnection):
    def __init__(self, host, port, address, timeout, proxy=None):
        super().__init__(host, port, timeout=timeout, context=net.ssl_context())
        self._addresses = address if isinstance(address, list) else [address]
        self._proxy = proxy

    def connect(self):
        if self._proxy:
            raw = _connect_any(self._addresses, self.port, self.timeout,
                               lambda a: net.tunnel(self._proxy, a, self.port, self.timeout))
        else:
            raw = _connect_any(self._addresses, self.port, self.timeout,
                               lambda a: socket.create_connection((a, self.port), self.timeout))
        self.sock = self._context.wrap_socket(raw, server_hostname=self.host)


def _exchange(p: Plan, timeout: float, read: int = REPLY_READ) -> tuple[int, bytes]:
    """Sends the request and reads at most `read` bytes of the reply: (status, body)."""
    if p.scheme == "https":
        conn = _PinnedTLS(p.host, p.port, p.tried(), timeout, p.proxy)
    else:
        conn = _Pinned(p.host, p.port, p.tried(), timeout)
    try:
        body = p.body if p.body is not None else b"" if p.method in ("POST", "PUT", "PATCH") else None
        headers = {"User-Agent": "Breakpatch", **p.headers}
        if body is not None:
            headers.setdefault("Content-Length", str(len(body)))
        conn.request(p.method, p.target, body=body, headers=headers)
        r = conn.getresponse()
        return r.status, r.read(read)
    finally:
        conn.close()


def _send(p: Plan, timeout: float) -> int:
    return _exchange(p, timeout)[0]


async def make(call: dict, app_url: str | None, secrets: dict[str, Secret], timeout: float,
               resolver=resolve, proxy_finder: net.Finder = net.proxy_for, *,
               pass_status: str | None = None, keep: str | None = None) -> Reply:
    """One call under the rules. Never raises: the reply says what happened. `pass_status`: the
    statuses a Call step counts as a pass (default 2xx); `keep`: where in a JSON reply the value
    it keeps is (Reply.kept)."""
    values = [s.value for s in secrets.values()]
    shown = f"{str((call or {}).get('method') or 'GET').upper()} {redact(str((call or {}).get('url') or ''), values)}"
    start = time.monotonic()
    try:
        statuses = parse_statuses(pass_status)
        if keep is not None:
            parse_path(keep)
        p = await asyncio.to_thread(plan, call, app_url, secrets, resolver, proxy_finder)
    except CallRefused as e:
        return Reply(False, error=e.kind, message=e.message, info=f"{shown} refused: {e.message}")
    try:
        status, body = await asyncio.wait_for(
            asyncio.to_thread(_exchange, p, timeout, KEEP_READ if keep is not None else REPLY_READ), timeout + 5)
    except (asyncio.TimeoutError, socket.timeout, TimeoutError):
        return Reply(False, error="timeout", message=f"No reply after {int(timeout)} s.", info=f"{shown} timed out")
    except net.ProxyError as e:
        return Reply(False, error="unreachable", message=net.explain(e, p.host, p.proxy),
                     info=f"{shown} failed: proxy {net.proxy_shown(p.proxy)} answered {e.status or 'nothing'}")
    except ssl.SSLError as e:
        message = net.explain(e, p.host) or f"{p.host}'s certificate couldn't be checked."
        return Reply(False, error="unreachable", message=message, info=f"{shown} failed: TLS {type(e).__name__}"
                     + (" (certificate not trusted)" if net.is_cert_failure(e) else ""))
    except (OSError, http.client.HTTPException) as e:
        via = f" through the proxy at {net.proxy_shown(p.proxy)}" if p.proxy else ""
        return Reply(False, error="unreachable", message=f"Couldn't reach {p.host}{via}.",
                     info=f"{shown} failed: {type(e).__name__}")
    ms = int((time.monotonic() - start) * 1000)
    if 300 <= status < 400:
        return Reply(False, status, ms, "redirect", "The address answered with a redirect, which calls don't follow. "
                     "Use the address it redirects to.", f"{shown} -> {status} (redirect, not followed)")
    if not passes(status, statuses):
        expected = "" if pass_status in (None, "", DEFAULT_PASS) else f" This step passes on {', '.join(_shown_statuses(statuses))}."
        return Reply(False, status, ms, "status", f"It replied {status}.{expected}", f"{shown} -> {status}")
    kept = None
    if keep is not None:
        try:
            kept = pick(body, keep)
        except CallRefused as e:
            return Reply(False, status, ms, "keep", e.message, f"{shown} -> {status} (nothing kept: {e.message})")
    return Reply(True, status, ms, info=f"{shown} -> {status}", kept=kept)


def _shown_statuses(statuses: list[tuple[int, int]]) -> list[str]:
    out = []
    for lo, hi in statuses:
        out.append(str(lo) if lo == hi else f"{lo // 100}xx" if lo % 100 == 0 and hi == lo + 99 else f"{lo}-{hi}")
    return out
