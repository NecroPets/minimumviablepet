"""Variant B experience tests: section integrity, the typed boot terminal,
Kernel's live chat (same dual-branch contract as variant A), the FAQ
accordion, the sincere-pivot styling, and the reduced-motion policy."""
from conftest import SHOTS

PATH = "/minimumviablepet/"
SECTION_IDS = [
    "top", "hero", "how", "demo", "local", "why",
    "pricing", "changelog", "faq", "waitlist",
]
BOOT_FINAL_LINE = "kernel is running on localhost. say hi."


def test_sections_present(server, page_factory):
    page = page_factory()
    page.goto(server.base_url + PATH, wait_until="load", timeout=30000)
    for sid in SECTION_IDS:
        assert page.locator(f"#{sid}").count() == 1, f"section #{sid} missing"


def test_boot_terminal_types_to_completion(server, page_factory):
    page = page_factory()
    page.goto(server.base_url + PATH, wait_until="load", timeout=30000)
    page.locator("#mvp-boot").scroll_into_view_if_needed()
    page.wait_for_function(
        f"""() => (document.getElementById('mvp-boot').textContent || '')
                .includes({BOOT_FINAL_LINE!r})""",
        timeout=20000,
    )
    # the whole sequence must be back, not just the last line
    text = page.locator("#mvp-boot").text_content()
    assert "$ mvp init --from ~/Photos/Kernel" in text
    assert "skipped (there is no cloud)" in text


def test_copy_button(server, page_factory):
    page = page_factory()
    page.context.grant_permissions(["clipboard-read", "clipboard-write"])
    page.goto(server.base_url + PATH, wait_until="load", timeout=30000)
    page.locator(".mvp-boot__copy").click()
    page.wait_for_function(
        "() => document.querySelector('.mvp-boot__copy').textContent.includes('copied')",
        timeout=3000,
    )
    clip = page.evaluate("() => navigator.clipboard.readText()")
    assert clip == "mvp init --from ~/Photos/Kernel --voice ~/VoiceMemos"


def test_chat_kernel(server, page_factory, ollama_up):
    page = page_factory()
    ollama_calls = []
    page.on(
        "response",
        lambda r: ollama_calls.append(r.status) if "11434" in r.url else None,
    )
    page.goto(server.base_url + PATH, wait_until="load", timeout=30000)
    page.locator("#demo").scroll_into_view_if_needed()
    page.wait_for_timeout(500)

    field = page.locator("#mvp-chat-field")
    assert field.count() == 1
    bots_before = page.locator("#mvp-chat-log .mvp-msg--bot").count()

    field.click()
    field.fill("kernel, status report on the birds situation?")
    page.locator("#mvp-chat-form .mvp-chat__send").click()

    page.wait_for_function(
        """(n) => { const b = document.querySelectorAll('#mvp-chat-log .mvp-msg--bot');
              return b.length > n && (b[b.length - 1].innerText || '').trim().length > 12; }""",
        arg=bots_before,
        timeout=90000 if ollama_up else 45000,  # down-branch: the page aborts its fetch at 30s when ollama hangs rather than refuses
    )
    page.screenshot(path=str(SHOTS / "minimumviablepet_chat.png"))

    mode = page.locator("#mvp-chat-status").get_attribute("data-mode")
    label = page.locator(".mvp-status-label").text_content()
    reply = page.locator("#mvp-chat-log .mvp-msg--bot").last.inner_text().strip()
    if ollama_up:
        assert 200 in ollama_calls, f"expected a live Ollama 200, saw {ollama_calls}"
        assert mode == "local", f"Ollama is up but page fell back to {mode!r}; reply={reply[:90]!r}"
        assert "live: localhost:11434" in label
    else:
        assert mode == "memory", f"Ollama is down but page claims mode={mode!r}"
        assert "replaying from cache" in label
        assert len(reply) > 12


KERNEL_FALLBACKS = [
    "I walked across your keyboard for years. Statistically, some of your best code is mine.",
    "Uptime down here is excellent. I have not knocked a single thing off a single table. I miss tables.",
    "Tell me about your day. I'll pretend to ignore you, but I'm caching every word.",
    "I attended four hundred standups from your lap. I have notes on your velocity.",
    "Purring at a steady sixty frames per second. Everything renders fine down here.",
    "You look tired. Sit down. That was always my job - making you sit down.",
    "I remember the ship-it bell. I remember sleeping through it on your keyboard. Good era.",
    "The birds outside your window remain unresolved. Leave that issue open for me.",
    "I won't say I missed you. I'm a cat. But my logs say otherwise.",
    "You know it was never the laptop that was warm. It was sitting next to you.",
]


