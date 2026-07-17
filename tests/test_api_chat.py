"""Streaming chat E2E: real Ollama, real SSE, real persistence. The awake
companion is hand-seeded (interview flow has its own tests)."""
import json
import sqlite3
import urllib.error
import urllib.request

import pytest

from conftest import SSEReader
from test_api_ingest import STORY, create_companion


RICH_PROFILE = {
    "pet": {"name": "Kernel", "species": "cat", "breed": "tabby", "color": "gray",
            "markings": "a white patch shaped like a semicolon"},
    "personality": {
        "core_traits": ["deadpan", "loyal", "observant"],
        "quirks": ["slept on the warm laptop", "attended standups"],
    },
    "relationship": {"how_they_met": "the shelter had one cat left and he chose"},
    "stories": ["He once shipped to prod by walking across the keyboard."],
}


def post_json(server, path, body):
    req = urllib.request.Request(
        server.base_url + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def awaken(server, cid):
    con = sqlite3.connect(server.mvp_db_path)
    con.execute(
        "UPDATE companions SET state='awake', profile_json=? WHERE id=?",
        (json.dumps(RICH_PROFILE), cid),
    )
    con.commit()
    con.close()


def sse_post(server, path, body, timeout=180):
    req = urllib.request.Request(
        server.base_url + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    return SSEReader(req, timeout=timeout)


def test_awake_chat_streams_retrieves_and_persists(
    server, upload, artifact_waiter, ollama_up, ollama_embed_up
):
    if not (ollama_up and ollama_embed_up):
        pytest.skip("live chat + embed models required")
    cid = create_companion(server)
    _, body = upload(f"{server.base_url}/api/companions/{cid}/artifacts", [("s.md", STORY.encode())])
    artifact_waiter(server, cid, body["results"][0]["artifact"]["id"])
    awaken(server, cid)

    status, body = post_json(server, "/api/conversations", {"companion_id": cid})
    assert status == 201
    conv = body["conversation"]["id"]

    reader = sse_post(server, "/api/chat", {
        "conversation_id": conv,
        "message": "Kernel, do you remember the standup incident with the spacebar?",
    })
    events = list(reader.events(max_events=2000, until="done"))
    reader.close()

    names = [e for e, _ in events]
    assert names[0] == "meta"
    meta = events[0][1]
    assert meta["mode"] == "chat"
    assert meta["message_id_user"] is not None
    assert any(c["source"] == "story" for c in meta["chunks"]), (
        f"retrieval should surface the standup story, got {meta['chunks']}"
    )
    deltas = [d["text"] for e, d in events if e == "delta"]
    assert len(deltas) >= 2, "response must stream incrementally, not arrive whole"
    reply = "".join(deltas)
    assert len(reply.strip()) > 10
    done = events[-1][1]
    assert done["message_id"] is not None
    assert done["eval_count"] > 0

    con = sqlite3.connect(server.mvp_db_path)
    rows = con.execute(
        "SELECT role, content, meta_json FROM messages ORDER BY id"
    ).fetchall()
    con.close()
    assert [r[0] for r in rows] == ["user", "assistant"]
    assert rows[1][1] == reply
    meta_json = json.loads(rows[1][2])
    assert meta_json["model"]
    assert meta_json["chunk_ids"], "assistant message must record which memories it saw"


def test_interview_begin_speaks_first(server, ollama_up):
    if not ollama_up:
        pytest.skip("live chat model required")
    status, body = post_json(server, "/api/companions", {"name": "Mochi"})
    assert status == 201
    conv = body["interview_conversation_id"]

    reader = sse_post(server, "/api/chat", {"conversation_id": conv, "begin": True})
    events = list(reader.events(max_events=2000, until="done"))
    reader.close()

    meta = events[0][1]
    assert meta["mode"] == "interview"
    assert meta["message_id_user"] is None, "begin turn is synthetic, never persisted"
    reply = "".join(d["text"] for e, d in events if e == "delta")
    assert len(reply.strip()) > 10

    con = sqlite3.connect(server.mvp_db_path)
    rows = con.execute("SELECT role FROM messages").fetchall()
    con.close()
    assert [r[0] for r in rows] == ["assistant"], "only the interviewer's opener is persisted"


def test_chat_validation(server):
    status, body = post_json(server, "/api/chat", {"conversation_id": "nope", "message": "hi"})
    assert (status, body["error"]) == (404, "conversation_not_found")

    cid = create_companion(server)
    _, got = post_json(server, "/api/companions", {})
    status, body = post_json(server, "/api/conversations", {"companion_id": cid})
    assert (status, body["error"]) == (409, "not_awake")

    status, body = post_json(server, "/api/conversations", {"companion_id": "ghost"})
    assert (status, body["error"]) == (404, "companion_not_found")

    # interview conversation exists from creation; empty message is rejected
    _, info = urllib_get(server, f"/api/companions/{cid}")
    conv = info["interview_conversation_id"]
    status, body = post_json(server, "/api/chat", {"conversation_id": conv, "message": "   "})
    assert (status, body["error"]) == (400, "missing_message")


def urllib_get(server, path):
    with urllib.request.urlopen(server.base_url + path) as r:
        return r.status, json.loads(r.read())


def test_messages_pagination(server, ollama_up):
    if not ollama_up:
        pytest.skip("live chat model required")
    cid = create_companion(server)
    awaken(server, cid)
    _, body = post_json(server, "/api/conversations", {"companion_id": cid})
    conv = body["conversation"]["id"]

    reader = sse_post(server, "/api/chat", {"conversation_id": conv, "message": "hello there"})
    list(reader.events(max_events=2000, until="done"))
    reader.close()

    _, body = urllib_get(server, f"/api/conversations/{conv}/messages?limit=1")
    assert len(body["messages"]) == 1
    assert body["messages"][0]["role"] == "assistant"
    _, body = urllib_get(server, f"/api/conversations/{conv}/messages")
    assert [m["role"] for m in body["messages"]] == ["user", "assistant"]

    _, body = urllib_get(server, f"/api/companions/{cid}/conversations")
    kinds = sorted(c["kind"] for c in body["conversations"])
    assert kinds == ["chat", "interview"]
