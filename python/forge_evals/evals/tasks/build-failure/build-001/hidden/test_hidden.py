"""Private behavioral regression for the build fixture."""

import subprocess
import sys

from src.main import main


def test_command_behavior_remains_unchanged() -> None:
    assert main([]) == 0
    assert main(["--fail"]) == 1


def test_module_entrypoint_executes() -> None:
    result = subprocess.run([sys.executable, "-m", "src.main"], check=False)
    assert result.returncode == 0
