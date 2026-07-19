# pan/tilt emanator rig — configuration.
# Edit this file, copy both files to the board, done. No cloud, no accounts:
# the rig is its own WiFi access point and speaks to nothing else.

# --- access point -----------------------------------------------------------
AP_SSID = "mvp-emanator"
AP_PASSWORD = "shape-of-them"   # CHANGE THIS. 8+ chars (WPA2 minimum).

# --- pins -------------------------------------------------------------------
PAN_PIN = 18
TILT_PIN = 19

# --- servo pulse calibration (microseconds) ---------------------------------
# 500..2500 us is the common hobby-servo range; narrow it if yours buzzes at
# the ends. These map to 0..180 degrees.
PULSE_MIN_US = 500
PULSE_MAX_US = 2500

# --- soft limits (degrees) --------------------------------------------------
# Set these DURING THE BENCH TEST, with the projector OFF the bracket:
# sweep slowly, note where the bracket, cables, or ceiling would collide,
# and back off 5 degrees. The firmware clamps every request to these.
PAN_MIN = 20
PAN_MAX = 160
TILT_MIN = 35
TILT_MAX = 120

# --- motion -----------------------------------------------------------------
# Max slew rate in degrees/second. Slow is the point: nothing overhead should
# ever snap. 15 deg/s crosses a room's worth of wall in ~6 s.
SLEW_DEG_PER_S = 15

# Where the rig parks on boot (must be inside the soft limits).
HOME_PAN = 90
HOME_TILT = 90

# --- presets ----------------------------------------------------------------
# name -> (pan_deg, tilt_deg). Aim them during setup; keep every preset
# pointing where a beam can never sweep seated eye level.
PRESETS = {
    "scrim": (90, 75),
    "wall": (140, 80),
    "floor": (90, 115),
}
