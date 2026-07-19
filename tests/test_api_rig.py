"""Rig build + serve routes. Real server, real SQLite, real files on disk.
The build test uses a real photo (demo/photos/oni-counter.jpeg — the one
docs/EMBODIMENT-PLAN.md calls the textbook case) and gates on the mask.swift
toolchain (macOS + swift on PATH), exactly like the whisper tests gate on the
whisper binary: skip cleanly when the tool is present but do the assertion
either way — real success path when available, the loud install-hint 500
when not."""
import json
import pathlib
import platform
import shutil
import sqlite3
import urllib.error
import urllib.request

import pytest

from test_api_ingest import create_companion

ROOT = pathlib.Path(__file__).resolve().parent.parent
ONI_PHOTO = ROOT / "demo" / "photos" / "oni-counter.jpeg"

MASKER_AVAILABLE = platform.system() == "Darwin" and shutil.which("swift") is not None


def api(server, method, path, body=None, timeout=90):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        server.base_url + path,
        data=data,
        headers={"Content-Type": "application/json"} if data else {},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def seed_processed_photo(server, upload, artifact_waiter, cid, photo_path, physical):
    """A real processed image artifact on disk; status and photos_analyzed
    are hand-seeded afterward (same pattern as test_api_memories.seed_memories)
    so rig building — which only cares that status='processed' and that a
    photo file exists on disk — never depends on the live vision model's
    captioning succeeding under whatever load the shared ollama daemon is
    under (it can genuinely fail the artifact under contention; that is a
    pre-existing ingest-pipeline concern, not something the rig build or
    serve routes should be judged on)."""
    photo_bytes = photo_path.read_bytes()
    _, body = upload(f"{server.base_url}/api/companions/{cid}/artifacts", [(photo_path.name, photo_bytes)])
    artifact = body["results"][0]["artifact"]
    artifact_waiter(server, cid, artifact["id"], timeout=300)

    con = sqlite3.connect(server.mvp_db_path)
    con.execute("UPDATE artifacts SET status='processed', error=NULL WHERE id=?", (artifact["id"],))
    profile = {
        "photos_analyzed": [
            {
                "file": photo_path.name,
                "hash8": artifact["hash"][:8],
                "captured_at": None,
                "summary": "A cat on the kitchen counter.",
                "physical": physical,
            }
        ]
    }
    con.execute("UPDATE companions SET profile_json=? WHERE id=?", (json.dumps(profile), cid))
    con.commit()
    con.close()
    return artifact


def test_rig_get_404_before_build(server):
    cid = create_companion(server)
    status, body = api(server, "GET", f"/api/companions/{cid}/rig")
    assert status == 404
    assert body["error"] == "no_rig"


def test_rig_cutout_404_before_build(server):
    cid = create_companion(server)
    try:
        urllib.request.urlopen(f"{server.base_url}/api/companions/{cid}/rig/cutout")
        raise AssertionError("expected 404")
    except urllib.error.HTTPError as e:
        assert e.code == 404
        assert json.loads(e.read())["error"] == "cutout_missing"


def test_rig_build_404_for_missing_companion(server):
    status, body = api(server, "POST", "/api/companions/nope/rig")
    assert status == 404
    assert body["error"] == "companion_not_found"


def test_rig_build_500_when_no_photo(server):
    """No processed photo at all — a loud, specific refusal, not a fake rig."""
    cid = create_companion(server)
    status, body = api(server, "POST", f"/api/companions/{cid}/rig")
    assert status == 500
    assert "no processed photo" in body["error"]


def test_rig_build_source_must_belong_to_companion(server):
    """?source= lets the owner pick the photo (docs §4.1); a source that isn't
    this companion's processed image is refused loudly, before any masking."""
    cid = create_companion(server)
    status, body = api(server, "POST", f"/api/companions/{cid}/rig?source=not-a-real-artifact")
    assert status == 500
    assert "is not a processed image of companion" in body["error"]


@pytest.mark.skipif(not MASKER_AVAILABLE, reason="needs macOS + swift on PATH")
def test_rig_build_and_serve_real_masker(server, upload, artifact_waiter):
    """The real path: macOS + swift + a real photo of an animal. Builds a
    genuine cutout PNG and descriptor, and both GET routes then serve it."""
    cid = create_companion(server)
    seed_processed_photo(server, upload, artifact_waiter, cid, ONI_PHOTO, physical=["orange tabby"])

    status, body = api(server, "POST", f"/api/companions/{cid}/rig")
    assert status == 200, body
    assert body["ok"] is True
    rig = body["rig"]
    assert rig["version"] == 1
    assert rig["cutout_url"] == f"/api/companions/{cid}/rig/cutout"
    assert rig["bounds"]["w"] > 0
    assert rig["bounds"]["h"] > 0
    assert rig["regions"] == {
        "ears": {"cy": 0.05, "top": 0.0, "bottom": 0.1},
        "head": {"cx": 0.5, "cy": 0.22, "top": 0.0, "bottom": 0.42},
        "torso": {"cx": 0.5, "cy": 0.66, "top": 0.42, "bottom": 1.0},
    }
    # no energy_level/quirks were seeded above — both fields land on their
    # documented defaults (persona.ts: unknown energy -> medium, no keyword
    # match -> the reaction library's declared order)
    assert rig["persona"] == {"energy_scalar": 0.55, "reactions": ["ear_perk", "head_tilt", "lean"]}

    status, body = api(server, "GET", f"/api/companions/{cid}/rig")
    assert status == 200
    assert body["rig"] == rig

    with urllib.request.urlopen(f"{server.base_url}/api/companions/{cid}/rig/cutout") as r:
        assert r.status == 200
        assert r.headers.get("Content-Type") == "image/png"
        data = r.read()
        assert data[:8] == b"\x89PNG\r\n\x1a\n"
        assert len(data) > 100

    con = sqlite3.connect(server.mvp_db_path)
    stored = con.execute("SELECT rig_json FROM companions WHERE id=?", (cid,)).fetchone()[0]
    con.close()
    assert json.loads(stored) == rig


@pytest.mark.skipif(MASKER_AVAILABLE, reason="swift/macOS IS available on this machine; nothing to assert here")
def test_rig_build_500_loud_without_masker(server, upload, artifact_waiter):
    """When the toolchain is absent, the honest answer is a loud 500 naming
    macOS/swift and the doc pointer — never a silent no-op or a fake rig."""
    cid = create_companion(server)
    seed_processed_photo(server, upload, artifact_waiter, cid, ONI_PHOTO, physical=["orange tabby"])
    status, body = api(server, "POST", f"/api/companions/{cid}/rig")
    assert status == 500
    assert "macos" in body["error"].lower() or "swift" in body["error"].lower()
