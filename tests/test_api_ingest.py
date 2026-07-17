"""Ingest surface: upload contract, idempotency/retry, the text processor
end-to-end (real chunks, real embeddings, real FTS), SSE ordering, and boot
recovery. Real server, real SQLite, real Ollama where gated."""
import json
import sqlite3
import urllib.error
import urllib.request

import pytest

from conftest import multipart_post, spawn_server, wait_artifact


def create_companion(server, name="Kernel"):
    req = urllib.request.Request(
        server.base_url + "/api/companions",
        data=json.dumps({"name": name}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())["companion"]["id"]


STORY = (
    "# The Standup Incident\n\n"
    "Kernel walked across the keyboard during the Monday standup and typed "
    "fourteen pages of the letter j. Nobody stopped him. He then sat on the "
    "spacebar until the meeting ended, which everyone agreed was the correct "
    "outcome. He purred the entire time, loud enough to be picked up by the "
    "microphone, and three coworkers asked if he was available for hire."
)


class TestUploadContract:
    def test_unsupported_type(self, server, upload):
        cid = create_companion(server)
        status, body = upload(
            f"{server.base_url}/api/companions/{cid}/artifacts", [("virus.exe", b"MZ\x90\x00")]
        )
        assert status == 400
        assert body["results"][0] == {"ok": False, "file": "virus.exe", "error": "unsupported_type"}

    def test_magic_mismatch(self, server, upload):
        cid = create_companion(server)
        status, body = upload(
            f"{server.base_url}/api/companions/{cid}/artifacts", [("photo.jpg", b"not a jpeg at all")]
        )
        assert status == 400
        assert body["results"][0]["error"] == "magic_mismatch"

    def test_invalid_utf8_text(self, server, upload):
        cid = create_companion(server)
        status, body = upload(
            f"{server.base_url}/api/companions/{cid}/artifacts", [("story.txt", b"\xff\xfe\xba\xad")]
        )
        assert status == 400
        assert body["results"][0]["error"] == "invalid_utf8"

    def test_empty_file(self, server, upload):
        cid = create_companion(server)
        status, body = upload(f"{server.base_url}/api/companions/{cid}/artifacts", [("story.txt", b"")])
        assert status == 400
        assert body["results"][0]["error"] == "empty_file"

    def test_per_file_cap(self, server, upload):
        cid = create_companion(server)
        big = b"a" * (1024 * 1024 + 1)  # text cap is 1MB
        status, body = upload(f"{server.base_url}/api/companions/{cid}/artifacts", [("big.txt", big)])
        assert status == 400
        assert body["results"][0]["error"] == "file_too_large"
        assert body["results"][0]["limit_mb"] == 1

    def test_too_many_files(self, server, upload):
        cid = create_companion(server)
        files = [(f"s{i}.txt", b"x" * 50) for i in range(51)]
        status, body = upload(f"{server.base_url}/api/companions/{cid}/artifacts", files)
        assert status == 400
        assert body["error"] == "too_many_files"

    def test_not_multipart(self, server):
        cid = create_companion(server)
        req = urllib.request.Request(
            f"{server.base_url}/api/companions/{cid}/artifacts",
            data=b"just bytes",
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            urllib.request.urlopen(req)
            raise AssertionError("expected 400")
        except urllib.error.HTTPError as e:
            assert e.code == 400
            assert json.loads(e.read())["error"] == "invalid_multipart"

    def test_request_level_413(self, tmp_path):
        handle = spawn_server(tmp_path, {"MVP_MAX_UPLOAD_MB": "1"})
        try:
            cid = create_companion(handle)
            status, body = multipart_post(
                f"{handle.base_url}/api/companions/{cid}/artifacts",
                [("big.txt", b"a" * (2 * 1024 * 1024))],
            )
            assert status == 413
            assert body["error"] == "payload_too_large"
        finally:
            handle.stop()

    def test_mixed_batch_partial_accept(self, server, upload):
        cid = create_companion(server)
        status, body = upload(
            f"{server.base_url}/api/companions/{cid}/artifacts",
            [("good.txt", STORY.encode()), ("bad.exe", b"MZ")],
        )
        assert status == 201
        oks = [r["ok"] for r in body["results"]]
        assert oks == [True, False]


class TestIdempotency:
    def test_same_bytes_twice_is_one_artifact(self, server, upload):
        cid = create_companion(server)
        url = f"{server.base_url}/api/companions/{cid}/artifacts"
        s1, b1 = upload(url, [("story.md", STORY.encode())])
        assert s1 == 201 and b1["results"][0]["duplicate"] is False
        s2, b2 = upload(url, [("story.md", STORY.encode())])
        assert s2 == 201 and b2["results"][0]["duplicate"] is True

        con = sqlite3.connect(server.mvp_db_path)
        assert con.execute("SELECT COUNT(*) FROM artifacts").fetchone()[0] == 1
        con.close()

    def test_reupload_of_failed_artifact_retries(self, server, upload, artifact_waiter, ollama_embed_up):
        if not ollama_embed_up:
            pytest.skip("ollama embed model unavailable")
        cid = create_companion(server)
        url = f"{server.base_url}/api/companions/{cid}/artifacts"
        _, body = upload(url, [("story.md", STORY.encode())])
        aid = body["results"][0]["artifact"]["id"]
        artifact_waiter(server, cid, aid)

        # force-fail it directly in the DB, then re-upload the same bytes
        con = sqlite3.connect(server.mvp_db_path)
        con.execute("UPDATE artifacts SET status='failed', error='forced by test' WHERE id=?", (aid,))
        con.commit()
        con.close()

        _, body = upload(url, [("story.md", STORY.encode())])
        r = body["results"][0]
        assert r["duplicate"] is True and r.get("retried") is True
        final = artifact_waiter(server, cid, aid)
        assert final["status"] == "processed"
        assert final["error"] is None


class TestTextProcessor:
    def test_story_end_to_end(self, server, upload, artifact_waiter, ollama_embed_up):
        if not ollama_embed_up:
            pytest.skip("ollama embed model unavailable")
        cid = create_companion(server)
        _, body = upload(
            f"{server.base_url}/api/companions/{cid}/artifacts", [("standup.md", STORY.encode())]
        )
        aid = body["results"][0]["artifact"]["id"]
        final = artifact_waiter(server, cid, aid)
        assert final["status"] == "processed", final

        con = sqlite3.connect(server.mvp_db_path)
        chunks = con.execute(
            "SELECT source, text, embedding, model, meta_json FROM chunks WHERE artifact_id=?", (aid,)
        ).fetchall()
        assert len(chunks) >= 1
        for source, text, embedding, model, meta_json in chunks:
            assert source == "story"
            assert "Kernel" in text or "keyboard" in text
            assert embedding is not None and len(embedding) == 4096  # 1024 x f32
            assert model  # embed model recorded
            assert json.loads(meta_json)["title"] == "The Standup Incident"
        fts = con.execute(
            "SELECT COUNT(*) FROM chunks_fts WHERE chunks_fts MATCH '\"spacebar\"'"
        ).fetchone()[0]
        assert fts >= 1
        derived = con.execute("SELECT derived_text FROM artifacts WHERE id=?", (aid,)).fetchone()[0]
        assert "fourteen pages" in derived
        con.close()

        # short story also lands verbatim in profile.stories
        with urllib.request.urlopen(f"{server.base_url}/api/companions/{cid}/profile") as r:
            profile = json.loads(r.read())["profile"]
        assert any("fourteen pages" in s for s in profile["stories"])

    def test_stories_endpoint(self, server, artifact_waiter, ollama_embed_up):
        if not ollama_embed_up:
            pytest.skip("ollama embed model unavailable")
        cid = create_companion(server)
        req = urllib.request.Request(
            f"{server.base_url}/api/companions/{cid}/stories",
            data=json.dumps({"text": STORY.split("\n\n")[1], "title": "Standup"}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req) as r:
            assert r.status == 201
            body = json.loads(r.read())
        art = body["result"]["artifact"]
        assert art["kind"] == "text"
        assert art["original_name"] == "Standup.txt"
        final = artifact_waiter(server, cid, art["id"])
        assert final["status"] == "processed"

    def test_story_validation(self, server):
        cid = create_companion(server)
        for payload, expected in [({"title": "x"}, "missing_text"), ({"text": "a" * 70000}, "story_too_long")]:
            req = urllib.request.Request(
                f"{server.base_url}/api/companions/{cid}/stories",
                data=json.dumps(payload).encode(),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            try:
                urllib.request.urlopen(req)
                raise AssertionError("expected 400")
            except urllib.error.HTTPError as e:
                assert e.code == 400
                assert json.loads(e.read())["error"] == expected


class TestConcurrency:
    def test_identical_bytes_racing_yield_one_artifact_no_500(self, server, upload):
        """The check-then-insert spans an await; ON CONFLICT + refetch must make
        both racing requests succeed with exactly one row."""
        import threading

        cid = create_companion(server)
        url = f"{server.base_url}/api/companions/{cid}/artifacts"
        payload = ("race.md", ("race payload " * 10).encode())
        results = []

        def go():
            results.append(upload(url, [payload]))

        threads = [threading.Thread(target=go) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert all(status == 201 for status, _ in results), results
        oks = [body["results"][0] for _, body in results]
        assert all(r["ok"] for r in oks)
        assert sum(1 for r in oks if not r["duplicate"]) == 1, "exactly one non-duplicate winner"

        con = sqlite3.connect(server.mvp_db_path)
        n = con.execute("SELECT COUNT(*) FROM artifacts").fetchone()[0]
        con.close()
        assert n == 1


class TestSSE:
    def test_event_ordering(self, server, upload, sse_reader, ollama_embed_up):
        if not ollama_embed_up:
            pytest.skip("ollama embed model unavailable")
        cid = create_companion(server)
        reader = sse_reader(f"{server.base_url}/api/companions/{cid}/ingest/events", timeout=120)
        upload(f"{server.base_url}/api/companions/{cid}/artifacts", [("s.md", STORY.encode())])

        seen = list(reader.events(max_events=30, until="idle"))
        names = [e for e, _ in seen]
        assert names[0] == "snapshot"
        assert "artifact" in names
        assert names[-1] == "idle"
        statuses = [d["status"] for e, d in seen if e == "artifact"]
        assert "processing" in statuses
        assert statuses[-1] == "processed"
        idle = seen[-1][1]
        assert idle["counts"]["processed"] == 1
        assert idle["counts"]["uploaded"] == 0


class TestBootRecovery:
    def test_processing_rows_requeued_and_tmp_swept(self, tmp_path, upload, ollama_embed_up):
        if not ollama_embed_up:
            pytest.skip("ollama embed model unavailable")
        first = spawn_server(tmp_path)
        try:
            cid = create_companion(first)
            _, body = upload(
                f"{first.base_url}/api/companions/{cid}/artifacts", [("s.md", STORY.encode())]
            )
            aid = body["results"][0]["artifact"]["id"]
            wait_artifact(first, cid, aid)
        finally:
            first.stop()

        # simulate a crash mid-processing + leftover scratch space
        con = sqlite3.connect(tmp_path / "mvp" / "mvp.db")
        con.execute("UPDATE artifacts SET status='processing' WHERE id=?", (aid,))
        con.execute("DELETE FROM chunks WHERE artifact_id=?", (aid,))
        con.commit()
        con.close()
        junk = tmp_path / "mvp" / "tmp" / "leftover"
        junk.mkdir(parents=True)
        (junk / "frame.jpg").write_bytes(b"x")

        second = spawn_server(tmp_path)
        try:
            final = wait_artifact(second, cid, aid, timeout=120)
            assert final["status"] == "processed"
            con = sqlite3.connect(tmp_path / "mvp" / "mvp.db")
            n = con.execute("SELECT COUNT(*) FROM chunks WHERE artifact_id=?", (aid,)).fetchone()[0]
            con.close()
            assert n >= 1, "recovered artifact was re-processed"
            assert not junk.exists(), "tmp/ must be swept on boot"
        finally:
            second.stop()
