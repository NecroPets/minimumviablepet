"""Media processors end-to-end with real generated files, real whisper, real
vision, real embeddings — gated per dependency, never silently faked."""
import json
import sqlite3
import urllib.request

import pytest

from conftest import spawn_server
from test_api_ingest import create_companion


def upload_file(server, cid, upload, path, name=None):
    data = path.read_bytes()
    status, body = upload(
        f"{server.base_url}/api/companions/{cid}/artifacts", [(name or path.name, data)]
    )
    assert status == 201, body
    return body["results"][0]["artifact"]["id"]


def get_profile(server, cid):
    with urllib.request.urlopen(f"{server.base_url}/api/companions/{cid}/profile") as r:
        return json.loads(r.read())["profile"]


def chunks_for(server, aid):
    con = sqlite3.connect(server.mvp_db_path)
    rows = con.execute(
        "SELECT source, text, embedding, meta_json FROM chunks WHERE artifact_id=?", (aid,)
    ).fetchall()
    con.close()
    return rows


def test_image_no_animal_is_honest(
    server, upload, artifact_waiter, media_fixtures, ollama_vision_up, ollama_embed_up
):
    if not (ollama_vision_up and ollama_embed_up):
        pytest.skip("vision + embed models required")
    cid = create_companion(server)
    aid = upload_file(server, cid, upload, media_fixtures / "square.png")
    final = artifact_waiter(server, cid, aid, timeout=300)
    assert final["status"] == "processed", final
    meta = json.loads(
        sqlite3.connect(server.mvp_db_path)
        .execute("SELECT meta_json FROM artifacts WHERE id=?", (aid,))
        .fetchone()[0]
    )
    assert meta["no_animal"] is True
    assert get_profile(server, cid)["photos_analyzed"] == [], (
        "an animal-free image must not fabricate photo evidence"
    )


def test_audio_speech_transcribed_as_owner_memory(
    server, upload, artifact_waiter, media_fixtures, whisper_up, ollama_embed_up
):
    if not (whisper_up and ollama_embed_up):
        pytest.skip("whisper + embed required")
    cid = create_companion(server)
    aid = upload_file(server, cid, upload, media_fixtures / "speech.wav")
    final = artifact_waiter(server, cid, aid, timeout=600)
    assert final["status"] == "processed", final
    rows = chunks_for(server, aid)
    assert len(rows) >= 1
    source, text, embedding, meta_json = rows[0]
    assert source == "voice_memo"
    assert "laser" in text.lower(), f"transcript should contain the spoken words, got: {text!r}"
    assert embedding is not None
    assert json.loads(meta_json)["perspective"] == "owner"


def test_audio_silent_is_processed_not_failed(
    server, upload, artifact_waiter, media_fixtures, whisper_up, ollama_embed_up
):
    if not (whisper_up and ollama_embed_up):
        pytest.skip("whisper + embed required")
    cid = create_companion(server)
    aid = upload_file(server, cid, upload, media_fixtures / "sine.wav")
    final = artifact_waiter(server, cid, aid, timeout=600)
    assert final["status"] == "processed", final
    assert chunks_for(server, aid) == []
    meta = json.loads(
        sqlite3.connect(server.mvp_db_path)
        .execute("SELECT meta_json FROM artifacts WHERE id=?", (aid,))
        .fetchone()[0]
    )
    assert meta["empty_transcript"] is True


