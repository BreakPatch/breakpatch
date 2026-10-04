"""The engine's own HTTPS: whose certificates it trusts, which proxy it goes through, and what it
says when a company network gets in the way (Team issue #42).

- Trust: the operating system's certificate store (the macOS Keychain, the Windows certificate
  store, the Linux system bundle), through `truststore`. A company that inspects TLS (Fortinet,
  Zscaler, Palo Alto...) installs its own root certificate there, so the engine trusts what the Mac
  trusts. Where truststore can't load, Python's default store plus certifi's bundle. Verification
  is never turned off.
- Proxy: the system's (System Settings > Network > Proxies on a Mac: Web Proxy and Secure Web
  Proxy, with "Bypass proxy settings for these hosts"), or HTTPS_PROXY / HTTP_PROXY / NO_PROXY when
  those are set, as `urllib.request.getproxies()` reads them. An automatic proxy configuration
  (a PAC file or WPAD) isn't read: `auto_proxy()` notices it so the error can say so.
- Messages: `explain()` turns a certificate or proxy failure into a sentence a person can act on.

Used by calls.py (set-up and clean-up calls), install.py (the model and browser downloads) and
browser.py (the words for a page that didn't load).
"""
from __future__ import annotations

import base64
import functools
import logging
import os
import socket
import ssl
import subprocess
import sys
import urllib.request
from typing import Callable
from urllib.parse import unquote, urlsplit

log = logging.getLogger("breakpatch.net")

# A host whose certificate is a public one, so a certificate this computer doesn't trust means
# something on the way replaced it (the model download, the browser download, Breakpatch's own services).
KNOWN_PUBLIC = ("huggingface.co", "hf.co", "breakpatch.dev", "playwright.dev", "playwright.azureedge.net",
                "microsoft.com")


def machine_words(platform: str | None = None) -> tuple[str, str]:
    """What the messages call the machine and where its proxy is set: ("this Mac", System Settings)
    on macOS, ("this PC", the system's own place) on Windows and Linux, as the app says it
    (app/src/lib/osWords.ts, app/src-tauri/src/os_words.rs)."""
    platform = platform or sys.platform
    if platform == "darwin":
        return "this Mac", "System Settings > Network > Details > Proxies"
    if platform == "win32":
        return "this PC", "Settings > Network & internet > Proxy"
    return "this PC", "your system's network proxy settings"


def tls_intercepted(platform: str | None = None) -> str:
    this, _ = machine_words(platform)
    return ("Your network replaced the website's certificate (common on company networks). Breakpatch "
            f"trusts the certificates {this} trusts; ask IT to install the network's certificate on {this}.")


TLS_INTERCEPTED = tls_intercepted()


def tls_untrusted(host: str, platform: str | None = None) -> str:
    """For a host that may have a certificate of its own making (a staging app)."""
    this, _ = machine_words(platform)
    return (f"{this[0].upper()}{this[1:]} doesn't trust {host}'s certificate. If you're on a company network, it may "
            f"have replaced the certificate: Breakpatch trusts the certificates {this} trusts, so ask IT to install "
            f"the network's certificate on {this}. If it's your own test server, its certificate needs to be "
            f"trusted on {this} too.")


def proxy_auth(proxy: str | None, platform: str | None = None) -> str:
    this, _ = machine_words(platform)
    return (f"Your network's proxy{_at(proxy)} asks for a password, which Breakpatch can't send. Ask IT to let "
            f"{this} through without one (for example by its address), or for the proxy address with the "
            "user name and password in it (see Using Breakpatch on a company network in the Breakpatch documentation).")


def proxy_failed(proxy: str | None, platform: str | None = None) -> str:
    _, settings = machine_words(platform)
    return f"Couldn't connect through your network's proxy{_at(proxy)}. Check the proxy in {settings}, or ask IT."


def proxy_refused(proxy: str | None, status: int | None) -> str:
    code = f" (it answered {status})" if status else ""
    return (f"Your network's proxy{_at(proxy)} refused the connection{code}. A company web filter may be "
            "blocking the address: ask IT to allow it.")


