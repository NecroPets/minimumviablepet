# pan-tilt firmware (ESP32, MicroPython)

Reference implementation for the Tier 3 ceiling rig. Two files, no
dependencies beyond MicroPython itself, no cloud: the board is its own WiFi
access point and speaks to nothing else, in the same spirit as the engine's
127.0.0.1.

**Honesty label:** written and reviewed with care; syntax and template
formatting are machine-checked in this repo, but the maintainers could not
flash servos from CI. You are the hardware test. Bench-test before anything
goes overhead — the steps below are the safety procedure, not a suggestion.

## Flash

```sh
# once: put MicroPython on the board (esptool.py, firmware from micropython.org/download/esp32)
esptool.py --chip esp32 erase_flash
esptool.py --chip esp32 write_flash -z 0x1000 ESP32_GENERIC-*.bin

# every config change: copy both files
pip install mpremote
mpremote cp config.py :config.py
mpremote cp main.py :main.py
mpremote reset
```

## Bench test (projector OFF the bracket)

1. Edit `config.py`: set `AP_PASSWORD`, leave the wide default limits.
2. Power servos from their own 5–6 V supply (wiring: `../..//schematics/pan-tilt-wiring.svg`).
3. Join the `mvp-emanator` network, open `http://192.168.4.1/`.
4. Sweep slowly. Note the angles where the bracket, cables, or mount would
   bind or collide — back each off by 5° and write them into
   `PAN_MIN/PAN_MAX/TILT_MIN/TILT_MAX`.
5. Re-copy `config.py`, reset, and confirm the sliders now refuse to go past
   the limits (`/status` shows the clamped targets).
6. Aim and save your `PRESETS`. Only then mount the projector.

## Behavior you can rely on

- Every request is clamped to the soft limits — there is no unclamped path.
- Motion is slew-limited (`SLEW_DEG_PER_S`, default 15°/s): nothing snaps.
- On boot it parks at `HOME_PAN/HOME_TILT`, inside the limits, at slew speed.
- Bad input gets a 400 with the reason. Unknown presets are named back at
  you with the list of ones that exist. Nothing is silently ignored.
- A password shorter than WPA2's minimum refuses to boot rather than
  degrading to an open network.
