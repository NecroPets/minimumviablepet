"""Memories drawer aggregation, artifact file serving, and per-item deletion.
Real server, real SQLite, real files on disk — model-dependent ingestion
(vision/whisper captions) is bypassed by hand-seeding profile/derived-text
rows directly, exactly like test_api_chat.awaken()."""
import base64
import json
import pathlib
import sqlite3
import urllib.error
import urllib.request

from conftest import build_min_pdf
from test_api_ingest import create_companion

TINY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="
)


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


def seed_memories(server, upload, artifact_waiter, cid):
    """Real uploads + real files on disk; profile/derived-text/fact rows are
    hand-seeded directly (like awaken()) so the test never depends on a live
    vision/whisper model — only the terminal wait avoids racing the ingest
    queue's own real attempt at processing these files."""
    _, body = upload(f"{server.base_url}/api/companions/{cid}/artifacts", [("captioned.png", TINY_PNG)])
    photo = body["results"][0]["artifact"]
    artifact_waiter(server, cid, photo["id"])

    _, body = upload(
        f"{server.base_url}/api/companions/{cid}/artifacts", [("uncaptioned.png", TINY_PNG + b"\x00")]
    )
    uncaptioned = body["results"][0]["artifact"]
    artifact_waiter(server, cid, uncaptioned["id"])

    pdf_bytes = build_min_pdf(["Patient: Kernel", "Species: Feline"])
    _, body = upload(f"{server.base_url}/api/companions/{cid}/artifacts", [("vet.pdf", pdf_bytes)])
    vet = body["results"][0]["artifact"]
    artifact_waiter(server, cid, vet["id"])

    fact_id = "fact-" + cid[:8]
    profile = {
        "pet": {"name": "Kernel"},
        "stories": ["He once shipped to prod by walking across the keyboard."],
        "photos_analyzed": [
            {
                "file": "captioned.png",
                "hash8": photo["hash"][:8],
                "captured_at": None,
                "summary": "A gray cat sitting proudly on a desk.",
                "physical": ["gray"],
            }
        ],
    }
    con = sqlite3.connect(server.mvp_db_path)
    con.execute("UPDATE companions SET profile_json=? WHERE id=?", (json.dumps(profile), cid))
    con.execute(
        "INSERT INTO facts (id, companion_id, text, category, confidence) VALUES (?,?,?,?,?)",
        (fact_id, cid, "He hated the vacuum with a fiery passion", "preference", 0.9),
    )
    con.execute(
        "INSERT INTO chunks (companion_id, source, source_key, seq, text, hash) VALUES (?, 'fact', ?, 0, ?, ?)",
        (cid, f"fact:{fact_id}", "He hated the vacuum with a fiery passion", "chunkhash1"),
    )
    con.execute(
        "UPDATE artifacts SET derived_text=?, status='processed' WHERE id=?",
        ("Patient: Kernel. Species: Feline. Conditions: none noted.", vet["id"]),
    )
    con.commit()
    con.close()
    return {"photo": photo, "uncaptioned": uncaptioned, "vet": vet, "fact_id": fact_id}


def test_memories_payload(server, upload, artifact_waiter):
    cid = create_companion(server)
    seeded = seed_memories(server, upload, artifact_waiter, cid)

    status, body = api(server, "GET", f"/api/companions/{cid}/memories")
    assert status == 200
    memories = body["memories"]

    assert any(f["id"] == seeded["fact_id"] for f in memories["facts"])
    assert any("keyboard" in s for s in memories["stories"])

    photos = {p["id"]: p for p in memories["photos"]}
    assert photos[seeded["photo"]["id"]]["caption"] == "A gray cat sitting proudly on a desk."
    assert photos[seeded["uncaptioned"]["id"]]["caption"] is None

    transcripts = {t["id"]: t for t in memories["transcripts"]}
    vet_transcript = transcripts[seeded["vet"]["id"]]
    assert "Patient: Kernel" in vet_transcript["text"]
    assert vet_transcript["kind"] == "pdf"
    assert vet_transcript["filename"] == "vet.pdf"

    ids_in_timeline = {a["id"] for a in memories["timeline"]["artifacts"]}
    assert seeded["photo"]["id"] in ids_in_timeline
    assert seeded["uncaptioned"]["id"] in ids_in_timeline
    assert seeded["vet"]["id"] in ids_in_timeline


def test_artifact_file_route_serves_real_bytes(server, upload, artifact_waiter):
    cid = create_companion(server)
    _, body = upload(f"{server.base_url}/api/companions/{cid}/artifacts", [("cat.png", TINY_PNG)])
    art = body["results"][0]["artifact"]
    artifact_waiter(server, cid, art["id"])

    with urllib.request.urlopen(f"{server.base_url}/api/companions/{cid}/artifacts/{art['id']}/file") as r:
        assert r.status == 200
        assert r.headers.get("Content-Type") == "image/png"
        assert r.read() == TINY_PNG


def test_artifact_file_route_404_for_missing_artifact(server):
    cid = create_companion(server)
    try:
        urllib.request.urlopen(f"{server.base_url}/api/companions/{cid}/artifacts/nope/file")
        raise AssertionError("expected 404")
    except urllib.error.HTTPError as e:
        assert e.code == 404
        assert json.loads(e.read())["error"] == "artifact_not_found"


