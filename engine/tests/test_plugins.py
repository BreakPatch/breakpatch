"""plugins.py: the Team engine is found once, registers the healer, and decides `system.info`'s edition."""
import asyncio
import sys
import types

import pytest

from breakpatch_engine import install, plugins


@pytest.fixture
def fresh_plugins(monkeypatch):
    """plugins.py as if the engine had just started (restored afterwards)."""
    monkeypatch.setattr(plugins, "_loaded", False)
    monkeypatch.setattr(plugins, "_healer", None)
    monkeypatch.setattr(plugins, "_team_version", None)
    monkeypatch.setattr(plugins, "_licence", None)
    monkeypatch.setattr(plugins, "_explainer", None)
    monkeypatch.setattr(plugins, "_planner", None)
    return plugins


def _team_installed() -> bool:
    try:
        import breakpatch_team_engine  # noqa: F401
    except ModuleNotFoundError:
        return False
    return True


def test_edition_is_community_without_the_team_engine():
    if _team_installed():
        pytest.skip("the Team engine is installed in this environment")
    assert plugins.edition() == "community"
    assert install.system_info()["edition"] == "community"
    assert install.system_info()["licence"] == {"state": "unavailable"}


def test_edition_is_team_when_the_team_engine_registers(fresh_plugins, monkeypatch):
    def heal(*a):  # pragma: no cover - never called
        raise AssertionError

    fake = types.ModuleType(plugins.TEAM_MODULE)
    fake.__version__ = "9.9.9"
    fake.register = lambda p: p.register_healer(heal)
    monkeypatch.setitem(sys.modules, plugins.TEAM_MODULE, fake)

    assert fresh_plugins.edition() == "team"
    assert fresh_plugins.healer() is heal
    assert install.system_info()["edition"] == "team"


@pytest.mark.parametrize("register", [None, "raises"])
def test_a_team_engine_that_cannot_register_leaves_community(fresh_plugins, monkeypatch, register):
    fake = types.ModuleType(plugins.TEAM_MODULE)
    if register == "raises":
        def boom(p):
            p.register_healer(lambda *a: None)
            p.register_explainer(object())
            p.register_planner(object())
            raise RuntimeError("licence file unreadable")
        fake.register = boom
    monkeypatch.setitem(sys.modules, plugins.TEAM_MODULE, fake)

    assert fresh_plugins.edition() == "community"
    assert fresh_plugins.healer() is None
    assert fresh_plugins.licence() is None
    assert fresh_plugins.explainer() is None
    assert fresh_plugins.planner() is None


class FakeLicence:
    def __init__(self):
        self.tokens = []

    def set(self, token):
        self.tokens.append(token)
        return self.to_json()

    def to_json(self):
        return {"state": "active" if self.tokens and self.tokens[-1] else "none", "features": []}


def test_licence_set_goes_to_the_team_engine_and_system_info_reports_it(fresh_plugins, monkeypatch):
    from breakpatch_engine.service import Engine

    lic = FakeLicence()
    fake = types.ModuleType(plugins.TEAM_MODULE)
    fake.register = lambda p: (p.register_healer(lambda *a: None), p.register_licence(lic))
    monkeypatch.setitem(sys.modules, plugins.TEAM_MODULE, fake)

    h = Engine(lambda *a: None).handlers()
    assert install.system_info()["licence"] == {"state": "none", "features": []}
    assert asyncio.run(h["licence.set"]({"token": "a.b.c"}))["state"] == "active"
    assert install.system_info()["licence"]["state"] == "active"
    assert asyncio.run(h["licence.set"]({"token": None}))["state"] == "none"
    assert lic.tokens == ["a.b.c", None]


def test_licence_set_in_community_is_unavailable_and_checks_its_input(fresh_plugins, monkeypatch):
    from breakpatch_engine.protocol import EngineError
    from breakpatch_engine.service import Engine

    monkeypatch.setitem(sys.modules, plugins.TEAM_MODULE, None)    # import fails: not installed
    h = Engine(lambda *a: None).handlers()
    assert asyncio.run(h["licence.set"]({"token": "a.b.c"})) == {"state": "unavailable"}
    with pytest.raises(EngineError) as e:
        asyncio.run(h["licence.set"]({"token": 42}))
    assert e.value.code == "bad_request"
