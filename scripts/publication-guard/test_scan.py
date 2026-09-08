#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


HERE = Path(__file__).resolve().parent
SCANNER = HERE / "scan.py"
CLASSIFIER = HERE / "classify_pr_files.py"


class PublicationGuardTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="publication-guard-")
        self.repo = Path(self.temp.name) / "repo"
        self.repo.mkdir()
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "Publication Guard Test")
        self.git("config", "user.email", "guard@example.invalid")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def git(self, *args: str) -> str:
        env = os.environ.copy()
        env["GIT_CONFIG_GLOBAL"] = os.devnull
        result = subprocess.run(
            ["git", "-C", os.fspath(self.repo), *args],
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        return result.stdout.strip()

    def write(self, relative: str, content: str | bytes) -> None:
        path = self.repo / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            path.write_bytes(content)
        else:
            path.write_text(content, encoding="utf-8")

    def commit(self, message: str) -> str:
        self.git("add", "-A")
        self.git("commit", "-qm", message)
        return self.git("rev-parse", "HEAD")

    def scan(self, *args: str, policy: Path | None = None) -> subprocess.CompletedProcess[str]:
        command = ["python3", os.fspath(SCANNER), "--repo", os.fspath(self.repo)]
        if policy is not None:
            command.extend(("--policy", os.fspath(policy)))
        command.extend(args)
        return subprocess.run(
            command,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    def seed_clean(self) -> str:
        self.write("README.md", "# Public fixture\n")
        self.write("stack/worker.py", "print('public')\n")
        return self.commit("clean base")

    def test_clean_repository_passes(self) -> None:
        head = self.seed_clean()
        result = self.scan("--reachable", head)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "Publication guard: PASS\n")

    def test_renamed_private_source_is_caught_by_content_marker(self) -> None:
        self.write("docs/holding.py", "# PRIVATE SOURCE: DO NOT PUBLISH\n")
        base = self.commit("fixture source")
        (self.repo / "stack").mkdir()
        self.git("mv", "docs/holding.py", "stack/innocent-name.py")
        head = self.commit("rename fixture")

        result = self.scan("--base", base, "--head", head)
        self.assertEqual(result.returncode, 1)
        self.assertIn("rule=private-source-marker", result.stderr)
        self.assertIn("path=stack/innocent-name.py", result.stderr)

    def test_add_then_delete_secret_fails_with_redacted_output(self) -> None:
        base = self.seed_clean()
        planted = "ghp_" + "A7b9C2d4E6f8G1h3J5k7L9m2N4p6R8s1T3v5W7x9"
        self.write("stack/temporary.txt", f"token='{planted}'\n")
        self.commit("add temporary fixture")
        (self.repo / "stack/temporary.txt").unlink()
        head = self.commit("delete temporary fixture")

        result = self.scan("--base", base, "--head", head)
        self.assertEqual(result.returncode, 1)
        self.assertIn("rule=credential-github-token", result.stderr)
        self.assertIn("content=[REDACTED]", result.stderr)
        self.assertNotIn(planted, result.stdout + result.stderr)

    def test_policy_change_cannot_neuter_trusted_scan(self) -> None:
        base = self.seed_clean()
        self.write("scripts/publication-guard/rules.json", "{}\n")
        planted = "AKIA" + "Q7W9E2R4T6Y8U1I3"
        self.write("stack/config.py", f"access_key='{planted}'\n")
        head = self.commit("try policy bypass")

        result = self.scan("--base", base, "--head", head)
        self.assertEqual(result.returncode, 1)
        self.assertIn("rule=credential-aws-access-key", result.stderr)
        self.assertNotIn(planted, result.stdout + result.stderr)

        metadata = [[{"filename": "docs/rules.json", "previous_filename": "scripts/publication-guard/rules.json"}]]
        classified = subprocess.run(
            ["python3", os.fspath(CLASSIFIER), "policy"],
            input=json.dumps(metadata),
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.assertEqual(classified.returncode, 0, classified.stderr)
        self.assertEqual(classified.stdout, "1\n")

    def test_symlink_and_disguised_archive_fail_closed(self) -> None:
        self.write("README.md", "# Public fixture\n")
        self.write("stack/innocent.txt", b"PK\x03\x04synthetic archive bytes")
        link = self.repo / "stack/runtime-link"
        link.parent.mkdir(parents=True, exist_ok=True)
        link.symlink_to("../private-runtime")
        base = self.commit("unsafe objects")
        self.git("update-index", "--add", "--cacheinfo", "160000," + base + ",stack/external")
        self.git("commit", "-qm", "add synthetic gitlink")
        head = self.git("rev-parse", "HEAD")

        result = self.scan("--rev", head)
        self.assertEqual(result.returncode, 1)
        self.assertIn("rule=archive-content", result.stderr)
        self.assertIn("rule=symbolic-link", result.stderr)
        self.assertIn("rule=git-submodule", result.stderr)

    def test_public_surface_and_sensitive_filename_are_enforced(self) -> None:
        self.write("unexpected/source.py", "print('outside')\n")
        self.write("stack/.env.production", "SAFE_FIXTURE=yes\n")
        head = self.commit("invalid paths")

        result = self.scan("--rev", head)
        self.assertEqual(result.returncode, 1)
        self.assertIn("rule=path-outside-public-surface", result.stderr)
        self.assertIn("rule=sensitive-filename", result.stderr)

    def test_literal_pathspecs_cover_adversarial_filename(self) -> None:
        self.write("README.md", "# Public fixture\n")
        planted = "github_pat_" + ("A7b9_" * 15)
        self.write("docs/:(glob)*.txt", planted + "\n")
        head = self.commit("adversarial filename")

        result = self.scan("--rev", head)
        self.assertEqual(result.returncode, 1)
        self.assertIn("rule=credential-github-token", result.stderr)
        self.assertNotIn(planted, result.stdout + result.stderr)

    def test_commit_message_is_scanned_without_echoing_it(self) -> None:
        self.seed_clean()
        planted = "glpat-" + "Q7w9E2r4T6y8U1i3O5p7"
        self.write("stack/worker.py", "print('changed')\n")
        head = self.commit(f"temporary credential {planted}")

        result = self.scan("--reachable", head)
        self.assertEqual(result.returncode, 1)
        self.assertIn("path=<commit-message>", result.stderr)
        self.assertNotIn(planted, result.stdout + result.stderr)

    def test_annotated_tag_message_is_scanned_and_redacted(self) -> None:
        self.seed_clean()
        planted = "sk-" + ("A7b9_" * 9)
        self.git("tag", "-a", "v1.0.0", "-m", "release credential " + planted)

        result = self.scan("--all-refs")
        self.assertEqual(result.returncode, 1)
        self.assertIn("path=<tag-message>", result.stderr)
        self.assertNotIn(planted, result.stdout + result.stderr)

    def test_exact_blob_exception_rejects_one_byte_change(self) -> None:
        planted = "AKIA" + "Q7W9E2R4T6Y8U1I3"
        path = "stack/exact-fixture.txt"
        self.write("README.md", "# Public fixture\n")
        self.write(path, planted + "\n")
        allowed_head = self.commit("exact fixture")
        blob_oid = self.git("rev-parse", "HEAD:" + path)

        policy_data = json.loads((HERE / "rules.json").read_text(encoding="utf-8"))
        policy_data["exact_blob_allowlist"].append(
            {"rule_id": "credential-aws-access-key", "path": path, "blob_oid": blob_oid}
        )
        trusted_policy = Path(self.temp.name) / "trusted-rules.json"
        trusted_policy.write_text(json.dumps(policy_data), encoding="utf-8")
        allowed = self.scan("--rev", allowed_head, policy=trusted_policy)
        self.assertEqual(allowed.returncode, 0, allowed.stderr)

        mutated = planted[:-1] + "Z"
        self.write(path, mutated + "\n")
        changed_head = self.commit("alter exact fixture")
        changed = self.scan("--rev", changed_head, policy=trusted_policy)
        self.assertEqual(changed.returncode, 1)
        self.assertIn("rule=credential-aws-access-key", changed.stderr)
        self.assertNotIn(planted, changed.stdout + changed.stderr)
        self.assertNotIn(mutated, changed.stdout + changed.stderr)

    def test_hook_installer_honors_linked_worktree_hooks_path(self) -> None:
        self.seed_clean()
        linked = Path(self.temp.name) / "linked"
        self.git("worktree", "add", "-q", "-b", "hook-test", os.fspath(linked))
        self.assertTrue((linked / ".git").is_file())
        self.git("-C", os.fspath(linked), "config", "core.hooksPath", ".custom-hooks")

        for _ in range(2):
            installed = subprocess.run(
                [os.fspath(HERE / "install-hook.sh")],
                cwd=linked,
                check=False,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            self.assertEqual(installed.returncode, 0, installed.stderr)
        self.assertTrue((linked / ".custom-hooks/pre-push").is_file())

    def test_pre_push_invokes_optional_boundary_as_direct_argv(self) -> None:
        self.write("scripts/publication-guard/scan.py", SCANNER.read_bytes())
        self.write("scripts/publication-guard/rules.json", (HERE / "rules.json").read_bytes())
        base = self.seed_clean()
        self.write("stack/worker.py", "print('candidate')\n")
        head = self.commit("candidate")
        helper = Path(self.temp.name) / "private-boundary"
        argument_log = Path(self.temp.name) / "private-arguments.json"
        helper.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, sys\n"
            "with open(os.environ['ARGUMENT_LOG'], 'w', encoding='utf-8') as handle:\n"
            "    json.dump(sys.argv[1:], handle)\n",
            encoding="utf-8",
        )
        helper.chmod(0o755)
        self.git("config", "aideploy.privateBoundaryCommand", os.fspath(helper))
        env = os.environ.copy()
        env["ARGUMENT_LOG"] = os.fspath(argument_log)
        result = subprocess.run(
            [os.fspath(HERE / "pre-push.sh"), "origin", "https://example.invalid/repo.git"],
            cwd=self.repo,
            # Existing hook managers can strip the terminating newline while
            # replaying this ref record to their local hook.
            input=f"refs/heads/main {head} refs/heads/main {base}",
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(argument_log.read_text(encoding="utf-8")),
            ["--repo", os.fspath(self.repo.resolve()), "--base", base, "--head", head],
        )

    def test_history_modes_reject_shallow_repositories(self) -> None:
        self.seed_clean()
        self.write("stack/worker.py", "print('second commit')\n")
        self.commit("second commit")
        shallow = Path(self.temp.name) / "shallow"
        subprocess.run(
            ["git", "clone", "-q", "--depth", "1", "file://" + os.fspath(self.repo), os.fspath(shallow)],
            check=True,
        )

        result = subprocess.run(
            ["python3", os.fspath(SCANNER), "--repo", os.fspath(shallow), "--reachable", "HEAD"],
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("requires a complete, non-shallow repository", result.stderr)

    def test_classifier_rejects_malformed_file_metadata(self) -> None:
        malformed = [[{"filename": 7}, {"previous_filename": "scripts/publication-guard/rules.json"}]]
        result = subprocess.run(
            ["python3", os.fspath(CLASSIFIER), "policy"],
            input=json.dumps(malformed),
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.assertEqual(result.returncode, 2)
        self.assertNotIn("scripts/publication-guard/rules.json", result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