def pac_hint(platform: str | None = None) -> str:
    this, _ = machine_words(platform)
    return (f" {this[0].upper()}{this[1:]} uses an automatic proxy configuration, which Breakpatch's own downloads "
            "can't read: see Using Breakpatch on a company network in the Breakpatch documentation.")


PAC_HINT = pac_hint()


def _at(proxy: str | None) -> str:
    shown = proxy_shown(proxy)
    return f" ({shown})" if shown else ""


def proxy_shown(proxy: str | None) -> str:
    """A proxy address for a message or a log: host and port, never a user name or password."""
    if not proxy:
        return ""
    try:
        u = urlsplit(proxy if "://" in proxy else "http://" + proxy)
        return f"{u.hostname}:{u.port}" if u.port else (u.hostname or "")
    except ValueError:
        return "the proxy"


# ---------------------------------------------------------------- trust

@functools.lru_cache(maxsize=1)
def trust_source() -> str:
    """"system" when truststore loads (the OS store), otherwise "python"."""
    try:
        import truststore
        truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        return "system"
    except Exception as e:  # noqa: BLE001 - an old OS or a build without it: Python's own store
        log.warning("the system certificate store isn't available (%s: %s); using Python's",
                    type(e).__name__, e)
        return "python"


def ssl_context() -> ssl.SSLContext:
    """A verifying client context over the system trust store; Python's default store plus
    certifi's bundle where truststore can't load. Hostname checks and verification stay on."""
    if trust_source() == "system":
        try:
            import truststore
            ctx = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            ctx.check_hostname = True
            ctx.verify_mode = ssl.CERT_REQUIRED
            return ctx
        except Exception:  # noqa: BLE001
            pass
    ctx = ssl.create_default_context()
    try:
        import certifi
        ctx.load_verify_locations(cafile=certifi.where())
    except Exception:  # noqa: BLE001 - a build without certifi keeps the default paths
        pass
    return ctx


# ---------------------------------------------------------------- proxy

Finder = Callable[[str], "str | None"]


def _loopback(host: str) -> bool:
    h = host.lower().strip("[]")
    if h == "localhost" or h.endswith(".localhost"):
        return True
    try:
        import ipaddress
        return ipaddress.ip_address(h.split("%", 1)[0]).is_loopback
    except ValueError:
        return False


def proxy_for(url: str, getproxies=urllib.request.getproxies, bypass=urllib.request.proxy_bypass) -> str | None:
    """The http(s) proxy for `url`, as `http://host:port` (with user info if it was given), or
    None to connect directly. Never one for this machine's own addresses. SOCKS isn't used."""
    try:
        u = urlsplit(url)
        scheme, host = u.scheme.lower(), (u.hostname or "")
    except ValueError:
        return None
    if scheme not in ("http", "https") or not host or _loopback(host):
        return None
    try:
        proxies = {k.lower(): v for k, v in (getproxies() or {}).items() if v}
    except Exception as e:  # noqa: BLE001 - the system settings couldn't be read: go direct
        log.info("proxy settings couldn't be read: %s", type(e).__name__)
        return None
    p = proxies.get(scheme) or proxies.get("all")
    if not p:
        return None
    if "://" not in p:
        p = "http://" + p
    if not p.lower().startswith(("http://", "https://")):
        return None                                      # socks5:// and the like
    try:
        if bypass(host):
            return None
    except Exception:  # noqa: BLE001
        pass
    return p


@functools.lru_cache(maxsize=1)
def auto_proxy() -> str | None:
    """On a Mac, "pac" or "wpad" when the system proxy comes from an automatic configuration (a PAC
    file, or Auto Proxy Discovery), which the engine's own downloads don't read. None otherwise."""
    if sys.platform != "darwin":
        return None
    try:
        out = subprocess.run(["/usr/sbin/scutil", "--proxy"], capture_output=True, text=True, timeout=3).stdout
    except Exception:  # noqa: BLE001
        return None
    return parse_scutil(out)


