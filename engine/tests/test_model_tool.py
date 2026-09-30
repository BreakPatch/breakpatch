"""tools/model-test: the harness that compares vision models (plan §2.4). It must ask and read
exactly as the engine does, so these tests check it has no prompt or parser of its own, and run it
end to end against a fake llama-server (no model, no GPU)."""
import importlib.util
import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest
from PIL import Image

from breakpatch_engine import locator

TOOL = Path(__file__).resolve().parents[2] / "tools" / "model-test"


def load(name):
    sys.path.insert(0, str(TOOL))
    try:
        spec = importlib.util.spec_from_file_location(name, TOOL / f"{name}.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    finally:
        sys.path.remove(str(TOOL))


mt = load("model_test")
compare = load("compare")

# A llama-server stand-in: --version, /health, and /v1/chat/completions that answers a box for
# "the Log in button" (in 0-1000 units), null for anything else, garbage for "the garbled thing",
# with llama-server's `timings`. It logs each request to FAKE_LOG.
FAKE_SERVER = textwrap.dedent('''\
    import base64, http.server, io, json, os, sys
    args = sys.argv[1:]
    if args == ["--version"]:
        print("version: 6000 (abc1234)\\nbuilt with cc for x86_64-linux-gnu", file=sys.stderr)
        sys.exit(0)
    opt = {args[i]: args[i + 1] for i in range(len(args) - 1) if args[i].startswith("-")}
    ballast = bytearray(48 * 2**20)          # so the peak resident size is clearly measurable
    for i in range(0, len(ballast), 4096):
        ballast[i] = 1
    log = os.environ["FAKE_LOG"]

    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a): pass
        def reply(self, code, doc):
            body = json.dumps(doc).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        def do_GET(self):
            self.reply(200 if self.path == "/health" else 404, {"status": "ok"})
        def do_POST(self):
            doc = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if self.headers.get("Authorization") != "Bearer " + opt.get("--api-key", ""):
                return self.reply(401, {"error": "no key"})
            parts = doc["messages"][0]["content"]
            url = next(p["image_url"]["url"] for p in parts if p["type"] == "image_url")
            text = next(p["text"] for p in parts if p["type"] == "text")
            from PIL import Image
            img = Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1])))
            with open(log, "a") as f:
                f.write(json.dumps({"size": img.size, "text": text, "temperature": doc["temperature"],
                                    "seed": doc.get("seed"), "max_tokens": doc["max_tokens"], "argv": args}) + "\\n")
            if "the Log in button" in text:
                answer = '{"bbox_2d": [100, 100, 300, 200]}'
            elif "garbled" in text:
                answer = "I think it is somewhere on the left"
            else:
                answer = '{"bbox_2d": null}'
            self.reply(200, {"choices": [{"message": {"content": answer}}],
                             "timings": {"prompt_n": 1080, "prompt_ms": 800.0, "predicted_n": 20, "predicted_ms": 200.0}})

    http.server.ThreadingHTTPServer(("127.0.0.1", int(opt["--port"])), H).serve_forever()
''')


@pytest.fixture
def bench(tmp_path, monkeypatch):
    """Two 1280 x 800 screenshots, cases with expected boxes, and the fake llama-server."""
    shots = tmp_path / "shots"
    shots.mkdir()
    for name in ("login.png", "note.png"):
        Image.new("RGB", (1280, 800), (240, 240, 240)).save(shots / name)
    cases = tmp_path / "cases.csv"
    # The Log in button at 0-1000 [100,100,300,200] is pixels [128,80,384,160]: centre (256, 120).
    cases.write_text("file,description,x1,y1,x2,y2,hard\n"
                     "# a comment\n"
                     "login.png,the Log in button,200,100,300,140,\n"
                     "login.png,the Email field,10,10,50,50,\n"
                     "note.png,the garbled thing,10,10,50,50,1\n"
                     "note.png,the second tag chip,,,,,1\n")
    exe = tmp_path / "llama-server"
    exe.write_text(f"#!{sys.executable}\n" + FAKE_SERVER)
    exe.chmod(0o755)
    (tmp_path / "model-Q4_K_M.gguf").write_bytes(b"GGUF")
    (tmp_path / "mmproj-model-F16.gguf").write_bytes(b"GGUF")
    log = tmp_path / "requests.log"
    monkeypatch.setenv("FAKE_LOG", str(log))
    return {"dir": tmp_path, "shots": shots, "cases": cases, "exe": exe, "log": log}


def run_llamacpp(b, out, *extra):
    return mt.main(["--runtime", "llamacpp", "--llama-server", str(b["exe"]), "--gguf", str(b["dir"] / "model-Q4_K_M.gguf"),
                    "--mmproj", str(b["dir"] / "mmproj-model-F16.gguf"), "--cases", str(b["cases"]),
                    "--shots", str(b["shots"]), "--out", str(out), "--threads", "4", *extra])


def requests(b):
    return [json.loads(l) for l in b["log"].read_text().splitlines()]


# ---------------------------------------------------------------- same prompt and parsing as the engine

def test_the_prompt_and_parser_are_the_engines():
    assert mt.LOCATE_PROMPT is locator.LOCATE_PROMPT
    assert mt.parse_bbox is locator.parse_bbox and mt.map_box is locator.map_box
    source = (TOOL / "model_test.py").read_text()
    assert "Reply with JSON only" not in source          # no copy of the prompt to drift
    assert not hasattr(mt, "PROMPT") and not hasattr(mt, "parse_box")
    assert mt.locate_prompt('the "Save" button') == locator.LOCATE_PROMPT.format(desc="the 'Save' button")
    assert "If it isn't in the screenshot" in mt.locate_prompt("x")


def test_median_and_p90_not_the_mean():
    secs = [1, 1, 1, 1, 1, 1, 1, 1, 1, 30]
    assert mt.median(secs) == 1
    assert mt.percentile(secs, 90) == pytest.approx(3.9)
    assert mt.percentile([], 50) is None and mt.percentile([2.5], 90) == 2.5
    rs = [{"secs": s, "hit": True, "box": [0, 0, 1, 1], "hard": False} for s in secs]
    s = mt.summarise(rs)
    assert s["medianS"] == 1 and s["p90S"] == pytest.approx(3.9)
    assert "avg" not in json.dumps(s).lower() and "mean" not in json.dumps(s).lower()


def test_image_tokens_for_the_engine_viewport():
    assert mt.image_tokens(1280, 800) == 1000
    # Qwen's resize rounds with Python's round(): 400 / 32 = 12.5 goes to 12, so 20 x 12.
    assert mt.image_tokens(640, 400) == 240


def test_the_readme_promises_what_the_tool_does():
    readme = (TOOL / "README.md").read_text()
    assert "median" in readme.lower() and "1280 × 800" in readme and "1440 × 900" not in readme.split("second set")[0]
    engine_readme = (TOOL.parents[1] / "engine" / "README.md").read_text()
    assert "imports" in engine_readme.split("## Needs a Mac")[1].split("##")[0]


# ---------------------------------------------------------------- end to end, with a fake llama-server

def test_llamacpp_run_end_to_end(bench):
    out = bench["dir"] / "out"
    assert run_llamacpp(bench, out) == 0
    doc = json.loads((out / "results.json").read_text())
    assert doc["resultsVersion"] == 2 and doc["set"] == "1280x800"
    assert set(doc["machine"]) >= {"cpu", "ramGb", "os", "arch"}
    (run,) = doc["runs"]
    assert run["runtime"] == "llamacpp" and run["device"] == "cpu"
    assert run["llamacppBuild"] == "b6000 (abc1234)"
    assert (run["quant"], run["mmprojQuant"], run["threads"]) == ("Q4_K_M", "F16", 4)
    rs = {r["desc"]: r for r in run["results"]}
    assert rs["the Log in button"]["box"] == [128, 80, 384, 160] and rs["the Log in button"]["hit"] is True
    assert rs["the Email field"]["box"] is None and rs["the Email field"]["hit"] is None
    assert rs["the garbled thing"]["box"] is None
    assert rs["the Log in button"]["prefillS"] == 0.8 and rs["the Log in button"]["decodeS"] == 0.2
    assert rs["the Log in button"]["promptTokens"] == 1080
    assert rs["the Log in button"]["effectiveSize"] == [1280, 800] and rs["the Log in button"]["imageTokensEst"] == 1000
    s = run["summary"]
    assert (s["hits"], s["judged"], s["hardJudged"], s["found"]) == (1, 1, 0, 1)
    assert s["medianPrefillS"] == 0.8 and s["medianS"] is not None and s["p90S"] >= s["medianS"]
    # Peak RSS of llama-server itself (VmHWM), labelled as that.
    assert run["memory"]["processPeakRssGb"] >= 0.04
    assert "llama-server's peak resident size" in run["memory"]["measures"]
    # One warm-up call, then one per case; the engine's request shape.
    sent = requests(bench)
    assert len(sent) == 5
    assert all(r["temperature"] == 0 and r["seed"] == mt.SEED and r["max_tokens"] == 96 for r in sent)
    assert all(r["size"] == [1280, 800] for r in sent)
    argv = sent[0]["argv"]
    assert argv[argv.index("--host") + 1] == "127.0.0.1" and "--api-key" in argv and "--jinja" in argv
    assert argv[argv.index("-ngl") + 1] == "0" and argv[argv.index("--threads") + 1] == "4"
    page = (out / "index.html").read_text()
    assert "Median answer" in page and "p90" in page and "Avg" not in page
    assert len(list((out / "images").glob("*.jpg"))) == 4


def test_half_size_screenshots_still_map_onto_the_full_screenshot(bench):
    out = bench["dir"] / "half"
    assert run_llamacpp(bench, out, "--scale", "0.5", "--image-max-tokens", "256", "--no-warmup") == 0
    (run,) = json.loads((out / "results.json").read_text())["runs"]
    r = run["results"][0]
    assert r["effectiveSize"] == [640, 400] and r["imageTokensEst"] == 240 and r["size"] == [1280, 800]
    assert r["box"] == [128, 80, 384, 160]
    assert run["imageMaxTokens"] == 256 and run["scale"] == 0.5
    sent = requests(bench)
    assert len(sent) == 4 and sent[0]["size"] == [640, 400]
    assert sent[0]["argv"][sent[0]["argv"].index("--image-max-tokens") + 1] == "256"


def test_screenshots_of_another_size_are_refused(bench):
    Image.new("RGB", (1440, 900)).save(bench["shots"] / "note.png")
    with pytest.raises(SystemExit, match=r"aren't 1280 x 800: note.png \(1440 x 900\)"):
        run_llamacpp(bench, bench["dir"] / "out")


def test_llama_server_that_dies_is_reported(bench):
    bench["exe"].write_text(f"#!{sys.executable}\nimport sys\nif sys.argv[1:] != ['--version']:\n"
                            "    print('failed to load model'); sys.exit(3)\n")
    with pytest.raises(SystemExit, match="llama-server stopped \\(exit 3\\):\nfailed to load model"):
        run_llamacpp(bench, bench["dir"] / "out")


def test_openai_runtime_against_a_running_server(bench):
    port = mt.free_port()
    env = dict(os.environ, FAKE_LOG=str(bench["log"]))
    proc = subprocess.Popen([str(bench["exe"]), "--port", str(port), "--api-key", "sekrit"], env=env)
    try:
        rt = mt.OpenAIRuntime("remote", f"http://127.0.0.1:{port}", None, 96, api_key="sekrit", server_pid=proc.pid)
        for _ in range(100):
            try:
                rt.ask(Image.new("RGB", (1280, 800)), mt.locate_prompt("the Log in button"))
                break
            except OSError:
                import time
                time.sleep(0.1)
        reply = rt.ask(Image.new("RGB", (1280, 800)), mt.locate_prompt("the Log in button"))
        assert locator.parse_bbox(reply.text, 1280, 800) == [128, 80, 384, 160]
        assert rt.memory()["processPeakRssGb"] >= 0.04
    finally:
        proc.kill()
        proc.wait()


# ---------------------------------------------------------------- compare.py

def write_results(path, key, outcomes, secs, runtime="mlx"):
    results = []
    for (desc, hard, box, hit_), s in zip(outcomes, secs):
        results.append({"file": "a.png", "desc": desc, "hard": hard, "box": box, "hit": hit_, "secs": s, "raw": "r"})
    doc = {"resultsVersion": 2, "set": "1280x800", "machine": {"cpu": "Test CPU", "os": "Linux"},
           "runs": [{"key": key, "runtime": runtime, "results": results, "summary": mt.summarise(results)}]}
    path.write_text(json.dumps(doc))
    return path


BOX = [1, 1, 2, 2]


def test_compare_shows_accuracy_speed_and_every_disagreement(tmp_path, capsys):
    cases = [("the Save button", False), ("the second tag", True), ("the search box", False), ("the Done button", False)]
    a = write_results(tmp_path / "a.json", "4b", [(d, h, BOX, True) for d, h in cases], [1, 1, 1, 1])
    b = write_results(tmp_path / "b.json", "gguf-4b", [(cases[0][0], False, BOX, True), (cases[1][0], True, None, None),
                                                     (cases[2][0], False, BOX, False), (cases[3][0], False, BOX, True)],
                      [10, 12, 14, 30], runtime="llamacpp")
    assert compare.main([str(a), str(b)]) == 1                  # 50 points down: not within 5
    out = capsys.readouterr().out
    assert "correct" in out and "100.0 %" in out and "66.7 %" in out and "-33.3 points" in out
    assert "median answer" in out and "13.00x the time" in out
    assert "2 cases where they disagree" in out
    assert "the second tag (hard)" in out and "A hit" in out and "B no box" in out
    assert "the search box" in out and "B miss" in out
    assert "B within 5 points of A (overall and hard cases): no" in out


def test_compare_within_the_points(tmp_path, capsys):
    a = write_results(tmp_path / "a.json", "4b", [("x", False, BOX, True), ("y", True, BOX, True)], [1, 2])
    b = write_results(tmp_path / "b.json", "cpu", [("x", False, BOX, True), ("y", True, BOX, True)], [4, 8])
    assert compare.main([f"{a}:4b", str(b), "--json"]) == 0
    out = capsys.readouterr().out
    assert "They agree on every case." in out and '"within": true' in out


def test_compare_reads_the_old_list_of_runs_and_needs_a_key_for_several(tmp_path, capsys):
    old = [{"key": "2b", "results": [{"file": "a.png", "desc": "x", "box": BOX, "hit": True, "secs": 1}]},
           {"key": "4b", "results": [{"file": "a.png", "desc": "x", "box": BOX, "hit": True, "secs": 2}]}]
    (tmp_path / "old.json").write_text(json.dumps(old))
    assert compare.main([str(tmp_path / "old.json"), str(tmp_path / "old.json")]) == 2
    assert "name one as" in capsys.readouterr().err
    assert compare.main([f"{tmp_path / 'old.json'}:2b", f"{tmp_path / 'old.json'}:4b"]) == 0
    assert "2.00x the time" in capsys.readouterr().out
