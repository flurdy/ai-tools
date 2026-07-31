from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = Path(__file__).with_name("kitty-title.sh")
CASES = json.loads((ROOT / "shared/kitty/session-name-cases.json").read_text())


class KittyTitleTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.kitten_log = self.root / "kitten.log"
        kitten = self.bin / "kitten"
        kitten.write_text(
            "#!/usr/bin/env bash\nprintf '%s\\0' \"$@\" >> \"$KITTY_TEST_LOG\"\n"
        )
        kitten.chmod(0o755)
        self.cache = self.root / "cache"
        self.cache.mkdir(mode=0o700)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def git_repo(self, branch: str = "main") -> Path:
        repo = self.root / f"repo-{uuid.uuid4().hex[:8]}"
        repo.mkdir()
        subprocess.run(
            ["git", "init", "-q", "-b", "main"], cwd=repo, check=True
        )
        if branch != "main":
            subprocess.run(
                ["git", "checkout", "-q", "-b", branch], cwd=repo, check=True
            )
        return repo

    def transcript(self, session_id: str, entries: list[dict] | None = None) -> Path:
        path = self.root / f"{session_id}.jsonl"
        path.write_text(
            "".join(json.dumps(entry, ensure_ascii=False) + "\n" for entry in entries or [])
        )
        return path

    def run_title(
        self,
        event: str,
        cwd: Path,
        session_id: str,
        transcript: Path,
        *,
        extra_payload: dict | None = None,
        extra_env: dict[str, str] | None = None,
    ) -> str:
        self.kitten_log.unlink(missing_ok=True)
        payload = {
            "cwd": str(cwd),
            "session_id": session_id,
            "transcript_path": str(transcript),
            **(extra_payload or {}),
        }
        env = {
            **os.environ,
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "KITTY_TEST_LOG": str(self.kitten_log),
            "CLAUDE_KITTY_TITLE_CACHE_DIR": str(self.cache),
            "CLAUDE_KITTY_TITLE_LOG": str(self.root / "hook.log"),
            "SSH_TTY": "",
            "KITTY_TITLE_REPO_ALIAS": "",
            "KITTY_TITLE_HOST_ALIAS": "",
            **(extra_env or {}),
        }
        subprocess.run(
            ["bash", str(SCRIPT), event],
            input=json.dumps(payload),
            text=True,
            cwd=cwd,
            env=env,
            check=True,
        )
        parts = self.kitten_log.read_bytes().split(b"\0")
        self.assertGreaterEqual(len(parts), 4)
        return parts[-2].decode()

    def test_shared_session_name_normalization_contract(self) -> None:
        repo = self.git_repo("feature/AB-123-example")
        for fixture in CASES:
            with self.subTest(fixture["name"]):
                session_id = str(uuid.uuid4())
                transcript = self.transcript(
                    session_id,
                    [
                        {
                            "type": "custom-title",
                            "sessionId": session_id,
                            "customTitle": fixture["input"],
                        }
                    ],
                )
                title = self.run_title("Stop", repo, session_id, transcript)
                if fixture["expected"]:
                    self.assertRegex(title, rf"/{re.escape(fixture['expected'])}·✅$")
                else:
                    self.assertRegex(title, r"/AB-123·✅$")
                self.assertNotRegex(title, r"[\x00-\x1f\x7f-\x9f]")

    def test_named_title_precedence_and_repo_alias(self) -> None:
        repo = self.git_repo("feature/AB-123-example")
        session_id = str(uuid.uuid4())
        transcript = self.transcript(
            session_id,
            [{"type": "custom-title", "sessionId": session_id, "customTitle": "Title work"}],
        )
        title = self.run_title(
            "UserPromptSubmit",
            repo,
            session_id,
            transcript,
            extra_payload={"prompt": "/watch-prs"},
            extra_env={"KITTY_TITLE_REPO_ALIAS": "workspace"},
        )
        self.assertEqual(title, "-workspace/Title-work·💭")
        self.assertNotIn("AB-123", title)
        self.assertNotIn("👀-PRs", title)

    def test_latest_session_scoped_title_is_cached_incrementally(self) -> None:
        repo = self.git_repo("feature/AB-123-example")
        session_id = str(uuid.uuid4())
        transcript = self.transcript(
            session_id,
            [{"type": "custom-title", "sessionId": session_id, "customTitle": "First"}],
        )
        self.assertIn("/First·", self.run_title("SessionStart", repo, session_id, transcript))
        with transcript.open("a") as output:
            output.write(json.dumps({"type": "user", "message": "ignored"}) + "\n")
            output.write(
                json.dumps(
                    {"type": "custom-title", "sessionId": session_id, "customTitle": "Second"}
                )
                + "\n"
            )
        self.assertIn("/Second·", self.run_title("Stop", repo, session_id, transcript))
        cache = json.loads((self.cache / f"kitty-title-claude-{session_id}.json").read_text())
        self.assertEqual(cache["offset"], transcript.stat().st_size)
        self.assertEqual(cache["title"], "Second")

    def test_partial_custom_title_record_is_retried_after_completion(self) -> None:
        repo = self.git_repo("feature/AB-123-example")
        session_id = str(uuid.uuid4())
        transcript = self.transcript(
            session_id,
            [{"type": "custom-title", "sessionId": session_id, "customTitle": "First"}],
        )
        self.assertIn("/First·", self.run_title("Stop", repo, session_id, transcript))
        partial = (
            '{"type":"custom-title","sessionId":"'
            + session_id
            + '","customTitle":"Second'
        )
        with transcript.open("ab") as output:
            output.write(partial.encode())
        self.assertIn("/First·", self.run_title("Stop", repo, session_id, transcript))
        cache = json.loads((self.cache / f"kitty-title-claude-{session_id}.json").read_text())
        self.assertLess(cache["offset"], transcript.stat().st_size)
        with transcript.open("ab") as output:
            output.write(b'"}\n')
        self.assertIn("/Second·", self.run_title("Stop", repo, session_id, transcript))

    def test_insecure_cache_directory_fails_closed(self) -> None:
        repo = self.git_repo("feature/AB-123-example")
        session_id = str(uuid.uuid4())
        transcript = self.transcript(
            session_id,
            [{"type": "custom-title", "sessionId": session_id, "customTitle": "Private"}],
        )
        self.cache.chmod(0o755)
        try:
            self.assertRegex(self.run_title("Stop", repo, session_id, transcript), r"/AB-123·✅$")
        finally:
            self.cache.chmod(0o700)

    def test_malformed_cache_cannot_inject_a_title(self) -> None:
        repo = self.git_repo("feature/AB-123-example")
        session_id = str(uuid.uuid4())
        transcript = self.transcript(
            session_id,
            [{"type": "user", "message": "no title"}],
        )
        stat = transcript.stat()
        cache_path = self.cache / f"kitty-title-claude-{session_id}.json"
        cache_path.write_text(
            json.dumps(
                {
                    "version": 1,
                    "path": str(transcript),
                    "device": stat.st_dev,
                    "inode": stat.st_ino,
                    "offset": True,
                    "mtime_ns": stat.st_mtime_ns,
                    "title": "BoolInjected",
                    "title_offset": None,
                }
            )
        )
        cache_path.chmod(0o600)
        title = self.run_title("Stop", repo, session_id, transcript)
        self.assertRegex(title, r"/AB-123·✅$")
        self.assertNotIn("BoolInjected", title)

    def test_oversized_non_title_record_is_skipped_with_bounded_memory(self) -> None:
        repo = self.git_repo("feature/AB-123-example")
        session_id = str(uuid.uuid4())
        transcript = self.transcript(
            session_id,
            [{"type": "custom-title", "sessionId": session_id, "customTitle": "Bounded"}],
        )
        self.assertIn("/Bounded·", self.run_title("Stop", repo, session_id, transcript))
        with transcript.open("a") as output:
            output.write(json.dumps({"type": "tool-output", "content": "x" * (1024 * 1024 + 1)}) + "\n")
        self.assertIn("/Bounded·", self.run_title("Stop", repo, session_id, transcript))
        cache = json.loads((self.cache / f"kitty-title-claude-{session_id}.json").read_text())
        self.assertEqual(cache["offset"], transcript.stat().st_size)

    def test_malformed_or_cross_session_titles_fail_closed(self) -> None:
        repo = self.git_repo("feature/AB-123-example")
        session_id = str(uuid.uuid4())
        transcript = self.transcript(
            session_id,
            [{"type": "custom-title", "sessionId": str(uuid.uuid4()), "customTitle": "Wrong"}],
        )
        self.assertRegex(self.run_title("Stop", repo, session_id, transcript), r"/AB-123·✅$")
        transcript.write_text('{"type":"custom-title","sessionId":')
        self.assertRegex(self.run_title("Stop", repo, session_id, transcript), r"/AB-123·✅$")
        wrong_path = self.root / "not-the-session.jsonl"
        wrong_path.write_text(
            json.dumps({"type": "custom-title", "sessionId": session_id, "customTitle": "Wrong"})
            + "\n"
        )
        self.assertRegex(self.run_title("Stop", repo, session_id, wrong_path), r"/AB-123·✅$")

    def test_unnamed_fallbacks_and_lifecycle_states(self) -> None:
        repo = self.git_repo("main")
        repo_name = repo.name
        beads = repo / ".beads"
        beads.mkdir()
        bead_id = f"{repo_name}-abc"
        issues = beads / "issues.jsonl"
        issues.write_text(json.dumps({"id": bead_id, "status": "in_progress"}) + "\n")
        session_id = str(uuid.uuid4())
        transcript = self.transcript(session_id)
        self.assertEqual(
            self.run_title("SessionStart", repo, session_id, transcript),
            f"-{repo_name}/abc·🌱",
        )
        issues.write_text(
            json.dumps(
                {"id": bead_id, "status": "closed", "closed_at": "2026-07-31"}
            )
            + "\n"
        )
        self.assertEqual(
            self.run_title("Stop", repo, session_id, transcript),
            f"-{repo_name}/✓abc·✅",
        )

        states = {
            "UserPromptSubmit": "💭",
            "PreToolUse": "⚙️",
            "PostToolUse": "💭",
            "PermissionRequest": "❓",
            "PreCompact": "🧹",
        }
        for event, state in states.items():
            with self.subTest(event):
                title = self.run_title(event, repo, session_id, transcript)
                self.assertTrue(title.endswith(f"·{state}"), title)

    def test_watcher_role_non_git_directory_and_ssh_prefix_remain_supported(self) -> None:
        repo = self.git_repo("main")
        session_id = str(uuid.uuid4())
        transcript = self.transcript(session_id)
        title = self.run_title(
            "UserPromptSubmit",
            repo,
            session_id,
            transcript,
            extra_payload={"prompt": "/watch-release"},
        )
        self.assertIn("·🚢-releases·💭", title)

        directory = self.root / "scratch"
        directory.mkdir()
        other_session = str(uuid.uuid4())
        other_transcript = self.transcript(other_session)
        self.assertEqual(
            self.run_title("Stop", directory, other_session, other_transcript),
            "󰉋-scratch·✅",
        )

        tty = self.root / "ssh-tty"
        tty.touch()
        payload = {
            "cwd": str(directory),
            "session_id": other_session,
            "transcript_path": str(other_transcript),
        }
        env = {
            **os.environ,
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "KITTY_TEST_LOG": str(self.kitten_log),
            "CLAUDE_KITTY_TITLE_CACHE_DIR": str(self.cache),
            "SSH_TTY": str(tty),
            "KITTY_TITLE_HOST_ALIAS": "host",
        }
        subprocess.run(
            ["bash", str(SCRIPT), "Stop"],
            input=json.dumps(payload),
            text=True,
            cwd=directory,
            env=env,
            check=True,
        )
        data = tty.read_bytes()
        match = re.search(rb"\x1b\]2;(.*?)\x07", data)
        self.assertIsNotNone(match)
        self.assertEqual((match.group(1) if match else b"").decode(), "🌐host/·󰉋-scratch·✅")


if __name__ == "__main__":
    unittest.main()
