"""/app E2E: real browser against the real server. Model-dependent flows are
gated; everything structural runs everywhere."""
import json
import sqlite3
import urllib.request

import pytest

from conftest import SHOTS
from test_api_chat import RICH_PROFILE, awaken
from test_api_ingest import create_companion


def app_url(server):
    return server.base_url + "/app/"


def wait_view(page, view, timeout=15000):
    page.wait_for_function(
        "(v) => document.body.getAttribute('data-view') === v", arg=view, timeout=timeout
    )


def test_empty_state_renders_clean(server, page_factory):
    page = page_factory()
    page.goto(app_url(server), wait_until="load", timeout=30000)
    wait_view(page, "empty")
    log = page.locator("#app-log").inner_text()
    assert "$ mvp list" in log
    assert "no companions found." in log
    assert "this machine has room for someone." in log
    assert "Everything you add stays on this machine." in log
    assert page.locator(".app-drop").count() == 1
    assert page.locator("#app-field").is_disabled()
    page.screenshot(path=str(SHOTS / "app_empty.png"))
    assert page.collected_errors["console"] == []
    assert page.collected_errors["page"] == []


def test_public_mode_has_no_app(public_server, page_factory):
    page = page_factory()
    resp = page.goto(app_url(public_server), wait_until="load", timeout=30000)
    assert resp.status == 404


def test_create_companion_enters_interview_ui(server, page_factory):
    """UI flips to interview immediately — the opener stream itself is
    model-gated and covered elsewhere."""
    page = page_factory()
    page.goto(app_url(server), wait_until="load", timeout=30000)
    wait_view(page, "empty")
    page.locator("#app-name-input").fill("Kernel")
    page.locator("#app-name-form button[type=submit]").click()
    wait_view(page, "interview")
    assert "building Kernel's profile" in page.locator("#app-meta").inner_text()
    assert "interview ·" in page.locator("#app-phase").inner_text()
    assert not page.locator("#app-drawer-btn").is_hidden()
    assert page.evaluate("location.hash").startswith("#/c/")
    con = sqlite3.connect(server.mvp_db_path)
    assert con.execute("SELECT name FROM companions").fetchone()[0] == "Kernel"
    con.close()


def test_readiness_drawer_checklist_prefills_never_sends(server, page_factory):
    page = page_factory()
    page.goto(app_url(server), wait_until="load", timeout=30000)
    wait_view(page, "empty")
    page.locator("#app-name-input").fill("Mochi")
    page.locator("#app-name-form button[type=submit]").click()
    wait_view(page, "interview")

    page.locator("#app-drawer-btn").click()
    page.wait_for_function(
        "() => document.getElementById('app-checklist').textContent.includes('persona build')",
        timeout=10000,
    )
    checklist = page.locator("#app-checklist").inner_text()
    assert "persona build · 1/9 checks passing" in checklist
    assert "✓ name" in checklist
    assert "✗ stories" in checklist

    page.locator('.app-check[data-met="0"]').first.click()
    page.wait_for_selector("#app-drawer[hidden]", state="attached")
    field_value = page.locator("#app-field").input_value()
    assert len(field_value) > 10, "hint question lands in the field"
    con = sqlite3.connect(server.mvp_db_path)
    n = con.execute("SELECT COUNT(*) FROM messages WHERE role='user'").fetchone()[0]
    con.close()
    assert n == 0, "the hint must never be auto-sent"


def test_train_refusal_is_kind_and_specific(server, page_factory):
    page = page_factory()
    page.goto(app_url(server), wait_until="load", timeout=30000)
    wait_view(page, "empty")
    page.locator("#app-name-input").fill("Pixel")
    page.locator("#app-name-form button[type=submit]").click()
    wait_view(page, "interview")
    page.locator("#app-drawer-btn").click()
    page.wait_for_selector("#app-drawer:not([hidden])")
    page.locator("#app-train-btn").click()
    page.wait_for_function(
        "() => document.getElementById('app-train-log').textContent.includes('build refused')",
        timeout=10000,
    )
    log = page.locator("#app-train-log").inner_text()
    assert "still missing" in log
    assert "stories: 0 of 3" in log


