"""Exercise CI suite selection and its conservative diff fallback."""

import unittest
from unittest.mock import patch

from ci_changes import changed_paths, suites


class SuiteSelectionTests(unittest.TestCase):
    def test_surface_changes(self):
        cases = {
            "backend/relay/app.py": (True, False, False, True),
            "backend/migrations/env.py": (True, False, False, True),
            "backend/tests/api/test_daemon_api.py": (True, False, False, False),
            "backend/uv.lock": (True, False, False, True),
            "web/src/App.tsx": (False, False, True, True),
            "packages/relay-core/src/index.ts": (True, True, True, True),
            "packages/relay-daemon/src/index.ts": (True, True, False, True),
            "packages/relay-daemon/tsconfig.json": (True, True, False, True),
            "packages/relay-daemon/tests/install.test.ts": (True, True, False, False),
            "packages/relay-supervisor/src/index.ts": (False, True, False, False),
            "tools/vendor/braces/index.js": (False, True, True, True),
            "tsconfig.options.json": (True, True, True, True),
            "README.md": (False, False, False, False),
            "package-lock.json": (True, True, True, True),
            ".github/workflows/ci.yml": (True, True, True, True),
        }
        for path, expected in cases.items():
            with self.subTest(path=path):
                selected = suites([path])
                self.assertEqual(selected, dict(zip(("python", "typescript", "web", "concurrency"), expected)))

    def test_unknown_diff_runs_all_suites(self):
        self.assertTrue(all(suites(None).values()))
        self.assertIsNone(changed_paths("workflow_dispatch", {}))
        self.assertIsNone(changed_paths("push", {"before": "0" * 40}))

    @patch("ci_changes.subprocess.check_output")
    def test_diff_failure_runs_all_suites(self, check_output):
        import subprocess

        check_output.side_effect = subprocess.CalledProcessError(1, "git")
        self.assertTrue(all(suites(changed_paths("push", {"before": "abc", "after": "def"})).values()))

    @patch("ci_changes.subprocess.check_output", return_value=b"web/src/App.tsx\0backend/relay/app.py\0")
    def test_pull_request_uses_complete_diff(self, check_output):
        paths = changed_paths("pull_request", {"pull_request": {"base": {"sha": "abc"}, "head": {"sha": "def"}}})
        self.assertEqual(paths, ["web/src/App.tsx", "backend/relay/app.py"])
        check_output.assert_called_once_with(["git", "diff", "--name-only", "--no-renames", "-z", "abc...def"])
        self.assertEqual(suites(paths), {"python": True, "typescript": False, "web": True, "concurrency": True})


if __name__ == "__main__":
    unittest.main()
