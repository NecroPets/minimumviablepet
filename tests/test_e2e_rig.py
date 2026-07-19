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
# P2 (depth parallax) sample pair — same 365x780 front-facing Oni cutout
# (byte-identical to SAMPLE_CUTOUT above) plus its matching depth map
# (grayscale, near=bright/far=dark, background=0), generated per
# docs/EMANATION-ENGINE-PLAN.md §4.3's Depth Anything V2 spike.
SAMPLE_DEPTH_CUTOUT = Path(
    "/private/tmp/claude-501/-Users-futjr-defai-defai/1144f77a-5722-4f5b-ae39-dbfd2d1354bb"
    "/scratchpad/p2-contract/sample-cutout.png"
)
SAMPLE_DEPTH = Path(
    "/private/tmp/claude-501/-Users-futjr-defai-defai/1144f77a-5722-4f5b-ae39-dbfd2d1354bb"
    "/scratchpad/p2-contract/sample-depth.png"
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


def rig_descriptor(cid, anchors=True):
    """Same shape server/engine/rig/descriptor.ts's buildDescriptor() emits —
    matched by hand since seeding bypasses that function (see module
    docstring), not copied from it, so this is worth keeping honest: same
    regions, same cutout_url pattern, same persona shape. Anchors are the real
    Vision keypoints for the sample cutout — the calm-baseline warp ignores
    them (they feed the neural Emanation Engine later), but they mirror what
    the real backend stores; pass anchors=False to omit them."""
    d = {
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
    if anchors:
        d["anchors"] = {
            "eye_l": {"x": 0.734, "y": 0.180, "conf": 0.92},
            "eye_r": {"x": 0.454, "y": 0.180, "conf": 0.91},
            "nose": {"x": 0.596, "y": 0.257, "conf": 0.85},
        }
    return d


def seed_rig(server, cid, anchors=True):
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
        (json.dumps(rig_descriptor(cid, anchors=anchors)), cid),
    )
    con.commit()
    con.close()


def seed_rig_with_depth(server, cid):
    """Seed a rig exactly like seed_rig(), plus a depth map + depth_url — the
    P2 (docs/EMANATION-ENGINE-PLAN.md §4.3) contract the WebGL parallax
    renderer depends on. Same no-interception philosophy as seed_rig(): the
    depth PNG goes on disk at the exact deterministic path
    (companions/:id/rig/depth.png) the real GET .../rig/depth route serves
    from, so the browser's request hits the real, unmodified server. Returns
    the seeded depth PNG path (unused by the test now that the real route is
    in place; kept for callers that want to inspect the seeded bytes)."""
    rig_dir = server.mvp_data_dir / "companions" / cid / "rig"
    rig_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(SAMPLE_DEPTH_CUTOUT, rig_dir / "cutout.png")
    depth_path = rig_dir / "depth.png"
    shutil.copyfile(SAMPLE_DEPTH, depth_path)

    descriptor = rig_descriptor(cid, anchors=True)
    descriptor["depth_url"] = f"/api/companions/{cid}/rig/depth"

    con = sqlite3.connect(server.mvp_db_path)
    con.execute(
        "UPDATE companions SET rig_json = ? WHERE id = ?",
        (json.dumps(descriptor), cid),
    )
    con.commit()
    con.close()
    return depth_path


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


def canvas_row_centroid_x_any_mode(page, row_frac):
    """Same alpha-weighted centroid as canvas_row_centroid_x, but copies the
    rig canvas onto a throwaway 2D canvas first via drawImage — works whether
    #app-rig-canvas itself is 2D- or WebGL-backed (a WebGL-backed canvas has
    no 2D context of its own to read pixels from directly; a <canvas> can
    only ever host one context type for its lifetime)."""
    return page.evaluate(
        """(rowFrac) => {
            const src = document.getElementById('app-rig-canvas');
            const tmp = document.createElement('canvas');
            tmp.width = src.width; tmp.height = src.height;
            const ctx = tmp.getContext('2d');
            ctx.drawImage(src, 0, 0);
            const w = tmp.width, h = tmp.height;
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


def canvas_corner_alpha(page):
    """Alpha of the canvas's top-left corner pixel — mode-agnostic (see
    canvas_row_centroid_x_any_mode). The cutout's background is transparent
    there in both the slice-warp (drawn straight from the alpha-cut PNG) and
    the GL parallax renderer (fragment shader discards/zeroes it)."""
    return page.evaluate(
        """() => {
            const src = document.getElementById('app-rig-canvas');
            const tmp = document.createElement('canvas');
            tmp.width = src.width; tmp.height = src.height;
            const ctx = tmp.getContext('2d');
            ctx.drawImage(src, 0, 0);
            return ctx.getImageData(0, 0, 1, 1).data[3];
        }"""
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


def test_rig_parallax_with_depth(server, page_factory):
    """P2 (docs/EMANATION-ENGINE-PLAN.md §4.3/§4.4): a rig descriptor
    carrying depth_url gets real WebGL depth parallax instead of the flat
    slice-warp, chosen in loadRig() when a canvas WebGL context (with vertex
    texture fetch — depth is sampled in the vertex shader) is actually
    available; otherwise it falls back to the same honest slice-warp the
    no-depth tests above already cover. Playwright's headless Chromium runs
    on SwiftShader (software GL) — this asserts whichever path really
    initialized rather than assuming one, and treats BOTH as a pass: (a) the
    canvas animates and (c) responds to the pointer either way (the slice-
    warp already proves that; GL mode proves the same behavior through the
    new renderer), and (b) the transparent background stays transparent
    regardless of which renderer drew it.
    """
    cid = create_companion(server, name="Oni")
    seed_awake_chat(server, cid)
    seed_rig_with_depth(server, cid)

    page = page_factory()
    page.goto(app_url(server), wait_until="load", timeout=30000)
    wait_view(page, "awake")
    page.wait_for_selector("#app-rig:not([hidden])", timeout=10000)
    assert page.locator("#app-rig").is_visible()

    mode = page.evaluate("() => window.__mvpRigTestHook.getMode()")
    assert mode in ("gl", "2d"), f"unexpected rig render mode: {mode!r}"
    print(f"\n[test_rig_parallax_with_depth] renderer actually used: {mode!r}")

    # honest label unchanged regardless of renderer
    label = page.locator("#app-rig-label").inner_text()
    assert "rigged" in label
    assert "not them" in label

    # (a) frame-diff over time proves the loop is actually running (shared
    # rAF loop — canvas_data_url works for both 2D- and WebGL-backed canvases
    # since preserveDrawingBuffer:true keeps the GL buffer readable)
    frame0 = canvas_data_url(page)
    page.wait_for_timeout(1200)
    frame1 = canvas_data_url(page)
    assert frame0 != frame1, "canvas pixels must change between t=0 and t=1.2s"

    # (c) pointer left vs right of the canvas shifts the rendered head row —
    # true for both renderers, just at different (both tasteful) amplitudes
    box = page.locator("#app-rig-canvas").bounding_box()
    cy = box["y"] + box["height"] / 2

    page.mouse.move(box["x"] + box["width"] * 0.1, cy)
    page.wait_for_timeout(700)
    left_centroid = canvas_row_centroid_x_any_mode(page, 0.15)

    page.mouse.move(box["x"] + box["width"] * 0.9, cy)
    page.wait_for_timeout(700)
    right_centroid = canvas_row_centroid_x_any_mode(page, 0.15)

    assert left_centroid is not None and right_centroid is not None
    print(f"[test_rig_parallax_with_depth] centroid left={left_centroid} right={right_centroid}")
    # the GL parallax amplitude is deliberately small (RIG_PARALLAX_MAX ~1.7%
    # of width) — subtle presence, not the slice-warp's larger look-toward
    # sway — so the bar is lower than the no-depth cursor test's, but still a
    # clear, non-noise margin.
    min_margin = 15 if mode == "2d" else 1.5
    assert right_centroid - left_centroid > min_margin, (
        f"pointer right of center should shift the head row right of pointer-left "
        f"by a clear margin (device px, mode={mode}); got left={left_centroid} right={right_centroid}"
    )

    # (b) the cutout's alpha-cut background stays transparent no matter which
    # renderer drew it (slice-warp draws the PNG's own alpha; the GL
    # fragment shader discards/zeroes background alpha)
    assert canvas_corner_alpha(page) == 0

    page.screenshot(path=str(SHOTS / "rig_parallax.png"))