def test_chat_kernel_offline_fallback(server, page_factory):
    """Force the Ollama route to fail so the real degrade path runs: canned
    in-voice reply, mode=memory, honest status label."""
    page = page_factory()
    page.route("http://localhost:11434/**", lambda route: route.abort())
    page.goto(server.base_url + PATH, wait_until="load", timeout=30000)
    page.locator("#demo").scroll_into_view_if_needed()

    field = page.locator("#mvp-chat-field")
    field.click()
    field.fill("anyone home?")
    page.locator("#mvp-chat-form .mvp-chat__send").click()

    page.wait_for_function(
        "() => document.querySelectorAll('#mvp-chat-log .mvp-msg--bot').length > 1",
        timeout=15000,
    )
    assert page.locator("#mvp-chat-status").get_attribute("data-mode") == "memory"
    assert "replaying from cache" in page.locator(".mvp-status-label").text_content()
    reply = page.locator("#mvp-chat-log .mvp-msg--bot").last.inner_text().strip()
    assert reply in KERNEL_FALLBACKS, f"unexpected canned reply: {reply!r}"


def test_mobile_nav_drawer(server, page_factory):
    page = page_factory(viewport={"width": 375, "height": 812})
    page.goto(server.base_url + PATH, wait_until="load", timeout=30000)

    burger = page.locator(".mvp-burger")
    links = page.locator(".mvp-nav__links")
    assert burger.is_visible()
    assert not links.is_visible(), "drawer starts closed"

    burger.click()
    assert links.is_visible(), "burger opens the drawer"
    assert burger.get_attribute("aria-expanded") == "true"

    links.locator("a", has_text="FAQ").click()
    page.wait_for_timeout(300)
    assert not links.is_visible(), "choosing a link closes the drawer"
    assert burger.get_attribute("aria-expanded") == "false"


def test_faq_one_open_at_a_time(server, page_factory):
    page = page_factory()
    page.goto(server.base_url + PATH, wait_until="load", timeout=30000)
    items = page.locator(".mvp-faq__item")
    count = items.count()
    assert count == 7

    def open_states():
        return [items.nth(i).get_attribute("open") is not None for i in range(count)]

    assert open_states()[0] is True, "first FAQ item starts open"

    items.nth(2).locator("summary").scroll_into_view_if_needed()
    items.nth(2).locator("summary").click()
    page.wait_for_timeout(150)
    states = open_states()
    assert states[2] is True, "clicked item opens"
    assert sum(states) == 1, f"exactly one item may be open, got {states}"

    items.nth(2).locator("summary").click()
    page.wait_for_timeout(150)
    assert sum(open_states()) == 0, "clicking the open item closes it"


def test_sincere_pivot_styling(server, page_factory):
    """The #why section is the page's armor-drop: serif italic with the only
    red on the page."""
    page = page_factory()
    page.goto(server.base_url + PATH, wait_until="load", timeout=30000)
    styles = page.evaluate(
        """() => {
            const el = document.querySelector('#why .mvp-why__body');
            const cs = getComputedStyle(el);
            return {
              family: cs.fontFamily,
              style: cs.fontStyle,
              border: cs.borderLeftColor,
            };
        }"""
    )
    assert "Source Serif 4" in styles["family"]
    assert styles["style"] == "italic"
    assert styles["border"] == "rgb(229, 72, 77)"


def test_reduced_motion_prerendered(server, page_factory):
    """Under prefers-reduced-motion the boot terminal must NOT retype: the full
    final text is already in the markup, and reveals are instantly visible."""
    page = page_factory(reduced_motion="reduce")
    page.goto(server.base_url + PATH, wait_until="load", timeout=30000)
    page.wait_for_timeout(300)

    text = page.locator("#mvp-boot").text_content()
    assert BOOT_FINAL_LINE in text, "boot text must be pre-rendered, not typed"

    opacity = page.evaluate(
        "() => getComputedStyle(document.querySelector('.mvp-reveal')).opacity"
    )
    assert opacity == "1"