def test_pdf_extracts_chunks_and_facts_without_clobbering(
    server, upload, artifact_waiter, media_fixtures, ollama_up, ollama_embed_up
):
    if not (ollama_up and ollama_embed_up):
        pytest.skip("chat + embed models required")
    cid = create_companion(server, name="Oni")
    # pre-seed an owner-provided field that the vet doc must NOT overwrite
    con = sqlite3.connect(server.mvp_db_path)
    con.execute(
        "UPDATE companions SET profile_json=? WHERE id=?",
        (json.dumps({"pet": {"name": "Oni", "color": "marbled brown"}}), cid),
    )
    con.commit()
    con.close()

    aid = upload_file(server, cid, upload, media_fixtures / "vet.pdf")
    final = artifact_waiter(server, cid, aid, timeout=600)
    assert final["status"] == "processed", final

    # fact extraction degrading to a warning is designed behavior for a
    # flaky model — but for THIS test it means the interesting assertions
    # can't run; fail with the actual reason instead of a bare empty-string
    meta = json.loads(
        sqlite3.connect(server.mvp_db_path)
        .execute("SELECT meta_json FROM artifacts WHERE id=?", (aid,))
        .fetchone()[0]
    )
    assert not any("fact_extraction_failed" in w for w in meta.get("warnings", [])), (
        f"vet fact extraction degraded to a warning (model contention?): {meta['warnings']}"
    )

    rows = chunks_for(server, aid)
    assert len(rows) >= 1
    assert all(r[0] == "vet_record" for r in rows)
    assert any("Bengal" in r[1] for r in rows)
    assert json.loads(rows[0][3])["page"] == 1

    profile = get_profile(server, cid)
    assert profile["pet"]["color"] == "marbled brown", "owner-provided values always win"
    assert "bengal" in profile["pet"]["breed"].lower()
    assert any("allergy" in c.lower() for c in profile["medical"]["conditions"])
    assert profile["medical"]["sources"] == ["vet.pdf"]


def test_video_summary_and_transcript(
    server, upload, artifact_waiter, media_fixtures,
    ollama_up, ollama_vision_up, whisper_up, ollama_embed_up,
):
    if not (ollama_up and ollama_vision_up and whisper_up and ollama_embed_up):
        pytest.skip("chat + vision + whisper + embed required")
    cid = create_companion(server)
    aid = upload_file(server, cid, upload, media_fixtures / "clip.mp4")
    final = artifact_waiter(server, cid, aid, timeout=900)
    assert final["status"] == "processed", final
    rows = chunks_for(server, aid)
    kinds = {json.loads(r[3]).get("kind") for r in rows}
    assert "summary" in kinds
    meta = json.loads(
        sqlite3.connect(server.mvp_db_path)
        .execute("SELECT meta_json FROM artifacts WHERE id=?", (aid,))
        .fetchone()[0]
    )
    assert 1 <= meta["frames_captioned"] <= 12


def test_batch_isolation_corrupt_file_never_stops_the_rest(
    server, upload, artifact_waiter, ollama_embed_up
):
    if not ollama_embed_up:
        pytest.skip("embed required for the good file")
    cid = create_companion(server)
    # valid jpeg magic, garbage body — sniff passes, sips fails, artifact fails
    corrupt = bytes([0xFF, 0xD8, 0xFF, 0xE0]) + b"this is not image data" * 100
    good = (
        "# The Box\n\nHe fell asleep inside a shipping box marked fragile and "
        "lived there for a week, emerging only for meals and judgment."
    ).encode()
    status, body = upload(
        f"{server.base_url}/api/companions/{cid}/artifacts",
        [("broken.jpg", corrupt), ("box.md", good)],
    )
    assert status == 201
    jpg_id = body["results"][0]["artifact"]["id"]
    md_id = body["results"][1]["artifact"]["id"]

    jpg = artifact_waiter(server, cid, jpg_id, timeout=120)
    md = artifact_waiter(server, cid, md_id, timeout=120)
    assert jpg["status"] == "failed"
    assert jpg["error"] and "sips" in jpg["error"]
    assert md["status"] == "processed"


def test_whisper_missing_fails_loudly_with_install_hint(
    tmp_path, upload, media_fixtures, ollama_embed_up
):
    if not ollama_embed_up:
        pytest.skip("embed required (probe gate)")
    handle = spawn_server(tmp_path, {"MVP_WHISPER_BIN": "/nonexistent/whisper-bin"})
    try:
        cid = create_companion(handle)
        aid = upload_file(handle, cid, upload, media_fixtures / "speech.wav")
        from conftest import wait_artifact

        final = wait_artifact(handle, cid, aid, timeout=120)
        assert final["status"] == "failed"
        assert "MVP_WHISPER_BIN" in final["error"]
        assert "uv tool install mlx-whisper" in final["error"]
    finally:
        handle.stop()
