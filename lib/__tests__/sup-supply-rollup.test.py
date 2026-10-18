#!/usr/bin/env python3
"""sup-supply-rollup.test.py - harness test for lib/sup-supply-rollup.py.

Subprocess-runs the rollup's inline --self-test (script path resolved relative
to this file, cwd-independent - the 2026-10-11 FileNotFoundError class) and
asserts exit 0. The rollup script owns the synthetic fixtures and formula
assertions; this file only proves the CLI contract runs green.
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.abspath(os.path.join(HERE, os.pardir, "sup-supply-rollup.py"))


def main():
    proc = subprocess.run(
        [sys.executable, SCRIPT, "--self-test"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if proc.returncode != 0:
        sys.stdout.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        print("sup-supply-rollup.test.py: FAIL (self-test exited %d)" % proc.returncode)
        return 1
    print("sup-supply-rollup.test.py: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
