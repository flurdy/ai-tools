"""Exercise the installed gate with synthetic audit reports, never real pushes."""

import copy
import json
import os
import shlex
import subprocess
import sys
import unittest
from pathlib import Path

GATE = Path(sys.argv.pop()).absolute()
REPORT = Path(os.environ["REPORT_FILE"])
INVOCATION = Path(os.environ["INVOCATION_FILE"])
CONFIG_ENVIRONMENT = Path(os.environ["CONFIG_ENVIRONMENT_FILE"])
REPOSITORY = REPORT.parent / "target"
SENTINEL = "UNSAFE-REPORT-TEXT"


def complete_report():
    return {
        "schemaVersion": "artifact-hygiene/v2",
        "status": "complete",
        "verdict": "clean",
        "coverage": [
            {"source": source, "status": "complete", "errors": [], "limits": []}
            for source in ("working-tree", "branch-history", "custom-detectors")
        ],
        "findings": [],
    }


def with_finding(severity="info", grade=None):
    report = complete_report()
    grade = grade or ("advisory" if severity == "info" else "block")
    report["verdict"] = grade
    report["findings"] = [
        {
            "severity": severity,
            "category": "fixture-category",
            "policy": {"grade": grade},
        }
    ]
    return report


def changed(report, path, value):
    result = copy.deepcopy(report)
    entry = result
    for key in path[:-1]:
        entry = entry[key]
    entry[path[-1]] = value
    return result


def credential_config(*keys):
    config = {"GIT_CONFIG_COUNT": str(len(keys))}
    for index, key in enumerate(keys):
        config[f"GIT_CONFIG_KEY_{index}"] = key
        config[f"GIT_CONFIG_VALUE_{index}"] = "false"
    return config


CREDENTIAL_KEYS = ("credential.interactive", "credential.guiPrompt")


