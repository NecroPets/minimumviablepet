"""The speak button — a bot reply read aloud by the local TTS binary, in a
real browser against the real route. Both outcomes are honest: with a binary
present the audio response is asserted; without one, the verbatim
install-hint line must surface in the log."""
import json
import sqlite3
from shutil import which

from test_api_chat import awaken
from test_api_ingest import create_companion

HAS_TTS = which("say") or which("espeak-ng")


def seed_chat_message(server, cid, content):
    con = sqlite3.connect(server.mvp_db_path)
    con.execute(
        "INSERT INTO conversations (id, companion_id, kind) VALUES ('conv-tts', ?, 'chat')",
        (cid,),
    )
    con.execute(
        "INSERT INTO messages (conversation_id, role, content) VALUES ('conv-tts', 'assistant', ?)",
        (content,),
    )
    con.commit()
    con.close()


def test_speak_button_speaks_or_fails_loudly(server, page_factory):
    cid = create_companion(server, name="Kernel")
    awaken(server, cid)
    seed_chat_message(server, cid, "I remember the sink. I'll always remember the sink.")

    page = page_factory()
    page.goto(server.base_url + f"/app/#/c/{cid}", wait_until="load")
    page.wait_for_selector(".app-msg--bot .app-msg__bubble")
    page.wait_for_selector(".app-speak")

    if HAS_TTS:
        with page.expect_response("**/say") as resp_info:
            page.click(".app-speak")
        resp = resp_info.value
        assert resp.status == 200
        assert resp.headers["content-type"] == "audio/wav"
        # (WAV bytes themselves are inspected in test_api_tts.py — Playwright
        # cannot re-read a streamed body the page already consumed)
        page.wait_for_timeout(500)
        assert page.locator("text=couldn't speak").count() == 0
    else:
        page.click(".app-speak")
        page.wait_for_selector("text=couldn't speak")
        page.wait_for_selector("text=not found")


def test_user_bubbles_get_no_speak_button(server, page_factory):
    cid = create_companion(server, name="Kernel")
    awaken(server, cid)
    con = sqlite3.connect(server.mvp_db_path)
    con.execute(
        "INSERT INTO conversations (id, companion_id, kind) VALUES ('conv-tts2', ?, 'chat')", (cid,)
    )
    con.execute(
        "INSERT INTO messages (conversation_id, role, content) VALUES ('conv-tts2', 'user', 'hey you')"
    )
    con.execute(
        "INSERT INTO messages (conversation_id, role, content) VALUES ('conv-tts2', 'assistant', 'mrow')"
    )
    con.commit()
    con.close()

    page = page_factory()
    page.goto(server.base_url + f"/app/#/c/{cid}", wait_until="load")
    page.wait_for_selector(".app-msg--user")
    assert page.locator(".app-msg--user .app-speak").count() == 0
    assert page.locator(".app-msg--bot .app-speak").count() == 1
