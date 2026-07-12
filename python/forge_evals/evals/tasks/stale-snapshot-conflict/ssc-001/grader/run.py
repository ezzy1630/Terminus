    """Synthetic grader for task package.

    Reads JSON on stdin: {"workdir": "...", "objective": "...", ...}.
    Writes JSON on stdout: {"passed": bool, "score": float, "evidence": [...]}.
    """
    from __future__ import annotations

    import json
    import sys
    from pathlib import Path


    def check_substring(workdir: Path, needle: str) -> bool:
        """Return True iff `needle` appears in any file under workdir (depth 2)."""
        for p in workdir.rglob("*"):
            if not p.is_file():
                continue
            try:
                text = p.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            if needle in text:
                return True
        return False


    def main() -> int:
        payload = json.load(sys.stdin)
        workdir = Path(payload["workdir"])
        checks = [
            check_substring(workdir, "src/config.py contains 'DEFAULT_TIMEOUT = 60'")
check_substring(workdir, "src/config.py does not contain 'DEFAULT_TIMEOUT = 30'")
        ]
        passed_count = sum(1 for c in checks if c)
        total = len(checks) if checks else 1
        score = passed_count / total if total else 0.0
        evidence = [
            f"passed {passed_count}/{total} acceptance checks",
        ]
        for i, ok in enumerate(checks):
            evidence.append(f"check {i+1}: {'PASS' if ok else 'FAIL'}")
        out = {
            "passed": passed_count == total,
            "score": score,
            "evidence": evidence,
            "metadata": {"checks_total": total, "checks_passed": passed_count},
        }
        print(json.dumps(out))
        return 0 if out["passed"] else 1


    if __name__ == "__main__":
        sys.exit(main())
