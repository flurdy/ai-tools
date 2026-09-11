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
REPOSITORY = REPORT.parent / "target"
SENTINEL = "UNSAFE-REPORT-TEXT"


def complete_report():
    return {
        "schemaVersion": "artifact-hygiene/v1",
        "status": "complete",
        "verdict": "clean",
        "coverage": [
            {"source": source, "status": "complete", "errors": [], "limits": []}
            for source in ("working-tree", "branch-history", "custom-detectors")
        ],
        "findings": [],
    }


def with_finding(severity="info"):
    report = complete_report()
    report["verdict"] = "findings"
    report["findings"] = [{"severity": severity, "category": "fixture-category"}]
    return report


def changed(report, path, value):
    result = copy.deepcopy(report)
    entry = result
    for key in path[:-1]:
        entry = entry[key]
    entry[path[-1]] = value
    return result


class ReportGateTests(unittest.TestCase):
    def run_report(
        self, report, expected, *, helper_status=0, cwd=None, extra_env=None
    ):
        raw = report if isinstance(report, bytes) else json.dumps(report).encode()
        REPORT.write_bytes(raw)
        INVOCATION.unlink(missing_ok=True)
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
        self.assertEqual(INVOCATION.read_text().strip(), str(REPOSITORY.resolve()))
        self.assertLess(len(output), 2048)
        self.assertNotIn(SENTINEL.encode(), output)
        self.assertNotIn(b"Traceback", output)
        if expected == 0:
            self.assertIn(b"passed", output)
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
        for field in ("category", "severity"):
            report = with_finding()
            del report["findings"][0][field]
            with self.subTest(missing_finding=field):
                self.run_report(report, 2)

    def test_invalid_shapes_and_consistency(self):
        changes = [
            (("schemaVersion",), "artifact-hygiene/v2"),
            (("schemaVersion",), []),
            (("status",), "partial"),
            (("status",), "failed"),
            (("status",), None),
            (("verdict",), "partial"),
            (("verdict",), "failed"),
            (("verdict",), "findings"),
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

    def test_only_info_is_allowed(self):
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
            report.update(status=state, verdict=state)
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
