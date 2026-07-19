"""Engine API contract tests: health, companions CRUD, and the MVP_PUBLIC
gate that keeps the product off public deploys. Real server, real SQLite."""
import json
import sqlite3
import urllib.error
import urllib.request


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


def test_engine_health_shape(server):
    status, body = api(server, "GET", "/api/app/health")
    assert status in (200, 503)
    assert body["db"] is True
    assert set(body["ollama"]["models"]) == {"chat", "vision", "embed"}


def test_companion_create_list_get_profile(server):
    status, body = api(server, "POST", "/api/companions", {"name": "Kernel"})
    assert status == 201
    cid = body["companion"]["id"]
    assert body["companion"]["state"] == "interviewing"
    assert body["interview_conversation_id"]
    assert body["progress"]["met"] is False
    # name check passes immediately; everything else is unmet
    checks = {c["key"]: c["met"] for c in body["progress"]["checks"]}
    assert checks["name"] is True
    assert checks["traits"] is False

    status, body = api(server, "GET", "/api/companions")
    assert status == 200
    assert [c["name"] for c in body["companions"]] == ["Kernel"]

    status, body = api(server, "GET", f"/api/companions/{cid}")
    assert status == 200
    assert body["companion"]["name"] == "Kernel"
    assert body["interview_conversation_id"]

    status, body = api(server, "GET", f"/api/companions/{cid}/profile")
    assert status == 200
    assert body["profile"]["pet"]["name"] == ""  # name lives on the row until the interview writes it
    assert body["profile"]["personality"]["core_traits"] == []

    status, body = api(server, "GET", f"/api/companions/{cid}/readiness")
    assert status == 200
    assert body["progress"]["missing"]  # plenty missing on a fresh companion

    # the engine actually created its own DB in the isolated data dir
    assert server.mvp_db_path.exists()
    con = sqlite3.connect(server.mvp_db_path)
    assert con.execute("SELECT COUNT(*) FROM companions").fetchone()[0] == 1
    assert con.execute("SELECT kind FROM conversations").fetchone()[0] == "interview"
    con.close()


def test_companion_nameless_create_allowed(server):
    status, body = api(server, "POST", "/api/companions", {})
    assert status == 201
    assert body["companion"]["name"] == ""


def test_companion_duplicate_name_409(server):
    api(server, "POST", "/api/companions", {"name": "Kernel"})
    status, body = api(server, "POST", "/api/companions", {"name": "kernel"})
    assert status == 409
    assert body["error"] == "duplicate_name"


def test_companion_unknown_404(server):
    status, body = api(server, "GET", "/api/companions/nope")
    assert status == 404
    assert body["error"] == "companion_not_found"


def test_companion_delete_requires_confirm(server):
    _, body = api(server, "POST", "/api/companions", {"name": "Kernel"})
    cid = body["companion"]["id"]

    status, body = api(server, "DELETE", f"/api/companions/{cid}?confirm=wrong")
    assert status == 400
    assert body["error"] == "confirm_mismatch"

    status, _ = api(server, "DELETE", f"/api/companions/{cid}?confirm=Kernel")
    assert status == 200
    status, _ = api(server, "GET", f"/api/companions/{cid}")
    assert status == 404
    con = sqlite3.connect(server.mvp_db_path)
    assert con.execute("SELECT COUNT(*) FROM conversations").fetchone()[0] == 0
    con.close()


def test_engine_invalid_json_body(server):
    req = urllib.request.Request(
        server.base_url + "/api/companions",
        data=b"not json",
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(req)
        raise AssertionError("expected 400")
    except urllib.error.HTTPError as e:
        assert e.code == 400
        assert json.loads(e.read())["error"] == "invalid_json"


def test_public_mode_hides_engine_entirely(public_server):
    """MVP_PUBLIC=1 is the Railway posture: landing pages + waitlist live,
    engine API absent, no companion DB ever created."""
    for path in ("/api/app/health", "/api/companions"):
        try:
            with urllib.request.urlopen(public_server.base_url + path) as r:
                status = r.status
        except urllib.error.HTTPError as e:
            status = e.code
        assert status == 404, f"{path} must not exist on a public deploy"

    with urllib.request.urlopen(public_server.base_url + "/necropets/") as r:
        assert r.status == 200

    req = urllib.request.Request(
        public_server.base_url + "/api/waitlist",
        data=json.dumps({"email": "pub@example.com", "variant": "necropets"}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as r:
        assert r.status == 201

    assert not public_server.mvp_db_path.exists(), "public mode must never create mvp.db"


def test_demo_video_served_with_range(server):
    """The landing page's dogfood video is self-hosted (so the pages' no-
    external-requests promise holds) and byte-range seekable."""
    # full GET
    with urllib.request.urlopen(server.base_url + "/demo/oni-demo.mp4") as r:
        assert r.status == 200
        assert r.headers.get("Content-Type") == "video/mp4"
        assert r.headers.get("Accept-Ranges") == "bytes"
        size = int(r.headers.get("Content-Length"))
        assert size > 100_000

    # range request → 206 with the exact slice
    req = urllib.request.Request(server.base_url + "/demo/oni-demo.mp4", headers={"Range": "bytes=0-1023"})
    with urllib.request.urlopen(req) as r:
        assert r.status == 206
        assert r.headers.get("Content-Range") == f"bytes 0-1023/{size}"
        assert len(r.read()) == 1024

    # unsatisfiable range → 416
    req = urllib.request.Request(server.base_url + "/demo/oni-demo.mp4", headers={"Range": f"bytes={size}-"})
    try:
        urllib.request.urlopen(req)
        raise AssertionError("expected 416")
    except urllib.error.HTTPError as e:
        assert e.code == 416


def test_demo_video_served_in_public_mode(public_server):
    """It is a landing-page asset, so it must serve even with the engine off."""
    with urllib.request.urlopen(public_server.base_url + "/demo/oni-demo.mp4") as r:
        assert r.status == 200
        assert r.headers.get("Content-Type") == "video/mp4"


def test_landing_page_references_the_demo_video(server):
    with urllib.request.urlopen(server.base_url + "/minimumviablepet/") as r:
        html = r.read().decode()
    assert "/demo/oni-demo.mp4" in html