class ReportGateTests(unittest.TestCase):
    def run_report(
        self,
        report,
        expected,
        *,
        helper_status=0,
        cwd=None,
        extra_env=None,
        audited=True,
    ):
        raw = report if isinstance(report, bytes) else json.dumps(report).encode()
        REPORT.write_bytes(raw)
        INVOCATION.unlink(missing_ok=True)
        CONFIG_ENVIRONMENT.unlink(missing_ok=True)
        payload = {"tool_input": {"command": f"git -C {REPOSITORY} push"}}
        result = subprocess.run(
            ["bash", str(GATE)],
            input=json.dumps(payload).encode(),
            capture_output=True,
            check=False,
            cwd=cwd,
            env={**os.environ, "AUDIT_STATUS": str(helper_status), **(extra_env or {})},
            timeout=20,
        )
        output = result.stdout + result.stderr
        self.assertEqual(result.returncode, expected, output.decode(errors="replace"))
        if audited:
            self.assertEqual(INVOCATION.read_text().strip(), str(REPOSITORY.resolve()))
            indexed_config = {
                key: value
                for key, value in (extra_env or {}).items()
                if key == "GIT_CONFIG_COUNT"
                or key.startswith(("GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_"))
            }
            self.assertEqual(json.loads(CONFIG_ENVIRONMENT.read_text()), indexed_config)
        else:
            self.assertFalse(INVOCATION.exists(), "Rejected config reached the auditor")
            self.assertFalse(CONFIG_ENVIRONMENT.exists())
        self.assertLess(len(output), 2048)
        self.assertNotIn(SENTINEL.encode(), output)
        self.assertNotIn(b"Traceback", output)
        if expected == 0:
            self.assertIn(b"passed", output)
            if isinstance(report, dict) and report.get("verdict") == "advisory":
                self.assertIn(b"advisory findings:", output)
        else:
            self.assertIn(b"denied", output)
            self.assertNotIn(b"passed", output)

    def test_valid_reports(self):
        for report in (complete_report(), with_finding()):
            with self.subTest(verdict=report["verdict"]):
                self.run_report(report, 0)
        extra = complete_report()
        extra["coverage"].append(
            {"source": "extra-source", "status": "complete", "errors": [], "limits": []}
        )
        self.run_report(extra, 0)

    def test_noninteractive_credential_config(self):
        for keys in (
            (),
            CREDENTIAL_KEYS[:1],
            CREDENTIAL_KEYS[1:],
            CREDENTIAL_KEYS,
            CREDENTIAL_KEYS[::-1],
        ):
            with self.subTest(keys=keys):
                self.run_report(
                    complete_report(), 0, extra_env=credential_config(*keys)
                )

    def test_invalid_config_counts(self):
        for count in (
            "",
            "-1",
            "+2",
            "02",
            "1k",
            "2 ",
            " 2",
            "2\n",
            "2.0",
            "３",
            "3",
            "999999999999999999999",
            SENTINEL,
        ):
            with self.subTest(count=count):
                self.run_report(
                    complete_report(),
                    2,
                    extra_env={
                        **credential_config(*CREDENTIAL_KEYS),
                        "GIT_CONFIG_COUNT": count,
                    },
                    audited=False,
                )

    def test_incomplete_or_extra_indexed_config(self):
        pair = credential_config(*CREDENTIAL_KEYS)
        cases = [
            {key: value for key, value in pair.items() if key != missing}
            for missing in pair
        ]
        cases.extend(
            [
                {**pair, "GIT_CONFIG_COUNT": "0"},
                {**pair, "GIT_CONFIG_COUNT": "1"},
                {"GIT_CONFIG_VALUE_0": SENTINEL},
                {"GIT_CONFIG_KEY_0": CREDENTIAL_KEYS[0]},
            ]
        )
        for prefix in ("GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_"):
            cases.extend(
                {**pair, prefix + index: SENTINEL}
                for index in ("", "2", "00", "+0", "-1", "word")
            )
        for config in cases:
            with self.subTest(config=config):
                self.run_report(complete_report(), 2, extra_env=config, audited=False)

    def test_only_the_two_exact_false_flags_are_allowed(self):
        for key in (
            "credential.helper",
            "credential.username",
            "credential.useHttpPath",
            "credential.https://example.invalid.interactive",
            "credentialInteractive",
            "CREDENTIAL.interactive",
            "credential.guiprompt",
            "core.worktree",
            "",
            SENTINEL,
        ):
            self.run_report(
                complete_report(), 2, extra_env=credential_config(key), audited=False
            )
        self.run_report(
            complete_report(),
            2,
            extra_env=credential_config(CREDENTIAL_KEYS[0], CREDENTIAL_KEYS[0]),
            audited=False,
        )
        for value in (
            "",
            "true",
            "False",
            "0",
            "never",
            "false\n",
            "!echo " + SENTINEL,
        ):
            self.run_report(
                complete_report(),
                2,
                extra_env={
                    **credential_config(*CREDENTIAL_KEYS),
                    "GIT_CONFIG_VALUE_1": value,
                },
                audited=False,
            )

    def test_credential_pair_does_not_relax_other_override_denials(self):
        for variable in (
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_COMMON_DIR",
            "GIT_INDEX_FILE",
            "GIT_OBJECT_DIRECTORY",
            "GIT_ALTERNATE_OBJECT_DIRECTORIES",
            "GIT_NAMESPACE",
            "GIT_CEILING_DIRECTORIES",
            "GIT_DISCOVERY_ACROSS_FILESYSTEM",
            "GIT_CONFIG",
            "GIT_CONFIG_PARAMETERS",
            "GIT_CONFIG_GLOBAL",
            "GIT_CONFIG_SYSTEM",
        ):
            for value in ("", SENTINEL):
                with self.subTest(variable=variable, value=value):
                    self.run_report(
                        complete_report(),
                        2,
                        extra_env={
                            **credential_config(*CREDENTIAL_KEYS),
                            variable: value,
                        },
                        audited=False,
                    )

    def test_credential_pair_preserves_report_decisions(self):
        pair = credential_config(*CREDENTIAL_KEYS)
        self.run_report(with_finding(), 0, extra_env=pair)
        self.run_report(with_finding("high"), 2, extra_env=pair)
        self.run_report(complete_report(), 2, extra_env=pair, helper_status=3)
        self.run_report(b"not-json", 2, extra_env=pair)
        partial = changed(complete_report(), ("status",), "partial")
        self.run_report(partial, 2, extra_env=pair)

    def test_environment_validator_failure_denies_before_audit(self):
        binaries = REPORT.parent / "env-validator-bin"
        binaries.mkdir(exist_ok=True)
        python = binaries / "python3"
        python.write_text(
            '#!/bin/sh\ncase "$3" in *os.environ*) '
            f"echo {SENTINEL} >&2; exit 1;; esac\n"
            f'exec {shlex.quote(sys.executable)} "$@"\n'
        )
        python.chmod(0o700)
        self.run_report(
            complete_report(),
            2,
            extra_env={
                **credential_config(*CREDENTIAL_KEYS),
                "PATH": f"{binaries}:{os.environ['PATH']}",
            },
            audited=False,
        )

    def test_decode_failures(self):
        for raw in (
            b"",
            b"not-json",
            b"[]",
            b"null",
            b'"text"',
            b"{}",
            b"\xff",
            b"[" * 2000 + b"]" * 2000,
            json.dumps(complete_report())
            .replace('"clean"', '"failed", "verdict": "clean"')
            .encode(),
            json.dumps(complete_report())
            .replace('"findings": []', '"findings": [], "extra": NaN')
            .encode(),
            b"\0" + json.dumps(complete_report()).encode(),
        ):
            with self.subTest(prefix=raw[:50], length=len(raw)):
                self.run_report(raw, 2)

    def test_size_boundary(self):
        raw = json.dumps(complete_report()).encode()
        self.run_report(raw.ljust(4_000_000, b" "), 0)
        self.run_report(raw.ljust(4_000_001, b" "), 2)

    def test_additional_coverage_entries(self):
        duplicate = complete_report()
        duplicate["coverage"].append(copy.deepcopy(duplicate["coverage"][0]))
        self.run_report(duplicate, 2)
        extra = complete_report()
        extra["coverage"].append(
            {"source": "extra-source", "status": "partial", "errors": [], "limits": []}
        )
        self.run_report(extra, 2)

    def test_required_fields(self):
        for field in complete_report():
            report = complete_report()
            del report[field]
            with self.subTest(missing=field):
                self.run_report(report, 2)
        for field in ("source", "status", "errors", "limits"):
            report = complete_report()
            del report["coverage"][0][field]
            with self.subTest(missing_coverage=field):
                self.run_report(report, 2)
        for field in ("category", "severity", "policy"):
            report = with_finding()
            del report["findings"][0][field]
            with self.subTest(missing_finding=field):
                self.run_report(report, 2)

    def test_invalid_shapes_and_consistency(self):
        changes = [
            (("schemaVersion",), "artifact-hygiene/v1"),
            (("schemaVersion",), "artifact-hygiene/v3"),
            (("schemaVersion",), []),
            (("status",), "partial"),
            (("status",), "failed"),
            (("status",), None),
            (("verdict",), "partial"),
            (("verdict",), "failed"),
            (("verdict",), "findings"),
            (("verdict",), "advisory"),
            (("verdict",), "block"),
            (("verdict",), []),
            (("coverage",), None),
            (("coverage",), {}),
            (("coverage",), []),
            (("coverage", 0), "invalid"),
            (("coverage", 0, "source"), []),
            (("coverage", 0, "source"), "branch-history"),
            (("coverage", 0, "source"), "different-source"),
            (("coverage", 0, "status"), "partial"),
            (("coverage", 0, "status"), "failed"),
            (("coverage", 0, "errors"), ["scanner-missing"]),
            (("coverage", 0, "errors"), None),
            (("coverage", 0, "limits"), ["timeout"]),
            (("coverage", 0, "limits"), ""),
            (("findings",), {}),
            (("findings",), None),
            (("findings",), ["invalid"]),
        ]
        for path, value in changes:
            with self.subTest(path=path, value=value):
                self.run_report(changed(complete_report(), path, value), 2)
        self.run_report(changed(with_finding(), ("verdict",), "clean"), 2)
        self.run_report(changed(with_finding(), ("findings",), ["invalid"]), 2)
        for category in (None, "", [], 42):
            with self.subTest(category=category):
                self.run_report(
                    changed(with_finding(), ("findings", 0, "category"), category), 2
                )

    def test_advisory_grades_allow_high_findings_but_never_critical(self):
        for severity in ("high", "medium", "low", "info"):
            self.run_report(with_finding(severity, "advisory"), 0)
        self.run_report(with_finding("critical", "advisory"), 2)
        for grade in (None, "allow", "clean", [], 0):
            self.run_report(
                changed(with_finding(), ("findings", 0, "policy", "grade"), grade), 2
            )
        self.run_report(changed(with_finding(), ("findings", 0, "policy"), {}), 2)
        self.run_report(changed(with_finding(), ("findings", 0, "policy"), None), 2)
        self.run_report(changed(with_finding("high"), ("verdict",), "advisory"), 2)
        self.run_report(changed(with_finding(), ("verdict",), "block"), 2)
        mixed = with_finding("high", "advisory")
        mixed["findings"].extend(with_finding("high", "block")["findings"])
        self.run_report(mixed, 2)
        mixed["verdict"] = "block"
        self.run_report(mixed, 2)

    def test_block_and_unknown_severities_are_denied(self):
        for severity in (
            "critical",
            "high",
            "medium",
            "low",
            "unknown",
            "INFO",
            None,
            [],
            42,
        ):
            with self.subTest(severity=severity):
                self.run_report(with_finding(severity), 2)

    def test_nonzero_helper_status(self):
        for status in (1, 2, 3, 127):
            with self.subTest(status=status):
                self.run_report(complete_report(), 2, helper_status=status)
                self.run_report(b"[]", 2, helper_status=status)
        for state, status in (("partial", 2), ("failed", 3)):
            report = complete_report()
            report.update(status=state, verdict="block")
            report["coverage"][0].update(status=state, errors=["fixture-error"])
            self.run_report(report, 2, helper_status=status)

    def test_report_text_never_reaches_output(self):
        unsafe = SENTINEL + "\x1b[31m\n1 high injected"
        self.run_report(with_finding(unsafe), 2)
        self.run_report(
            changed(with_finding("high"), ("findings", 0, "category"), unsafe), 2
        )
        self.run_report(
            changed(complete_report(), ("coverage", 0, "source"), unsafe), 2
        )
        self.run_report(
            changed(complete_report(), ("coverage", 0, "errors"), [unsafe]), 2
        )
        self.run_report(unsafe.encode(), 2)
        self.run_report(with_finding(unsafe * 10000), 2)

    def test_unexpected_validator_failure_denies(self):
        binaries = REPORT.parent / "bin"
        binaries.mkdir(exist_ok=True)
        python = binaries / "python3"
        python.write_text(
            '#!/bin/sh\ncase "$3" in *sys.stdin.buffer*) '
            f"echo {SENTINEL} >&2; exit 1;; esac\n"
            f'exec {shlex.quote(sys.executable)} "$@"\n'
        )
        python.chmod(0o700)
        self.run_report(
            complete_report(), 2, extra_env={"PATH": f"{binaries}:{os.environ['PATH']}"}
        )

    def test_python_imports_ignore_hook_cwd(self):
        poison = REPORT.parent / "json.py"
        marker = REPORT.parent / "imported"
        poison.write_text(
            f"open({str(marker)!r}, 'w').close()\nraise RuntimeError({SENTINEL!r})\n"
        )
        try:
            self.run_report(complete_report(), 0, cwd=REPORT.parent)
            self.assertFalse(marker.exists())
        finally:
            poison.unlink()


if __name__ == "__main__":
    unittest.main()
