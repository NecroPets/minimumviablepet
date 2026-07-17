"""Browser E2E tests that both variants must pass identically: clean load,
anchor integrity, and every waitlist form state, verified against the real DB."""
import pytest

from conftest import SHOTS, VARIANT_PAGES


def first_form(page):
    form = page.locator("form[data-waitlist]").first
    return (
        form,
        form.locator('input[type="email"]'),
        form.locator('button[type="submit"]'),
        form.locator("[data-waitlist-msg]"),
    )


def wait_for_state(page, msg_locator, state, timeout=10000):
    page.wait_for_function(
        "([el, want]) => el.getAttribute('data-state') === want",
        arg=[msg_locator.element_handle(), state],
        timeout=timeout,
    )


@pytest.mark.parametrize("variant,path", VARIANT_PAGES)
def test_page_loads_clean(server, page_factory, variant, path):
    page = page_factory()
    page.goto(server.base_url + path, wait_until="load", timeout=30000)
    page.wait_for_timeout(1200)
    assert page.title(), "page must have a title"
    page.screenshot(path=str(SHOTS / f"{variant}_desktop.png"))
    assert page.collected_errors["console"] == []
    assert page.collected_errors["page"] == []


@pytest.mark.parametrize("variant,path", VARIANT_PAGES)
def test_nav_anchors_resolve(server, page_factory, variant, path):
    page = page_factory()
    page.goto(server.base_url + path, wait_until="load", timeout=30000)
    dead = page.evaluate(
        """() => {
            const out = [];
            document.querySelectorAll('a[href^="#"]').forEach(a => {
              const id = a.getAttribute('href').slice(1);
              if (id && !document.getElementById(id)) out.push(a.getAttribute('href'));
            });
            return [...new Set(out)];
        }"""
    )
    assert dead == []


@pytest.mark.parametrize("variant,path", VARIANT_PAGES)
def test_waitlist_signup_ok(server, page_factory, db_rows, variant, path):
    page = page_factory()
    page.goto(server.base_url + path, wait_until="load", timeout=30000)
    form, field, button, msg = first_form(page)
    email = f"e2e-{variant}@example.com"
    field.fill(email)
    button.click()
    wait_for_state(page, msg, "ok")

    assert field.is_disabled(), "field locks after a successful signup"
    rows = db_rows(server.db_path)
    assert len(rows) == 1
    assert rows[0]["email"] == email
    assert rows[0]["variant"] == variant, "page must tag its OWN variant"
    assert rows[0]["referrer"].endswith(path)


@pytest.mark.parametrize("variant,path", VARIANT_PAGES)
def test_waitlist_server_side_invalid_email(server, page_factory, db_rows, variant, path):
    """'test@nodot' passes the browser's type=email check; the server must be
    the one to reject it."""
    page = page_factory()
    page.goto(server.base_url + path, wait_until="load", timeout=30000)
    form, field, button, msg = first_form(page)
    field.fill("test@nodot")
    button.click()
    wait_for_state(page, msg, "error")
    assert not button.is_disabled(), "form re-enables after a rejection"
    assert db_rows(server.db_path) == []


@pytest.mark.parametrize("variant,path", VARIANT_PAGES)
def test_waitlist_duplicate(server, page_factory, db_rows, waitlist_post, variant, path):
    email = f"already-{variant}@example.com"
    status, _, _ = waitlist_post(server.base_url, {"email": email, "variant": variant})
    assert status == 201

    page = page_factory()
    page.goto(server.base_url + path, wait_until="load", timeout=30000)
    form, field, button, msg = first_form(page)
    field.fill(email)
    button.click()
    wait_for_state(page, msg, "duplicate")
    assert len(db_rows(server.db_path)) == 1


@pytest.mark.parametrize("variant,path", VARIANT_PAGES)
def test_waitlist_server_down(server, page_factory, variant, path):
    """Kill the server after page load; the fetch-rejection branch must surface
    an error state instead of hanging or lying."""
    page = page_factory()
    page.goto(server.base_url + path, wait_until="load", timeout=30000)
    server.stop()

    form, field, button, msg = first_form(page)
    field.fill("ghost@example.com")
    button.click()
    wait_for_state(page, msg, "error")
    assert not button.is_disabled(), "form re-enables so the visitor can retry"


@pytest.mark.parametrize("variant,path", VARIANT_PAGES)
def test_mobile_viewport(server, page_factory, db_rows, variant, path):
    page = page_factory(viewport={"width": 375, "height": 812})
    page.goto(server.base_url + path, wait_until="load", timeout=30000)
    page.wait_for_timeout(800)

    overflow = page.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
    assert overflow <= 2, f"horizontal overflow of {overflow}px at 375px"

    form, field, button, msg = first_form(page)
    email = f"mobile-{variant}@example.com"
    field.fill(email)
    button.click()
    wait_for_state(page, msg, "ok")
    assert [r["email"] for r in db_rows(server.db_path)] == [email]

    page.screenshot(path=str(SHOTS / f"{variant}_mobile.png"))
