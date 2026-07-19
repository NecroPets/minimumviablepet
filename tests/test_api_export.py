"""Portable export: MEMORIES.md + artifacts/ + data.json, zipped with the
system zip binary. Real server, real SQLite, real files on disk. Scoping is
proved by seeding a second companion and asserting its data never appears."""
import json
import pathlib
import sqlite3
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from shutil import which

from test_api_ingest import create_companion

STORY_TEXT = "He once shipped to prod by walking across the keyboard during standup."
FACT_TEXT = "He hated the vacuum with a fiery passion"
SECRET_TEXT = "not kernel's — nova's own note"


def api(server, method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        server.base_url + path,
        data=data,
        headers={"Content-Type": "application/json"} if data else {},
        method=method,
    )
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def test_export_bundle_contents(server, upload, artifact_waiter, tmp_path):
    cid = create_companion(server, name="Kernel")
    other_cid = create_companion(server, name="Nova")

    _, body = upload(f"{server.base_url}/api/companions/{cid}/artifacts", [("note.txt", b"a real uploaded note")])
    art = body["results"][0]["artifact"]
    artifact_waiter(server, cid, art["id"])

    # a second companion's own real artifact, to prove strict companion_id scoping
    _, other_body = upload(
        f"{server.base_url}/api/companions/{other_cid}/artifacts", [("secret.txt", SECRET_TEXT.encode())]
    )
    other_art = other_body["results"][0]["artifact"]
    artifact_waiter(server, other_cid, other_art["id"])

    con = sqlite3.connect(server.mvp_db_path)
    con.execute(
        "UPDATE companions SET profile_json=? WHERE id=?",
        (json.dumps({"pet": {"name": "Kernel", "species": "cat"}, "stories": [STORY_TEXT]}), cid),
    )
    con.execute(
        "INSERT INTO facts (id, companion_id, text, category, confidence) VALUES ('fact1', ?, ?, 'preference', 0.9)",
        (cid, FACT_TEXT),
    )
    con.execute(
        "INSERT INTO facts (id, companion_id, text, category, confidence) VALUES ('fact2', ?, ?, 'preference', 0.9)",
        (other_cid, SECRET_TEXT),
    )
    con.commit()
    con.close()

    req = urllib.request.Request(f"{server.base_url}/api/companions/{cid}/export")

    if which("zip") is None:
        try:
            urllib.request.urlopen(req)
            raise AssertionError("expected a loud error when zip is missing")
        except urllib.error.HTTPError as e:
            assert e.code == 500
            msg = json.loads(e.read())["error"].lower()
            assert "zip" in msg and "install" in msg
        return

    with urllib.request.urlopen(req) as r:
        assert r.status == 200
        assert r.headers.get("Content-Type") == "application/zip"
        disposition = r.headers.get("Content-Disposition") or ""
        assert "attachment" in disposition
        assert "Kernel-memories.zip" in disposition
        zip_bytes = r.read()

    zip_path = tmp_path / "export.zip"
    zip_path.write_bytes(zip_bytes)
    extract_dir = tmp_path / "extracted"
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(extract_dir)

    memories_md = (extract_dir / "MEMORIES.md").read_text()
    assert "# Kernel" in memories_md
    assert STORY_TEXT in memories_md
    assert FACT_TEXT in memories_md
    assert SECRET_TEXT not in memories_md

    note_path = extract_dir / "artifacts" / "note.txt"
    assert note_path.exists()
    assert note_path.read_bytes() == b"a real uploaded note"
    assert not (extract_dir / "artifacts" / "secret.txt").exists()

    data = json.loads((extract_dir / "data.json").read_text())
    assert data["companion"]["id"] == cid
    assert data["companion"]["name"] == "Kernel"
    assert [a["id"] for a in data["artifacts"]] == [art["id"]]
    assert all(f["companion_id"] == cid for f in data["facts"])
    assert [f["text"] for f in data["facts"]] == [FACT_TEXT]
    raw = json.dumps(data)
    assert SECRET_TEXT not in raw
    assert other_cid not in raw


def test_export_cleans_up_its_temp_dir_after_download(server, tmp_path):
    """The server builds each export in a tmpdir and must remove it once the
    stream completes — a leak here grows with every backup ever taken."""
    cid = create_companion(server, name="Tidy")
    tmp_root = pathlib.Path(tempfile.gettempdir())
    before = {p.name for p in tmp_root.glob("mvp-export-*")}

    with urllib.request.urlopen(f"{server.base_url}/api/companions/{cid}/export") as r:
        assert r.status == 200
        assert r.read()[:2] == b"PK"

    # created-during-this-request dirs must disappear; generous poll because
    # cleanup runs on the server's stream-close callback
    deadline = time.time() + 10
    while time.time() < deadline:
        leaked = {p.name for p in tmp_root.glob("mvp-export-*")} - before
        if not leaked:
            break
        time.sleep(0.2)
    assert leaked == set(), f"export temp dirs never cleaned up: {leaked}"


def test_export_cleans_up_when_client_aborts_mid_download(server, upload, artifact_waiter):
    """The other half of the cleanup contract: a client that disconnects
    partway through the zip must still leave no temp dir behind (the
    stream's cancel path)."""
    import http.client
    import os
    import random

    cid = create_companion(server, name="Abort")
    # 8 MB of incompressible bytes behind a PNG magic → a zip big enough
    # that closing after 64 KB is a genuine mid-stream abort
    blob = b"\x89PNG\r\n\x1a\n" + random.randbytes(8 * 1024 * 1024)
    _, body = upload(f"{server.base_url}/api/companions/{cid}/artifacts", [("big.png", blob)], timeout=120)
    artifact_waiter(server, cid, body["results"][0]["artifact"]["id"], timeout=120)

    tmp_root = pathlib.Path(tempfile.gettempdir())
    before = {p.name for p in tmp_root.glob("mvp-export-*")}

    conn = http.client.HTTPConnection("127.0.0.1", server.port, timeout=30)
    conn.request("GET", f"/api/companions/{cid}/export")
    resp = conn.getresponse()
    assert resp.status == 200
    first = resp.read(65536)
    assert first[:2] == b"PK"
    # the zip contains 8 MB of incompressible bytes, so 64 KB read is
    # mid-stream by construction (Bun streams chunked — no Content-Length)
    conn.close()  # abort with most of the body unread

    deadline = time.time() + 15
    while time.time() < deadline:
        leaked = {p.name for p in tmp_root.glob("mvp-export-*")} - before
        if not leaked:
            break
        time.sleep(0.3)
    assert leaked == set(), f"aborted export leaked temp dirs: {leaked}"


def test_export_404_for_unknown_companion(server):
    status, body = api(server, "GET", "/api/companions/nope/export")
    assert status == 404
    assert body["error"] == "companion_not_found"