def parse_scutil(out: str) -> str | None:
    keys = {}
    for line in out.splitlines():
        if " : " in line:
            k, v = line.strip().split(" : ", 1)
            keys[k.strip()] = v.strip()
    if keys.get("ProxyAutoConfigEnable") == "1":
        return "pac"
    if keys.get("ProxyAutoDiscoveryEnable") == "1":
        return "wpad"
    return None


class ProxyError(OSError):
    """The proxy didn't open a tunnel. `status` is its HTTP answer, if it gave one."""

    def __init__(self, proxy: str, status: int | None = None, reason: str = ""):
        super().__init__(f"proxy {proxy_shown(proxy)}: {status or ''} {reason}".strip())
        self.proxy = proxy
        self.status = status


def tunnel(proxy: str, address: str, port: int, timeout: float) -> socket.socket:
    """A socket to `address:port` through an http proxy's CONNECT. The tunnel names the address
    (already checked, calls.py), not a host name, so the proxy can't resolve it elsewhere."""
    u = urlsplit(proxy)
    if u.scheme.lower() != "http" or not u.hostname:
        raise ProxyError(proxy, None, "only http:// proxies are supported")
    sock = socket.create_connection((u.hostname, u.port or 80), timeout)
    try:
        target = f"[{address}]:{port}" if ":" in address else f"{address}:{port}"
        lines = [f"CONNECT {target} HTTP/1.1", f"Host: {target}", "User-Agent: Breakpatch"]
        if u.username:
            cred = f"{unquote(u.username)}:{unquote(u.password or '')}".encode()
            lines.append("Proxy-Authorization: Basic " + base64.b64encode(cred).decode())
        sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("latin-1"))
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = sock.recv(4096)
            if not chunk:
                raise ProxyError(proxy, None, "closed the connection")
            head += chunk
            if len(head) > 64 * 1024:
                raise ProxyError(proxy, None, "answer too long")
        status_line = head.split(b"\r\n", 1)[0].decode("latin-1", "replace").split()
        try:
            status = int(status_line[1])
        except (IndexError, ValueError):
            raise ProxyError(proxy, None, "unreadable answer") from None
        if status != 200:
            raise ProxyError(proxy, status)
        return sock
    except BaseException:
        sock.close()
        raise


def child_env(base: dict, download_url: str, finder: Finder = proxy_for, system_ca: bool | None = None) -> dict:
    """The environment for a child that downloads on its own (Playwright's browser install, in
    Node): the system proxy as HTTPS_PROXY when none is set, and Node's --use-system-ca so it trusts
    the system store too (Node 22.15+/23.8+; `system_ca` says whether this one has it)."""
    env = dict(base)
    if not any(env.get(k) for k in ("HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy")):
        p = finder(download_url)
        if p:
            env["HTTPS_PROXY"] = p
    if system_ca:
        opts = env.get("NODE_OPTIONS", "")
        if "--use-system-ca" not in opts:
            env["NODE_OPTIONS"] = (opts + " --use-system-ca").strip()
    return env


def node_has_system_ca(node: str) -> bool:
    """Whether this Node takes --use-system-ca (an older one would refuse to start with it)."""
    try:
        r = subprocess.run([node, "--use-system-ca", "-e", "0"], capture_output=True, timeout=15,
                           env={**os.environ, "NODE_OPTIONS": ""})
        return r.returncode == 0
    except Exception:  # noqa: BLE001
        return False


# ---------------------------------------------------------------- the model download (huggingface_hub)

def use_for_hub(endpoint: str = "https://huggingface.co") -> None:
    """huggingface_hub's shared httpx client, with the system trust store and proxy. Without this it
    trusts certifi's bundle only, and reads the proxy but not the Mac's bypass list."""
    import httpx
    from huggingface_hub import set_client_factory
    try:
        from huggingface_hub.utils._http import hf_request_event_hook
        hooks = {"request": [hf_request_event_hook]}
    except ImportError:                                   # another huggingface_hub: its hook is optional
        hooks = {}

    def factory() -> httpx.Client:
        return hub_client(endpoint, hooks)

    set_client_factory(factory)


