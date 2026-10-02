"""The engine's own HTTPS on company networks (Team issue #42): the system trust store, the system
proxy, and plain words when a TLS-inspecting network or a proxy gets in the way. No real network:
a local HTTPS server with a certificate nobody trusts, and a local CONNECT proxy."""
import shutil
import socket
import ssl
import subprocess
import sys
import threading

import pytest

from breakpatch_engine import calls, install, net
from breakpatch_engine.calls import Plan


# ---------------------------------------------------------------- local servers

@pytest.fixture(scope="module")
def untrusted_https(tmp_path_factory):
    """An HTTPS server on 127.0.0.1 whose self-made certificate (for localhost) no store trusts,
    the way a TLS-inspecting network's replacement certificate looks to a Mac without its root."""
    if not shutil.which("openssl"):
        pytest.skip("no openssl to make a certificate")
    d = tmp_path_factory.mktemp("tls")
    key, cert = d / "key.pem", d / "cert.pem"
    r = subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key),
                        "-out", str(cert), "-days", "2", "-subj", "/CN=localhost",
                        "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], capture_output=True)
    if r.returncode != 0:
        pytest.skip("openssl couldn't make a certificate")
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)
    srv = socket.create_server(("127.0.0.1", 0))
    stop = threading.Event()

    def serve():
        srv.settimeout(0.2)
        while not stop.is_set():
            try:
                conn, _ = srv.accept()
            except (TimeoutError, OSError):
                continue
            try:
                with ctx.wrap_socket(conn, server_side=True) as s:
                    s.recv(1024)
                    s.sendall(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")
            except (ssl.SSLError, OSError):
                pass                                    # the client gave up on the certificate

    threading.Thread(target=serve, daemon=True).start()
    yield srv.getsockname()[1]
    stop.set()
    srv.close()


class FakeProxy:
    """An http proxy that answers CONNECT with `status`, then relays to the address it was asked for."""

    def __init__(self, status=200):
        self.status = status
        self.requests: list[bytes] = []
        self.srv = socket.create_server(("127.0.0.1", 0))
        self.port = self.srv.getsockname()[1]
        self.url = f"http://127.0.0.1:{self.port}"
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        while True:
            try:
                conn, _ = self.srv.accept()
            except OSError:
                return
            threading.Thread(target=self._one, args=(conn,), daemon=True).start()

    def _one(self, conn):
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = conn.recv(4096)
            if not chunk:
                return conn.close()
            head += chunk
        self.requests.append(head)
        if self.status != 200:
            conn.sendall(f"HTTP/1.1 {self.status} No\r\nContent-Length: 0\r\n\r\n".encode())
            return conn.close()
        host, port = head.split(b" ")[1].decode().rsplit(":", 1)
        up = socket.create_connection((host.strip("[]"), int(port)))
        conn.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")

        def pipe(a, b):
            try:
                while data := a.recv(65536):
                    b.sendall(data)
            except OSError:
                pass
            finally:
                for s in (a, b):
                    try:
                        s.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass

        threading.Thread(target=pipe, args=(up, conn), daemon=True).start()
        pipe(conn, up)

    def close(self):
        self.srv.close()


# ---------------------------------------------------------------- trust

def test_the_system_store_is_used_and_verification_stays_on():
    ctx = net.ssl_context()
    assert ctx.verify_mode == ssl.CERT_REQUIRED and ctx.check_hostname
    try:
        import truststore
    except ImportError:
        pytest.skip("truststore isn't installed here")
    assert net.trust_source() == "system" and isinstance(ctx, truststore.SSLContext)


def test_without_truststore_it_falls_back_to_a_verifying_python_context(monkeypatch):
    net.trust_source.cache_clear()
    monkeypatch.setitem(sys.modules, "truststore", None)      # import truststore -> ImportError
    try:
        assert net.trust_source() == "python"
        ctx = net.ssl_context()
        assert type(ctx) is ssl.SSLContext
        assert ctx.verify_mode == ssl.CERT_REQUIRED and ctx.check_hostname
    finally:
        net.trust_source.cache_clear()


# ---------------------------------------------------------------- the TLS-inspection message

async def test_a_certificate_the_mac_doesnt_trust_says_so_for_a_call(untrusted_https):
    url = f"https://localhost:{untrusted_https}/seed"
    r = await calls.make({"method": "POST", "url": url}, f"https://localhost:{untrusted_https}/", {}, 5)
    assert not r.ok and r.error == "unreachable"
    assert "doesn't trust localhost's certificate" in r.message and "company network" in r.message
    assert "ask IT to install the network's certificate on this Mac" in r.message
    assert "certificate not trusted" in r.info and "SSL" not in r.message


def test_a_known_public_host_gets_the_network_replaced_it_message():
    e = ssl.SSLCertVerificationError(1, "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: "
                                        "unable to get local issuer certificate")
    assert net.explain(e, "huggingface.co") == net.TLS_INTERCEPTED
    assert net.explain(e, "cdn-lfs.huggingface.co") == net.TLS_INTERCEPTED
    assert net.TLS_INTERCEPTED.startswith("Your network replaced the website's certificate (common on company networks).")
    # Wrapped, as httpx and huggingface_hub hand it on.
    try:
        try:
            raise e
        except ssl.SSLError as inner:
            raise RuntimeError("ConnectError") from inner
    except RuntimeError as outer:
        assert net.explain(outer, "huggingface.co") == net.TLS_INTERCEPTED
    assert net.explain(ConnectionResetError("reset"), "huggingface.co") is None


def test_the_model_downloads_client_reports_interception_in_plain_words(untrusted_https):
    """The real chain: httpx (huggingface_hub's client) -> httpcore -> ssl, with our context."""
    import httpx
    with net.hub_client("https://huggingface.co", finder=lambda u: None) as c:
        with pytest.raises(httpx.ConnectError) as e:
            c.get(f"https://localhost:{untrusted_https}/api/models/x")
    assert net.is_cert_failure(e.value)
    assert net.explain(e.value, "huggingface.co") == net.TLS_INTERCEPTED


# ---------------------------------------------------------------- proxies

def fake_proxies(**kw):
    return lambda: kw


def test_the_system_proxy_is_used_for_https_but_never_for_this_machine():
    getp = fake_proxies(https="http://proxy.corp:8080", http="proxy.corp:3128")
    assert net.proxy_for("https://huggingface.co/x", getp, lambda h: False) == "http://proxy.corp:8080"
    assert net.proxy_for("http://example.com/", getp, lambda h: False) == "http://proxy.corp:3128"
    for local in ("https://localhost:3000/", "https://127.0.0.1/", "https://[::1]:8443/", "https://app.localhost/"):
        assert net.proxy_for(local, getp, lambda h: False) is None
    # The Mac's "Bypass proxy settings for these hosts" (or NO_PROXY).
    assert net.proxy_for("https://intranet.corp/", getp, lambda h: h.endswith(".corp")) is None
    # Nothing set, SOCKS only, or settings that can't be read: straight there.
    assert net.proxy_for("https://huggingface.co/", fake_proxies(), lambda h: False) is None
    assert net.proxy_for("https://huggingface.co/", fake_proxies(all="socks5://s:1080"), lambda h: False) is None

    def broken():
        raise OSError("SystemConfiguration")
    assert net.proxy_for("https://huggingface.co/", broken, lambda h: False) is None


def test_a_call_to_a_public_host_plans_the_proxy_and_a_local_one_doesnt():
    from test_calls import APP, PUBLIC
    finder = lambda url: "http://proxy.corp:8080"  # noqa: E731
    p = calls.plan({"method": "GET", "url": "https://api.acme.com/seed"}, APP, {}, PUBLIC, finder)
    assert p.proxy == "http://proxy.corp:8080" and p.address == "93.184.216.35"
    lp = calls.plan({"method": "GET", "url": "http://localhost:3000/"}, "http://localhost:3000/", {}, PUBLIC, finder)
    assert lp.proxy is None


def test_a_call_tunnels_to_the_checked_address_with_the_real_name_for_tls(untrusted_https):
    proxy = FakeProxy()
    try:
        p = Plan("GET", f"https://localhost:{untrusted_https}/", "https", "localhost", untrusted_https, "/",
                 "127.0.0.1", {}, proxy.url)
        with pytest.raises(ssl.SSLCertVerificationError):
            calls._send(p, 5)                   # through the tunnel to the server, whose certificate fails
        assert proxy.requests and proxy.requests[0].startswith(f"CONNECT 127.0.0.1:{untrusted_https} HTTP/1.1".encode())
    finally:
        proxy.close()


def test_ipv6_addresses_are_bracketed_and_proxy_credentials_are_sent():
    proxy = FakeProxy(status=403)
    try:
        with pytest.raises(net.ProxyError):
            net.tunnel(f"http://me%40corp:p%3Ass@127.0.0.1:{proxy.port}", "2606:4700::1111", 443, 5)
        head = proxy.requests[0].decode()
        assert head.startswith("CONNECT [2606:4700::1111]:443 HTTP/1.1")
        import base64
        assert "Proxy-Authorization: Basic " + base64.b64encode(b"me@corp:p:ss").decode() in head
    finally:
        proxy.close()


def test_a_proxy_that_wants_a_password_or_refuses_says_so():
    for status, words in ((407, "asks for a password"), (403, "refused the connection (it answered 403)")):
        proxy = FakeProxy(status=status)
        try:
            with pytest.raises(net.ProxyError) as e:
                net.tunnel(proxy.url, "93.184.216.34", 443, 5)
            msg = net.explain(e.value, "api.acme.com", proxy.url)
            assert words in msg and f"127.0.0.1:{proxy.port}" in msg
        finally:
            proxy.close()
    assert "user:pw" not in net.proxy_auth("http://user:pw@proxy.corp:8080")


def test_httpx_proxy_errors_are_worded_too():
    class ProxyError(Exception):
        pass
    assert "asks for a password" in net.explain(ProxyError("407 Proxy Authentication Required"), "huggingface.co",
                                                "http://proxy.corp:8080")
    assert "Couldn't connect through your network's proxy (proxy.corp:8080)" in net.explain(
        ProxyError("connection refused"), "huggingface.co", "http://proxy.corp:8080")


def test_the_hub_client_uses_the_system_store_and_the_proxy():
    import httpx
    with net.hub_client("https://huggingface.co", finder=lambda u: "http://proxy.corp:8080") as c:
        t = c._transport_for_url(httpx.URL("https://huggingface.co/api/models/x"))
        assert type(t).__name__ == "HTTPTransport" and "proxy" in type(t._pool).__name__.lower()
    with net.hub_client("https://huggingface.co", finder=lambda u: None) as c:
        t = c._transport_for_url(httpx.URL("https://huggingface.co/api/models/x"))
        assert "proxy" not in type(t._pool).__name__.lower()


def test_use_for_hub_replaces_huggingface_hubs_client():
    from huggingface_hub import set_client_factory
    from huggingface_hub.utils import _http
    original = _http._GLOBAL_CLIENT_FACTORY
    try:
        net.use_for_hub("https://huggingface.co")
        c = _http.get_session()
        assert c._trust_env is False and c.follow_redirects
        assert _http.hf_request_event_hook in c.event_hooks["request"]
    finally:
        set_client_factory(original)


def test_the_browser_install_gets_the_proxy_and_the_system_store():
    env = net.child_env({"PATH": "/bin"}, install.BROWSER_DOWNLOAD, lambda u: "http://proxy.corp:8080", system_ca=True)
    assert env["HTTPS_PROXY"] == "http://proxy.corp:8080" and env["NODE_OPTIONS"] == "--use-system-ca"
    kept = net.child_env({"https_proxy": "http://mine:1", "NODE_OPTIONS": "--max-old-space-size=99"},
                         install.BROWSER_DOWNLOAD, lambda u: "http://proxy.corp:8080", system_ca=True)
    assert "HTTPS_PROXY" not in kept and kept["NODE_OPTIONS"] == "--max-old-space-size=99 --use-system-ca"
    old_node = net.child_env({}, install.BROWSER_DOWNLOAD, lambda u: None, system_ca=False)
    assert old_node == {}


def test_playwrights_node_takes_use_system_ca():
    try:
        cmd, _ = install._driver()
    except Exception:  # noqa: BLE001
        pytest.skip("no Playwright driver")
    assert net.node_has_system_ca(cmd[0])
    assert not net.node_has_system_ca("/nonexistent/node")


def test_browser_install_failures_are_worded():
    assert install.install_failure(["Error: unable to get local issuer certificate",
                                    "code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'"], {}) == net.TLS_INTERCEPTED
    assert "asks for a password" in install.install_failure(["407 Proxy Authentication Required"],
                                                            {"HTTPS_PROXY": "http://p.corp:8080"})
    assert install.install_failure(["ECONNRESET"], {"HTTPS_PROXY": "http://p"}).startswith("The browser couldn't be installed.")


def test_chromium_network_errors_are_worded():
    m = net.browser_message("Page.goto: net::ERR_CERT_AUTHORITY_INVALID at https://staging.acme.com/", "https://staging.acme.com/")
    assert "doesn't trust staging.acme.com's certificate" in m
    assert "asks for a password" in net.browser_message("net::ERR_PROXY_AUTH_UNSUPPORTED", "https://a.com/")
    assert "web filter" in net.browser_message("net::ERR_TUNNEL_CONNECTION_FAILED", "https://a.com/")
    assert net.browser_message("net::ERR_NAME_NOT_RESOLVED", "https://a.com/") is None


def test_an_automatic_proxy_configuration_is_noticed():
    out = "<dictionary> {\n  HTTPEnable : 0\n  ProxyAutoConfigEnable : 1\n  ProxyAutoConfigURLString : http://wpad/p.pac\n}"
    assert net.parse_scutil(out) == "pac"
    assert net.parse_scutil("<dictionary> {\n  ProxyAutoDiscoveryEnable : 1\n}") == "wpad"
    assert net.parse_scutil("<dictionary> {\n  HTTPSEnable : 1\n  HTTPSProxy : p.corp\n}") is None
