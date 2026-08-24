#!/usr/bin/env python3
"""Validate a DSH skill directory (SKILL.md exists and frontmatter is legal).

Behaviour ported from the upstream claude-plugins-official skill-creator
`scripts/quick_validate.py` (checks and error wording); the implementation is
an independent rewrite under the MIT license.

Checks (matching the TypeScript port in src/lib/validate-skill.ts):
  1. SKILL.md must exist in the directory
  2. the file must carry a YAML frontmatter block (`---` ... `---`)
  3. the frontmatter must parse as a YAML mapping
  4. `name` and `description` must be present, non-empty strings
  5. `name` must match the DSH skill-name grammar (kebab-case)

CLI exit codes: 0 = valid, 1 = invalid, 2 = usage error.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

try:
    import yaml
except Exception:  # pragma: no cover - environment dependent
    yaml = None

SKILL_NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def split_frontmatter(raw: str):
    """Return (yaml_text, body) or None when no frontmatter block is present."""
    lines = raw.splitlines()
    if not lines or lines[0].strip() != "---":
        return None
    closing = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            closing = i
            break
    if closing is None:
        return None
    return "\n".join(lines[1:closing]), "\n".join(lines[closing + 1 :])


def validate_skill(skill_dir: str) -> tuple[bool, list[str]]:
    """Validate one skill directory; returns (ok, error_messages)."""
    root = Path(skill_dir)
    skill_file = root / "SKILL.md"
    if not skill_file.is_file():
        return False, [f"skill file SKILL.md not found at {root}"]

    raw = skill_file.read_text(encoding="utf-8")
    split = split_frontmatter(raw)
    if split is None:
        return False, ["missing YAML frontmatter"]

    yaml_text, _body = split
    if yaml is None:
        return False, [
            "cannot validate YAML: PyYAML is not installed (pip install pyyaml)"
        ]
    try:
        data = yaml.safe_load(yaml_text)
    except Exception as exc:  # noqa: BLE001 - report any parse failure verbatim
        return False, [f"invalid YAML frontmatter: {exc}"]

    if not isinstance(data, dict):
        return False, ["frontmatter must be a YAML mapping"]

    name = data.get("name")
    description = data.get("description")
    missing = [
        key
        for key, value in (("name", name), ("description", description))
        if not isinstance(value, str) or not value.strip()
    ]
    if missing:
        return False, [f"frontmatter requires {' and '.join(missing)}"]

    assert isinstance(name, str)  # guaranteed above
    if not SKILL_NAME_RE.match(name):
        return False, [f'invalid skill name "{name}"']

    return True, []


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) != 1:
        print(f"usage: {Path(sys.argv[0]).name} <skill-dir>", file=sys.stderr)
        return 2
    ok, errors = validate_skill(argv[0])
    if ok:
        print(f"OK: {argv[0]}")
        return 0
    for error in errors:
        print(f"FAIL: {error}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())