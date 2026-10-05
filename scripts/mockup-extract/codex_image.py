"""Run Codex's image generation on a reference picture, using this Mac's Codex sign-in."""

from __future__ import annotations

import subprocess
import threading
import time
from pathlib import Path

CODEX_MODEL = "gpt-5.6-sol"
CODEX_TIMEOUT_S = 900
TAIL_LINES = 3
# Codex sessions that start at the same moment can stall before they begin, so starts are spaced out.
START_GAP_S = 20
# Codex is an agent: without this it reads instruction files and starts helpers before drawing.
DIRECTLY = " Do this directly: generate the image straight away, without reading any other files or starting sub-agents."

_start_lock = threading.Lock()
_last_start = [0.0]


def _wait_for_turn() -> None:
    with _start_lock:
        wait = _last_start[0] + START_GAP_S - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        _last_start[0] = time.monotonic()


def generate_image(work: Path, reference: Path, prompt: str, out_name: str) -> tuple[Path | None, str]:
    """Ask Codex (sandboxed to `work`) for an image; the prompt must tell it to copy the result to ./out_name.
    Returns the image's path, or None and why none came back."""
    _wait_for_turn()
    try:
        result = subprocess.run(
            ["codex", "exec", "-m", CODEX_MODEL, "--skip-git-repo-check", "--sandbox", "workspace-write",
             "-C", str(work), "-i", str(reference), "--json", prompt + DIRECTLY],
            capture_output=True, text=True, timeout=CODEX_TIMEOUT_S, stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired:
        return None, f"Codex took longer than {CODEX_TIMEOUT_S} s"
    made = work / out_name
    if made.exists():
        return made, ""
    return None, " | ".join((result.stdout + result.stderr).strip().splitlines()[-TAIL_LINES:])