def test_artifact_file_route_404_when_disk_file_vanished(server, upload, artifact_waiter):
    """Row exists but the stored file is gone from disk — the honest answer is
    a loud file_missing, not a 500 or an empty 200."""
    cid = create_companion(server)
    _, body = upload(f"{server.base_url}/api/companions/{cid}/artifacts", [("cat.png", TINY_PNG)])
    art = body["results"][0]["artifact"]
    artifact_waiter(server, cid, art["id"])

    con = sqlite3.connect(server.mvp_db_path)
    stored_path = con.execute("SELECT stored_path FROM artifacts WHERE id=?", (art["id"],)).fetchone()[0]
    con.close()
    pathlib.Path(stored_path).unlink()

    try:
        urllib.request.urlopen(f"{server.base_url}/api/companions/{cid}/artifacts/{art['id']}/file")
        raise AssertionError("expected 404")
    except urllib.error.HTTPError as e:
        assert e.code == 404
        assert json.loads(e.read())["error"] == "file_missing"


def test_artifact_delete_succeeds_when_disk_file_already_gone(server, upload, artifact_waiter):
    """Forget must still work if the stored file vanished out from under us —
    the DB row and chunks go, loudly logged, never a crash."""
    cid = create_companion(server)
    _, body = upload(f"{server.base_url}/api/companions/{cid}/artifacts", [("cat.png", TINY_PNG)])
    art = body["results"][0]["artifact"]
    artifact_waiter(server, cid, art["id"])

    con = sqlite3.connect(server.mvp_db_path)
    stored_path = con.execute("SELECT stored_path FROM artifacts WHERE id=?", (art["id"],)).fetchone()[0]
    con.close()
    pathlib.Path(stored_path).unlink()

    status, body = api(server, "DELETE", f"/api/companions/{cid}/artifacts/{art['id']}")
    assert status == 200
    assert body["ok"] is True

    con = sqlite3.connect(server.mvp_db_path)
    assert con.execute("SELECT COUNT(*) FROM artifacts WHERE id=?", (art["id"],)).fetchone()[0] == 0
    assert con.execute("SELECT COUNT(*) FROM chunks WHERE artifact_id=?", (art["id"],)).fetchone()[0] == 0
    con.close()


def test_artifact_file_route_404_for_mismatched_companion(server, upload, artifact_waiter):
    cid1 = create_companion(server, name="Kernel")
    cid2 = create_companion(server, name="Nova")
    _, body = upload(f"{server.base_url}/api/companions/{cid1}/artifacts", [("cat.png", TINY_PNG)])
    art = body["results"][0]["artifact"]
    artifact_waiter(server, cid1, art["id"])

    try:
        urllib.request.urlopen(f"{server.base_url}/api/companions/{cid2}/artifacts/{art['id']}/file")
        raise AssertionError("expected 404")
    except urllib.error.HTTPError as e:
        assert e.code == 404
        assert json.loads(e.read())["error"] == "artifact_not_found"


def test_artifact_delete_removes_row_chunks_file_and_profile_entry(server, upload, artifact_waiter):
    cid = create_companion(server)
    _, body = upload(f"{server.base_url}/api/companions/{cid}/artifacts", [("cat.png", TINY_PNG)])
    art = body["results"][0]["artifact"]
    artifact_waiter(server, cid, art["id"])

    con = sqlite3.connect(server.mvp_db_path)
    stored_path = con.execute("SELECT stored_path FROM artifacts WHERE id=?", (art["id"],)).fetchone()[0]
    profile = {
        "photos_analyzed": [
            {"file": "cat.png", "hash8": art["hash"][:8], "captured_at": None, "summary": "cap", "physical": ["gray"]}
        ]
    }
    con.execute("UPDATE companions SET profile_json=? WHERE id=?", (json.dumps(profile), cid))
    con.execute(
        "INSERT INTO chunks (companion_id, source, source_key, artifact_id, text, hash) "
        "VALUES (?, 'photo', ?, ?, 'a caption', 'hh')",
        (cid, f"artifact:{art['id']}", art["id"]),
    )
    con.commit()
    con.close()
    assert pathlib.Path(stored_path).exists()

    status, body = api(server, "DELETE", f"/api/companions/{cid}/artifacts/{art['id']}")
    assert status == 200
    assert body["ok"] is True

    con = sqlite3.connect(server.mvp_db_path)
    assert con.execute("SELECT COUNT(*) FROM artifacts WHERE id=?", (art["id"],)).fetchone()[0] == 0
    assert con.execute("SELECT COUNT(*) FROM chunks WHERE artifact_id=?", (art["id"],)).fetchone()[0] == 0
    profile_json = json.loads(con.execute("SELECT profile_json FROM companions WHERE id=?", (cid,)).fetchone()[0])
    con.close()
    assert profile_json["photos_analyzed"] == []
    assert not pathlib.Path(stored_path).exists()


