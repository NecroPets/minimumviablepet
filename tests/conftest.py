"""Shared fixtures: a real bun server subprocess on an ephemeral port with a
temp SQLite DB, a real headless Chromium, and direct-DB inspection helpers.
Nothing under test is mocked."""
import json
import os
import pathlib
import socket
import sqlite3
import subprocess
import time
import urllib.error
import urllib.request

import pytest
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SERVER_TS = ROOT / "server" / "server.ts"
SHOTS = pathlib.Path(__file__).resolve().parent / "shots"
SHOTS.mkdir(exist_ok=True)

OLLAMA_BASE = "http://127.0.0.1:11434"
OLLAMA_MODEL = "glm-4.7-flash:q8_0"

VARIANT_PAGES = [
    ("necropets", "/necropets/"),
    ("minimumviablepet", "/minimumviablepet/"),
]


class ServerHandle:
    def __init__(self, base_url: str, port: int, db_path: pathlib.Path, proc: subprocess.Popen):
        self.base_url = base_url
        self.port = port
        self.db_path = db_path
        self.proc = proc

    def stop(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            self.proc.wait(timeout=5)


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def spawn_server(tmp_path, extra_env=None):
    port = free_port()
    db_path = tmp_path / "waitlist.db"
    env = {
        **os.environ,
        "PORT": str(port),
        "WAITLIST_DB": str(db_path),
        # every test server gets an isolated engine data dir — no test may
        # ever touch the real ~/.mvp
        "MVP_DATA_DIR": str(tmp_path / "mvp"),
        **(extra_env or {}),
    }
    proc = subprocess.Popen(
        ["bun", str(SERVER_TS)],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    base = f"http://127.0.0.1:{port}"
    deadline = time.time() + 5
    last_err = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(base + "/api/health", timeout=1) as r:
                if r.status == 200:
                    break
        except (urllib.error.URLError, ConnectionError, OSError) as e:
            last_err = e
            time.sleep(0.05)
    else:
        proc.terminate()
        raise RuntimeError(f"bun server did not become healthy on {base}: {last_err}")

    handle = ServerHandle(base, port, db_path, proc)
    handle.mvp_data_dir = tmp_path / "mvp"
    handle.mvp_db_path = tmp_path / "mvp" / "mvp.db"
    return handle


@pytest.fixture
def server(tmp_path):
    handle = spawn_server(tmp_path)
    yield handle
    handle.stop()


@pytest.fixture
def public_server(tmp_path):
    """The Railway posture: MVP_PUBLIC=1, engine never mounted."""
    handle = spawn_server(tmp_path, {"MVP_PUBLIC": "1"})
    yield handle
    handle.stop()


@pytest.fixture
def db_rows():
    def _rows(db_path):
        con = sqlite3.connect(db_path)
        try:
            cur = con.execute(
                "SELECT email, variant, referrer, user_agent, created_at FROM waitlist ORDER BY id"
            )
            cols = [c[0] for c in cur.description]
            return [dict(zip(cols, row)) for row in cur.fetchall()]
        finally:
            con.close()

    return _rows


@pytest.fixture(scope="session")
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        yield b
        b.close()


@pytest.fixture
def page_factory(browser):
    contexts = []

    def _make(**ctx_kwargs):
        kwargs = {"viewport": {"width": 1366, "height": 900}}
        kwargs.update(ctx_kwargs)
        ctx = browser.new_context(**kwargs)
        contexts.append(ctx)
        page = ctx.new_page()
        errors = {"console": [], "page": []}
        page.on(
            "console",
            lambda m: errors["console"].append(m.text) if m.type == "error" else None,
        )
        page.on("pageerror", lambda e: errors["page"].append(str(e)))
        page.collected_errors = errors
        return page

    yield _make
    for ctx in contexts:
        ctx.close()


@pytest.fixture(scope="session")
def ollama_up():
    """True only if the Ollama daemon answers AND the page's model is warm enough
    to reply well inside the page's 30s AbortController window."""
    try:
        with urllib.request.urlopen(OLLAMA_BASE + "/api/version", timeout=2) as r:
            if r.status != 200:
                return False
    except (urllib.error.URLError, ConnectionError, OSError):
        return False

    payload = json.dumps(
        {
            "model": OLLAMA_MODEL,
            "messages": [{"role": "user", "content": "hi"}],
            "stream": False,
            "options": {"num_predict": 1},
        }
    ).encode()
    req = urllib.request.Request(
        OLLAMA_BASE + "/api/chat",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return r.status == 200
    except (urllib.error.URLError, ConnectionError, OSError):
        return False


def post_waitlist(base_url, body, content_type="application/json"):
    """POST to /api/waitlist; returns (status, parsed_body, headers) without
    raising on 4xx/5xx."""
    data = body if isinstance(body, bytes) else json.dumps(body).encode()
    req = urllib.request.Request(
        base_url + "/api/waitlist",
        data=data,
        headers={"Content-Type": content_type},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read()), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read()), dict(e.headers)


@pytest.fixture
def waitlist_post():
    return post_waitlist
