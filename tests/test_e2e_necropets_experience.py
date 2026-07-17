"""Variant A experience tests, ported from the original test_necropets.py
harness: section integrity, the resurrection wizard, and the live chat.
The chat test hard-asserts BOTH branches: with Ollama up it must observe a
real 200 to :11434 and mode=local; with Ollama down it must degrade to
mode=memory with a canned reply. Nothing is silently skipped."""
import re

from conftest import SHOTS

PATH = "/necropets/"
SECTION_IDS = ["hero", "how", "resurrect", "companion", "privacy", "close"]


def test_sections_present(server, page_factory):
    page = page_factory()
    page.goto(server.base_url + PATH, wait_until="load", timeout=30000)
    for sid in SECTION_IDS:
        assert page.locator(f"#{sid}").count() == 1, f"section #{sid} missing"


def test_wizard_upload_stepnav_resurrect(server, page_factory, tmp_path):
    page = page_factory()
    page.goto(server.base_url + PATH, wait_until="load", timeout=30000)
    wiz = page.locator("#resurrect")
    wiz.scroll_into_view_if_needed()
    page.wait_for_timeout(500)

    # file upload changes wizard state
    sample = tmp_path / "sample.txt"
    sample.write_text("memory")
    file_inputs = wiz.locator("input[type=file]")
    assert file_inputs.count() > 0, "wizard must expose a file input"
    before = wiz.inner_text()
    file_inputs.first.set_input_files(str(sample))
    page.wait_for_timeout(600)
    assert wiz.inner_text() != before, "uploading a file must change the wizard UI"

    # step navigation advances
    clicks = 0
    for _ in range(6):
        nxt = wiz.get_by_role("button", name=re.compile(r"next|continue|forward", re.I))
        if nxt.count() and nxt.first.is_visible():
            nxt.first.click()
            clicks += 1
            page.wait_for_timeout(350)
        else:
            break
    assert clicks >= 1, "wizard must advance at least one step"

    # resurrect -> awake
    act = wiz.get_by_role(
        "button", name=re.compile(r"resurrect|awaken|reanimate|bring.*back|begin|summon|wake", re.I)
    )
    assert act.count() > 0, "no resurrect/awaken button found"
    act.first.click()
    page.wait_for_function(
        """() => /awake|alive|is here|meet |say hello|hello,|waiting for you/i
               .test(document.querySelector('#resurrect')?.innerText || '')""",
        timeout=12000,
    )
    page.screenshot(path=str(SHOTS / "necropets_wizard.png"))


def test_chat_luna(server, page_factory, ollama_up):
    page = page_factory()
    ollama_calls = []
    page.on(
        "response",
        lambda r: ollama_calls.append(r.status) if "11434" in r.url else None,
    )
    page.goto(server.base_url + PATH, wait_until="load", timeout=30000)
    page.locator("#companion").scroll_into_view_if_needed()
    page.wait_for_timeout(500)

    field = page.locator("#np-chat-field")
    assert field.count() == 1
    bots_before = page.locator("#np-chat-log .np-msg--bot").count()

    field.click()
    field.fill("Hi Luna, do you remember our evening walks together?")
    page.locator("#np-chat-form .np-chat__send").click()

    page.wait_for_function(
        """(n) => { const b = document.querySelectorAll('#np-chat-log .np-msg--bot');
              return b.length > n && (b[b.length - 1].innerText || '').trim().length > 12; }""",
        arg=bots_before,
        timeout=90000 if ollama_up else 45000,  # down-branch: the page aborts its fetch at 30s when ollama hangs rather than refuses
    )
    page.screenshot(path=str(SHOTS / "necropets_chat.png"))

    mode = page.locator("#np-chat-status").get_attribute("data-mode")
    reply = page.locator("#np-chat-log .np-msg--bot").last.inner_text().strip()
    if ollama_up:
        assert 200 in ollama_calls, f"expected a live Ollama 200, saw {ollama_calls}"
        assert mode == "local", f"Ollama is up but page fell back to {mode!r}; reply={reply[:90]!r}"
    else:
        assert mode == "memory", f"Ollama is down but page claims mode={mode!r}"
        assert len(reply) > 12


def test_chat_luna_offline_fallback(server, page_factory):
    """Force the Ollama route to fail so the real degrade path runs: canned
    reply appears and the status pill honestly reports memory mode."""
    page = page_factory()
    page.route("http://localhost:11434/**", lambda route: route.abort())
    page.goto(server.base_url + PATH, wait_until="load", timeout=30000)
    page.locator("#companion").scroll_into_view_if_needed()

    field = page.locator("#np-chat-field")
    field.click()
    field.fill("are you there, girl?")
    page.locator("#np-chat-form .np-chat__send").click()

    page.wait_for_function(
        "() => document.querySelectorAll('#np-chat-log .np-msg--bot').length > 1",
        timeout=15000,
    )
    assert page.locator("#np-chat-status").get_attribute("data-mode") == "memory"
    reply = page.locator("#np-chat-log .np-msg--bot").last.inner_text().strip()
    assert len(reply) > 12
