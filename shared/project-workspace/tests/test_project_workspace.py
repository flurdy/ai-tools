"""End-to-end tests for the project-workspace scaffold CLI."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
CLI = PROJECT / "project-workspace"


class ProjectWorkspaceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.command_log = self.root / "commands.log"
        self.skill_root = self.root / "skills"
        self.write_command(
            "git",
            'echo "git $*" >> "$COMMAND_LOG"\n'
            "require_local_comparison() {\n"
            '  printf "comparison environment: lazy=%s locks=%s command=%s\\n" '
            '"${GIT_NO_LAZY_FETCH:-}" "${GIT_OPTIONAL_LOCKS:-}" "$*" '
            '>> "$COMMAND_LOG"\n'
            '  if [[ "${GIT_NO_LAZY_FETCH:-}" != 1 || "${GIT_OPTIONAL_LOCKS:-}" != 0 ]]; then\n'
            '    echo "comparison environment is not read-only" >&2\n'
            "    exit 4\n"
            "  fi\n"
            "}\n"
            'if [[ "$1" == "rev-parse" && "${2:-}" == "--git-common-dir" ]]; then\n'
            '  if [[ -f .git/project-workspace-common-dir-fail ]]; then\n'
            '    cat .git/project-workspace-common-dir-fail >&2\n'
            "    exit 2\n"
            "  fi\n"
            '  [[ -f .git/project-workspace-common-dir ]] && cat .git/project-workspace-common-dir || printf "%s/.git\\n" "$(pwd -P)"\n'
            "  exit\n"
            "fi\n"
            'if [[ "$1" == "for-each-ref" ]]; then\n'
            '  if [[ -f .git/project-workspace-branches-fail ]]; then\n'
            '    cat .git/project-workspace-branches-fail >&2\n'
            "    exit 2\n"
            "  fi\n"
            '  if [[ -f .git/project-workspace-branches ]]; then\n'
            '    cat .git/project-workspace-branches\n'
            "  else\n"
            '    printf "main\\t\\t\\t%s\\n" "$(date +%s)"\n'
            "  fi\n"
            "  exit\n"
            "fi\n"
            'if [[ "$1" == "worktree" && "${2:-}" == "list" ]]; then\n'
            '  if [[ -f .git/project-workspace-worktrees-fail ]]; then\n'
            '    cat .git/project-workspace-worktrees-fail >&2\n'
            "    exit 2\n"
            "  fi\n"
            '  if [[ -f .git/project-workspace-worktrees ]]; then\n'
            '    cat .git/project-workspace-worktrees\n'
            "  else\n"
            '    printf "worktree %s\\nHEAD test\\nbranch refs/heads/main\\n\\n" "$(pwd -P)"\n'
            "  fi\n"
            "  exit\n"
            "fi\n"
            'if [[ "$1" == "rev-parse" ]]; then\n'
            '  require_local_comparison "$@"\n'
            '  if [[ -f .git/project-workspace-revisions-fail ]]; then\n'
            '    cat .git/project-workspace-revisions-fail >&2\n'
            "    exit 2\n"
            "  fi\n"
            '  if [[ -f .git/project-workspace-revisions ]]; then\n'
            '    cat .git/project-workspace-revisions\n'
            "  else\n"
            '    printf "%040d\\n%040d\\n" 1 2\n'
            "  fi\n"
            "  exit\n"
            "fi\n"
            'if [[ "$1" == "rev-list" ]]; then\n'
            '  require_local_comparison "$@"\n'
            '  if [[ -f .git/project-workspace-rev-list-fail ]]; then\n'
            '    cat .git/project-workspace-rev-list-fail >&2\n'
            "    exit 2\n"
            "  fi\n"
            '  if [[ "$*" == *"--merges"* ]]; then\n'
            '    [[ -f .git/project-workspace-merge-count ]] &&\n'
            '      cat .git/project-workspace-merge-count || echo 0\n'
            "  else\n"
            '    [[ -f .git/project-workspace-patch-count ]] &&\n'
            '      cat .git/project-workspace-patch-count || echo 1\n'
            "  fi\n"
            "  exit\n"
            "fi\n"
            'if [[ "$1" == "cherry" ]]; then\n'
            '  require_local_comparison "$@"\n'
            '  if [[ -f .git/project-workspace-cherry-fail ]]; then\n'
            '    cat .git/project-workspace-cherry-fail >&2\n'
            "    exit 2\n"
            "  fi\n"
            '  if [[ -f .git/project-workspace-cherry ]]; then\n'
            '    cat .git/project-workspace-cherry\n'
            "  else\n"
            '    printf "+ %040d\\n" 2\n'
            "  fi\n"
            "  exit\n"
            "fi\n"
            'if [[ "$1" == "status" ]]; then\n'
            '  if [[ "${GIT_NO_LAZY_FETCH:-}" != 1 || "${GIT_OPTIONAL_LOCKS:-}" != 0 ]]; then\n'
            '    echo "git status environment is not read-only" >&2\n'
            "    exit 4\n"
            "  fi\n"
            '  [[ -f .git/project-workspace-status-sleep ]] && sleep 6\n'
            '  if [[ -f .git/project-workspace-status-fail ]]; then\n'
            '    cat .git/project-workspace-status-fail >&2\n'
            "    exit 2\n"
            "  fi\n"
            "  if [[ -f .git/project-workspace-status ]]; then\n"
            "    cat .git/project-workspace-status\n"
            "  else\n"
            "    echo '# branch.head main'\n"
            "  fi\n"
            "  exit\n"
            "fi\n"
            'if [[ "$1" == fetch || "$1" == push || "$1" == merge || "$1" == rebase ]]; then\n'
            '  if [[ -f ".git/project-workspace-$1-fail" ]]; then\n'
            '    cat ".git/project-workspace-$1-fail" >&2\n'
            "    exit 3\n"
            "  fi\n"
            '  if [[ -f ".git/project-workspace-status-after-$1" ]]; then\n'
            '    mv ".git/project-workspace-status-after-$1" .git/project-workspace-status\n'
            "  fi\n"
            "  exit\n"
            "fi\n"
            'if [[ "$1" == "-C" ]]; then\n'
            '  [[ -f "$2/.git/project-workspace-initialized" ]] && echo "$2"\n'
            "  exit\n"
            "fi\n"
            "mkdir -p .git\n"
            'if [[ "${GIT_FAIL_ONCE:-}" == "1" && ! -f "$COMMAND_LOG.git-failed" ]]; then\n'
            '  touch "$COMMAND_LOG.git-failed"\n'
            "  exit 1\n"
            "fi\n"
            "touch .git/project-workspace-initialized\n",
        )
        self.write_command(
            "bd",
            'echo "bd $*" >> "$COMMAND_LOG"\n'
            'if [[ "$1" == "list" ]]; then\n'
            '  if [[ "$*" == *"--json"* ]]; then\n'
            '    [[ -f .beads/project-workspace-status-sleep ]] && sleep 6\n'
            '    if [[ -f .beads/project-workspace-status-fail ]]; then\n'
            '      cat .beads/project-workspace-status-fail >&2\n'
            "      exit 2\n"
            "    fi\n"
            '    if [[ "$*" == *"--ready"* ]]; then\n'
            "      status_file=.beads/project-workspace-ready.json\n"
            '    elif [[ "$*" == *"--status=in_progress"* ]]; then\n'
            "      status_file=.beads/project-workspace-active.json\n"
            "    else\n"
            "      status_file=.beads/project-workspace-all.json\n"
            "    fi\n"
            '    [[ -f "$status_file" ]] && cat "$status_file" || echo "[]"\n'
            "    exit\n"
            "  fi\n"
            '  if [[ "${BD_HEALTH_FAIL:-}" == "1" ]]; then\n'
            '    echo "${BD_HEALTH_ERROR:-store unavailable}" >&2\n'
            "    exit 2\n"
            "  fi\n"
            "  exit\n"
            "fi\n"
            'if [[ "$1" == "blocked" ]]; then\n'
            '  if [[ "$*" == *"--no-pager"* ]]; then\n'
            '    echo "unknown flag: --no-pager" >&2\n'
            "    exit 2\n"
            "  fi\n"
            '  [[ -f .beads/project-workspace-status-sleep ]] && sleep 6\n'
            '  if [[ -f .beads/project-workspace-status-fail ]]; then\n'
            '    cat .beads/project-workspace-status-fail >&2\n'
            "    exit 2\n"
            "  fi\n"
            '  [[ -f .beads/project-workspace-blocked.json ]] && cat .beads/project-workspace-blocked.json || echo "[]"\n'
            "  exit\n"
            "fi\n"
            "mkdir -p .beads\n"
            'if [[ "${BD_FAIL_ONCE:-}" == "1" && ! -f "$COMMAND_LOG.bd-failed" ]]; then\n'
            '  touch "$COMMAND_LOG.bd-failed"\n'
            "  exit 1\n"
            "fi\n",
        )
        self.environment = os.environ.copy()
        self.environment["COMMAND_LOG"] = str(self.command_log)
        self.environment["PATH"] = (
            f"{self.bin}:{PROJECT}:{self.environment.get('PATH', '')}"
        )
        self.environment["SKILLS_DIR"] = str(self.skill_root)
        self.environment["CLAUDE_HOME"] = str(self.root / "missing-claude-home")

    def create_mgit_skill(self, skill_root: Path | None = None) -> Path:
        skill = (skill_root or self.skill_root) / "setup-multirepo-git"
        script = skill / "scripts" / "mgit"
        templates = skill / "templates"
        script.parent.mkdir(parents=True)
        templates.mkdir()
        (skill / "SKILL.md").write_text("# mgit skill\n", encoding="utf-8")
        (templates / "permissions.json").write_text("{}\n", encoding="utf-8")
        (templates / "AGENTS-MGIT.md").write_text("# mgit\n", encoding="utf-8")
        script.write_text(
            "#!/usr/bin/env bash\n"
            "set -euo pipefail\n"
            "subcommand=$1\n"
            "service=$2\n"
            "shift 2\n"
            "if [[ ${MGIT_FAIL:-} == 1 ]]; then\n"
            '  echo "${MGIT_ERROR:-mgit status failed}" >&2\n'
            "  exit 1\n"
            "fi\n"
            "if [[ $service == root || $service == . ]]; then\n"
            "  path=$PWD\n"
            "else\n"
            "  path=$PWD/$service\n"
            "fi\n"
            "exec git -C \"$path\" \"$subcommand\" \"$@\"\n",
            encoding="utf-8",
        )
        script.chmod(0o755)
        return script

    def write_command(self, name: str, body: str) -> None:
        command = self.bin / name
        command.write_text(f"#!/usr/bin/env bash\nset -euo pipefail\n{body}", encoding="utf-8")
        command.chmod(0o755)

    def run_cli(
        self, *arguments: str, cwd: Path | None = None, check: bool = True
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(CLI), *arguments],
            capture_output=True,
            check=check,
            cwd=cwd or self.root,
            env=self.environment,
            stdin=subprocess.DEVNULL,
            text=True,
        )

    def create_workspace(self, name: str = "workspace") -> Path:
        workspace = self.root / name
        self.run_cli("init", name.title(), "--output", str(workspace))
        return workspace

    def create_repository(self, name: str) -> Path:
        repository = self.root / name
        (repository / ".git").mkdir(parents=True)
        (repository / ".git" / "project-workspace-initialized").touch()
        return repository

    def set_git_status(self, repository: Path, output: str) -> None:
        (repository / ".git" / "project-workspace-status").write_text(
            output, encoding="utf-8"
        )

    def set_worktrees(self, repository: Path, worktrees: list[Path]) -> None:
        self.set_worktree_entries(
            repository, [(worktree, "main") for worktree in worktrees]
        )

    def set_worktree_entries(
        self, repository: Path, worktrees: list[tuple[Path, str | None]]
    ) -> None:
        output = ""
        for worktree, branch in worktrees:
            output += f"worktree {worktree.resolve()}\nHEAD {'1' * 40}\n"
            output += (
                f"branch refs/heads/{branch}\n\n"
                if branch is not None
                else "detached\n\n"
            )
        (repository / ".git" / "project-workspace-worktrees").write_text(
            output, encoding="utf-8"
        )

    def set_branches(
        self,
        repository: Path,
        branches: list[tuple[str, str, str, int]],
    ) -> None:
        output = "".join(
            f"{branch}\t{upstream}\t{tracking}\t{timestamp}\n"
            for branch, upstream, tracking, timestamp in branches
        )
        (repository / ".git" / "project-workspace-branches").write_text(
            output, encoding="utf-8"
        )

    def set_tracking_status(
        self,
        repository: Path,
        ahead: int,
        behind: int,
        dirty: int = 0,
        after_fetch: bool = False,
        branch: str = "main",
    ) -> None:
        suffix = "-after-fetch" if after_fetch else ""
        (repository / ".git" / f"project-workspace-status{suffix}").write_text(
            f"# branch.head {branch}\n"
            "# branch.upstream origin/main\n"
            f"# branch.ab +{ahead} -{behind}\n" + "1 changed\n" * dirty,
            encoding="utf-8",
        )

    def set_patch_comparison(
        self,
        repository: Path,
        cherry: str = "+ 0000000000000000000000000000000000000002\n",
        patch_count: str = "1\n",
        merge_count: str = "0\n",
    ) -> None:
        metadata = {
            "project-workspace-cherry": cherry,
            "project-workspace-patch-count": patch_count,
            "project-workspace-merge-count": merge_count,
        }
        for name, value in metadata.items():
            (repository / ".git" / name).write_text(value, encoding="utf-8")

    def sync_workspace_with(self, name: str, repositories: list[str]) -> Path:
        workspace = self.create_workspace(name)
        self.set_git_status(workspace, "# branch.head main\n")
        for repository in repositories:
            self.run_cli(
                "add-repo",
                str(self.create_repository(repository)),
                "--workspace",
                str(workspace),
            )
        return workspace

    def set_beads_status(
        self,
        repository: Path,
        active: list[dict[str, object]],
        ready: list[dict[str, object]],
    ) -> None:
        beads = repository / ".beads"
        beads.mkdir(exist_ok=True)
        (beads / "project-workspace-active.json").write_text(
            json.dumps(active), encoding="utf-8"
        )
        (beads / "project-workspace-ready.json").write_text(
            json.dumps(ready), encoding="utf-8"
        )
        (beads / "project-workspace-all.json").write_text(
            json.dumps(
                [dict(issue, status="in_progress") for issue in active]
                + [dict(issue, status="open") for issue in ready]
            ),
            encoding="utf-8",
        )
        (beads / "project-workspace-blocked.json").write_text(
            "[]", encoding="utf-8"
        )

    def use_real_git(self) -> str:
        real_git = shutil.which("git")
        assert real_git is not None
        real_bin = self.root / "real-bin"
        real_bin.mkdir()
        (real_bin / "git").symlink_to(real_git)
        self.environment["PATH"] = f"{real_bin}:{self.bin}:{os.environ['PATH']}"
        return real_git

    def test_initialises_named_greenfield_workspace_and_reruns_safely(self) -> None:
        workspace = self.root / "example-project"

        result = self.run_cli("init", "Example Project")

        self.assertIn(f"Initialised workspace: {workspace}", result.stdout)
        self.assertTrue((workspace / ".git").is_dir())
        self.assertTrue((workspace / ".beads").is_dir())
        self.assertTrue((workspace / "docs" / "adrs" / ".gitkeep").is_file())
        self.assertTrue((workspace / "infrastructure" / ".gitkeep").is_file())
        self.assertFalse((workspace / ".mgit.conf").exists())
        self.assertFalse((workspace / "scripts" / "mgit").exists())
        expected_envrc = (
            "# Local direnv configuration for project workspaces.\n"
            "source_up\n"
            "\n"
            "source_env_if_exists .envrc.local\n"
            "dotenv_if_exists .env\n"
            "dotenv_if_exists .env.local\n"
        )
        generated_envrc = (workspace / ".envrc").read_text(encoding="utf-8")
        self.assertEqual(expected_envrc, generated_envrc)
        generated_readme = (workspace / "README.md").read_text(encoding="utf-8")
        self.assertIn("modern Unix-like systems with Python 3.10+", generated_readme)
        self.assertIn("copying the executable alone is unsupported", generated_readme)
        self.assertIn("records local relative topology", generated_readme)
        self.assertIn("Codex, Claude, then Pi's", generated_readme)
        manifest = json.loads((workspace / "workspace.json").read_text(encoding="utf-8"))
        self.assertEqual("Example Project", manifest["name"])
        self.assertEqual([], manifest["repositories"])
        self.assertEqual([], manifest["infrastructure"])
        first_commands = self.command_log.read_text(encoding="utf-8")
        self.assertIn("git init -b main", first_commands)
        self.assertIn("bd init --init-if-missing --non-interactive --skip-agents", first_commands)

        rerun = self.run_cli("init", "Example Project")

        self.assertEqual(0, rerun.returncode)
        self.assertEqual(
            generated_envrc, (workspace / ".envrc").read_text(encoding="utf-8")
        )
        rerun_commands = self.command_log.read_text(encoding="utf-8")
        self.assertEqual(1, rerun_commands.count("git init -b main"))
        self.assertEqual(2, rerun_commands.count("bd init --init-if-missing"))

    def test_rerun_adds_missing_managed_envrc(self) -> None:
        workspace = self.create_workspace()
        envrc = workspace / ".envrc"
        expected = envrc.read_text(encoding="utf-8")
        envrc.unlink()

        result = self.run_cli("init", "Workspace", "--output", str(workspace))

        self.assertEqual(0, result.returncode)
        self.assertEqual(expected, envrc.read_text(encoding="utf-8"))

    def test_rerun_preserves_conflicting_managed_envrc(self) -> None:
        workspace = self.create_workspace()
        envrc = workspace / ".envrc"
        custom = "export KEEP_ME=1\n"
        envrc.write_text(custom, encoding="utf-8")

        result = self.run_cli(
            "init", "Workspace", "--output", str(workspace), check=False
        )

        self.assertNotEqual(0, result.returncode)
        self.assertEqual(custom, envrc.read_text(encoding="utf-8"))

    def test_links_existing_repository_without_absorbing_it(self) -> None:
        repository = self.create_repository("application")
        workspace = self.root / "operations"

        self.run_cli("init", "--repo", str(repository), "--output", str(workspace))

        link = workspace / "repos" / "application"
        self.assertTrue(link.is_symlink())
        self.assertEqual(repository, link.resolve())
        self.assertFalse((repository / "workspace.json").exists())
        manifest = json.loads((workspace / "workspace.json").read_text(encoding="utf-8"))
        self.assertEqual(
            [{"name": "application", "path": "repos/application", "role": "primary"}],
            manifest["repositories"],
        )
        readme = (workspace / "README.md").read_text(encoding="utf-8")
        self.assertIn("[`repos/application`](repos/application)", readme)

    def test_init_and_doctor_reject_absolute_repository_links(self) -> None:
        repository = self.create_repository("application")
        workspace = self.root / "operations"
        self.run_cli("init", "--repo", str(repository), "--output", str(workspace))
        link = workspace / "repos" / "application"
        link.unlink()
        link.symlink_to(repository, target_is_directory=True)

        rerun = self.run_cli(
            "init", "--repo", str(repository), "--output", str(workspace), check=False
        )
        doctor = self.run_cli("doctor", "--workspace", str(workspace), check=False)

        self.assertNotEqual(0, rerun.returncode)
        self.assertIn("refusing to overwrite", rerun.stderr)
        self.assertNotEqual(0, doctor.returncode)
        self.assertIn("not a safe relative symlink", doctor.stderr)
        self.assertTrue(os.path.isabs(os.readlink(link)))

    def test_dry_run_reports_plan_without_writing(self) -> None:
        workspace = self.root / "preview"

        result = self.run_cli(
            "init", "Preview", "--output", str(workspace), "--dry-run"
        )

        self.assertIn("CREATE file .envrc", result.stdout)
        self.assertIn("CREATE file workspace.json", result.stdout)
        self.assertIn("RUN git init -b main", result.stdout)
        self.assertIn("RUN bd init", result.stdout)
        self.assertFalse(workspace.exists())
        self.assertFalse(self.command_log.exists())

    def test_conflict_fails_before_other_content_is_created(self) -> None:
        workspace = self.root / "conflict"
        workspace.mkdir()
        readme = workspace / "README.md"
        readme.write_text("keep me\n", encoding="utf-8")

        result = self.run_cli(
            "init", "Conflict", "--output", str(workspace), check=False
        )

        self.assertNotEqual(0, result.returncode)
        self.assertIn("refusing to overwrite", result.stderr)
        self.assertEqual("keep me\n", readme.read_text(encoding="utf-8"))
        self.assertFalse((workspace / "workspace.json").exists())
        self.assertFalse((workspace / ".git").exists())
        self.assertFalse((workspace / ".beads").exists())

    def test_rejects_workspace_nested_inside_existing_repository(self) -> None:
        repository = self.create_repository("application")

        result = self.run_cli(
            "init",
            "--repo",
            str(repository),
            "--output",
            str(repository / "workspace"),
            check=False,
        )

        self.assertNotEqual(0, result.returncode)
        self.assertIn("must be separate directories", result.stderr)
        self.assertFalse((repository / "workspace").exists())

    def test_rejects_existing_foreign_git_repository_as_output(self) -> None:
        workspace = self.root / "foreign"
        (workspace / ".git").mkdir(parents=True)

        result = self.run_cli(
            "init", "Foreign", "--output", str(workspace), check=False
        )

        self.assertNotEqual(0, result.returncode)
        self.assertIn("existing Git repository", result.stderr)
        self.assertFalse((workspace / "workspace.json").exists())

    @unittest.skipUnless(
        shutil.which("git") and shutil.which("bd"),
        "Git and Beads are required for the health-probe smoke test",
    )
    def test_real_beads_health_probe(self) -> None:
        real_tools = self.root / "real-workspace-tools"
        real_tools.mkdir()
        for name in ("git", "bd"):
            source = shutil.which(name)
            assert source is not None
            (real_tools / name).symlink_to(source)
        environment = os.environ.copy()
        environment["PATH"] = f"{real_tools}:{environment['PATH']}"
        environment["BEADS_ACTOR"] = "project-workspace-test"
        workspace = self.root / "real-beads-workspace"

        subprocess.run(
            [
                sys.executable,
                str(CLI),
                "init",
                "Real Beads Workspace",
                "--output",
                str(workspace),
            ],
            capture_output=True,
            check=True,
            cwd=self.root,
            env=environment,
            text=True,
        )
        result = subprocess.run(
            [sys.executable, str(CLI), "doctor", "--workspace", str(workspace)],
            capture_output=True,
            check=True,
            cwd=self.root,
            env=environment,
            text=True,
        )

        self.assertIn("Workspace: PASS", result.stdout)
        self.assertIn("Beads: PASS", result.stdout)

    @unittest.skipUnless(
        shutil.which("git"), "Git is required for containment validation"
    )
    def test_real_git_init_rejects_output_nested_in_existing_work_tree(self) -> None:
        real_git = self.use_real_git()
        repository = self.root / "repository"
        repository.mkdir()
        subprocess.run(
            [real_git, "init", "-b", "main"],
            cwd=repository,
            check=True,
            capture_output=True,
        )
        workspace = repository / "workspace"

        preview = self.run_cli(
            "init",
            "Workspace",
            "--output",
            str(workspace),
            "--dry-run",
            check=False,
        )
        result = self.run_cli(
            "init", "Workspace", "--output", str(workspace), check=False
        )

        for rejected in (preview, result):
            self.assertNotEqual(0, rejected.returncode)
            self.assertIn("existing Git work tree", rejected.stderr)
        self.assertFalse(workspace.exists())
        self.assertFalse(self.command_log.exists())

    @unittest.skipUnless(
        shutil.which("git"), "Git is required for containment validation"
    )
    def test_real_git_init_rejects_planted_manifest_in_existing_repository(self) -> None:
        real_git = self.use_real_git()
        workspace = self.root / "foreign"
        workspace.mkdir()
        subprocess.run(
            [real_git, "init", "-b", "main"],
            cwd=workspace,
            check=True,
            capture_output=True,
        )
        (workspace / "workspace.json").write_text(
            json.dumps(
                {
                    "version": 1,
                    "name": "Foreign",
                    "repositories": [],
                    "infrastructure": [],
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

        result = self.run_cli(
            "init", "Foreign", "--output", str(workspace), check=False
        )

        self.assertNotEqual(0, result.returncode)
        self.assertIn("existing Git repository", result.stderr)
        self.assertFalse((workspace / "README.md").exists())
        self.assertFalse(self.command_log.exists())

    def test_rejects_symlinked_workspace_root_and_managed_directory(self) -> None:
        outside = self.root / "outside"
        outside.mkdir()
        root_link = self.root / "linked-root"
        root_link.symlink_to(outside, target_is_directory=True)

        root_result = self.run_cli(
            "init", "Linked", "--output", str(root_link), check=False
        )

        self.assertNotEqual(0, root_result.returncode)
        self.assertIn("root must not be a symlink", root_result.stderr)
        self.assertEqual([], list(outside.iterdir()))

        workspace = self.root / "managed-link"
        workspace.mkdir()
        (workspace / "docs").symlink_to(outside, target_is_directory=True)

        directory_result = self.run_cli(
            "init", "Managed Link", "--output", str(workspace), check=False
        )

        self.assertNotEqual(0, directory_result.returncode)
        self.assertIn("managed directory must not be a symlink", directory_result.stderr)
        self.assertEqual([], list(outside.iterdir()))

    def test_recovers_from_partial_git_and_beads_initialisation(self) -> None:
        git_workspace = self.root / "git-recovery"
        self.environment["GIT_FAIL_ONCE"] = "1"

        first_git = self.run_cli(
            "init", "Git Recovery", "--output", str(git_workspace), check=False
        )
        second_git = self.run_cli(
            "init", "Git Recovery", "--output", str(git_workspace)
        )

        self.assertNotEqual(0, first_git.returncode)
        self.assertEqual(0, second_git.returncode)
        commands = self.command_log.read_text(encoding="utf-8")
        self.assertEqual(2, commands.count("git init -b main"))
        self.environment.pop("GIT_FAIL_ONCE")

        beads_workspace = self.root / "beads-recovery"
        self.environment["BD_FAIL_ONCE"] = "1"
        first_beads = self.run_cli(
            "init", "Beads Recovery", "--output", str(beads_workspace), check=False
        )
        second_beads = self.run_cli(
            "init", "Beads Recovery", "--output", str(beads_workspace)
        )

        self.assertNotEqual(0, first_beads.returncode)
        self.assertEqual(0, second_beads.returncode)
        commands = self.command_log.read_text(encoding="utf-8")
        self.assertGreaterEqual(commands.count("bd init --init-if-missing"), 3)

    def test_registers_repositories_and_infrastructure_and_reruns_safely(self) -> None:
        workspace = self.create_workspace()
        primary = self.create_repository("primary-api")
        service = self.create_repository("worker")
        infrastructure = self.root / "deployment-config"
        infrastructure.mkdir()

        first = self.run_cli(
            "add-repo", str(primary), "--workspace", str(workspace)
        )
        self.run_cli("add-repo", str(service), "--workspace", str(workspace))
        self.run_cli(
            "add-infrastructure",
            str(infrastructure),
            "--workspace",
            str(workspace),
        )
        manifest_before_rerun = (workspace / "workspace.json").read_text(encoding="utf-8")
        rerun = self.run_cli(
            "add-repo", str(primary), "--workspace", str(workspace)
        )

        self.assertIn("Registered repos/primary-api", first.stdout)
        self.assertIn("Registration unchanged: repos/primary-api", rerun.stdout)
        self.assertEqual(
            manifest_before_rerun,
            (workspace / "workspace.json").read_text(encoding="utf-8"),
        )
        self.assertEqual(primary, (workspace / "repos" / "primary-api").resolve())
        self.assertEqual(service, (workspace / "repos" / "worker").resolve())
        self.assertEqual(
            infrastructure,
            (workspace / "infrastructure" / "deployment-config").resolve(),
        )
        self.assertFalse(os.readlink(workspace / "repos" / "primary-api").startswith("/"))
        manifest = json.loads(manifest_before_rerun)
        self.assertEqual(
            [
                {
                    "name": "primary-api",
                    "path": "repos/primary-api",
                    "role": "primary",
                },
                {"name": "worker", "path": "repos/worker", "role": "service"},
            ],
            manifest["repositories"],
        )
        self.assertEqual(
            [
                {
                    "name": "deployment-config",
                    "path": "infrastructure/deployment-config",
                }
            ],
            manifest["infrastructure"],
        )
        readme = (workspace / "README.md").read_text(encoding="utf-8")
        self.assertIn("[`repos/primary-api`](repos/primary-api) (primary)", readme)
        self.assertIn("[`repos/worker`](repos/worker) (service)", readme)
        self.assertIn(
            "[`infrastructure/deployment-config`](infrastructure/deployment-config)",
            readme,
        )
        doctor = subprocess.run(
            ["make", "doctor"],
            capture_output=True,
            check=True,
            cwd=workspace,
            env=self.environment,
            text=True,
        )
        self.assertIn("Workspace: PASS", doctor.stdout)

    def test_registration_dry_run_reports_without_writing(self) -> None:
        workspace = self.create_workspace()
        repository = self.create_repository("preview-service")
        manifest_before = (workspace / "workspace.json").read_text(encoding="utf-8")
        readme_before = (workspace / "README.md").read_text(encoding="utf-8")

        result = self.run_cli(
            "add-repo",
            str(repository),
            "--workspace",
            str(workspace),
            "--dry-run",
        )

        self.assertIn("CREATE link repos/preview-service", result.stdout)
        self.assertIn("UPDATE file workspace.json", result.stdout)
        self.assertFalse((workspace / "repos" / "preview-service").exists())
        self.assertEqual(
            manifest_before, (workspace / "workspace.json").read_text(encoding="utf-8")
        )
        self.assertEqual(readme_before, (workspace / "README.md").read_text(encoding="utf-8"))

    def test_registration_recovers_interrupted_link_and_readme_updates(self) -> None:
        repository = self.create_repository("recoverable")

        linked_workspace = self.create_workspace("linked-interruption")
        link = linked_workspace / "repos" / "recoverable"
        link.symlink_to(os.path.relpath(repository, link.parent), target_is_directory=True)
        linked_result = self.run_cli(
            "add-repo", str(repository), "--workspace", str(linked_workspace)
        )

        readme_workspace = self.create_workspace("readme-interruption")
        manifest_path = readme_workspace / "workspace.json"
        original_manifest = manifest_path.read_text(encoding="utf-8")
        self.run_cli(
            "add-repo", str(repository), "--workspace", str(readme_workspace)
        )
        updated_readme = (readme_workspace / "README.md").read_text(encoding="utf-8")
        manifest_path.write_text(original_manifest, encoding="utf-8")
        readme_result = self.run_cli(
            "add-repo", str(repository), "--workspace", str(readme_workspace)
        )

        self.assertIn("Registered repos/recoverable", linked_result.stdout)
        self.assertIn("Registered repos/recoverable", readme_result.stdout)
        self.assertEqual(
            updated_readme,
            (readme_workspace / "README.md").read_text(encoding="utf-8"),
        )
        for workspace in (linked_workspace, readme_workspace):
            manifest = json.loads(
                (workspace / "workspace.json").read_text(encoding="utf-8")
            )
            self.assertEqual("recoverable", manifest["repositories"][0]["name"])

    def test_registration_migrates_legacy_readme_and_preserves_custom_sections(self) -> None:
        workspace = self.root / "legacy-workspace"
        self.run_cli("init", "Legacy Workspace", "--output", str(workspace))
        manifest = json.loads((workspace / "workspace.json").read_text(encoding="utf-8"))
        legacy_template = (
            PROJECT / "templates" / "README.md.legacy.tmpl"
        ).read_text(encoding="utf-8")
        legacy_readme = legacy_template.replace(
            "{{PROJECT_NAME}}", str(manifest["name"])
        ).replace("{{REPOSITORIES}}", "_No repositories are registered yet._")
        (workspace / "README.md").write_text(legacy_readme, encoding="utf-8")
        legacy_doctor = self.run_cli("doctor", "--workspace", str(workspace))
        self.assertIn("Workspace: PASS", legacy_doctor.stdout)
        repository = self.create_repository("legacy-service")

        self.run_cli(
            "add-repo", str(repository), "--workspace", str(workspace)
        )
        migrated = (workspace / "README.md").read_text(encoding="utf-8")
        self.assertIn("<!-- project-workspace:repositories:start -->", migrated)
        self.assertIn("[`repos/legacy-service`](repos/legacy-service)", migrated)

        custom = "\n## Local notes\n\nPreserve this text.\n"
        (workspace / "README.md").write_text(migrated + custom, encoding="utf-8")
        second = self.create_repository("second-service")
        self.run_cli("add-repo", str(second), "--workspace", str(workspace))
        updated = (workspace / "README.md").read_text(encoding="utf-8")
        self.assertIn("Preserve this text.", updated)
        self.assertIn("[`repos/second-service`](repos/second-service)", updated)

    def test_registration_accepts_noncanonical_manifest_formatting(self) -> None:
        workspace = self.create_workspace("noncanonical")
        manifest_path = workspace / "workspace.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        repository = self.create_repository("formatted-service")

        result = self.run_cli(
            "add-repo", str(repository), "--workspace", str(workspace)
        )

        self.assertEqual(0, result.returncode)
        updated = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.assertEqual("formatted-service", updated["repositories"][0]["name"])

    def test_registration_preserves_unknown_manifest_keys(self) -> None:
        workspace = self.create_workspace("extensible")
        primary = self.create_repository("primary")
        service = self.create_repository("service")
        self.run_cli("add-repo", str(primary), "--workspace", str(workspace))
        manifest_path = workspace / "workspace.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["future"] = {"enabled": True}
        manifest["repositories"][0]["future-role"] = "coordinator"
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

        self.run_cli("add-repo", str(service), "--workspace", str(workspace))
        updated = json.loads(manifest_path.read_text(encoding="utf-8"))

        self.assertEqual({"enabled": True}, updated["future"])
        self.assertEqual("coordinator", updated["repositories"][0]["future-role"])

    def test_registration_rejects_duplicate_names_and_sources_without_writes(self) -> None:
        workspace = self.create_workspace()
        first = self.create_repository("shared-name")
        second_parent = self.root / "other"
        second = second_parent / "shared-name"
        (second / ".git").mkdir(parents=True)
        (second / ".git" / "project-workspace-initialized").touch()
        self.run_cli("add-repo", str(first), "--workspace", str(workspace))
        manifest_before = (workspace / "workspace.json").read_text(encoding="utf-8")

        duplicate_name = self.run_cli(
            "add-repo", str(second), "--workspace", str(workspace), check=False
        )
        duplicate_source = self.run_cli(
            "add-repo",
            str(first),
            "--name",
            "renamed-source",
            "--workspace",
            str(workspace),
            check=False,
        )

        self.assertNotEqual(0, duplicate_name.returncode)
        self.assertIn("duplicate registration name", duplicate_name.stderr)
        self.assertNotEqual(0, duplicate_source.returncode)
        self.assertIn("source is already registered", duplicate_source.stderr)
        self.assertFalse((workspace / "repos" / "renamed-source").exists())
        self.assertEqual(
            manifest_before, (workspace / "workspace.json").read_text(encoding="utf-8")
        )

    def test_registration_rejects_non_git_overlap_symlinks_and_traversal(self) -> None:
        workspace = self.create_workspace()
        plain_directory = self.root / "plain"
        plain_directory.mkdir()
        non_git = self.run_cli(
            "add-repo",
            str(plain_directory),
            "--workspace",
            str(workspace),
            check=False,
        )
        fake_repository = self.root / "fake-repository"
        (fake_repository / ".git").mkdir(parents=True)
        fake_git = self.run_cli(
            "add-repo",
            str(fake_repository),
            "--workspace",
            str(workspace),
            check=False,
        )
        fake_init = self.run_cli(
            "init",
            "--repo",
            str(fake_repository),
            "--output",
            str(self.root / "fake-workspace"),
            check=False,
        )
        overlap_repository = workspace / "nested-repository"
        (overlap_repository / ".git").mkdir(parents=True)
        (overlap_repository / ".git" / "project-workspace-initialized").touch()
        overlap = self.run_cli(
            "add-repo",
            str(overlap_repository),
            "--workspace",
            str(workspace),
            check=False,
        )
        repository = self.create_repository("safe-source")
        source_link = self.root / "source-link"
        source_link.symlink_to(repository, target_is_directory=True)
        symlink = self.run_cli(
            "add-repo",
            str(source_link),
            "--workspace",
            str(workspace),
            check=False,
        )
        traversal = self.run_cli(
            "add-repo",
            str(repository),
            "--name",
            "../escape",
            "--workspace",
            str(workspace),
            check=False,
        )

        self.assertIn("not a Git repository", non_git.stderr)
        self.assertIn("not a Git repository", fake_git.stderr)
        self.assertIn("not a Git repository", fake_init.stderr)
        self.assertIn("must be separate directories", overlap.stderr)
        self.assertIn("source must not be a symlink", symlink.stderr)
        self.assertIn("registration name must use", traversal.stderr)
        self.assertFalse((workspace.parent / "escape").exists())
        manifest = json.loads((workspace / "workspace.json").read_text(encoding="utf-8"))
        self.assertEqual([], manifest["repositories"])

    @unittest.skipUnless(shutil.which("git"), "Git is required for root validation")
    def test_real_git_root_validation_rejects_repository_subdirectories(self) -> None:
        real_git = shutil.which("git")
        assert real_git is not None
        workspace = self.create_workspace("real-git-workspace")
        shutil.rmtree(workspace / ".git")
        subprocess.run(
            [real_git, "init", "-b", "main"], cwd=workspace, check=True, capture_output=True
        )
        repository = self.root / "real-repository"
        repository.mkdir()
        subprocess.run(
            [real_git, "init", "-b", "main"],
            cwd=repository,
            check=True,
            capture_output=True,
        )
        subdirectory = repository / "nested"
        subdirectory.mkdir()

        result = subprocess.run(
            [
                sys.executable,
                str(CLI),
                "add-repo",
                str(subdirectory),
                "--workspace",
                str(workspace),
            ],
            capture_output=True,
            check=False,
            cwd=self.root,
            env=os.environ.copy(),
            text=True,
        )

        self.assertNotEqual(0, result.returncode)
        self.assertIn("not a Git repository", result.stderr)

    def test_registration_rejects_foreign_workspaces_and_manifest_link_conflicts(self) -> None:
        repository = self.create_repository("service")
        foreign = self.root / "foreign-workspace"
        (foreign / ".git").mkdir(parents=True)
        (foreign / ".beads").mkdir()
        foreign_result = self.run_cli(
            "add-repo",
            str(repository),
            "--workspace",
            str(foreign),
            check=False,
        )

        workspace = self.create_workspace()
        orphan = workspace / "repos" / "orphan"
        orphan.symlink_to(os.path.relpath(repository, orphan.parent), target_is_directory=True)
        manifest_before = (workspace / "workspace.json").read_text(encoding="utf-8")
        conflict = self.run_cli(
            "add-repo",
            str(repository),
            "--workspace",
            str(workspace),
            check=False,
        )

        self.assertIn("not an initialised project workspace", foreign_result.stderr)
        self.assertIn("unregistered workspace path: repos/orphan", conflict.stderr)
        self.assertEqual(
            manifest_before, (workspace / "workspace.json").read_text(encoding="utf-8")
        )

    def test_registration_rejects_manifest_path_traversal_without_writes(self) -> None:
        workspace = self.create_workspace()
        repository = self.create_repository("service")
        manifest_path = workspace / "workspace.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["repositories"] = [
            {"name": "service", "path": "repos/../outside", "role": "primary"}
        ]
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        readme_before = (workspace / "README.md").read_text(encoding="utf-8")

        result = self.run_cli(
            "add-repo",
            str(repository),
            "--workspace",
            str(workspace),
            check=False,
        )

        self.assertIn("unsafe registered path", result.stderr)
        self.assertEqual(
            json.dumps(manifest, indent=2) + "\n",
            manifest_path.read_text(encoding="utf-8"),
        )
        self.assertEqual(readme_before, (workspace / "README.md").read_text(encoding="utf-8"))
        self.assertFalse((workspace / "repos" / "service").exists())

    def test_configure_mgit_requires_an_installed_skill_without_writes(self) -> None:
        workspace = self.create_workspace()
        repository = self.create_repository("service")
        self.run_cli("add-repo", str(repository), "--workspace", str(workspace))

        result = self.run_cli(
            "configure-mgit", "--workspace", str(workspace), "--dry-run", check=False
        )

        self.assertNotEqual(0, result.returncode)
        self.assertIn("setup-multirepo-git skill is not installed", result.stderr)
        self.assertFalse((workspace / ".mgit.conf").exists())
        self.assertFalse((workspace / "scripts").exists())

    def test_configure_mgit_keeps_explicit_skills_dir_authoritative(self) -> None:
        workspace = self.create_workspace()
        repository = self.create_repository("service")
        self.run_cli("add-repo", str(repository), "--workspace", str(workspace))
        claude_home = self.root / "claude-home"
        self.create_mgit_skill(claude_home / "skills")
        self.environment["SKILLS_DIR"] = str(self.root / "missing-skills")
        self.environment["CLAUDE_HOME"] = str(claude_home)

        result = self.run_cli(
            "configure-mgit",
            "--workspace",
            str(workspace),
            "--dry-run",
            check=False,
        )

        self.assertIn("setup-multirepo-git skill is not installed", result.stderr)
        self.assertFalse((workspace / ".mgit.conf").exists())
        self.assertFalse((workspace / "scripts").exists())

    def test_configure_mgit_searches_default_roots_for_complete_skill(self) -> None:
        workspace = self.create_workspace()
        repository = self.create_repository("service")
        self.run_cli("add-repo", str(repository), "--workspace", str(workspace))
        codex_home = self.root / "codex-home"
        (codex_home / "skills").mkdir(parents=True)
        claude_home = self.root / "claude-home"
        source = self.create_mgit_skill(claude_home / "skills")
        self.environment.pop("SKILLS_DIR")
        self.environment["CODEX_HOME"] = str(codex_home)
        self.environment["CLAUDE_HOME"] = str(claude_home)

        result = self.run_cli(
            "configure-mgit", "--workspace", str(workspace), "--dry-run"
        )

        self.assertIn(f"CREATE link scripts/mgit -> {source}", result.stdout)

    def test_configure_mgit_finds_pi_agents_skill(self) -> None:
        workspace = self.create_workspace()
        repository = self.create_repository("service")
        self.run_cli("add-repo", str(repository), "--workspace", str(workspace))
        home = self.root / "home"
        (home / ".codex" / "skills").mkdir(parents=True)
        (home / ".claude" / "skills").mkdir(parents=True)
        source = self.create_mgit_skill(home / ".agents" / "skills")
        self.environment.pop("SKILLS_DIR")
        self.environment.pop("CODEX_HOME", None)
        self.environment.pop("CLAUDE_HOME", None)
        self.environment["HOME"] = str(home)

        result = self.run_cli(
            "configure-mgit", "--workspace", str(workspace), "--dry-run"
        )

        self.assertIn(f"CREATE link scripts/mgit -> {source}", result.stdout)

    def test_configure_mgit_treats_empty_skills_dir_as_unset(self) -> None:
        workspace = self.create_workspace()
        repository = self.create_repository("service")
        self.run_cli("add-repo", str(repository), "--workspace", str(workspace))
        codex_home = self.root / "codex-home"
        source = self.create_mgit_skill(codex_home / "skills")
        self.environment["SKILLS_DIR"] = ""
        self.environment["CODEX_HOME"] = str(codex_home)

        result = self.run_cli(
            "configure-mgit", "--workspace", str(workspace), "--dry-run"
        )

        self.assertIn(f"CREATE link scripts/mgit -> {source}", result.stdout)

    def test_configure_mgit_dry_run_previews_without_writing(self) -> None:
        workspace = self.create_workspace()
        repository = self.create_repository("service")
        self.run_cli("add-repo", str(repository), "--workspace", str(workspace))
        source = self.create_mgit_skill()

        result = self.run_cli(
            "configure-mgit", "--workspace", str(workspace), "--dry-run"
        )

        self.assertIn("Services: repos/service", result.stdout)
        self.assertIn("CREATE file .mgit.conf", result.stdout)
        self.assertIn(f"CREATE link scripts/mgit -> {source}", result.stdout)
        self.assertIn(".mgit.conf:\n# Multi-repo workspace configuration", result.stdout)
        self.assertIn("services=repos/service", result.stdout)
        self.assertIn("VERIFY ./scripts/mgit status root", result.stdout)
        self.assertFalse((workspace / ".mgit.conf").exists())
        self.assertFalse((workspace / "scripts").exists())

    def test_configure_mgit_creates_and_verifies_installed_wrapper(self) -> None:
        workspace = self.create_workspace()
        primary = self.create_repository("primary")
        service = self.create_repository("service")
        self.run_cli("add-repo", str(primary), "--workspace", str(workspace))
        self.run_cli("add-repo", str(service), "--workspace", str(workspace))
        source = self.create_mgit_skill()

        result = self.run_cli("configure-mgit", "--workspace", str(workspace))
        rerun = self.run_cli("configure-mgit", "--workspace", str(workspace))
        config = (workspace / ".mgit.conf").read_text(encoding="utf-8")
        script = workspace / "scripts" / "mgit"
        doctor = self.run_cli("doctor", "--workspace", str(workspace))

        self.assertIn("Configured mgit", result.stdout)
        self.assertIn("Configured mgit", rerun.stdout)
        self.assertEqual(
            "# Multi-repo workspace configuration\n"
            "# Presence of this file marks the project root for mgit\n"
            "services=repos/primary,repos/service\n",
            config,
        )
        self.assertTrue(script.is_symlink())
        self.assertFalse(os.readlink(script).startswith("/"))
        self.assertEqual(source, script.resolve())
        commands = self.command_log.read_text(encoding="utf-8")
        self.assertIn(f"git -C {workspace} status", commands)
        self.assertIn(f"git -C {workspace / 'repos' / 'primary'} status", commands)
        self.assertIn("Mgit: PASS", doctor.stdout)

    def test_registration_updates_managed_mgit_and_verifies_new_service(self) -> None:
        workspace = self.create_workspace()
        primary = self.create_repository("primary")
        service = self.create_repository("service")
        self.run_cli("add-repo", str(primary), "--workspace", str(workspace))
        self.create_mgit_skill()
        self.run_cli("configure-mgit", "--workspace", str(workspace))
        config_path = workspace / ".mgit.conf"
        manifest_path = workspace / "workspace.json"
        config_before = config_path.read_text(encoding="utf-8")
        manifest_before = manifest_path.read_text(encoding="utf-8")
        self.command_log.write_text("", encoding="utf-8")

        preview = self.run_cli(
            "add-repo",
            str(service),
            "--workspace",
            str(workspace),
            "--dry-run",
        )

        self.assertIn("UPDATE file .mgit.conf", preview.stdout)
        self.assertIn("VERIFY ./scripts/mgit status repos/service", preview.stdout)
        self.assertEqual(config_before, config_path.read_text(encoding="utf-8"))
        self.assertEqual(manifest_before, manifest_path.read_text(encoding="utf-8"))
        self.assertFalse((workspace / "repos" / "service").exists())

        result = self.run_cli(
            "add-repo", str(service), "--workspace", str(workspace)
        )
        config_after = config_path.read_text(encoding="utf-8")
        rerun = self.run_cli(
            "add-repo", str(service), "--workspace", str(workspace)
        )
        doctor = self.run_cli("doctor", "--workspace", str(workspace))

        self.assertIn("Registered repos/service", result.stdout)
        self.assertIn("Registration unchanged: repos/service", rerun.stdout)
        self.assertIn("services=repos/primary,repos/service", config_after)
        self.assertEqual(config_after, config_path.read_text(encoding="utf-8"))
        commands = self.command_log.read_text(encoding="utf-8")
        self.assertIn(f"git -C {workspace} status", commands)
        self.assertIn(f"git -C {workspace / 'repos' / 'service'} status", commands)
        self.assertIn("Mgit: PASS", doctor.stdout)

    def test_registration_rejects_conflicting_mgit_without_writes(self) -> None:
        workspace = self.create_workspace()
        primary = self.create_repository("primary")
        service = self.create_repository("service")
        self.run_cli("add-repo", str(primary), "--workspace", str(workspace))
        self.create_mgit_skill()
        self.run_cli("configure-mgit", "--workspace", str(workspace))
        config_path = workspace / ".mgit.conf"
        manifest_path = workspace / "workspace.json"
        readme_path = workspace / "README.md"
        config_path.write_text("services=user-managed\n", encoding="utf-8")
        manifest_before = manifest_path.read_text(encoding="utf-8")
        readme_before = readme_path.read_text(encoding="utf-8")

        result = self.run_cli(
            "add-repo", str(service), "--workspace", str(workspace), check=False
        )

        self.assertNotEqual(0, result.returncode)
        self.assertIn("existing mgit configuration conflicts", result.stderr)
        self.assertEqual("services=user-managed\n", config_path.read_text(encoding="utf-8"))
        self.assertEqual(manifest_before, manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(readme_before, readme_path.read_text(encoding="utf-8"))
        self.assertFalse((workspace / "repos" / "service").exists())

    def test_registration_rolls_back_mgit_and_leaves_infrastructure_independent(
        self,
    ) -> None:
        workspace = self.create_workspace()
        primary = self.create_repository("primary")
        service = self.create_repository("service")
        infrastructure = self.root / "infrastructure-source"
        infrastructure.mkdir()
        self.run_cli("add-repo", str(primary), "--workspace", str(workspace))
        self.create_mgit_skill()
        self.run_cli("configure-mgit", "--workspace", str(workspace))
        config_path = workspace / ".mgit.conf"
        manifest_path = workspace / "workspace.json"
        readme_path = workspace / "README.md"
        config_before = config_path.read_text(encoding="utf-8")
        manifest_before = manifest_path.read_text(encoding="utf-8")
        readme_before = readme_path.read_text(encoding="utf-8")
        self.environment["MGIT_FAIL"] = "1"

        failed = self.run_cli(
            "add-repo", str(service), "--workspace", str(workspace), check=False
        )

        self.assertNotEqual(0, failed.returncode)
        self.assertEqual(config_before, config_path.read_text(encoding="utf-8"))
        self.assertEqual(manifest_before, manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(readme_before, readme_path.read_text(encoding="utf-8"))
        self.assertFalse((workspace / "repos" / "service").exists())

        infrastructure_result = self.run_cli(
            "add-infrastructure",
            str(infrastructure),
            "--workspace",
            str(workspace),
        )

        self.assertIn(
            "Registered infrastructure/infrastructure-source",
            infrastructure_result.stdout,
        )
        self.assertEqual(config_before, config_path.read_text(encoding="utf-8"))

    def test_configure_mgit_rolls_back_when_verification_fails(self) -> None:
        workspace = self.create_workspace()
        repository = self.create_repository("service")
        self.run_cli("add-repo", str(repository), "--workspace", str(workspace))
        self.create_mgit_skill()
        self.environment["MGIT_FAIL"] = "1"

        result = self.run_cli(
            "configure-mgit", "--workspace", str(workspace), check=False
        )

        self.assertNotEqual(0, result.returncode)
        self.assertFalse((workspace / ".mgit.conf").exists())
        self.assertFalse((workspace / "scripts" / "mgit").exists())
        self.assertFalse((workspace / "scripts").exists())

    def test_configure_mgit_rejects_conflicts_and_manifest_traversal(self) -> None:
        workspace = self.create_workspace()
        repository = self.create_repository("service")
        self.run_cli("add-repo", str(repository), "--workspace", str(workspace))
        self.create_mgit_skill()
        config = workspace / ".mgit.conf"
        config.write_text("services=unrelated\n", encoding="utf-8")

        conflict = self.run_cli(
            "configure-mgit", "--workspace", str(workspace), check=False
        )
        self.assertIn("existing mgit configuration conflicts", conflict.stderr)
        self.assertFalse((workspace / "scripts").exists())

        config.unlink()
        script = workspace / "scripts" / "mgit"
        script.parent.mkdir()
        script.write_text("untrusted wrapper\n", encoding="utf-8")
        script_conflict = self.run_cli(
            "configure-mgit", "--workspace", str(workspace), check=False
        )
        self.assertIn("workspace mgit script is unsafe", script_conflict.stderr)
        script.unlink()
        script.parent.rmdir()
        manifest_path = workspace / "workspace.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["repositories"][0]["path"] = "repos/../escape"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        traversal = self.run_cli(
            "configure-mgit", "--workspace", str(workspace), check=False
        )

        self.assertIn("unsafe registered path", traversal.stderr)
        self.assertFalse((workspace / ".mgit.conf").exists())
        self.assertFalse((workspace / "scripts").exists())

    def test_configure_mgit_rejects_broken_repository_links_without_writes(self) -> None:
        workspace = self.create_workspace()
        repository = self.create_repository("service")
        self.run_cli("add-repo", str(repository), "--workspace", str(workspace))
        self.create_mgit_skill()
        (workspace / "repos" / "service").unlink()

        result = self.run_cli(
            "configure-mgit", "--workspace", str(workspace), check=False
        )

        self.assertIn("registered path is not a safe relative symlink", result.stderr)
        self.assertFalse((workspace / ".mgit.conf").exists())
        self.assertFalse((workspace / "scripts").exists())

    def test_status_reports_git_and_beads_without_mgit(self) -> None:
        workspace = self.create_workspace("status")
        service = self.create_repository("service")
        no_tracker = self.create_repository("no-tracker")
        self.run_cli("add-repo", str(service), "--workspace", str(workspace))
        self.run_cli("add-repo", str(no_tracker), "--workspace", str(workspace))
        self.set_git_status(workspace, "# branch.head main\n? README.md\n")
        self.set_git_status(
            service,
            "# branch.head feature\n"
            "# branch.upstream origin/main\n"
            "# branch.ab +2 -3\n"
            "1 changed\n",
        )
        self.set_beads_status(
            workspace,
            [{"id": "workspace-1", "title": "Coordinate work", "priority": 2}],
            [],
        )
        self.set_beads_status(
            service,
            [],
            [{"id": "service-1", "title": "Ready work", "priority": 3}],
        )

        result = self.run_cli("status", "--workspace", str(workspace))

        self.assertIn("=== GIT STATUS ===", result.stdout)
        self.assertIn(
            "branch main | upstream — | ahead — | behind — | dirty 1",
            result.stdout,
        )
        self.assertIn(
            "branch feature | upstream origin/main | ahead 2 | behind 3 | dirty 1",
            result.stdout,
        )
        self.assertIn(
            "| in_progress | P2 | workspace-1 | Coordinate work", result.stdout
        )
        self.assertIn("| ready       | P3 | service-1 | Ready work", result.stdout)
        self.assertRegex(
            result.stdout,
            r"(?m)^no-tracker \(repos/no-tracker\) *\| not initialized$",
        )
        self.assertRegex(result.stdout, r"(?m)^workspace \(\.\) *\| branch main \|")
        self.assertIn("\n\n=== BEADS STATUS ===", result.stdout)
        self.assertFalse((workspace / ".mgit.conf").exists())
        commands = self.command_log.read_text(encoding="utf-8")
        self.assertIn("--readonly", commands)
        self.assertNotIn(" fetch ", commands)

    def test_beads_counts_aggregates_all_registered_stores_and_p4_work(self) -> None:
        workspace = self.create_workspace("aggregate-counts")
        service = self.create_repository("service")
        self.run_cli("add-repo", str(service), "--workspace", str(workspace))
        self.set_beads_status(
            workspace,
            [{"id": "workspace-active", "title": "Active", "priority": 2}],
            [{"id": "workspace-p4", "title": "Backlog", "priority": 4}],
        )
        self.set_beads_status(
            service,
            [{"id": "service-active", "title": "Active", "priority": 1}],
            [
                {"id": "service-p0", "title": "Urgent", "priority": 0},
                {"id": "service-p4", "title": "Backlog", "priority": 4},
            ],
        )
        (service / ".beads" / "project-workspace-blocked.json").write_text(
            '[{"id":"blocked"}]', encoding="utf-8"
        )

        result = self.run_cli(
            "beads-counts", "--workspace", str(workspace), "--timeout", "1"
        )

        self.assertEqual(
            {
                "version": 1,
                "openByPriority": [1, 0, 0, 0, 2],
                "inProgress": 2,
                "blocked": 1,
                "successfulSources": 2,
                "unavailableSources": 0,
                "diagnostics": [],
            },
            json.loads(result.stdout),
        )
        commands = self.command_log.read_text(encoding="utf-8")
        self.assertIn("bd list --json --limit 0 --no-pager --readonly", commands)
        self.assertIn("bd blocked --json --readonly", commands)

    def test_beads_counts_reports_partial_sources_without_counting_them_as_zero(self) -> None:
        workspace = self.create_workspace("partial-counts")
        failing = self.create_repository("failing")
        missing = self.create_repository("missing")
        self.run_cli("add-repo", str(failing), "--workspace", str(workspace))
        self.run_cli("add-repo", str(missing), "--workspace", str(workspace))
        self.set_beads_status(
            workspace,
            [],
            [{"id": "workspace-p4", "title": "Backlog", "priority": 4}],
        )
        self.set_beads_status(failing, [], [])
        (failing / ".beads" / "project-workspace-status-fail").write_text(
            "store unavailable\n", encoding="utf-8"
        )

        result = self.run_cli(
            "beads-counts", "--workspace", str(workspace), "--timeout", "1"
        )
        payload = json.loads(result.stdout)

        self.assertEqual([0, 0, 0, 0, 1], payload["openByPriority"])
        self.assertEqual(1, payload["successfulSources"])
        self.assertEqual(2, payload["unavailableSources"])
        self.assertEqual(2, len(payload["diagnostics"]))
        self.assertTrue(any("failing (repos/failing): store unavailable" in item for item in payload["diagnostics"]))
        self.assertTrue(
            any(
                "missing (repos/missing): Beads store is not initialized" in item
                for item in payload["diagnostics"]
            )
        )

    def test_beads_counts_keeps_healthy_counts_when_a_store_times_out(self) -> None:
        workspace = self.create_workspace("timeout-counts")
        slow = self.create_repository("slow")
        self.run_cli("add-repo", str(slow), "--workspace", str(workspace))
        self.set_beads_status(
            workspace,
            [],
            [{"id": "workspace-p2", "title": "Ready", "priority": 2}],
        )
        self.set_beads_status(slow, [], [])
        (slow / ".beads" / "project-workspace-status-sleep").touch()

        started = time.monotonic()
        result = self.run_cli(
            "beads-counts", "--workspace", str(workspace), "--timeout", "0.1"
        )
        elapsed = time.monotonic() - started
        payload = json.loads(result.stdout)

        self.assertLess(elapsed, 1)
        self.assertEqual([0, 0, 1, 0, 0], payload["openByPriority"])
        self.assertEqual(1, payload["successfulSources"])
        self.assertEqual(1, payload["unavailableSources"])
        self.assertIn("timed out after 0.1 seconds", payload["diagnostics"][0])

    def test_beads_counts_caps_workers_and_does_not_restart_queued_timeouts(self) -> None:
        workspace = self.create_workspace("queued-counts")
        repositories = [self.create_repository(f"slow-{index}") for index in range(9)]
        for repository in repositories:
            self.run_cli("add-repo", str(repository), "--workspace", str(workspace))
        for repository in [workspace, *repositories]:
            self.set_beads_status(repository, [], [])
            (repository / ".beads" / "project-workspace-status-sleep").touch()
        self.command_log.write_text("", encoding="utf-8")

        started = time.monotonic()
        result = self.run_cli(
            "beads-counts", "--workspace", str(workspace), "--timeout", "0.1"
        )
        elapsed = time.monotonic() - started
        payload = json.loads(result.stdout)
        commands = self.command_log.read_text(encoding="utf-8").splitlines()
        count_commands = [
            command
            for command in commands
            if command.startswith(("bd list", "bd blocked"))
        ]

        self.assertLess(elapsed, 1)
        self.assertGreater(len(count_commands), 0)
        self.assertLessEqual(len(count_commands), 16)
        self.assertEqual(0, payload["successfulSources"])
        self.assertEqual(10, payload["unavailableSources"])

    def test_beads_counts_rejects_malformed_workspace_topology(self) -> None:
        workspace = self.create_workspace("malformed-counts")
        manifest = workspace / "workspace.json"
        data = json.loads(manifest.read_text(encoding="utf-8"))
        data["repositories"] = "invalid"
        manifest.write_text(json.dumps(data), encoding="utf-8")

        result = self.run_cli(
            "beads-counts", "--workspace", str(workspace), check=False
        )

        self.assertNotEqual(0, result.returncode)
        self.assertEqual("", result.stdout)
        self.assertIn("workspace.json field must be a list", result.stderr)

    def test_git_inventory_lists_all_branches_and_links_worktrees(self) -> None:
        workspace = self.create_workspace("branch-inventory")
        service = self.create_repository("service")
        alternate = self.create_repository("service-alternate")
        detached = self.create_repository("service-detached")
        self.run_cli("add-repo", str(service), "--workspace", str(workspace))
        now = int(time.time())
        self.set_branches(
            service,
            [
                ("main", "origin/main", "", now),
                ("feature", "", "", now - 86_400),
                ("parked", "origin/parked", "behind 2", now - 40 * 86_400),
            ],
        )
        self.set_worktree_entries(
            service,
            [(service, "main"), (alternate, "feature"), (detached, None)],
        )
        self.set_tracking_status(service, ahead=0, behind=0, branch="main")
        self.set_git_status(alternate, "# branch.head feature\n")
        self.set_git_status(detached, "# branch.head (detached)\n")

        result = self.run_cli("git-inventory", "--workspace", str(workspace))

        self.assertIn("=== GIT INVENTORY ===", result.stdout)
        self.assertRegex(
            result.stdout,
            rf"(?m)^service \(repos/service\) +\| branch main +\| "
            rf"worktree {re.escape(str(service.resolve()))} +\| checkout registered ",
        )
        self.assertRegex(
            result.stdout,
            rf"(?m)^service \(repos/service\) +\| branch feature +\| "
            rf"worktree {re.escape(str(alternate.resolve()))} +\| checkout alternate ",
        )
        self.assertRegex(
            result.stdout,
            r"(?m)^service \(repos/service\) +\| branch parked +\| "
            r"worktree — +\| checkout — .*\| behind 2 ",
        )
        self.assertRegex(
            result.stdout,
            rf"(?m)^service \(repos/service\) +\| branch \(detached\) +\| "
            rf"worktree {re.escape(str(detached.resolve()))} .*"
            rf"\| freshness unknown$",
        )
        self.assertIn("| freshness unclassified", result.stdout)
        commands = self.command_log.read_text(encoding="utf-8")
        self.assertIn("git for-each-ref", commands)
        self.assertNotIn("git fetch", commands)

    def test_git_inventory_classifies_freshness_only_with_threshold(self) -> None:
        workspace = self.create_workspace("stale-inventory")
        service = self.create_repository("service")
        self.run_cli("add-repo", str(service), "--workspace", str(workspace))
        now = int(time.time())
        self.set_branches(
            service,
            [
                ("fresh", "", "", now - 29 * 86_400),
                ("stale", "", "", now - 30 * 86_400),
            ],
        )
        self.set_worktree_entries(service, [(service, "fresh")])
        self.set_git_status(service, "# branch.head fresh\n")

        result = self.run_cli(
            "git-inventory",
            "--workspace",
            str(workspace),
            "--stale-after-days",
            "30",
        )

        self.assertRegex(
            result.stdout,
            r"(?m)branch fresh .*\| age 29d \| freshness current$",
        )
        self.assertRegex(
            result.stdout,
            r"(?m)branch stale .*\| age 30d \| freshness stale$",
        )

    def test_git_inventory_continues_after_branch_source_failure(self) -> None:
        workspace = self.create_workspace("partial-inventory")
        failing = self.create_repository("failing")
        healthy = self.create_repository("healthy")
        self.run_cli("add-repo", str(failing), "--workspace", str(workspace))
        self.run_cli("add-repo", str(healthy), "--workspace", str(workspace))
        (failing / ".git" / "project-workspace-branches-fail").write_text(
            "branch inventory unavailable\n", encoding="utf-8"
        )
        self.set_branches(
            healthy, [("feature", "", "", int(time.time()))]
        )
        self.set_worktree_entries(healthy, [(healthy, "feature")])
        self.set_git_status(healthy, "# branch.head feature\n")

        result = self.run_cli(
            "git-inventory", "--workspace", str(workspace), check=False
        )

        self.assertNotEqual(0, result.returncode)
        self.assertIn(
            "failing (repos/failing) | ERROR: branch inventory unavailable",
            result.stdout,
        )
        self.assertRegex(
            result.stdout,
            rf"(?m)^failing \(repos/failing\) \| branch main \| worktree "
            rf"{re.escape(str(failing.resolve()))} ",
        )
        self.assertIn("healthy (repos/healthy)", result.stdout)
        self.assertIn("branch feature", result.stdout)

    def test_git_inventory_rejects_malformed_branch_output(self) -> None:
        workspace = self.create_workspace("malformed-inventory")
        service = self.create_repository("service")
        self.run_cli("add-repo", str(service), "--workspace", str(workspace))
        (service / ".git" / "project-workspace-branches").write_text(
            "malformed\n", encoding="utf-8"
        )

        result = self.run_cli(
            "git-inventory", "--workspace", str(workspace), check=False
        )

        self.assertNotEqual(0, result.returncode)
        self.assertIn(
            "service (repos/service) | ERROR: invalid local branch inventory",
            result.stdout,
        )

    def test_git_inventory_never_classifies_unknown_worktree_state_as_integrated(
        self,
    ) -> None:
        scenarios = ("worktrees", "status", "mismatch")
        for scenario in scenarios:
            with self.subTest(scenario=scenario):
                workspace = self.create_workspace(f"{scenario}-failure-inventory")
                service = self.create_repository(f"{scenario}-service")
                alternate = self.create_repository(f"{scenario}-alternate")
                self.run_cli(
                    "add-repo", str(service), "--workspace", str(workspace)
                )
                branches = [
                    ("feature", "origin/main", "ahead 1", int(time.time()))
                ]
                if scenario == "mismatch":
                    branches.append(
                        ("other", "origin/main", "ahead 1", int(time.time()))
                    )
                self.set_branches(service, branches)
                self.set_worktree_entries(service, [(alternate, "feature")])
                self.set_patch_comparison(
                    service,
                    cherry="- 0000000000000000000000000000000000000002\n",
                )
                if scenario == "worktrees":
                    (
                        service / ".git" / "project-workspace-worktrees-fail"
                    ).write_text("worktrees unavailable\n", encoding="utf-8")
                elif scenario == "status":
                    (
                        alternate / ".git" / "project-workspace-status-fail"
                    ).write_text("status unavailable\n", encoding="utf-8")
                else:
                    self.set_git_status(
                        alternate, "# branch.head other\n? changed\n"
                    )

                result = self.run_cli(
                    "git-inventory", "--workspace", str(workspace), check=False
                )

                self.assertNotEqual(0, result.returncode)
                self.assertIn("branch feature", result.stdout)
                self.assertNotIn("integrated cleanup candidate", result.stdout)
                if scenario == "mismatch":
                    self.assertIn(
                        "worktree branch changed during inventory", result.stdout
                    )

    def test_git_inventory_reports_documented_safety_caps(self) -> None:
        workspace = self.create_workspace("bounded-inventory")
        service = self.create_repository("service")
        self.run_cli("add-repo", str(service), "--workspace", str(workspace))
        self.set_branches(
            service,
            [
                (f"branch-{index:04d}", "", "", int(time.time()))
                for index in range(1_001)
            ],
        )

        result = self.run_cli(
            "git-inventory", "--workspace", str(workspace), check=False
        )

        self.assertNotEqual(0, result.returncode)
        self.assertIn(
            "branch limit exceeded (1001 > 1000)", result.stdout
        )

        worktree_workspace = self.create_workspace("bounded-worktree-inventory")
        worktree_service = self.create_repository("worktree-service")
        self.run_cli(
            "add-repo",
            str(worktree_service),
            "--workspace",
            str(worktree_workspace),
        )
        self.set_branches(
            worktree_service,
            [("main", "", "", int(time.time()))],
        )
        self.set_worktree_entries(
            worktree_service,
            [
                (self.root / f"bounded-worktree-{index:03d}", f"branch-{index:03d}")
                for index in range(201)
            ],
        )

        worktree_result = self.run_cli(
            "git-inventory",
            "--workspace",
            str(worktree_workspace),
            check=False,
        )

        self.assertNotEqual(0, worktree_result.returncode)
        self.assertIn(
            "worktree limit exceeded (more than 200)", worktree_result.stdout
        )

    def test_git_inventory_requires_a_positive_stale_threshold(self) -> None:
        workspace = self.create_workspace("invalid-threshold")

        result = self.run_cli(
            "git-inventory",
            "--workspace",
            str(workspace),
            "--stale-after-days",
            "0",
            check=False,
        )

        self.assertEqual(2, result.returncode)
        self.assertIn("must be greater than zero", result.stderr)

    def test_git_status_does_not_run_complete_inventory(self) -> None:
        workspace = self.create_workspace("status-compatibility")

        self.run_cli("status", "--workspace", str(workspace), "--section", "git")

        commands = self.command_log.read_text(encoding="utf-8")
        self.assertNotIn("git for-each-ref", commands)
        self.assertNotIn("=== GIT INVENTORY ===", commands)

    def test_status_reports_dirty_and_ahead_alternate_worktrees(self) -> None:
        workspace = self.create_workspace("worktree-status")
        service = self.create_repository("service")
        dirty = self.create_repository("service-dirty")
        ahead = self.create_repository("service-ahead")
        behind = self.create_repository("service-behind")
        self.run_cli("add-repo", str(service), "--workspace", str(workspace))
        self.set_tracking_status(service, ahead=0, behind=0)
        self.set_tracking_status(dirty, ahead=0, behind=0, dirty=2)
        self.set_tracking_status(ahead, ahead=3, behind=1)
        self.set_tracking_status(behind, ahead=0, behind=4)
        self.set_worktrees(service, [service, dirty, ahead, behind])

        result = self.run_cli(
            "status", "--workspace", str(workspace), "--section", "git"
        )

        self.assertIn(
            f"service worktree ({dirty.resolve()})",
            result.stdout,
        )
        self.assertIn(
            "branch main | upstream origin/main | ahead 0 | behind 0 | dirty 2",
            result.stdout,
        )
        self.assertIn(
            f"service worktree ({ahead.resolve()})",
            result.stdout,
        )
        self.assertIn(
            "branch main | upstream origin/main | ahead 3 | behind 1 | dirty 0",
            result.stdout,
        )
        self.assertNotIn(
            f"service worktree ({behind.resolve()})",
            result.stdout,
        )
        self.assertNotIn("integrated cleanup candidate", result.stdout)

    def test_status_keeps_an_unmatched_clean_worktree_actionable(self) -> None:
        workspace = self.create_workspace("unmatched-worktree")
        service = self.create_repository("service")
        alternate = self.create_repository("service-alternate")
        self.run_cli("add-repo", str(service), "--workspace", str(workspace))
        self.set_tracking_status(service, ahead=0, behind=0)
        self.set_tracking_status(
            alternate, ahead=1, behind=0, branch="feature"
        )
        self.set_patch_comparison(service)
        self.set_worktrees(service, [service, alternate])

        result = self.run_cli(
            "status", "--workspace", str(workspace), "--section", "git"
        )

        self.assertIn(f"service worktree ({alternate.resolve()})", result.stdout)
        self.assertIn("ahead 1 | behind 0 | dirty 0", result.stdout)
        self.assertNotIn("integrated cleanup candidate", result.stdout)
        commands = self.command_log.read_text(encoding="utf-8")
        comparison_commands = [
            command
            for command in commands.splitlines()
            if command.startswith("comparison environment:")
        ]
        self.assertEqual(4, len(comparison_commands))
        self.assertTrue(
            all("lazy=1 locks=0" in command for command in comparison_commands)
        )
        self.assertTrue(
            any("command=cherry " in command for command in comparison_commands)
        )
        self.assertNotIn("git fetch", commands)

    def test_status_suppresses_cleanup_with_multiple_registered_heads(self) -> None:
        workspace = self.create_workspace("ambiguous-worktree")
        service = self.create_repository("service")
        linked = self.create_repository("service-linked")
        alternate = self.create_repository("service-alternate")
        self.run_cli("add-repo", str(service), "--workspace", str(workspace))
        self.run_cli(
            "add-repo",
            str(linked),
            "--name",
            "service-linked",
            "--workspace",
            str(workspace),
        )
        common_directory = self.root / "shared-common"
        for repository in (service, linked):
            (
                repository / ".git" / "project-workspace-common-dir"
            ).write_text(f"{common_directory}\n", encoding="utf-8")
            self.set_tracking_status(repository, ahead=0, behind=0)
        self.set_tracking_status(
            alternate, ahead=1, behind=0, branch="feature"
        )
        self.set_patch_comparison(
            service,
            cherry="- 0000000000000000000000000000000000000002\n",
        )
        self.set_worktrees(service, [service, linked, alternate])

        result = self.run_cli(
            "status", "--workspace", str(workspace), "--section", "git"
        )

        self.assertIn(f"service worktree ({alternate.resolve()})", result.stdout)
        self.assertNotIn("integrated cleanup candidate", result.stdout)
        commands = self.command_log.read_text(encoding="utf-8")
        self.assertNotIn("comparison environment:", commands)

    def test_status_rejects_merge_only_and_failed_patch_comparisons(self) -> None:
        scenarios = {
            "merge": ("1\n", "1\n", None),
            "malformed": ("1\n", "invalid\n", None),
            "too-many": ("101\n", "0\n", None),
            "failure": ("1\n", "0\n", "comparison unavailable\n"),
        }
        for name, (patch_count, merge_count, failure) in scenarios.items():
            with self.subTest(name=name):
                workspace = self.create_workspace(f"{name}-comparison")
                service = self.create_repository(f"{name}-service")
                alternate = self.create_repository(f"{name}-alternate")
                self.run_cli(
                    "add-repo", str(service), "--workspace", str(workspace)
                )
                self.set_tracking_status(service, ahead=0, behind=0)
                self.set_tracking_status(
                    alternate, ahead=1, behind=0, branch="feature"
                )
                self.set_patch_comparison(
                    service,
                    cherry="- 0000000000000000000000000000000000000002\n",
                    patch_count=patch_count,
                    merge_count=merge_count,
                )
                if failure is not None:
                    (
                        service
                        / ".git"
                        / "project-workspace-cherry-fail"
                    ).write_text(failure, encoding="utf-8")
                self.set_worktrees(service, [service, alternate])

                result = self.run_cli(
                    "status",
                    "--workspace",
                    str(workspace),
                    "--section",
                    "git",
                )

                self.assertIn(
                    f"{name}-service worktree ({alternate.resolve()})",
                    result.stdout,
                )
                self.assertNotIn("integrated cleanup candidate", result.stdout)

    @unittest.skipUnless(shutil.which("git"), "Git is required for worktree tests")
    def test_status_labels_a_cherry_picked_worktree_as_a_cleanup_candidate(
        self,
    ) -> None:
        real_git = self.use_real_git()
        workspace = self.create_workspace("integrated-worktree")
        repository = self.root / "integrated-service"
        repository.mkdir()
        subprocess.run(
            [real_git, "init", "-b", "main"],
            cwd=repository,
            check=True,
            capture_output=True,
        )
        subprocess.run(
            [real_git, "config", "user.email", "test@example.com"],
            cwd=repository,
            check=True,
        )
        subprocess.run(
            [real_git, "config", "user.name", "Test User"],
            cwd=repository,
            check=True,
        )
        (repository / "README.md").write_text("base\n", encoding="utf-8")
        subprocess.run([real_git, "add", "README.md"], cwd=repository, check=True)
        subprocess.run(
            [real_git, "commit", "-m", "base"],
            cwd=repository,
            check=True,
            capture_output=True,
        )
        subprocess.run(
            [real_git, "branch", "tracking-base"],
            cwd=repository,
            check=True,
        )
        alternate = self.root / "integrated-alternate"
        subprocess.run(
            [
                real_git,
                "worktree",
                "add",
                "-b",
                "feature",
                str(alternate),
                "tracking-base",
            ],
            cwd=repository,
            check=True,
            capture_output=True,
        )
        subprocess.run(
            [real_git, "branch", "--set-upstream-to=tracking-base"],
            cwd=alternate,
            check=True,
            capture_output=True,
        )
        (alternate / "feature.txt").write_text("integrated\n", encoding="utf-8")
        subprocess.run([real_git, "add", "feature.txt"], cwd=alternate, check=True)
        subprocess.run(
            [real_git, "commit", "-m", "feature"],
            cwd=alternate,
            check=True,
            capture_output=True,
        )
        feature_commit = subprocess.run(
            [real_git, "rev-parse", "HEAD"],
            cwd=alternate,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        cherry_pick_environment = os.environ.copy()
        cherry_pick_environment["GIT_COMMITTER_DATE"] = "2001-01-01T00:00:00+0000"
        subprocess.run(
            [real_git, "cherry-pick", feature_commit],
            cwd=repository,
            check=True,
            capture_output=True,
            env=cherry_pick_environment,
        )
        self.run_cli(
            "add-repo", str(repository), "--workspace", str(workspace)
        )

        result = self.run_cli(
            "status", "--workspace", str(workspace), "--section", "git"
        )

        self.assertRegex(
            result.stdout,
            rf"(?m)^integrated-service worktree \({re.escape(str(alternate.resolve()))}\)"
            r" .*\| integrated cleanup candidate$",
        )

    def test_status_reports_detached_and_no_upstream_alternate_worktrees(self) -> None:
        workspace = self.create_workspace("worktree-branches")
        service = self.create_repository("service")
        detached = self.create_repository("service-detached")
        unpublished = self.create_repository("service-unpublished")
        self.run_cli("add-repo", str(service), "--workspace", str(workspace))
        self.set_tracking_status(service, ahead=0, behind=0)
        self.set_git_status(detached, "# branch.head (detached)\n")
        self.set_git_status(unpublished, "# branch.head feature\n")
        self.set_worktrees(service, [service, detached, unpublished])

        result = self.run_cli(
            "status", "--workspace", str(workspace), "--section", "git"
        )

        self.assertIn(
            f"service worktree ({detached.resolve()})",
            result.stdout,
        )
        self.assertIn("branch (detached) | upstream —", result.stdout)
        self.assertIn(
            f"service worktree ({unpublished.resolve()})",
            result.stdout,
        )
        self.assertIn("branch feature | upstream —", result.stdout)

    @unittest.skipUnless(shutil.which("git"), "Git is required for worktree tests")
    def test_status_and_inventory_omit_bare_repository_records(self) -> None:
        real_git = self.use_real_git()
        workspace = self.create_workspace("bare-linked-worktrees")
        seed = self.root / "seed"
        bare = self.root / "bare-store"
        registered = self.root / "registered"
        alternate = self.root / "alternate"
        for arguments in (
            ["init", "-b", "main", str(seed)],
            [
                "-C", str(seed), "-c", "user.name=Test User",
                "-c", "user.email=test@example.com",
                "commit", "--allow-empty", "-m", "initial",
            ],
            ["clone", "--bare", "--local", str(seed), str(bare)],
            ["-C", str(bare), "worktree", "add", str(registered), "main"],
            ["-C", str(bare), "worktree", "add", "-b", "feature", str(alternate), "main"],
        ):
            subprocess.run(
                [real_git, *arguments], check=True, capture_output=True,
                env=self.environment,
            )
        self.run_cli("add-repo", str(registered), "--workspace", str(workspace))
        (alternate / "changed.txt").write_text("uncommitted\n", encoding="utf-8")
        porcelain = subprocess.run(
            [real_git, "-C", str(registered), "worktree", "list", "--porcelain"],
            check=True, capture_output=True, text=True,
        ).stdout
        self.assertIn(f"worktree {bare.resolve()}\nbare\n", porcelain)

        for command in (("status", "--section", "git"), ("git-inventory",)):
            with self.subTest(command=command):
                result = self.run_cli(*command, "--workspace", str(workspace), check=False)
                self.assertEqual(0, result.returncode, result.stdout + result.stderr)
                self.assertNotIn(str(bare.resolve()), result.stdout)
                self.assertIn("registered (repos/registered)", result.stdout)
                self.assertIn(str(alternate.resolve()), result.stdout)
                self.assertIn("branch feature", result.stdout)
                self.assertIn("dirty 1", result.stdout)

    def test_worktree_discovery_distinguishes_bare_only_from_empty_output(self) -> None:
        workspace = self.create_workspace("bare-only")
        output = workspace / ".git" / "project-workspace-worktrees"
        bare = self.root / "bare-store"
        for porcelain, expected_error in (
            (f"worktree {bare}\nbare\n\n", None),
            ("", "no worktree entries"),
        ):
            output.write_text(porcelain, encoding="utf-8")
            for command in (("status", "--section", "git"), ("git-inventory",)):
                with self.subTest(command=command, porcelain=porcelain):
                    result = self.run_cli(*command, "--workspace", str(workspace), check=False)
                    if expected_error is None:
                        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
                        self.assertNotIn(str(bare), result.stdout)
                    else:
                        self.assertNotEqual(0, result.returncode)
                        self.assertIn(expected_error, result.stdout)

    def test_worktree_discovery_rejects_malformed_bare_records(self) -> None:
        workspace = self.create_workspace("malformed-bare")
        output = workspace / ".git" / "project-workspace-worktrees"
        for record, expected_error in (
            ("bare", "missing worktree path"),
            (f"worktree {self.root / 'bare'}\nbare invalid", "missing branch state"),
            (f"worktree {self.root / 'bare'}", "missing branch state"),
            (f"worktree {self.root / 'bare'}\nbare\nbranch refs/heads/main",
             "conflicting bare worktree state"),
            (f"worktree {self.root / 'bare'}\nbare\ndetached",
             "conflicting bare worktree state"),
            (f"worktree {self.root / 'bare'}\nbare\nHEAD {'1' * 40}",
             "conflicting bare worktree state"),
        ):
            output.write_text(record + "\n\n", encoding="utf-8")
            for command in (("status", "--section", "git"), ("git-inventory",)):
                with self.subTest(command=command, record=record):
                    result = self.run_cli(*command, "--workspace", str(workspace), check=False)
                    self.assertNotEqual(0, result.returncode)
                    self.assertIn(expected_error, result.stdout)

    def test_worktree_discovery_rejects_duplicates_involving_bare_records(self) -> None:
        workspace = self.create_workspace("duplicate-bare")
        output = workspace / ".git" / "project-workspace-worktrees"
        bare_record = f"worktree {workspace}\nbare\n\n"
        branch_record = f"worktree {workspace}\nbranch refs/heads/main\n\n"
        for porcelain in (
            bare_record + branch_record,
            branch_record + bare_record,
            bare_record + bare_record,
        ):
            output.write_text(porcelain, encoding="utf-8")
            for command in (("status", "--section", "git"), ("git-inventory",)):
                with self.subTest(command=command, porcelain=porcelain):
                    result = self.run_cli(*command, "--workspace", str(workspace), check=False)
                    self.assertNotEqual(0, result.returncode)
                    self.assertIn("duplicate worktree path", result.stdout)

    def test_status_counts_bare_records_toward_worktree_limit(self) -> None:
        workspace = self.create_workspace("bare-limit")
        records = f"worktree {self.root / 'bare'}\nbare\n\n"
        records += "".join(
            f"worktree {self.root / str(index)}\nbranch refs/heads/main\n\n"
            for index in range(20)
        )
        (workspace / ".git" / "project-workspace-worktrees").write_text(
            records, encoding="utf-8"
        )
        result = self.run_cli(
            "status", "--section", "git", "--workspace", str(workspace), check=False
        )
        self.assertNotEqual(0, result.returncode)
        self.assertIn("worktree limit exceeded (21 > 20)", result.stdout)

    def test_status_reports_worktree_discovery_failure_and_continues(self) -> None:
        workspace = self.create_workspace("worktree-failure")
        failing = self.create_repository("failing")
        healthy = self.create_repository("healthy")
        healthy_alternate = self.create_repository("healthy-alternate")
        self.run_cli("add-repo", str(failing), "--workspace", str(workspace))
        self.run_cli("add-repo", str(healthy), "--workspace", str(workspace))
        (
            failing / ".git" / "project-workspace-worktrees-fail"
        ).write_text("worktree discovery unavailable\n", encoding="utf-8")
        self.set_git_status(healthy_alternate, "# branch.head feature\n? changed\n")
        self.set_worktrees(healthy, [healthy, healthy_alternate])

        result = self.run_cli(
            "status",
            "--workspace",
            str(workspace),
            "--section",
            "git",
            check=False,
        )

        self.assertNotEqual(0, result.returncode)
        self.assertRegex(
            result.stdout,
            r"(?m)^failing worktrees \(repos/failing\) +\| "
            r"ERROR: worktree discovery unavailable$",
        )
        self.assertIn(
            f"healthy worktree ({healthy_alternate.resolve()})",
            result.stdout,
        )

    def test_status_bounds_worktree_discovery(self) -> None:
        workspace = self.create_workspace("bounded-worktrees")
        service = self.create_repository("service")
        alternates = [
            self.create_repository(f"service-{index}") for index in range(21)
        ]
        self.run_cli("add-repo", str(service), "--workspace", str(workspace))
        self.set_worktrees(service, [service, *alternates])

        result = self.run_cli(
            "status",
            "--workspace",
            str(workspace),
            "--section",
            "git",
            check=False,
        )

        self.assertNotEqual(0, result.returncode)
        self.assertIn(
            "service worktrees (repos/service) | ERROR: "
            "worktree limit exceeded (22 > 20)",
            result.stdout,
        )

    @unittest.skipUnless(shutil.which("git"), "Git is required for worktree tests")
    def test_status_handles_registered_linked_worktree_and_deduplicates_common_dir(
        self,
    ) -> None:
        real_git = self.use_real_git()
        workspace = self.create_workspace("linked-worktrees")
        repository = self.root / "shared-repository"
        repository.mkdir()
        subprocess.run(
            [real_git, "init", "-b", "main"],
            cwd=repository,
            check=True,
            capture_output=True,
        )
        subprocess.run(
            [real_git, "config", "user.email", "test@example.com"],
            cwd=repository,
            check=True,
        )
        subprocess.run(
            [real_git, "config", "user.name", "Test User"],
            cwd=repository,
            check=True,
        )
        (repository / "README.md").write_text("test\n", encoding="utf-8")
        subprocess.run(
            [real_git, "add", "README.md"], cwd=repository, check=True
        )
        subprocess.run(
            [real_git, "commit", "-m", "initial"],
            cwd=repository,
            check=True,
            capture_output=True,
        )
        linked = self.root / "shared-linked"
        alternate = self.root / "shared-alternate"
        subprocess.run(
            [real_git, "worktree", "add", "-b", "linked", str(linked)],
            cwd=repository,
            check=True,
            capture_output=True,
        )
        subprocess.run(
            [real_git, "worktree", "add", "-b", "alternate", str(alternate)],
            cwd=repository,
            check=True,
            capture_output=True,
        )
        subprocess.run(
            [real_git, "tag", "alternate", "main"],
            cwd=repository,
            check=True,
            capture_output=True,
        )
        self.run_cli(
            "add-repo",
            str(repository),
            "--name",
            "main-copy",
            "--workspace",
            str(workspace),
        )
        self.run_cli(
            "add-repo",
            str(linked),
            "--name",
            "linked-copy",
            "--workspace",
            str(workspace),
        )

        result = self.run_cli(
            "status", "--workspace", str(workspace), "--section", "git"
        )

        self.assertRegex(result.stdout, r"(?m)^main-copy \(repos/main-copy\) +\|")
        self.assertRegex(
            result.stdout, r"(?m)^linked-copy \(repos/linked-copy\) +\|"
        )
        self.assertEqual(
            1, result.stdout.count(f"worktree ({alternate.resolve()})")
        )

        inventory = self.run_cli(
            "git-inventory", "--workspace", str(workspace), check=False
        )

        self.assertEqual(0, inventory.returncode, inventory.stdout + inventory.stderr)
        self.assertEqual(1, inventory.stdout.count("| branch alternate |"))
        self.assertEqual(1, inventory.stdout.count("| branch linked |"))
        self.assertEqual(1, inventory.stdout.count(str(alternate.resolve())))
        self.assertEqual(1, inventory.stdout.count(str(linked.resolve())))

    def test_beads_status_limits_each_work_group(self) -> None:
        workspace = self.create_workspace("bounded-status")
        ready = [
            {"id": f"workspace-{index}", "title": f"Ready {index}", "priority": 4}
            for index in range(21)
        ]
        self.set_beads_status(workspace, [], ready)

        result = self.run_cli(
            "status", "--workspace", str(workspace), "--section", "beads"
        )

        self.assertIn("workspace-19 | Ready 19", result.stdout)
        self.assertNotIn("workspace-20 | Ready 20", result.stdout)
        self.assertIn("more ready work omitted", result.stdout)
        commands = self.command_log.read_text(encoding="utf-8")
        self.assertIn("--limit 21", commands)

    def test_status_continues_after_git_and_beads_failures(self) -> None:
        workspace = self.create_workspace("partial-status")
        failing = self.create_repository("failing")
        healthy = self.create_repository("healthy")
        self.run_cli("add-repo", str(failing), "--workspace", str(workspace))
        self.run_cli("add-repo", str(healthy), "--workspace", str(workspace))
        (failing / ".git" / "project-workspace-status-fail").write_text(
            "status unavailable\n", encoding="utf-8"
        )
        self.set_git_status(healthy, "# branch.head healthy\n")
        self.set_beads_status(workspace, [], [])
        self.set_beads_status(failing, [], [])
        (failing / ".beads" / "project-workspace-status-fail").write_text(
            "store unavailable\n", encoding="utf-8"
        )
        self.set_beads_status(
            healthy,
            [],
            [{"id": "healthy-1", "title": "Still visible", "priority": 4}],
        )

        git_result = self.run_cli(
            "status", "--workspace", str(workspace), "--section", "git", check=False
        )
        beads_result = self.run_cli(
            "status", "--workspace", str(workspace), "--section", "beads", check=False
        )

        self.assertNotEqual(0, git_result.returncode)
        self.assertIn("ERROR: status unavailable", git_result.stdout)
        self.assertIn("branch healthy", git_result.stdout)
        self.assertNotEqual(0, beads_result.returncode)
        self.assertIn("ERROR: store unavailable", beads_result.stdout)
        self.assertIn("healthy-1 | Still visible", beads_result.stdout)

    def test_status_times_out_without_blocking_forever(self) -> None:
        workspace = self.create_workspace("status-timeout")
        (workspace / ".git" / "project-workspace-status-sleep").touch()

        result = self.run_cli(
            "status", "--workspace", str(workspace), "--section", "git", check=False
        )

        self.assertNotEqual(0, result.returncode)
        self.assertIn("timed out after 5 seconds", result.stdout)

    def test_generated_make_status_supports_workspace_extensions(self) -> None:
        workspace = self.create_workspace("make-status")
        service = self.create_repository("service")
        self.run_cli("add-repo", str(service), "--workspace", str(workspace))
        extension = """.PHONY: custom-status