def test_companion_switcher_and_hash_routing(server, page_factory):
    for name in ("Kernel", "Mochi"):
        req = urllib.request.Request(
            server.base_url + "/api/companions",
            data=json.dumps({"name": name}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req).read()

    page = page_factory()
    page.goto(app_url(server), wait_until="load", timeout=30000)
    wait_view(page, "interview")  # first companion auto-opens
    options = page.locator("#app-switcher option").all_inner_texts()
    assert options == ["Kernel", "Mochi", "+ new companion"]

    page.locator("#app-switcher").select_option(label="Mochi")
    page.wait_for_function(
        "() => document.getElementById('app-meta').textContent.includes(\"Mochi's profile\")"
    )
    assert "#/c/" in page.url


def test_awake_companion_loads_awake_view(server, page_factory, upload, artifact_waiter, ollama_embed_up):
    """Awake view structure (meta line, enabled input) — the greeting stream is
    model-gated; here the companion is hand-awakened with existing history so
    no model call is needed on load."""
    cid = create_companion(server, name="Kernel")
    awaken(server, cid)
    # pre-create a chat conversation WITH history so the UI does not begin-stream
    con = sqlite3.connect(server.mvp_db_path)
    con.execute("INSERT INTO conversations (id, companion_id, kind) VALUES ('conv1', ?, 'chat')", (cid,))
    con.execute("INSERT INTO messages (conversation_id, role, content) VALUES ('conv1', 'user', 'hey')")
    con.execute(
        "INSERT INTO messages (conversation_id, role, content) VALUES ('conv1', 'assistant', 'Oh. You are back. Status report: still here.')"
    )
    con.commit()
    con.close()

    page = page_factory()
    page.goto(app_url(server), wait_until="load", timeout=30000)
    wait_view(page, "awake")
    assert page.locator("#app-title").inner_text() == "kernel@localhost:~"
    assert "pid 1" in page.locator("#app-meta").inner_text()
    bubbles = page.locator(".app-msg__bubble").all_inner_texts()
    assert any("Status report" in b for b in bubbles)
    assert not page.locator("#app-field").is_disabled()
    page.screenshot(path=str(SHOTS / "app_awake.png"))


def test_switcher_new_companion_shows_empty_state(server, page_factory):
    create_companion(server, name="Kernel")
    page = page_factory()
    page.goto(app_url(server), wait_until="load", timeout=30000)
    wait_view(page, "interview")
    page.locator("#app-switcher").select_option(value="__new__")
    wait_view(page, "empty")
    assert "this machine has room for someone" in page.locator("#app-log").inner_text()
    assert page.locator(".app-drop").count() == 1


def test_unknown_hash_is_graceful(server, page_factory):
    create_companion(server, name="Kernel")
    page = page_factory()
    page.goto(app_url(server), wait_until="load", timeout=30000)
    wait_view(page, "interview")
    page.evaluate("() => { location.hash = '#/c/ghost-id-that-does-not-exist'; }")
    page.wait_for_function(
        "() => document.body.getAttribute('data-view') === 'empty'", timeout=10000
    )
    log = page.locator("#app-log").inner_text()
    assert "companion_not_found" in log or "isn't on this machine" in log
    assert page.collected_errors["page"] == [], "no uncaught rejections"


def test_ui_ingest_surface_live(server, page_factory, tmp_path, ollama_embed_up):
    """The whole UI ingest path: file input -> progress line -> ✓ -> idle
    summary -> input re-enabled."""
    if not ollama_embed_up:
        pytest.skip("embed model required")
    story = tmp_path / "box.md"
    story.write_text(
        "# The Box\n\nHe fell asleep inside a shipping box marked fragile and "
        "lived there for a week, emerging only for meals and judgment."
    )
    page = page_factory()
    page.goto(app_url(server), wait_until="load", timeout=30000)
    wait_view(page, "empty")
    page.locator("#app-name-input").fill("Kernel")
    page.locator("#app-name-form button[type=submit]").click()
    wait_view(page, "interview")

    page.locator("#app-file-input").set_input_files(str(story))
    page.wait_for_function(
        "() => document.getElementById('app-log').textContent.includes('✓ box.md')",
        timeout=240000,
    )
    page.wait_for_function(
        "() => document.getElementById('app-log').textContent.includes('ingest done')",
        timeout=60000,
    )
    assert not page.locator("#app-field").is_disabled(), "input re-enables after idle"
    con = sqlite3.connect(server.mvp_db_path)
    n = con.execute("SELECT COUNT(*) FROM chunks WHERE source='story'").fetchone()[0]
    con.close()
    assert n >= 1


def test_offline_posture_when_server_dies(server, page_factory):
    cid = create_companion(server, name="Kernel")
    awaken(server, cid)
    con = sqlite3.connect(server.mvp_db_path)
    con.execute("INSERT INTO conversations (id, companion_id, kind) VALUES ('conv1', ?, 'chat')", (cid,))
    con.execute("INSERT INTO messages (conversation_id, role, content) VALUES ('conv1', 'assistant', 'here.')")
    con.commit()
    con.close()

    page = page_factory()
    page.goto(app_url(server), wait_until="load", timeout=30000)
    wait_view(page, "awake")
    server.stop()

    page.locator("#app-field").fill("are you there?")
    page.locator("#app-send").click()
    page.wait_for_selector(".app-line--warn", timeout=15000)
    log = page.locator("#app-log").inner_text()
    assert "everything you said is on disk" in log
    assert not page.locator("#app-field").is_disabled(), "input re-enables for retry"
