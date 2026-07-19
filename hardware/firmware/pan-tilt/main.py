# pan/tilt emanator rig — MicroPython (ESP32).
#
# REFERENCE IMPLEMENTATION, HONESTLY LABELED: written and reviewed with care,
# but this repo's maintainers cannot flash hardware from CI. Bench-test the
# sweep with the projector OFF the bracket, set the soft limits in config.py,
# and only then hang anything over anyone's head. Safety notes: hardware/README.md.
#
# What it does, completely and only:
#   - brings up a WPA2 access point (nothing leaves it, ever)
#   - serves one control page with pan/tilt sliders + the config.py presets
#   - GET /set?pan=<deg>&tilt=<deg>   -> clamped to soft limits, slew-limited
#   - GET /preset?name=<name>         -> same, from config.PRESETS
#   - GET /status                     -> JSON of where it is and where it's going
# Bad input answers 400 with the reason; nothing is silently ignored.

import json
import socket
import time

import network
from machine import PWM, Pin, Timer

import config

TICK_MS = 20  # servo update period; also the slew integrator step


def clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v


class SlewedServo:
    """A hobby servo that refuses to snap: position moves toward the target
    at most config.SLEW_DEG_PER_S, updated every TICK_MS by a hardware timer."""

    def __init__(self, pin, lo, hi, home):
        self.lo = lo
        self.hi = hi
        self.pos = float(clamp(home, lo, hi))
        self.target = self.pos
        self.pwm = PWM(Pin(pin), freq=50)
        self._write(self.pos)

    def _write(self, deg):
        span = config.PULSE_MAX_US - config.PULSE_MIN_US
        us = config.PULSE_MIN_US + span * (deg / 180.0)
        self.pwm.duty_ns(int(us * 1000))

    def aim(self, deg):
        self.target = float(clamp(deg, self.lo, self.hi))
        return self.target

    def tick(self):
        step = config.SLEW_DEG_PER_S * (TICK_MS / 1000.0)
        if self.pos < self.target:
            self.pos = min(self.pos + step, self.target)
        elif self.pos > self.target:
            self.pos = max(self.pos - step, self.target)
        self._write(self.pos)


pan = SlewedServo(config.PAN_PIN, config.PAN_MIN, config.PAN_MAX, config.HOME_PAN)
tilt = SlewedServo(config.TILT_PIN, config.TILT_MIN, config.TILT_MAX, config.HOME_TILT)

timer = Timer(0)
timer.init(period=TICK_MS, mode=Timer.PERIODIC, callback=lambda t: (pan.tick(), tilt.tick()))


PAGE = """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mvp emanator rig</title>
<style>
 body{background:#000;color:#9ab89f;font-family:ui-monospace,monospace;padding:24px;max-width:480px;margin:auto}
 h1{color:#3fe28f;font-size:16px;font-weight:500}
 label{display:block;margin-top:18px;font-size:13px}
 input[type=range]{width:100%%}
 .presets{margin-top:22px;display:flex;gap:8px;flex-wrap:wrap}
 button{background:#0d1117;border:1px solid #1d2a22;color:#9ab89f;font:inherit;padding:8px 14px;border-radius:6px}
 button:hover{border-color:#3fe28f}
 #st{margin-top:20px;font-size:12px;color:#56705c;white-space:pre}
</style></head><body>
<h1>$ mvp emanator rig</h1>
<label>pan <span id="pv"></span>&deg;
 <input id="pan" type="range" min="%d" max="%d" value="%d"></label>
<label>tilt <span id="tv"></span>&deg;
 <input id="tilt" type="range" min="%d" max="%d" value="%d"></label>
<div class="presets">%s</div>
<div id="st"></div>
<script>
const pan=document.getElementById('pan'),tilt=document.getElementById('tilt');
const pv=document.getElementById('pv'),tv=document.getElementById('tv');
function labels(){pv.textContent=pan.value;tv.textContent=tilt.value}
labels();
let t=null;
function send(){clearTimeout(t);t=setTimeout(async()=>{
 const r=await fetch(`/set?pan=${pan.value}&tilt=${tilt.value}`);
 document.getElementById('st').textContent=JSON.stringify(await r.json(),null,1);
},120)}
pan.oninput=()=>{labels();send()};tilt.oninput=()=>{labels();send()};
async function preset(n){const r=await fetch(`/preset?name=${n}`);
 const j=await r.json();if(j.ok){pan.value=j.pan_target;tilt.value=j.tilt_target;labels()}
 document.getElementById('st').textContent=JSON.stringify(j,null,1)}
setInterval(async()=>{const r=await fetch('/status');
 document.getElementById('st').textContent=JSON.stringify(await r.json(),null,1)},2000);
</script></body></html>"""