custom-status:
\t@echo "Custom: PASS"

all-status: custom-status
"""
        (workspace / "workspace.mk").write_text(extension, encoding="utf-8")

        result = subprocess.run(
            ["make", "status"],
            capture_output=True,
            check=True,
            cwd=workspace,
            env=self.environment,
            text=True,
        )

        self.assertIn("=== GIT STATUS ===", result.stdout)
        self.assertIn("\n\n=== BEADS STATUS ===", result.stdout)
        self.assertIn("\n\n=== WORKSPACE HEALTH ===", result.stdout)
        self.assertIn("Workspace: PASS", result.stdout)
        self.assertIn("Custom: PASS", result.stdout)
        makefile = (workspace / "Makefile").read_text(encoding="utf-8")
        self.assertIn("git-status", makefile)
        self.assertIn("beads-status", makefile)
        self.assertIn("-include workspace.mk", makefile)

        second = self.create_repository("second")
        self.run_cli("add-repo", str(second), "--workspace", str(workspace))
        self.assertEqual(
            extension, (workspace / "workspace.mk").read_text(encoding="utf-8")
        )

    def test_sync_publishes_ahead_work_and_reports_skips(self) -> None:
        workspace = self.sync_workspace_with(
            "sync", ["ahead", "current", "unstaged"]
        )
        self.set_tracking_status(self.root / "ahead", ahead=6, behind=0)
        self.set_tracking_status(self.root / "current", ahead=0, behind=0)
        self.set_tracking_status(self.root / "unstaged", ahead=2, behind=0, dirty=3)

        result = self.run_cli("sync", "--workspace", str(workspace))

        self.assertIn("=== WORKSPACE SYNC ===", result.stdout)
        self.assertRegex(
            result.stdout,
            r"(?m)^workspace \(\.\) +\| skipped \(branch main has no upstream\)$",
        )
        self.assertRegex(
            result.stdout, r"(?m)^ahead \(repos/ahead\) +\| pushed 6 to origin/main$"
        )
        self.assertRegex(
            result.stdout,
            r"(?m)^current \(repos/current\) +\| up to date with origin/main$",
        )
        self.assertRegex(
            result.stdout,
            r"(?m)^unstaged \(repos/unstaged\) +\| skipped \(uncommitted changes: 3\)$",
        )
        commands = self.command_log.read_text(encoding="utf-8")
        self.assertIn(
            "Scope: registered checkouts only; alternate worktrees are not synced.",
            result.stdout,
        )
        self.assertEqual(1, commands.count("git push"))
        self.assertEqual(2, commands.count("git fetch --quiet"))
        self.assertNotIn("git worktree list", commands)

    def test_sync_fast_forwards_repositories_behind_upstream(self) -> None:
        workspace = self.sync_workspace_with("sync-behind", ["behind"])
        self.set_tracking_status(self.root / "behind", ahead=0, behind=0)
        self.set_tracking_status(
            self.root / "behind", ahead=0, behind=4, after_fetch=True
        )

        result = self.run_cli("sync", "--workspace", str(workspace))

        self.assertRegex(
            result.stdout,
            r"(?m)^behind \(repos/behind\) +\| fast-forwarded 4 from origin/main$",
        )
        commands = self.command_log.read_text(encoding="utf-8")
        self.assertIn("git merge --ff-only origin/main", commands)
        self.assertNotIn("git push", commands)

    def test_sync_rebases_diverged_repository_only_with_consent(self) -> None:
        workspace = self.sync_workspace_with("sync-diverged", ["diverged"])
        self.set_tracking_status(self.root / "diverged", ahead=2, behind=3)

        declined = self.run_cli("sync", "--workspace", str(workspace))

        self.assertIn(
            "skipped (diverged from origin/main; rerun with --yes)", declined.stdout
        )
        self.assertNotIn("git rebase", self.command_log.read_text(encoding="utf-8"))

        approved = self.run_cli("sync", "--workspace", str(workspace), "--yes")

        self.assertIn("rebased onto origin/main and pushed 2", approved.stdout)
        commands = self.command_log.read_text(encoding="utf-8")
        self.assertIn("git rebase origin/main", commands)
        self.assertIn("git push", commands)

    def test_sync_reports_repository_failures_without_stopping(self) -> None:
        workspace = self.sync_workspace_with(
            "sync-failures", ["rejected", "conflicted", "healthy"]
        )
        self.set_tracking_status(self.root / "rejected", ahead=1, behind=0)
        (self.root / "rejected" / ".git" / "project-workspace-push-fail").write_text(
            "remote rejected the update\n", encoding="utf-8"
        )
        self.set_tracking_status(self.root / "conflicted", ahead=1, behind=1)
        (
            self.root / "conflicted" / ".git" / "project-workspace-rebase-fail"
        ).write_text("conflict in shared file\n", encoding="utf-8")
        self.set_tracking_status(self.root / "healthy", ahead=0, behind=0)

        result = self.run_cli(
            "sync", "--workspace", str(workspace), "--yes", check=False
        )

        self.assertNotEqual(0, result.returncode)
        self.assertIn("ERROR: push failed: remote rejected the update", result.stdout)
        self.assertIn(
            "ERROR: rebase onto origin/main was aborted: conflict in shared file",
            result.stdout,
        )
        self.assertIn("up to date with origin/main", result.stdout)
        self.assertIn(
            "git rebase --abort", self.command_log.read_text(encoding="utf-8")
        )

    def test_sync_dry_run_previews_without_changing_repositories(self) -> None:
        workspace = self.sync_workspace_with(
            "sync-preview", ["ahead", "behind", "diverged"]
        )
        self.set_tracking_status(self.root / "ahead", ahead=6, behind=0)
        self.set_tracking_status(self.root / "behind", ahead=0, behind=4)
        self.set_tracking_status(self.root / "diverged", ahead=2, behind=3)

        result = self.run_cli("sync", "--workspace", str(workspace), "--dry-run")

        self.assertIn("would push 6 to origin/main", result.stdout)
        self.assertIn("would fast-forward 4 from origin/main", result.stdout)
        self.assertIn(
            "would rebase 2 onto origin/main and push (behind 3)", result.stdout
        )
        commands = self.command_log.read_text(encoding="utf-8")
        self.assertIn("git fetch --quiet", commands)
        self.assertNotIn("git push", commands)
        self.assertNotIn("git merge", commands)
        self.assertNotIn("git rebase", commands)

    def test_generated_make_sync_previews_repository_publication(self) -> None:
        workspace = self.sync_workspace_with("make-sync", ["service"])
        self.set_tracking_status(self.root / "service", ahead=3, behind=0)

        result = subprocess.run(
            ["make", "sync-check"],
            capture_output=True,
            check=True,
            cwd=workspace,
            env=self.environment,
            stdin=subprocess.DEVNULL,
            text=True,
        )

        self.assertIn("=== WORKSPACE SYNC ===", result.stdout)
        self.assertIn("would push 3 to origin/main", result.stdout)
        self.assertNotIn("git push", self.command_log.read_text(encoding="utf-8"))

    def test_doctor_distinguishes_unconfigured_and_partial_mgit(self) -> None:
        workspace = self.create_workspace()
        unconfigured = self.run_cli("doctor", "--workspace", str(workspace))
        (workspace / ".mgit.conf").write_text("services=\n", encoding="utf-8")
        partial = self.run_cli("doctor", "--workspace", str(workspace), check=False)

        self.assertIn("Beads: PASS", unconfigured.stdout)
        self.assertIn("Mgit: UNCONFIGURED", unconfigured.stdout)
        self.assertIn("mgit configuration is incomplete", partial.stderr)

    def test_doctor_distinguishes_missing_bd_from_an_unusable_store(self) -> None:
        missing_workspace = self.create_workspace("missing-bd")
        bin_without_bd = self.root / "bin-without-bd"
        bin_without_bd.mkdir()
        git_script = (self.bin / "git").read_text(encoding="utf-8")
        (bin_without_bd / "git").write_text(
            git_script.replace("#!/usr/bin/env bash", "#!/bin/bash", 1),
            encoding="utf-8",
        )
        (bin_without_bd / "git").chmod(0o755)
        missing_environment = self.environment.copy()
        missing_environment["PATH"] = str(bin_without_bd)

        missing = subprocess.run(
            [
                sys.executable,
                str(CLI),
                "doctor",
                "--workspace",
                str(missing_workspace),
            ],
            capture_output=True,
            check=False,
            cwd=self.root,
            env=missing_environment,
            text=True,
        )

        unusable_workspace = self.create_workspace("unusable-beads")
        self.environment["BD_HEALTH_FAIL"] = "1"
        self.environment["BD_HEALTH_ERROR"] = "database cannot be opened"
        unusable = self.run_cli(
            "doctor", "--workspace", str(unusable_workspace), check=False
        )

        self.assertIn("bd is required to validate workspace tracking", missing.stderr)
        self.assertIn("workspace Beads store is unusable", unusable.stderr)
        self.assertIn("database cannot be opened", unusable.stderr)

    def test_doctor_surfaces_mgit_verification_stderr(self) -> None:
        workspace = self.create_workspace("mgit-diagnostics")
        repository = self.create_repository("service")
        self.run_cli("add-repo", str(repository), "--workspace", str(workspace))
        self.create_mgit_skill()
        self.run_cli("configure-mgit", "--workspace", str(workspace))
        self.environment["MGIT_FAIL"] = "1"
        self.environment["MGIT_ERROR"] = "\x1b[31mrepository status unavailable\x1b[0m"

        result = self.run_cli("doctor", "--workspace", str(workspace), check=False)

        self.assertIn("mgit verification failed for root:", result.stderr)
        self.assertIn("repository status unavailable", result.stderr)
        self.assertNotIn("\x1b", result.stderr)

    def test_doctor_warns_when_template_owned_files_drift(self) -> None:
        workspace = self.create_workspace("template-drift")

        clean = self.run_cli("doctor", "--workspace", str(workspace))

        self.assertIn("Templates: PASS", clean.stdout)

        readme = workspace / "README.md"
        readme.write_text(
            readme.read_text(encoding="utf-8") + "\n## Local notes\n",
            encoding="utf-8",
        )
        agents = workspace / "AGENTS.md"
        agents.write_text(
            agents.read_text(encoding="utf-8") + "\nLocal agent guidance.\n",
            encoding="utf-8",
        )
        makefile = workspace / "Makefile"
        makefile.write_text(
            makefile.read_text(encoding="utf-8") + "\nlocal-target:\n\t@true\n",
            encoding="utf-8",
        )

        drifted = self.run_cli("doctor", "--workspace", str(workspace))

        self.assertEqual(0, drifted.returncode)
        self.assertIn(
            "Templates: WARNING (drift: README.md, AGENTS.md, Makefile)",
            drifted.stdout,
        )

    def test_doctor_rejects_missing_workspace_files_and_directories(self) -> None:
        missing_file = self.create_workspace("missing-file")
        (missing_file / "AGENTS.md").unlink()
        file_result = self.run_cli(
            "doctor", "--workspace", str(missing_file), check=False
        )

        missing_readme = self.create_workspace("missing-readme")
        (missing_readme / "README.md").unlink()
        readme_result = self.run_cli(
            "doctor", "--workspace", str(missing_readme), check=False
        )

        missing_directory = self.create_workspace("missing-directory")
        shutil.rmtree(missing_directory / "docs" / "prds")
        directory_result = self.run_cli(
            "doctor", "--workspace", str(missing_directory), check=False
        )

        overlap = self.create_workspace("overlap")
        overlap_link = overlap / "repos" / "self"
        overlap_link.symlink_to("..", target_is_directory=True)
        overlap_manifest = json.loads(
            (overlap / "workspace.json").read_text(encoding="utf-8")
        )
        overlap_manifest["repositories"] = [
            {"name": "self", "path": "repos/self", "role": "primary"}
        ]
        (overlap / "workspace.json").write_text(
            json.dumps(overlap_manifest, indent=2) + "\n", encoding="utf-8"
        )
        overlap_result = self.run_cli(
            "doctor", "--workspace", str(overlap), check=False
        )

        self.assertIn("workspace file is missing", file_result.stderr)
        self.assertIn("workspace file is missing", readme_result.stderr)
        self.assertIn("workspace directory is unsafe or missing", directory_result.stderr)
        self.assertIn("workspace and registered source must be separate", overlap_result.stderr)

    def test_generated_make_doctor_validates_state_and_links(self) -> None:
        repository = self.create_repository("doctor-repository")
        workspace = self.root / "doctor"
        self.run_cli(
            "init", "--repo", str(repository), "--output", str(workspace)
        )

        result = subprocess.run(
            ["make", "doctor"],
            capture_output=True,
            check=True,
            cwd=workspace,
            env=self.environment,
            text=True,
        )

        self.assertIn("Workspace: PASS", result.stdout)

        readme_path = workspace / "README.md"
        generated_readme = readme_path.read_text(encoding="utf-8")
        customized_readme = generated_readme + "\n## Local notes\n\nKeep this section.\n"
        readme_path.write_text(customized_readme, encoding="utf-8")
        customized = subprocess.run(
            ["make", "doctor"],
            capture_output=True,
            check=True,
            cwd=workspace,
            env=self.environment,
            text=True,
        )
        self.assertIn("Workspace: PASS", customized.stdout)
        readme_path.write_text(
            customized_readme.replace("`doctor-repository`", "`wrong-name`", 1),
            encoding="utf-8",
        )
        readme_drift = subprocess.run(
            ["make", "doctor"],
            capture_output=True,
            check=False,
            cwd=workspace,
            env=self.environment,
            text=True,
        )
        self.assertNotEqual(0, readme_drift.returncode)
        readme_path.write_text(generated_readme, encoding="utf-8")

        orphan = workspace / "repos" / "orphan"
        orphan.symlink_to(
            os.path.relpath(repository, orphan.parent), target_is_directory=True
        )
        orphaned = subprocess.run(
            ["make", "doctor"],
            capture_output=True,
            check=False,
            cwd=workspace,
            env=self.environment,
            text=True,
        )
        self.assertNotEqual(0, orphaned.returncode)
        orphan.unlink()

        (workspace / "repos" / "doctor-repository").unlink()
        failed = subprocess.run(
            ["make", "doctor"],
            capture_output=True,
            check=False,
            cwd=workspace,
            env=self.environment,
            text=True,
        )
        self.assertNotEqual(0, failed.returncode)

        link = workspace / "repos" / "doctor-repository"
        target = os.path.relpath(repository, link.parent)
        link.symlink_to(target, target_is_directory=True)
        manifest_path = workspace / "workspace.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["repositories"][0]["path"] = "repos/../outside"
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        traversal = subprocess.run(
            ["make", "doctor"],
            capture_output=True,
            check=False,
            cwd=workspace,
            env=self.environment,
            text=True,
        )
        self.assertNotEqual(0, traversal.returncode)


if __name__ == "__main__":
    unittest.main()