def test_artifact_delete_404_for_nonexistent(server):
    cid = create_companion(server)
    status, body = api(server, "DELETE", f"/api/companions/{cid}/artifacts/nope")
    assert status == 404
    assert body["error"] == "artifact_not_found"


def test_artifact_delete_404_when_companion_mismatched(server, upload, artifact_waiter):
    cid1 = create_companion(server, name="Kernel")
    cid2 = create_companion(server, name="Nova")
    _, body = upload(f"{server.base_url}/api/companions/{cid1}/artifacts", [("cat.png", TINY_PNG)])
    art = body["results"][0]["artifact"]
    artifact_waiter(server, cid1, art["id"])

    status, _ = api(server, "DELETE", f"/api/companions/{cid2}/artifacts/{art['id']}")
    assert status == 404
    con = sqlite3.connect(server.mvp_db_path)
    assert con.execute("SELECT COUNT(*) FROM artifacts WHERE id=?", (art["id"],)).fetchone()[0] == 1
    con.close()


def seed_text_artifact(server, cid, art_id, raw_text, hash_):
    """A processed text artifact row + its verbatim story in profile.stories,
    exactly the state processText leaves behind (hand-seeded so the test never
    depends on a live embed model)."""
    collapsed = " ".join(raw_text.split())
    con = sqlite3.connect(server.mvp_db_path)
    con.execute(
        """INSERT INTO artifacts (id, companion_id, kind, original_name, stored_path, mime, bytes, hash, status, derived_text)
           VALUES (?, ?, 'text', ?, ?, 'text/plain', ?, ?, 'processed', ?)""",
        (art_id, cid, f"{art_id}.txt", f"/nowhere/{art_id}.txt", len(raw_text), hash_, raw_text),
    )
    profile_row = con.execute("SELECT profile_json FROM companions WHERE id=?", (cid,)).fetchone()[0]
    profile = json.loads(profile_row)
    profile.setdefault("stories", [])
    if collapsed not in profile["stories"]:
        profile["stories"].append(collapsed)
    con.execute("UPDATE companions SET profile_json=? WHERE id=?", (json.dumps(profile), cid))
    con.commit()
    con.close()
    return collapsed


def test_text_artifact_delete_also_forgets_its_story(server):
    """'Forget this for good' must mean the story too — not just the file and
    chunks, or it resurfaces in the drawer, exports, and the next train."""
    cid = create_companion(server)
    story = seed_text_artifact(server, cid, "txtart1", "He stole  a whole\nrotisserie chicken once.", "texthash1")

    _, body = api(server, "GET", f"/api/companions/{cid}/memories")
    assert story in body["memories"]["stories"]

    status, _ = api(server, "DELETE", f"/api/companions/{cid}/artifacts/txtart1")
    assert status == 200

    _, body = api(server, "GET", f"/api/companions/{cid}/memories")
    assert story not in body["memories"]["stories"]
    con = sqlite3.connect(server.mvp_db_path)
    profile = json.loads(con.execute("SELECT profile_json FROM companions WHERE id=?", (cid,)).fetchone()[0])
    con.close()
    assert story not in profile.get("stories", [])


def test_text_artifact_delete_keeps_story_when_a_twin_survives(server):
    """Two uploads carrying the identical text: forgetting one artifact must
    not forget the story the surviving one still vouches for."""
    cid = create_companion(server)
    story = seed_text_artifact(server, cid, "twina", "Same exact memory, kept twice.", "twinhash-a")
    seed_text_artifact(server, cid, "twinb", "Same exact memory, kept twice.", "twinhash-b")

    status, _ = api(server, "DELETE", f"/api/companions/{cid}/artifacts/twina")
    assert status == 200

    _, body = api(server, "GET", f"/api/companions/{cid}/memories")
    assert story in body["memories"]["stories"]


def test_fact_delete_removes_fact_and_paired_chunk(server):
    cid = create_companion(server)
    fact_id = "fdel1"
    con = sqlite3.connect(server.mvp_db_path)
    con.execute(
        "INSERT INTO facts (id, companion_id, text, category, confidence) VALUES (?,?,?,?,?)",
        (fact_id, cid, "loved rain", "preference", 0.8),
    )
    con.execute(
        "INSERT INTO chunks (companion_id, source, source_key, seq, text, hash) VALUES (?, 'fact', ?, 0, ?, ?)",
        (cid, f"fact:{fact_id}", "loved rain", "hx"),
    )
    con.commit()
    con.close()

    status, body = api(server, "DELETE", f"/api/companions/{cid}/facts/{fact_id}")
    assert status == 200
    assert body["ok"] is True

    con = sqlite3.connect(server.mvp_db_path)
    assert con.execute("SELECT COUNT(*) FROM facts WHERE id=?", (fact_id,)).fetchone()[0] == 0
    assert con.execute("SELECT COUNT(*) FROM chunks WHERE source_key=?", (f"fact:{fact_id}",)).fetchone()[0] == 0
    con.close()


def test_fact_delete_404_for_nonexistent(server):
    cid = create_companion(server)
    status, body = api(server, "DELETE", f"/api/companions/{cid}/facts/nope")
    assert status == 404
    assert body["error"] == "fact_not_found"
