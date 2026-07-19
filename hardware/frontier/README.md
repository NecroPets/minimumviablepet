# frontier/ — the honest edge (Tier 4)

**Where the movie shot is actually being approached by real research, what
you can build of it today, and the physics wall behind all of it. Nothing in
this folder projects your pet. It exists so this repo never has to lie to
you about what could.**

## The physics wall, stated once

"Hard light" — photons you can touch — is not an engineering gap, it is a
physics violation. Light is massless and does not meaningfully interact with
itself at everyday energies; solidity is electron clouds repelling each
other, and a photon brings no electrons. The nearest real science is
Rydberg-polariton work ("photonic molecules": photons briefly interacting
*inside* an ultracold atomic medium) — microscopic, cryogenic, inseparable
from its apparatus. No emitter design routes around this. Anyone selling
you one is selling you the word "hologram."

What research actually does is keep the rule every tier in this repo obeys —
**light needs matter to land on** — and shrink the matter until you stop
noticing it:

| approach | the matter | scale today | can you feel it? |
|---|---|---|---|
| optical trap display (BYU, *Nature* 2018) | one laser-trapped dust-sized particle, swept fast | ~cm³, single figure | no |
| femtosecond plasma voxels ("Fairy Lights", 2015) | air, briefly ionized | ~cm³, sparkles | yes — as tingling plasma pops |
| acoustic trap display (Sussex, *Nature* 2019) | a levitated 1–2 mm bead, swept fast | ~cm³ | yes — ultrasound haptics from the same array |
| ultrasound mid-air haptics (Ultraleap, shipping) | your own skin | palm-sized | yes — that's all it does |

The Sussex device is the closest thing to a Joi emanator on Earth: image,
touch, and sound from one ultrasound phased array. It draws a butterfly,
centimeters tall, in a lab. That is the honest state of the art.

## What is genuinely home-buildable: the phased array itself

A 16×16 grid of 40 kHz ultrasonic transducers, each driven with an
individually phase-shifted square wave, makes a steerable acoustic focal
point: enough to levitate polystyrene beads, push a focal spot you can feel
on your palm, and — at the bleeding edge — sweep a bead fast enough to trace
a small glowing outline under RGB light.

[`phased-array-architecture.svg`](phased-array-architecture.svg) is the
block architecture. The phase math is one line: for focal point **F**,
each transducer *i* at distance *dᵢ* fires with delay
**τᵢ = (dᵢ − d_min) / c**, c = 343 m/s. Everything else is drive
electronics.

**BOM sketch (~$300–700):** 256× 10 mm 40 kHz transducers (the MA40S4S
class), a controller that can hold 256 phase-locked outputs (Teensy 4.1 +
shift-register boards, or an FPGA dev board), half-bridge drivers, a 12–24 V
supply, and a rigid drilled grid plate. Days of soldering. It will be loud
to every animal in the house — see the warning below.

**This repo ships no phased-array firmware, on purpose.** The maintained
open implementations are further along than anything we would write from
scratch: **OpenMPD** (UCL's multimodal particle display framework) and
**SonicSurface** (open 16×16 hardware). Build on those; that's what open
source is for. If you get a bead tracing shapes over your kitchen table,
send photos.

## The warning that matters in *this* repo

40 kHz is silent to you and **not silent to animals**. Dogs hear to ~45 kHz,
cats to ~64 kHz, and a phased array's grating lobes and subharmonics leak
audible-to-them energy. If a living animal shares your home, an ultrasound
array is a rude houseguest — keep sessions short, keep the array pointed
away from where they rest, and watch their ears the first time. This
product exists because someone loved an animal; the hardware folder will
not injure the ones still here.

## Where this leaves the pet

For a shape you can see across the room tonight: Tier 2's scrim. For the
research bench: this folder. For photons you can pet: nowhere, and we will
keep saying so. The roadmap's photo-to-motion item remains the honest next
software step — real, local, and unshipped until it's real.
