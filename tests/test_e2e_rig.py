"""Rig (Phase 1 embodiment) E2E: real browser, real bun server, real backend
rig routes — nothing under test is mocked.

The backend (built in parallel with the frontend under test here) landed
GET/POST /api/companions/:id/rig and GET .../rig/cutout on
`companions.rig_json` + companions/:id/rig/cutout.png under MVP_DATA_DIR
(server/engine/routes.ts, server/engine/rig/build.ts) partway through this
work. Building an actual rig end-to-end goes through buildRig() ->
maskToCutout(), which shells out to a macOS/Swift Vision helper
(server/engine/rig/masker.ts) — a real dependency this suite shouldn't
require just to exercise the frontend runtime. So rigs are seeded directly,
exactly the way the real POST /rig handler persists them: write
`rig_json` onto the companion row and drop a real cutout PNG at the exact
deterministic path (companions/:id/rig/cutout.png) the real GET
.../rig/cutout route serves from. From there, every request the browser
makes — GET .../rig, GET .../rig/cutout, everything else — hits the real,
unmodified server.
"""
import json
import shutil
import sqlite3
from pathlib import Path

from conftest import SHOTS
from test_api_chat import awaken
from test_api_ingest import create_companion

SAMPLE_CUTOUT = Path(
    "/private/tmp/claude-501/-Users-futjr-defai-defai/1144f77a-5722-4f5b-ae39-dbfd2d1354bb"
    "/scratchpad/rig-contract/sample-cutout.png"
)
BOUNDS = {"w": 365, "h": 780}


def app_url(server):
    return server.base_url + "/app/"


def wait_view(page, view, timeout=15000):
    page.wait_for_function(
        "(v) => document.body.getAttribute('data-view') === v", arg=view, timeout=timeout
    )


def seed_awake_chat(server, cid):
    """Awake companion with existing chat history — renders the awake view
    with no model call needed (streamTurn only opens a stream when a
    conversation has zero messages)."""
    awaken(server, cid)
    con = sqlite3.connect(server.mvp_db_path)
    con.execute("INSERT INTO conversations (id, companion_id, kind) VALUES ('conv1', ?, 'chat')", (cid,))
    con.execute("INSERT INTO messages (conversation_id, role, content) VALUES ('conv1', 'user', 'hey')")
    con.execute(
        "INSERT INTO messages (conversation_id, role, content) VALUES ('conv1', 'assistant', 'Still here.')"
    )
    con.commit()
    con.close()


def rig_descriptor(cid):
    """Same shape server/engine/rig/descriptor.ts's buildDescriptor() emits —
    matched by hand since seeding bypasses that function (see module
    docstring), not copied from it, so this is worth keeping honest: same
    regions, same cutout_url pattern, same persona shape."""
    return {
        "version": 1,
        "cutout_url": f"/api/companions/{cid}/rig/cutout",
        "bounds": BOUNDS,
        "regions": {
            "ears": {"cy": 0.05, "top": 0.0, "bottom": 0.10},
            "head": {"cx": 0.5, "cy": 0.22, "top": 0.0, "bottom": 0.42},
            "torso": {"cx": 0.5, "cy": 0.66, "top": 0.42, "bottom": 1.0},
        },
        "persona": {"energy_scalar": 0.8, "reactions": ["head_tilt", "ear_perk", "lean"]},
    }


def seed_rig(server, cid):
    """Seed a rig exactly the way the real POST /rig handler persists one:
    `rig_json` on the companion row, cutout PNG at the deterministic disk
    path the real GET .../rig/cutout route serves from. No route
    interception, no stubbing — the browser's requests hit the real server."""
    rig_dir = server.mvp_data_dir / "companions" / cid / "rig"
    rig_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(SAMPLE_CUTOUT, rig_dir / "cutout.png")

    con = sqlite3.connect(server.mvp_db_path)
    con.execute(
        "UPDATE companions SET rig_json = ? WHERE id = ?",
        (json.dumps(rig_descriptor(cid)), cid),
    )
    con.commit()
    con.close()


def canvas_data_url(page):
    return page.evaluate("document.getElementById('app-rig-canvas').toDataURL()")


def canvas_row_centroid_x(page, row_frac):
    """Alpha-weighted centroid x of a canvas row's opaque pixels — a robust,
    directionally meaningful measure of how far the cutout has been shifted
    horizontally on that row (immune to the purely-vertical breath scale)."""
    return page.evaluate(
        """(rowFrac) => {
            const canvas = document.getElementById('app-rig-canvas');
            const ctx = canvas.getContext('2d');
            const w = canvas.width, h = canvas.height;
            const rowY = Math.min(h - 1, Math.floor(h * rowFrac));
            const data = ctx.getImageData(0, rowY, w, 1).data;
            let sumX = 0, sumA = 0;
            for (let x = 0; x < w; x++) {
                const a = data[x * 4 + 3];
                if (a > 20) { sumX += x * a; sumA += a; }
            }
            return sumA > 0 ? sumX / sumA : null;
        }""",
        row_frac,
    )


