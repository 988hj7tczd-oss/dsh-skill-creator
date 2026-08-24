#!/usr/bin/env python3
"""Package a DSH skill directory into a distributable `.skill` (zip) file.

Exclusion rules ported from the upstream claude-plugins-official skill-creator
`scripts/package_skill.py` (behaviour); the implementation is an independent
rewrite under the MIT license:

    EXCLUDE_DIRS  = {"__pycache__", "node_modules"}   (any depth)
    EXCLUDE_GLOBS = {"*.pyc"}                         (any depth)
    EXCLUDE_FILES = {".DS_Store"}                     (any depth)
    "evals/" is excluded only at the skill root.

Packaging first runs scripts/quick_validate.py's `validate_skill()`; invalid
skills refuse to package. The archive structure is `<skill-name>/ + contents`.
The produced file is written atomically (temp file + os.replace).
"""

from __future__ import annotations

import argparse
import fnmatch
import os
import sys
import tempfile
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from quick_validate import validate_skill  # noqa: E402

EXCLUDE_DIRS = {"__pycache__", "node_modules"}
EXCLUDE_GLOBS = {"*.pyc"}
EXCLUDE_FILES = {".DS_Store"}


def should_exclude(rel: str, is_dir: bool) -> bool:
    segments = [segment for segment in rel.split(os.sep) if segment]
    if not segments:
        return False
    base = segments[-1]
    if is_dir:
        if base in EXCLUDE_DIRS:
            return True
        # evals/ is excluded only when it is a direct child of the skill root.
        if len(segments) == 1 and base == "evals":
            return True
        return False
    if base in EXCLUDE_FILES:
        return True
    for glob in EXCLUDE_GLOBS:
        if fnmatch.fnmatch(base, glob):
            return True
    return False


def collect_entries(skill_root: str) -> list[tuple[str, str]]:
    """Return (rel_path, abs_path) pairs for every packageable file."""
    entries: list[tuple[str, str]] = []
    for dirpath, dirnames, filenames in os.walk(skill_root):
        rel_dir = os.path.relpath(dirpath, skill_root)
        kept: list[str] = []
        for name in dirnames:
            rel = name if rel_dir == "." else os.path.join(rel_dir, name)
            if not should_exclude(rel, True):
                kept.append(name)
        dirnames[:] = kept  # prune excluded directories from os.walk
        for name in filenames:
            rel = name if rel_dir == "." else os.path.join(rel_dir, name)
            if should_exclude(rel, False):
                continue
            entries.append((rel, os.path.join(dirpath, name)))
    entries.sort(key=lambda entry: entry[0])
    return entries


def package_skill(skill_dir: str, out_dir: str | None = None, out_path: str | None = None) -> str:
    ok, errors = validate_skill(skill_dir)
    if not ok:
        raise RuntimeError(
            "validation failed:\n" + "\n".join(f"- {error}" for error in errors)
        )
    root = Path(skill_dir)
    skill_name = root.name
    entries = collect_entries(skill_dir)
    if not entries:
        raise RuntimeError("no files to package")

    dest = out_path or str((Path(out_dir) if out_dir else root.parent) / f"{skill_name}.skill")
    dest_path = Path(dest)
    dest_path.parent.mkdir(parents=True, exist_ok=True)

    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{skill_name}-", suffix=".tmp", dir=str(dest_path.parent)
    )
    os.close(fd)
    try:
        with zipfile.ZipFile(tmp_name, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(f"{skill_name}/", "")
            for rel, abs_path in entries:
                archive.write(abs_path, arcname=f"{skill_name}/{rel}")
        os.replace(tmp_name, dest)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise
    return dest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", help="skill directory to package")
    parser.add_argument("--out-dir", default=None, help="output directory for <name>.skill")
    parser.add_argument("--out", dest="out_path", default=None, help="exact output path")
    args = parser.parse_args(argv)

    try:
        dest = package_skill(args.path, out_dir=args.out_dir, out_path=args.out_path)
    except RuntimeError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    except OSError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    print(f"OK: {dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())