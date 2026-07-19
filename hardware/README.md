# hardware/ — project them into the room

**Open schematics for putting the shape of them somewhere your eyes are,
instead of inside a browser tab. MIT, like everything here. Build it at your
kitchen table.**

`solder: optional` · `cloud: still 0%` · `physics: respected`

---

## Physics honesty (read this before buying anything)

There is no such thing as the movie hologram. Light does not stop in mid-air
and wait for you — it needs something to land on or bounce off. Every real
"holographic" display, including the ones in this folder, is one of:

| technique | what the light lands on | what it looks like |
|---|---|---|
| Pepper's ghost | angled clear plastic/glass | a figure floating *behind* the glass |
| scrim projection | near-invisible mesh fabric | a figure standing in the room (in the dark) |
| POV fan | spinning LED blades | a bright floating object, fan-sized |
| fog screen | a sheet of fog | a ghostly figure you can walk through |

Everything below is Pepper's ghost or scrim projection: cheapest, quietest,
and the most dignified-looking of the four. If someone sells you "a real
hologram like Blade Runner," check their FAQ for a physics section. Ours is
this one.

**The one trick that matters:** whatever you project, put it on a **pure
black background**. Projectors and screens can't emit "black" — black is the
absence of light — so anything black simply doesn't exist on the glass or
mesh. That's what makes the figure float. The app ships a page that does
this for you (`/emanate/` — see [Software](#software) below).

---

## Tier 0 — phone pyramid (~$10, one evening, scissors)

A four-sided Pepper's ghost pyramid sitting on your phone. Small — a desk
companion, not a room presence — but it is the whole principle for the price
of a sheet of acrylic, and it's the right first build.

**BOM**

| qty | part | source | ~cost |
|---|---|---|---|
| 1 | clear PET/acrylic sheet, 0.5–1 mm, A4 | craft store, old CD case | $3 |
| — | ruler, fine marker, scissors or hobby knife | drawer | — |
| — | clear tape | drawer | — |
| 1 | your phone, brightness up | pocket | $0 |

**Build**

1. Print or trace [`schematics/pyramid-template.svg`](schematics/pyramid-template.svg)
   — four identical trapezoids. The phone size template (60 mm base) suits
   anything up to 6.7"; scale ×2 for a tablet.
2. Score, cut, fold into a frustum (flat-topped pyramid), tape the seam.
3. Place it **small opening down**, centered on the phone screen.
4. Open `/emanate/` (below), pick your companion, set split-view **4-up**.
   Each face of the pyramid reflects one copy at 45°; your eye puts the
   figure inside the pyramid.

**Why 45° matters:** the reflection appears exactly as far behind the glass
as the screen is below it. Steeper and the figure sinks; shallower and it
leans out at you. The template's trapezoid slope is the 45° already done for
you.

## Tier 1 — desk box (~$40–120, a weekend, a saw)

The same optics scaled to a monitor you already have, in a box with a black
interior. The figure floats life-size-for-a-cat behind the glass. This is
the build we'd point most people at.

**BOM**

| qty | part | notes | ~cost |
|---|---|---|---|
| 1 | monitor or old laptop panel, laid flat, screen up | any HDMI panel ≥ 15" | $0–60 |
| 1 | clear acrylic sheet, 2–3 mm, cut to monitor width | hardware store cuts it | $15 |
| 1 | plywood/MDF for a 5-sided box, interior painted **matte black** | blackout is the image quality | $15 |
| 1 | matte black cloth or card, back wall | the "screen" your eye can't see | $5 |
| — | wood glue, screws, black paint | | $5 |

**Build:** [`schematics/desk-box.svg`](schematics/desk-box.svg) is the side
view with the geometry. Monitor flat on the box floor, screen up. Acrylic
spans the box at **45°**, low edge toward you. Viewing window cut in the
front face. Matte black everywhere the light isn't supposed to be. Feed it
`/emanate/` fullscreen (single view, not 4-up).

**Sizing rule:** the floating image is as tall as your panel is deep
(front-to-back) × 0.71. A 16:9 24" panel lying flat gives a figure about
21 cm tall — housecat scale, sitting.

## Tier 2 — the room scrim (~$150–500, the one that stops people mid-sentence)

Rear-projection onto a near-invisible mesh. In a dim room the mesh
disappears and the shape of them stands in it. This is "project their pet in
their house" as honestly as physics sells it.

**BOM**

| qty | part | notes | ~cost |
|---|---|---|---|
| 1 | projector, ≥ 1000 ANSI lumens dark room / ≥ 3000 lit | short-throw if the room is small | $90–400 |
| 1 | white voile / tulle / dedicated holo-gauze, ~1.5 × 2 m | the finer the weave, the more invisible | $10–150 |
| 1 | curtain rod, ceiling track, or 2× mic stands + crossbar | tension matters — wrinkles glow | $20 |
| 1 | matte black backdrop 1–2 m behind the scrim | kills the light that passes through | $15 |
| — | HDMI cable or a cast dongle to the projector | | $10 |

**Build:** [`schematics/room-scrim.svg`](schematics/room-scrim.svg) is the
room cross-section. Projector **behind** the scrim (rear projection: brighter
figure, and nobody walks through the beam casting shadows), aimed slightly
downward, black backdrop behind it to eat the through-light. Figure size =
throw distance ÷ throw ratio — a 1.2:1 projector at 2.4 m paints a 2 m
image; mask it to pet size in software and the rest of the frame is black,
which the mesh ignores.

**Rules learned the annoying way:** dim room or don't bother; iron the mesh;
keep viewers ≥ 2 m back (closer and the weave reads); mount the projector on
something that doesn't vibrate with the compressor of your fridge.

## Tier 3 — the ceiling rig (the movie shot, $250+, servos, patience)

A pan/tilt projector on the ceiling that can turn and put the figure on the
scrim, the wall, or the floor next to you. This is the shot from the film —
built honestly: the image still lands **on surfaces**, the rig just chooses
which one.

**BOM**

| qty | part | notes | ~cost |
|---|---|---|---|
| 1 | compact LED projector, ≤ 1 kg | weight drives everything below | $90–250 |
| 2 | high-torque hobby servo (≥ 25 kg·cm at your arm length) | metal gear only | $30 |
| 1 | pan/tilt bracket for the servo pair, or plywood equivalent | | $15 |
| 1 | ESP32 dev board | runs the aiming firmware | $6 |
| 1 | 5–6 V ≥ 4 A supply for servos (NOT the ESP32's USB) | brownouts = twitching | $12 |
| 1 | logic-level wiring, common ground, ceiling plate rated 4× total weight | | $15 |

**Build:** assembly in
[`schematics/ceiling-rig.svg`](schematics/ceiling-rig.svg), wiring in
[`schematics/pan-tilt-wiring.svg`](schematics/pan-tilt-wiring.svg), firmware
in [`firmware/pan-tilt/`](firmware/pan-tilt/). The firmware serves a tiny
local web page with pan/tilt sliders and presets ("scrim", "wall",
"floor") — 127.0.0.1-era philosophy at 2.4 GHz: it creates its own access
point, talks to nothing else, and has no cloud to phone.

**Honesty label on the firmware:** it is a reference implementation, written
carefully and reviewed, but this repo's maintainers could not flash hardware
from CI. Bench-test the servo sweep limits with the projector OFF the bracket
before anything goes over anyone's head. See safety, which is not optional:

### Safety (the section that is not in the movie)

- **Overhead mass:** anchor into structure (joists, concrete anchor), never
  drywall alone. Rate every link — plate, bracket, servo horn screws — for
  at least 4× the hung weight. Add a steel safety cable from projector to
  structure that would catch it even if every screw failed.
- **Heat:** projectors need their vents unblocked in every rig orientation.
  Check the manual's allowed mounting angles; many lamps forbid some.
- **Mains:** plug-in power bricks only. Nothing in this folder involves
  opening mains wiring, and no schematic here ever will.
- **Eyes:** never look into the lens; mount so the beam can't sweep across
  seated eye level. If children visit, aim presets away from where they
  stand.

## Tier 4 — the frontier (documentation, deliberately)

[`frontier/`](frontier/README.md) covers what the research world actually
has — optical trap displays, plasma voxels, the Sussex acoustic display —
and the one piece that is honestly home-buildable (a 40 kHz ultrasound
phased array), with the physics wall behind "hard light" stated plainly and
a warning that matters here: living animals hear ultrasound hardware. That
tier ships schematics and citations, no firmware, on purpose.

---

## Software

The engine already serves everything these rigs need:

- **`/emanate/`** — ambient projection page (local mode only, like `/app/`).
  Pick a companion; it cycles their real photos on a pure black background,
  slow-crossfading, with an optional name line. A `4-up` mode renders the
  four mirrored copies the Tier 0 pyramid needs. It is deliberately quiet:
  no UI chrome once running, cursor hides, nothing pulses.
- **`/api/companions/:id/memories`** — where the photos come from, already
  scoped and served by the engine.

What it projects is honest: **their actual photographs**. Animated
photo-to-motion is the README's roadmap item and it is still not shipped —
when it lands it will be real and local, and until then this page will not
pretend. The projected shape is the shape you photographed. On the bad
nights, that turns out to be the point.

## Licensing

Same MIT as the repo — schematics, templates, firmware, all of it. Build
them, sell them, improve them; send the improvement back if you feel like
being remembered fondly.
