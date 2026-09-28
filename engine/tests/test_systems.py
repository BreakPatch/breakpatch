"""Where a test was recorded, and when a run is on another kind of system (systems.py)."""
from breakpatch_engine import install, systems

MAC = {"os": "macOS", "osVersion": "15.3", "arch": "arm64", "chromium": "140.0.7339.16"}
LINUX = {"os": "Linux", "osVersion": "24.04", "arch": "x86_64", "chromium": "140.0.7339.16"}


def test_current_system_has_every_field():
    now = systems.current()
    assert set(now) == set(systems.FIELDS)
    assert now["os"] in ("macOS", "Linux", "Windows") and now["arch"]
    assert systems.current("HeadlessChrome/141.0.1.2")["chromium"] == "141.0.1.2"
    assert install.system_info()["system"]["os"] == now["os"]


def test_versions_are_cleaned():
    assert systems.clean_version("Chromium 140.0.7339.16") == "140.0.7339.16"
    assert systems.clean_version(None) == ""
    assert systems.major("140.0.7339.16") == "140" and systems.major("") == ""


def test_recorded_on_is_read_leniently():
    assert systems.parse(None) is None and systems.parse("macOS") is None and systems.parse({"arch": "arm64"}) is None
    got = systems.parse({"os": "macOS", "osVersion": 15.3, "chromium": "x" * 99, "evil": {"a": 1}})
    assert got == {"os": "macOS", "osVersion": "15.3", "chromium": "x" * systems.MAX_LEN}


def test_differences_are_the_os_family_and_the_chromium_major():
    assert systems.differences(MAC, dict(MAC, osVersion="14.1", arch="x86_64")) == []
    assert systems.differences(MAC, dict(MAC, chromium="140.0.9999.1")) == []
    assert systems.differences(MAC, LINUX) == ["os"]
    assert systems.differences(MAC, dict(MAC, chromium="141.0.1.1")) == ["chromium"]
    assert systems.differences(MAC, dict(LINUX, chromium="139.0")) == ["os", "chromium"]
    assert systems.differences(dict(MAC, chromium=""), dict(MAC, chromium="141.0")) == []    # unknown: no guess
    assert systems.differences(None, LINUX) == []                                         # an older test


def test_mismatch_explains_in_plain_words():
    assert systems.mismatch(MAC, dict(MAC, osVersion="15.4"), relaxed=True) is None
    assert systems.mismatch(None, LINUX, relaxed=True) is None
    m = systems.mismatch(MAC, LINUX, relaxed=True)
    assert m["relaxed"] is True and m["differences"] == ["os"] and m["recordedOn"] == MAC and m["ranOn"] == LINUX
    assert m["message"] == ("This test was recorded on macOS 15 and ran on Linux. Text can look slightly different "
                            "on another system, which can fail screen checks. Re-record it on this system, or run it "
                            "on a Mac.")
    back = systems.mismatch(LINUX, MAC, relaxed=False)
    assert back["relaxed"] is False and back["message"].endswith("or run it on Linux.")
    assert "ran on macOS 15" in back["message"]
    chrome = systems.mismatch(MAC, dict(MAC, chromium="141.0.1.1"), relaxed=True)
    assert chrome["message"].startswith("This test was recorded with Chromium 140 and ran with Chromium 141.")
    for m in (m, back, chrome):
        assert "–" not in m["message"] and "—" not in m["message"]
