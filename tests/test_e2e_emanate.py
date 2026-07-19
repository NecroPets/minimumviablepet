"""/emanate/ — the projection surface. Real server, real browser, real photo
bytes; the assertions that matter are the optical ones: the background is
pure black and the photo actually renders."""
import json
import sqlite3
import urllib.error
import urllib.request

from test_api_ingest import create_companion
from test_api_memories import TINY_PNG, api


def seed_photo(server, upload, artifact_waiter, cid, name="glow.png"):
    _, body = upload(f"{server.base_url}/api/companions/{cid}/artifacts", [(name, TINY_PNG)])
    art = body["results"][0]["artifact"]
    artifact_waiter(server, cid, art["id"])
    return art


def test_emanate_served_local_only(server, public_server):
    with urllib.request.urlopen(server.base_url + "/emanate/") as r:
        assert r.status == 200
        assert b"$ mvp emanate" in r.read()
    try:
        urllib.request.urlopen(public_server.base_url + "/emanate/")
        raise AssertionError("public mode must never serve the projection page")
    except urllib.error.HTTPError as e:
        assert e.code == 404


def test_picker_lists_companions_and_black_background(server, upload, artifact_waiter, page_factory):
    cid = create_companion(server, name="Oni")
    seed_photo(server, upload, artifact_waiter, cid)

    page = page_factory()
    page.goto(server.base_url + "/emanate/", wait_until="load")
    page.wait_for_selector(f"text=emanate oni/")
    bg = page.evaluate("getComputedStyle(document.body).backgroundColor")
    assert bg == "rgb(0, 0, 0)"


def test_show_renders_photo_on_black(server, upload, artifact_waiter, page_factory):
    cid = create_companion(server, name="Oni")
    seed_photo(server, upload, artifact_waiter, cid)

    page = page_factory()
    page.goto(server.base_url + "/emanate/", wait_until="load")
    page.click("text=emanate oni/")
    page.wait_for_selector("#stage.on .layer.showing img", state="attached")
    page.wait_for_function(
        "document.querySelector('#stage .layer.showing img')?.naturalWidth > 0"
    )
    assert page.evaluate("document.getElementById('picker').style.display") == "none"
    # caption defaults on in single mode
    assert page.evaluate("document.getElementById('caption').hidden") is False
    assert page.evaluate("document.getElementById('caption').textContent") == "oni"


def test_quad_mode_renders_four_copies(server, upload, artifact_waiter, page_factory):
    cid = create_companion(server, name="Oni")
    seed_photo(server, upload, artifact_waiter, cid)

    page = page_factory()
    page.goto(server.base_url + f"/emanate/?companion={cid}&mode=quad", wait_until="load")
    page.wait_for_selector("#stage.on.quad")
    page.wait_for_function(
        "document.querySelectorAll('#stage .layer.showing img').length === 4"
    )
    page.wait_for_function(
        "[...document.querySelectorAll('#stage .layer.showing img')].every(i => i.naturalWidth > 0)"
    )


def test_no_renderable_photos_is_a_loud_state(server, page_factory):
    cid = create_companion(server, name="Nova")
    # a HEIC-only library: stored, honest, not projectable in a browser
    con = sqlite3.connect(server.mvp_db_path)
    con.execute(
        """INSERT INTO artifacts (id, companion_id, kind, original_name, stored_path, mime, bytes, hash, status)
           VALUES ('heic1', ?, 'image', 'winter.heic', '/nowhere/winter.heic', 'image/heic', 9, 'heichash', 'processed')""",
        (cid,),
    )
    con.commit()
    con.close()

    page = page_factory()
    page.goto(server.base_url + "/emanate/", wait_until="load")
    page.click("text=emanate nova/")
    page.wait_for_selector("text=no photos the browser can show")
    # the show must NOT have started
    assert page.evaluate("document.getElementById('stage').className") == ""


def test_unknown_companion_in_url_warns_and_falls_back(server, page_factory):
    create_companion(server, name="Oni")
    page = page_factory()
    page.goto(server.base_url + "/emanate/?companion=nope", wait_until="load")
    page.wait_for_selector("text=companion from the URL not found")
    page.wait_for_selector("text=emanate oni/")
