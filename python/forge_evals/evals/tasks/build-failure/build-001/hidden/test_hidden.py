"""Private behavioral regression for the build fixture."""

from src.main import main
import subprocess
import sys


def test_command_behavior_remains_unchanged() -> None:
    assert main([]) == 0
    assert main(["--fail"]) == 1


def test_module_entrypoint_executes() -> None:
    result = subprocess.run([sys.executable, "-m", "src.main"], check=False)
    assert result.returncode == 0
