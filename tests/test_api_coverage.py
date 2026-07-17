"""Coverage the audit proved missing: deterministic health 503, the 405
matrix, and the modelless train-success path over real SSE."""
import json
import sqlite3
import urllib.error
import urllib.request

import pytest

from conftest import SSEReader, spawn_server
from test_api_ingest import create_companion


def test_app_health_503_when_ollama_unreachable(tmp_path):
    handle = spawn_server(tmp_path, {"OLLAMA_BASE_URL": "http://127.0.0.1:9"})
    try:
        try:
            urllib.request.urlopen(handle.base_url + "/api/app/health", timeout=10)
            raise AssertionError("expected 503")
        except urllib.error.HTTPError as e:
            assert e.code == 503
            body = json.loads(e.read())
            assert body["ok"] is False
            assert body["ollama"]["models"] == {"chat": False, "vision": False, "embed": False}
    finally:
        handle.stop()


def test_engine_405_matrix(server):
    cid = create_companion(server)
    with urllib.request.urlopen(f"{server.base_url}/api/companions/{cid}") as r:
        conv = json.loads(r.read())["interview_conversation_id"]

    cases = [
        ("PUT", "/api/companions", "GET, POST"),
        ("DELETE", "/api/app/health", "GET"),
        ("GET", "/api/chat", "POST"),
        ("GET", "/api/conversations", "POST"),
        ("POST", f"/api/conversations/{conv}/messages", "GET"),
        ("PUT", f"/api/companions/{cid}/artifacts", "GET, POST"),
        ("GET", f"/api/companions/{cid}/stories", "POST"),
        ("GET", f"/api/companions/{cid}/train", "POST"),
        ("POST", f"/api/companions/{cid}", "GET, DELETE"),
    ]
    for method, path, allow in cases:
        req = urllib.request.Request(server.base_url + path, method=method)
        try:
            urllib.request.urlopen(req)
            raise AssertionError(f"{method} {path}: expected 405")
        except urllib.error.HTTPError as e:
            assert e.code == 405, f"{method} {path}: got {e.code}"
            assert e.headers.get("Allow") == allow, f"{method} {path}: Allow={e.headers.get('Allow')}"
            assert json.loads(e.read())["error"] == "method_not_allowed"


def test_messages_invalid_params_400(server):
    cid = create_companion(server)
    with urllib.request.urlopen(f"{server.base_url}/api/companions/{cid}") as r:
        conv = json.loads(r.read())["interview_conversation_id"]
    for query in ("limit=abc", "limit=0", "limit=2.5", "before=-1", "before=xyz"):
        try:
            urllib.request.urlopen(f"{server.base_url}/api/conversations/{conv}/messages?{query}")
            raise AssertionError(f"{query}: expected 400")
        except urllib.error.HTTPError as e:
            assert e.code == 400, f"{query}: got {e.code}"
            assert json.loads(e.read())["error"] == "invalid_param"


RICH = {
    "pet": {"name": "Kernel", "species": "cat", "breed": "tabby", "color": "gray"},
    "personality": {
        "core_traits": ["deadpan", "loyal", "observant"],
        "quirks": ["laptop sleeper", "standup attender"],
    },
    "relationship": {"how_they_met": "the shelter had one cat left and he chose"},
    "voice_notes": {"how_they_would_speak": "Short, dry sentences. Secretly warm underneath, though he would deny it."},
    "stories": [
        "He walked across the keyboard during standup and typed fourteen pages of the letter j before anyone stopped him.",
        "He fell asleep inside a shipping box marked fragile and lived there for a week of quiet judgment.",
        "He learned to open the treat drawer with one paw and denied everything to investigators.",
    ],
}


def test_train_success_over_http_sse_modelless(server, ollama_embed_up):
    """Consensus skips the chat model when nothing is both needed and
    evidenced — so the full train SSE path runs with only the embedder."""
    if not ollama_embed_up:
        pytest.skip("embed model required")
    cid = create_companion(server, name="Kernel")
    con = sqlite3.connect(server.mvp_db_path)
    con.execute("UPDATE companions SET profile_json=? WHERE id=?", (json.dumps(RICH), cid))
    con.commit()
    con.close()

    req = urllib.request.Request(
        f"{server.base_url}/api/companions/{cid}/train", method="POST"
    )
    reader = SSEReader(req, timeout=300)
    events = list(reader.events(max_events=200, until="done"))
    reader.close()

    names = [e for e, _ in events]
    assert "step" in names
    steps = [d["name"] for e, d in events if e == "step"]
    assert steps == ["consensus", "chunks", "embedding", "compile"]
    done = events[-1][1]
    assert done["state"] == "awake"
    assert done["chunks_total"] >= 4
    assert done["chunks_embedded"] == done["chunks_total"]

    with urllib.request.urlopen(f"{server.base_url}/api/companions/{cid}") as r:
        body = json.loads(r.read())
    assert body["companion"]["state"] == "awake"

    con = sqlite3.connect(server.mvp_db_path)
    persona = con.execute("SELECT persona_prompt FROM companions").fetchone()[0]
    unembedded = con.execute("SELECT COUNT(*) FROM chunks WHERE embedding IS NULL").fetchone()[0]
    con.close()
    assert "You are Kernel" in persona
    assert unembedded == 0
