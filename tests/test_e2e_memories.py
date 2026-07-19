"""Memories drawer E2E: real browser, real server, real SQLite, real files on
disk. Model-dependent ingestion (vision captions) is bypassed by hand-seeding
profile/derived-text/fact rows directly — same trick as
test_api_memories.seed_memories. Every companion here stays in the default
"interviewing" state: test_readiness_drawer_checklist_prefills_never_sends
already proves the drawer buttons appear and are usable immediately, without
waiting on the (model-gated, possibly-offline) interview begin-stream."""
import json
import sqlite3
import urllib.error
import urllib.request
from shutil import which

from test_api_ingest import create_companion
from test_api_memories import seed_memories
from test_e2e_app import app_url, wait_view


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


def open_memories_drawer(page, server, cid):
    page.goto(app_url(server) + "#/c/" + cid, wait_until="load", timeout=30000)
    wait_view(page, "interview")
    page.locator("#app-memories-btn").click()
    page.wait_for_selector("#app-memories-drawer:not([hidden])")
    # renderMemoriesDrawer() is async (fetches /memories); timeline renders last
    # in that sequence, so waiting for it means every section above it is done.
    page.wait_for_function(
        "() => document.getElementById('app-mem-timeline').children.length > 0", timeout=10000
    )
    return page


def test_drawer_shows_seeded_fact_story_and_photo(server, page_factory, upload, artifact_waiter):
    cid = create_companion(server, name="Kernel")
    seed_memories(server, upload, artifact_waiter, cid)

    page = page_factory()
    open_memories_drawer(page, server, cid)

    facts_text = page.locator("#app-mem-facts").inner_text()
    assert "He hated the vacuum with a fiery passion" in facts_text

    stories_text = page.locator("#app-mem-stories").inner_text()
    assert "keyboard" in stories_text

    photos_text = page.locator("#app-mem-photos").inner_text()
    assert "A gray cat sitting proudly on a desk." in photos_text

    imgs = page.locator("#app-mem-photos img")
    assert imgs.count() == 2  # both seeded photos are .png — browser-renderable
    page.wait_for_function(
        "() => { const img = document.querySelector('#app-mem-photos img'); "
        "return img && img.complete && img.naturalWidth > 0; }",
        timeout=10000,
    )
    assert imgs.first.evaluate("img => img.naturalWidth") > 0


def test_photo_placeholder_for_non_renderable_type(server, page_factory):
    """A HEIC (or any non-browser-renderable image kind) gets an honest
    placeholder tile instead of a broken <img> — never a fake preview."""
    cid = create_companion(server, name="Kernel")
    con = sqlite3.connect(server.mvp_db_path)
    con.execute(
        "INSERT INTO artifacts (id, companion_id, kind, original_name, stored_path, mime, bytes, hash, status) "
        "VALUES ('heic1', ?, 'image', 'mystery.heic', '/nonexistent/mystery.heic', 'image/heic', 10, 'heichash', 'processed')",
        (cid,),
    )
    con.commit()
    con.close()

    page = page_factory()
    open_memories_drawer(page, server, cid)

    assert page.locator("#app-mem-photos img").count() == 0
    stub = page.locator("#app-mem-photos .app-mem-photo__stub")
    assert stub.count() == 1
    assert "mystery.heic" in stub.inner_text()
    assert "stored — no browser preview" in stub.inner_text()


def test_forget_fact_removes_from_ui_and_db(server, page_factory):
    cid = create_companion(server, name="Kernel")
    con = sqlite3.connect(server.mvp_db_path)
    con.execute(
        "INSERT INTO facts (id, companion_id, text, category, confidence) VALUES (?,?,?,?,?)",
        ("fdel1", cid, "loved rain", "preference", 0.8),
    )
    con.execute(
        "INSERT INTO chunks (companion_id, source, source_key, seq, text, hash) VALUES (?, 'fact', ?, 0, ?, ?)",
        (cid, "fact:fdel1", "loved rain", "hx"),
    )
    con.commit()
    con.close()

    page = page_factory()
    open_memories_drawer(page, server, cid)
    assert "loved rain" in page.locator("#app-mem-facts").inner_text()

    page.on("dialog", lambda dialog: dialog.accept())
    page.locator("#app-mem-facts .app-mem-fact", has_text="loved rain").locator(".app-mem-forget").click()
    page.wait_for_function(
        "() => !document.getElementById('app-mem-facts').textContent.includes('loved rain')", timeout=10000
    )

    con = sqlite3.connect(server.mvp_db_path)
    assert con.execute("SELECT COUNT(*) FROM facts WHERE id='fdel1'").fetchone()[0] == 0
    assert con.execute("SELECT COUNT(*) FROM chunks WHERE source_key='fact:fdel1'").fetchone()[0] == 0
    con.close()


def test_forget_photo_removes_tile_and_artifact_row(server, page_factory, upload, artifact_waiter):
    cid = create_companion(server, name="Kernel")
    seeded = seed_memories(server, upload, artifact_waiter, cid)
    photo_id = seeded["photo"]["id"]

    page = page_factory()
    open_memories_drawer(page, server, cid)
    assert page.locator("#app-mem-photos img").count() == 2

    page.on("dialog", lambda dialog: dialog.accept())
    page.locator("#app-mem-photos .app-mem-photo", has_text="A gray cat sitting proudly on a desk.").locator(
        ".app-mem-forget"
    ).click()
    page.wait_for_function(
        "() => document.querySelectorAll('#app-mem-photos img').length === 1", timeout=10000
    )

    con = sqlite3.connect(server.mvp_db_path)
    assert con.execute("SELECT COUNT(*) FROM artifacts WHERE id=?", (photo_id,)).fetchone()[0] == 0
    con.close()


def test_export_downloads_a_real_zip(server, page_factory):
    cid = create_companion(server, name="Kernel")
    con = sqlite3.connect(server.mvp_db_path)
    con.execute(
        "UPDATE companions SET profile_json=? WHERE id=?",
        (json.dumps({"pet": {"name": "Kernel"}, "stories": ["He shipped to prod once."]}), cid),
    )
    con.commit()
    con.close()

    page = page_factory()
    open_memories_drawer(page, server, cid)

    if which("zip") is None:
        page.locator("#app-mem-export-btn").click()
        page.wait_for_function(
            "() => document.getElementById('app-mem-log').textContent.includes('install')", timeout=10000
        )
        log = page.locator("#app-mem-log").inner_text()
        assert "zip" in log.lower() and "install" in log.lower()
        return

    with page.expect_download() as dl_info:
        page.locator("#app-mem-export-btn").click()
    download = dl_info.value
    data = open(download.path(), "rb").read()
    assert data[:2] == b"PK"


def test_delete_companion_requires_exact_name_then_removes_it(server, page_factory):
    cid = create_companion(server, name="Kernel")

    page = page_factory()
    open_memories_drawer(page, server, cid)

    btn = page.locator("#app-mem-delete-btn")
    assert btn.is_disabled()

    page.locator("#app-mem-confirm-input").fill("Kern")
    assert btn.is_disabled()
    page.locator("#app-mem-confirm-input").fill("kernel")  # wrong case, still must not match
    assert btn.is_disabled()

    page.locator("#app-mem-confirm-input").fill("Kernel")
    assert not btn.is_disabled()

    btn.click()
    wait_view(page, "empty")
    log = page.locator("#app-log").inner_text()
    assert "no companions found." in log

    status, body = api(server, "GET", f"/api/companions/{cid}")
    assert status == 404
    assert body["error"] == "companion_not_found"
