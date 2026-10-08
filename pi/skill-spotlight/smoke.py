"""Isolated real-TUI smoke. Requires Pi, tmux and Python; never submits a model prompt."""
import json
import os
import shlex
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EXTENSION = Path(__file__).with_name("pi-skill-spotlight.ts")


def main():
    for command in ("pi", "tmux"):
        if shutil.which(command) is None:
            raise SystemExit(f"{command} is required")
    artifacts = ROOT / ".artifacts"
    artifacts.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="spotlight-smoke-", dir=artifacts) as temporary:
        root = Path(temporary)
        home, agent, work = (root / name for name in ("home", "agent", "work"))
        for directory in (home, agent, work):
            directory.mkdir()
        skill = agent / "skills/spotlight-fixture"
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text("---\nname: spotlight-fixture\ndescription: Learn one available skill without loading it.\n---\nSPOTLIGHT_BODY_MUST_NOT_LOAD\n")
        (agent / "settings.json").write_text(json.dumps({"defaultProjectTrust": "never", "enableInstallTelemetry": False,
                                                       "quietStartup": False, "collapseChangelog": True}))
        resumed = root / "resumed.jsonl"
        resumed.write_text(json.dumps({"type": "session", "version": 3, "id": str(uuid.uuid4()),
                                       "timestamp": "2026-01-01T00:00:00Z", "cwd": str(work)}) + "\n")
        env = {"HOME": str(home), "PATH": os.environ["PATH"], "TERM": "xterm-256color",
               "PI_CODING_AGENT_DIR": str(agent), "PI_SKIP_VERSION_CHECK": "1", "PI_OFFLINE": "1",
               "PI_TELEMETRY": "0", "PI_SKILL_SPOTLIGHT": "1"}
        socket = str(root / "tmux.sock")

        def tmux(*args, check=True):
            return subprocess.run(["tmux", "-S", socket, *args], env=env, text=True,
                                  capture_output=True, timeout=10, check=check).stdout

        def wait_screen(name, predicate):
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                screen = tmux("capture-pane", "-p", "-t", name)
                if predicate(screen):
                    assert "Failed to load extension" not in screen, screen
                    assert "SPOTLIGHT_BODY_MUST_NOT_LOAD" not in screen, screen
                    return screen
                time.sleep(0.05)
            raise AssertionError(f"{name}: screen did not settle\n{screen}")

        base = ["pi", "--offline", "--no-extensions", "-e", str(EXTENSION), "--no-context-files",
                "--no-tools", "--no-approve", "--no-themes", "--no-prompt-templates", "--verbose"]
        try:
            for name, enabled, extra in (("fresh", "1", []), ("disabled", "0", []),
                                         ("resumed", "1", ["--session", str(resumed)])):
                command = shlex.join(["env", f"PI_SKILL_SPOTLIGHT={enabled}", *base, *extra])
                tmux("-f", "/dev/null", "new-session", "-d", "-s", name, "-x", "120", "-y", "55", "-c", str(work), command)
                screen = wait_screen(name, lambda value: "[Skills]" in value and "spotlight-fixture" in value)
                # A stable second frame catches extension/resource initialization completion.
                time.sleep(0.4)
                screen = tmux("capture-pane", "-p", "-t", name)
                if name == "fresh":
                    assert screen.count("Skill spotlight") == 1, screen
                    assert screen.index("[Skills]") < screen.index("Skill spotlight"), screen
                    assert "/skill:spotlight-fixture" in screen, screen
                    assert "Learn one available skill without loading it." in screen, screen
                    print("TUI PASS: header/resources precede one tip; skill body not loaded.")
                else:
                    assert "Skill spotlight" not in screen, screen
                    print(f"TUI PASS: {name} session has no tip.")
            tmux("resize-window", "-t", "fresh", "-x", "36", "-y", "55")
            wait_screen("fresh", lambda value: "Skill spotlight" in value)
            tmux("send-keys", "-t", "fresh", "/reload", "Enter")
            wait_screen("fresh", lambda value: "Reloaded" in value and "Skill spotlight" not in value)
            print("TUI PASS: narrow resize and reload suppress repeat without a model turn.")
            process = subprocess.Popen([*base, "--mode", "rpc"], cwd=work, env=env,
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                try:
                    out, err = process.communicate('{"id":"probe","type":"get_commands"}\n', timeout=3)
                except subprocess.TimeoutExpired:
                    process.terminate()
                    out, err = process.communicate(timeout=5)
                assert '"id":"probe"' in out and '"success":true' in out, out + err
                assert "setWidget" not in out and "Skill spotlight" not in out, out
                assert "Failed to load extension" not in err, err
                print("RPC PASS: commands available, no spotlight UI output.")
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
        finally:
            tmux("kill-server", check=False)
    print("Skill spotlight smoke PASS; isolated home/settings, no provider requests or live installation changes.")


if __name__ == "__main__":
    main()
