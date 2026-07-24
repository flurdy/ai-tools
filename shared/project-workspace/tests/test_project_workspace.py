#!/usr/bin/env python3
"""End-to-end tests for the project-workspace scaffold CLI."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
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
        manifest = json.loads((workspace / "workspace.json").read_text(encoding="utf-8"))
        self.assertEqual("Example Project", manifest["name"])
        self.assertEqual([], manifest["repositories"])
        self.assertEqual([], manifest["infrastructure"])
        first_commands = self.command_log.read_text(encoding="utf-8")
        self.assertIn("git init -b main", first_commands)
        self.assertIn("bd init --init-if-missing --non-interactive --skip-agents", first_commands)

        rerun = self.run_cli("init", "Example Project")

        self.assertEqual(0, rerun.returncode)
        rerun_commands = self.command_log.read_text(encoding="utf-8")
        self.assertEqual(1, rerun_commands.count("git init -b main"))
        self.assertEqual(2, rerun_commands.count("bd init --init-if-missing"))

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

    def test_dry_run_reports_plan_without_writing(self) -> None:
        workspace = self.root / "preview"

        result = self.run_cli(
            "init", "Preview", "--output", str(workspace), "--dry-run"
        )

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

    def test_configure_mgit_falls_back_to_claude_skill_directory(self) -> None:
        workspace = self.create_workspace()
        repository = self.create_repository("service")
        self.run_cli("add-repo", str(repository), "--workspace", str(workspace))
        claude_home = self.root / "claude-home"
        source = self.create_mgit_skill(claude_home / "skills")
        self.environment["SKILLS_DIR"] = str(self.root / "missing-skills")
        self.environment["CLAUDE_HOME"] = str(claude_home)

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

    def test_doctor_distinguishes_unconfigured_and_partial_mgit(self) -> None:
        workspace = self.create_workspace()
        unconfigured = self.run_cli("doctor", "--workspace", str(workspace))
        (workspace / ".mgit.conf").write_text("services=\n", encoding="utf-8")
        partial = self.run_cli("doctor", "--workspace", str(workspace), check=False)

        self.assertIn("Mgit: UNCONFIGURED", unconfigured.stdout)
        self.assertIn("mgit configuration is incomplete", partial.stderr)

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