def hub_client(endpoint: str, hooks: dict | None = None, finder: Finder = proxy_for):
    import httpx
    proxy = finder(endpoint)
    if proxy:
        log.info("downloads go through the proxy at %s", proxy_shown(proxy))
    # trust_env=False: the proxy is the one worked out above (which reads the same variables), and
    # SSL_CERT_FILE and the like don't replace the system store.
    return httpx.Client(event_hooks=hooks or {}, follow_redirects=True, timeout=None, verify=ssl_context(),
                        proxy=proxy, trust_env=False)


# ---------------------------------------------------------------- messages

def _chain(exc: BaseException):
    seen = set()
    while exc is not None and id(exc) not in seen:
        seen.add(id(exc))
        yield exc
        exc = exc.__cause__ or exc.__context__


def _known_public(host: str | None) -> bool:
    h = (host or "").lower().rstrip(".")
    return any(h == k or h.endswith("." + k) for k in KNOWN_PUBLIC)


def is_cert_failure(exc: BaseException) -> bool:
    for e in _chain(exc):
        if isinstance(e, ssl.SSLCertVerificationError):
            return True
        text = str(e)
        if "CERTIFICATE_VERIFY_FAILED" in text or "certificate verify failed" in text.lower():
            return True
    return False


@functools.lru_cache(maxsize=1)
def _httpx_proxy_errors() -> tuple[type[BaseException], ...]:
    """httpx's and httpcore's ProxyError (the model download's client), where they're installed.
    Imported when first needed, not with this module."""
    out: list[type[BaseException]] = []
    for mod in ("httpx", "httpcore"):
        try:
            out.append(getattr(__import__(mod), "ProxyError"))
        except (ImportError, AttributeError):
            pass
    return tuple(out)


def explain(exc: BaseException, host: str | None = None, proxy: str | None = None) -> str | None:
    """A sentence for a certificate or proxy failure, or None when it's neither."""
    if is_cert_failure(exc):
        return TLS_INTERCEPTED if _known_public(host) or not host else tls_untrusted(host)
    for e in _chain(exc):
        if isinstance(e, ProxyError):
            if e.status == 407:
                return proxy_auth(e.proxy)
            if e.status:
                return proxy_refused(e.proxy, e.status)
            return proxy_failed(e.proxy)
        if isinstance(e, _httpx_proxy_errors()):
            text = str(e)
            if "407" in text:
                return proxy_auth(proxy)
            for code in ("403", "502", "503", "451"):
                if code in text:
                    return proxy_refused(proxy, int(code))
            return proxy_failed(proxy)
    if proxy and any(isinstance(e, (ConnectionRefusedError, socket.gaierror)) for e in _chain(exc)):
        return proxy_failed(proxy)
    return None


# Chromium's net errors (page.goto's message) that mean the network got in the way.
_BROWSER = {
    "ERR_CERT_AUTHORITY_INVALID": "cert", "ERR_CERT_COMMON_NAME_INVALID": "cert",
    "ERR_CERT_INVALID": "cert", "ERR_CERT_DATE_INVALID": "cert",
    "ERR_PROXY_AUTH_UNSUPPORTED": "auth", "ERR_PROXY_AUTH_REQUESTED": "auth",
    "ERR_PROXY_CONNECTION_FAILED": "proxy", "ERR_TUNNEL_CONNECTION_FAILED": "tunnel",
    "ERR_PROXY_CERTIFICATE_INVALID": "network", "ERR_BLOCKED_BY_ADMINISTRATOR": "blocked",
}


def browser_message(error: str, url: str) -> str | None:
    """Words for a page that didn't load because of the network, from Chromium's error, or None."""
    host = urlsplit(url).hostname or url
    for code, kind in _BROWSER.items():
        if f"net::{code}" in error:
            if kind == "cert":
                return tls_untrusted(host)
            if kind == "network":
                return TLS_INTERCEPTED
            if kind == "auth":
                return proxy_auth(None)
            if kind == "proxy":
                return proxy_failed(None)
            if kind == "tunnel":
                return (f"Your network's proxy wouldn't connect to {host}. A company web filter may be blocking "
                        "it: ask IT to allow it.")
            if kind == "blocked":
                return f"{host} is blocked on {machine_words()[0]} by an administrator's policy."
    return None
