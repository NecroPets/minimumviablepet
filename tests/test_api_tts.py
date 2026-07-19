"""POST /api/companions/:id/say — local TTS. The happy path runs the real
system binary (macOS `say` / espeak-ng) and inspects the WAV bytes; when
neither binary exists the loud install-hint error is asserted instead.
Either way, the real route code runs."""
import json
import pathlib
import tempfile
import time
import urllib.error
import urllib.request
from shutil import which

from test_api_ingest import create_companion
from test_api_memories import api

HAS_TTS = which("say") or which("espeak-ng")


def say(server, cid, payload):
    req = urllib.request.Request(
        f"{server.base_url}/api/companions/{cid}/say",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    return urllib.request.urlopen(req)


def test_say_returns_playable_wav_or_loud_hint(server):
    cid = create_companion(server)
    try:
        with say(server, cid, {"text": "I remember that. I'll always remember that."}) as r:
            assert HAS_TTS, "synthesis succeeded but no TTS binary was expected"
            assert r.status == 200
            assert r.headers.get("Content-Type") == "audio/wav"
            body = r.read()
            assert body[:4] == b"RIFF" and body[8:12] == b"WAVE"
            assert len(body) > 1000
    except urllib.error.HTTPError as e:
        assert not HAS_TTS, f"TTS binary exists but the route failed: {e.read()!r}"
        assert e.code == 500
        msg = json.loads(e.read())["error"]
        assert "not found" in msg and ("install" in msg or "MVP_TTS_BIN" in msg)


def test_say_cleans_up_its_temp_dir(server):
    if not HAS_TTS:
        return  # the failure path cleans up too, asserted above via the 500
    cid = create_companion(server)
    tmp_root = pathlib.Path(tempfile.gettempdir())
    before = {p.name for p in tmp_root.glob("mvp-say-*")}
    with say(server, cid, {"text": "short"}) as r:
        assert r.read()[:4] == b"RIFF"
    deadline = time.time() + 10
    while time.time() < deadline:
        leaked = {p.name for p in tmp_root.glob("mvp-say-*")} - before
        if not leaked:
            break
        time.sleep(0.2)
    assert leaked == set(), f"say temp dirs never cleaned up: {leaked}"


def test_say_rejects_bad_input_loudly(server):
    cid = create_companion(server)
    status, body = api(server, "POST", f"/api/companions/{cid}/say", {})
    assert (status, body["error"]) == (400, "text_required")
    status, body = api(server, "POST", f"/api/companions/{cid}/say", {"text": "   "})
    assert (status, body["error"]) == (400, "text_required")
    status, body = api(server, "POST", f"/api/companions/{cid}/say", {"text": "x" * 2001})
    assert status == 400
    assert "text_too_long" in body["error"]
    status, body = api(server, "POST", "/api/companions/nope/say", {"text": "hi"})
    assert status == 404


def test_say_wrong_method_405(server):
    cid = create_companion(server)
    status, body = api(server, "GET", f"/api/companions/{cid}/say")
    assert status == 405
