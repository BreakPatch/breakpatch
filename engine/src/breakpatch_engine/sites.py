"""Web origins, for saved secrets (the sites each may be typed on) and set-up and clean-up calls."""
from __future__ import annotations

from urllib.parse import urlsplit


def origin_of(url: str | None) -> str | None:
    """`scheme://host[:port]` for an http(s) address (lower case, default port dropped), else None."""
    try:
        u = urlsplit((url or "").strip())
        port = u.port
    except ValueError:
        return None
    if u.scheme.lower() not in ("http", "https") or not u.hostname:
        return None
    scheme = u.scheme.lower()
    host = u.hostname.lower().rstrip(".")
    if ":" in host:
        host = f"[{host}]"                      # IPv6
    if port is not None and port != (443 if scheme == "https" else 80):
        host = f"{host}:{port}"
    return f"{scheme}://{host}"


def site_name(origin: str | None) -> str:
    """How an origin reads in a message: `evil.example`, `127.0.0.1:8080`."""
    return origin.split("://", 1)[1] if origin and "://" in origin else "this page"
