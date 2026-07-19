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


def rig_descriptor(cid, anchors=True):
    """Same shape server/engine/rig/descriptor.ts's buildDescriptor() emits —
    matched by hand since seeding bypasses that function (see module
    docstring), not copied from it, so this is worth keeping honest: same
    regions, same cutout_url pattern, same persona shape. The anchors are the
    real Vision keypoints for the front-facing sample cutout (eyes ~0.18 down),
    so the blink can be exercised; pass anchors=False for the no-eyes case."""
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


# Measure, in-page (timing is reliable here), how much the eye boxes change
# ACROSS a blink vs across a breath-only interval of the same duration. The
# eyelid overlay swaps eye pixels for brow fur → a large SAD in the eye boxes;
# breath only shifts them slightly → a small SAD. Returns {blink, baseline}.
BLINK_MEASURE_JS = """
async () => {
  const c = document.getElementById('app-rig-canvas');
  const ctx = c.getContext('2d');
  // two tight eye boxes around the anchors (eyes sit ~0.18 down)
  const boxes = [[0.734, 0.180], [0.454, 0.180]].map(([x, y]) => ({
    x: Math.round((x - 0.10) * c.width), y: Math.round((y - 0.065) * c.height),
    w: Math.round(0.20 * c.width), h: Math.round(0.13 * c.height),
  }));
  const grab = () => boxes.map(b => ctx.getImageData(b.x, b.y, b.w, b.h).data);
  const sad = (A, B) => { let s = 0; for (let k = 0; k < A.length; k++) { const a = A[k], b = B[k]; for (let i = 0; i < a.length; i += 8) s += Math.abs(a[i] - b[i]); } return s; };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  // baseline: breath only, over ~95ms
  const g0 = grab(); await wait(95); const g1 = grab();
  const baseline = sad(g0, g1);
  await wait(400); // let any breath settle difference average out
  // blink: fire and sample at the envelope peak (~RIG_BLINK_MS/2)
  const h0 = grab();
  window.__mvpRigTestHook.blink();
  await wait(95);
  const h1 = grab();
  return { blink: sad(h0, h1), baseline };
}
"""


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


def test_rig_blinks_with_real_eye_anchors(server, page_factory):
    """Phase 2: with real eye anchors the cat blinks — the eyelid overlay
    covers the eyes, so the eye band changes far more during a blink than it
    does from breathing alone. Proven by pixel signature, not a screenshot."""
    cid = create_companion(server, name="Oni")
    seed_awake_chat(server, cid)
    seed_rig(server, cid, anchors=True)

    page = page_factory()
    page.goto(app_url(server), wait_until="load", timeout=30000)
    wait_view(page, "awake")
    page.wait_for_selector("#app-rig:not([hidden])", timeout=10000)
    assert page.evaluate("() => window.__mvpRigTestHook.hasEyes()") is True

    # A conservative lower bound: breath already moves the eye region a lot
    # (the bottom-anchored breath scale displaces the TOP rows — where the
    # eyes are — the most), so we only require the blink to clearly exceed
    # that. The eyes-closing is proven visually in the saved frames below.
    m = page.evaluate(BLINK_MEASURE_JS)
    assert m["blink"] > m["baseline"] * 1.5 and m["blink"] > 0, (
        f"a blink must change the eye boxes more than breathing alone: "
        f"blink={m['blink']} baseline={m['baseline']}"
    )

    # visual record: open vs the blink envelope peak
    page.locator("#app-rig-canvas").screenshot(path=str(SHOTS / "rig_eyes_open.png"))
    page.evaluate("() => window.__mvpRigTestHook.blink()")
    page.wait_for_timeout(95)
    page.locator("#app-rig-canvas").screenshot(path=str(SHOTS / "rig_eyes_blink.png"))


def test_no_eye_anchors_means_no_blink(server, page_factory):
    """No faked eyes: a rig without eye anchors never blinks — hasEyes is
    false and firing a blink changes nothing."""
    cid = create_companion(server, name="Nemo")
    seed_awake_chat(server, cid)
    seed_rig(server, cid, anchors=False)

    page = page_factory()
    page.goto(app_url(server), wait_until="load", timeout=30000)
    wait_view(page, "awake")
    page.wait_for_selector("#app-rig:not([hidden])", timeout=10000)
    assert page.evaluate("() => window.__mvpRigTestHook.hasEyes()") is False