# ---------------------------------------------------------------------------


def test_no_rig_leaves_app_unaffected(server, page_factory):
    """(a), no-rig half: a companion with no rig gets the real server's real
    404 {ok:false,error:"no_rig"} from GET .../rig — no canvas, app as-is."""
    cid = create_companion(server, name="Kernel")
    seed_awake_chat(server, cid)

    page = page_factory()
    page.goto(app_url(server), wait_until="load", timeout=30000)
    wait_view(page, "awake")
    assert page.locator("#app-rig").is_hidden()
    assert not page.locator("#app-field").is_disabled()
    page.wait_for_timeout(300)  # give the rig fetch a moment to resolve before checking errors
    assert page.collected_errors["page"] == [], "a 404 rig fetch must never surface as an uncaught rejection"


def test_rig_canvas_appears_and_animates(server, page_factory):
    """(a), rig-exists half, plus (b) and (d)."""
    cid = create_companion(server, name="Oni")
    seed_awake_chat(server, cid)
    seed_rig(server, cid)

    page = page_factory()
    page.goto(app_url(server), wait_until="load", timeout=30000)
    wait_view(page, "awake")
    page.wait_for_selector("#app-rig:not([hidden])", timeout=10000)
    assert page.locator("#app-rig").is_visible()

    # (d) honest label, no forbidden claims
    label = page.locator("#app-rig-label").inner_text()
    assert "rigged" in label
    assert "not them" in label
    for bad in ("alive", "resurrected", "back"):
        assert bad not in label.lower(), f"forbidden word {bad!r} in rig label: {label!r}"

    # the test-only state-hook is reachable and drives the same setter the
    # real chat hooks call — exercised directly here, per the model-free ask
    assert page.evaluate("() => window.__mvpRigTestHook.getState()") == "idle"
    page.evaluate("() => window.__mvpRigTestHook.setState('listening')")
    assert page.evaluate("() => window.__mvpRigTestHook.getState()") == "listening"
    page.evaluate("() => window.__mvpRigTestHook.setState('idle')")

    # (b) frame-diff over time proves the rAF warp loop is actually running
    frame0 = canvas_data_url(page)
    page.wait_for_timeout(1200)
    frame1 = canvas_data_url(page)
    assert frame0 != frame1, "canvas pixels must change between t=0 and t=1.2s"
    page.screenshot(path=str(SHOTS / "app_rig_awake.png"))


def test_rig_looks_toward_cursor(server, page_factory):
    """(c): pointer left vs right of the canvas shifts the rendered cutout
    in the matching direction — measured directly (alpha centroid of a head
    row), not just "any two frames differ" (which breathing alone would
    already satisfy and wouldn't prove look-toward specifically)."""
    cid = create_companion(server, name="Oni")
    seed_awake_chat(server, cid)
    seed_rig(server, cid)

    page = page_factory()
    page.goto(app_url(server), wait_until="load", timeout=30000)
    wait_view(page, "awake")
    page.wait_for_selector("#app-rig:not([hidden])", timeout=10000)

    box = page.locator("#app-rig-canvas").bounding_box()
    cy = box["y"] + box["height"] / 2

    page.mouse.move(box["x"] + box["width"] * 0.1, cy)
    page.wait_for_timeout(700)
    left_centroid = canvas_row_centroid_x(page, 0.15)

    page.mouse.move(box["x"] + box["width"] * 0.9, cy)
    page.wait_for_timeout(700)
    right_centroid = canvas_row_centroid_x(page, 0.15)

    assert left_centroid is not None and right_centroid is not None
    assert right_centroid - left_centroid > 15, (
        f"pointer right of center should shift the head row right of pointer-left "
        f"by a clear margin (device px); got left={left_centroid} right={right_centroid}"
    )


def test_rig_teardown_on_route_away(server, page_factory):
    """The app's view lifecycle: leaving the companion tears the rig down
    (route()'s teardownRig hook) — no leaked rAF loop, no stale canvas into
    a companion that has no rig."""
    cid = create_companion(server, name="Oni")
    seed_awake_chat(server, cid)
    seed_rig(server, cid)
    other_cid = create_companion(server, name="Mochi")  # no rig, still interviewing

    page = page_factory()
    page.goto(app_url(server) + f"#/c/{cid}", wait_until="load", timeout=30000)
    wait_view(page, "awake")
    page.wait_for_selector("#app-rig:not([hidden])", timeout=10000)

    page.evaluate("(id) => { location.hash = '#/c/' + id; }", other_cid)
    wait_view(page, "interview")
    assert page.locator("#app-rig").is_hidden()
