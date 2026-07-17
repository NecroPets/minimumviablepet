"""CLI tests: the real `bun cli/mvp.ts` as a subprocess against the real
server. Exit codes are part of the contract."""
import json
import subprocess
from pathlib import Path

import pytest

from conftest import spawn_server
from test_api_ingest import STORY

ROOT = Path(__file__).resolve().parent.parent


def mvp(server, *args, stdin=None, timeout=120):
    return subprocess.run(
        ["bun", str(ROOT / "cli" / "mvp.ts"), "--server", server.base_url, *args],
        capture_output=True, text=True, input=stdin, timeout=timeout,
    )


def test_list_empty_and_exit_0(server):
    r = mvp(server, "list")
    assert r.returncode == 0
    assert "no companions found" in r.stdout
    assert "this machine has room for someone" in r.stdout


def test_init_then_list_json(server):
    r = mvp(server, "init", "Kernel")
    assert r.returncode == 0, r.stderr
    assert 'creating companion "Kernel"' in r.stdout
    assert "mvp run kernel" in r.stdout

    r = mvp(server, "list", "--json")
    assert r.returncode == 0
    companions = json.loads(r.stdout)
    assert [c["name"] for c in companions] == ["Kernel"]
    assert companions[0]["state"] == "interviewing"


def test_init_duplicate_exit_3(server):
    assert mvp(server, "init", "Kernel").returncode == 0
    r = mvp(server, "init", "kernel")
    assert r.returncode == 3
    assert "already exists" in r.stderr


def test_unknown_companion_exit_4(server):
    r = mvp(server, "train", "ghost")
    assert r.returncode == 4
    assert 'no companion called "ghost"' in r.stderr


def test_server_down_exit_2_with_hint():
    class Dead:
        base_url = "http://127.0.0.1:9"

    r = mvp(Dead, "list")
    assert r.returncode == 2
    assert "can't reach the engine" in r.stderr
    assert "mvp serve" in r.stderr


def test_train_unmet_bar_exit_3_with_checklist(server):
    assert mvp(server, "init", "Mochi").returncode == 0
    r = mvp(server, "train", "mochi")
    assert r.returncode == 3
    assert "build refused" in r.stdout
    assert "✗ stories" in r.stdout
    assert "Tell me a story" in r.stdout  # the hint rides along


def test_status_reports_engine_and_models(server):
    r = mvp(server, "status")
    assert "engine .... ok" in r.stdout
    assert "ollama ...." in r.stdout


def test_ingest_story_progress_lines(server, tmp_path, ollama_embed_up):
    if not ollama_embed_up:
        pytest.skip("embed required")
    assert mvp(server, "init", "Kernel").returncode == 0
    story = tmp_path / "standup.md"
    story.write_text(STORY)
    r = mvp(server, "ingest", "kernel", str(story), timeout=300)
    assert r.returncode == 0, r.stderr
    assert "✓ standup.md" in r.stdout

    # duplicate ingest is friendly
    r = mvp(server, "ingest", "kernel", str(story), timeout=300)
    assert r.returncode == 0
    assert "already known" in r.stdout


def test_ingest_missing_file_exit_5(server):
    assert mvp(server, "init", "Kernel").returncode == 0
    r = mvp(server, "ingest", "kernel", "/nonexistent/file.png")
    assert r.returncode == 5
    assert "no such file" in r.stdout


def test_unknown_command_usage_exit_1(server):
    r = mvp(server, "frobnicate")
    assert r.returncode == 1
    assert "unknown command" in r.stderr
    assert "usage:" in r.stderr

    r = mvp(server, "--help")
    assert r.returncode == 0
    assert "usage:" in r.stdout


def test_run_pipe_mode_streams_reply(server, ollama_up):
    if not ollama_up:
        pytest.skip("live chat model required")
    assert mvp(server, "init", "Kernel").returncode == 0
    r = mvp(server, "run", "kernel", stdin="Her name was Kernel, a gray tabby.", timeout=400)
    assert r.returncode == 0, r.stderr
    assert len(r.stdout.strip()) > 10, "the interviewer's reply streams to stdout"