def render_page():
    buttons = "".join(
        '<button onclick="preset(\'%s\')">%s</button>' % (name, name) for name in config.PRESETS
    )
    return PAGE % (
        config.PAN_MIN, config.PAN_MAX, int(pan.target),
        config.TILT_MIN, config.TILT_MAX, int(tilt.target),
        buttons,
    )


def status_body():
    return {
        "ok": True,
        "pan": round(pan.pos, 1), "pan_target": pan.target,
        "tilt": round(tilt.pos, 1), "tilt_target": tilt.target,
        "limits": {"pan": [config.PAN_MIN, config.PAN_MAX], "tilt": [config.TILT_MIN, config.TILT_MAX]},
        "slew_deg_per_s": config.SLEW_DEG_PER_S,
    }


def parse_query(path):
    if "?" not in path:
        return {}
    out = {}
    for pair in path.split("?", 1)[1].split("&"):
        if "=" in pair:
            k, v = pair.split("=", 1)
            out[k] = v
    return out


def respond(conn, code, content_type, body):
    reason = {200: "OK", 400: "Bad Request", 404: "Not Found"}[code]
    conn.send("HTTP/1.0 %d %s\r\nContent-Type: %s\r\nConnection: close\r\n\r\n" % (code, reason, content_type))
    conn.send(body)


def handle(conn, path):
    if path == "/" or path.startswith("/?"):
        respond(conn, 200, "text/html", render_page())
        return
    if path.startswith("/status"):
        respond(conn, 200, "application/json", json.dumps(status_body()))
        return
    if path.startswith("/set"):
        q = parse_query(path)
        try:
            pan_deg = float(q["pan"])
            tilt_deg = float(q["tilt"])
        except (KeyError, ValueError):
            respond(conn, 400, "application/json",
                    json.dumps({"ok": False, "error": "need numeric pan=&tilt=, e.g. /set?pan=90&tilt=80"}))
            return
        pan.aim(pan_deg)
        tilt.aim(tilt_deg)
        respond(conn, 200, "application/json", json.dumps(status_body()))
        return
    if path.startswith("/preset"):
        name = parse_query(path).get("name", "")
        if name not in config.PRESETS:
            respond(conn, 400, "application/json",
                    json.dumps({"ok": False, "error": "unknown preset '%s' — have: %s" % (name, list(config.PRESETS))}))
            return
        p, t = config.PRESETS[name]
        pan.aim(p)
        tilt.aim(t)
        respond(conn, 200, "application/json", json.dumps(status_body()))
        return
    respond(conn, 404, "application/json", json.dumps({"ok": False, "error": "not_found"}))


def run():
    if len(config.AP_PASSWORD) < 8:
        raise ValueError("AP_PASSWORD must be 8+ characters (WPA2) — edit config.py")
    ap = network.WLAN(network.AP_IF)
    ap.active(True)
    ap.config(essid=config.AP_SSID, password=config.AP_PASSWORD, authmode=network.AUTH_WPA_WPA2_PSK)
    while not ap.active():
        time.sleep_ms(50)
    print("emanator rig up: ssid=%s ip=%s (open http://%s/)" % (config.AP_SSID, ap.ifconfig()[0], ap.ifconfig()[0]))

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("0.0.0.0", 80))
    server.listen(2)
    while True:
        conn, addr = server.accept()
        try:
            req = conn.recv(1024).decode()
            line = req.split("\r\n", 1)[0]
            parts = line.split(" ")
            if len(parts) >= 2 and parts[0] == "GET":
                handle(conn, parts[1])
            else:
                respond(conn, 400, "application/json", json.dumps({"ok": False, "error": "GET only"}))
        finally:
            conn.close()


run()
