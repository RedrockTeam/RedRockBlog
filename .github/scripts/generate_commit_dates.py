#!/usr/bin/env python3
"""Fill front-matter `date` with each content file's first git commit time.

Usage: generate_commit_dates.py  (run from repo root)

For every index.md under content/blog/ and content/log/, find the first commit
that touched the file (git log --reverse) and set front-matter `date` to that
timestamp. Files without git history (e.g. local drafts) are left untouched.

Idempotent: once `date` equals the first-commit time, later runs change nothing,
so committing the result back to main does not cause a loop.
"""

import re
import subprocess
from pathlib import Path

ROOT = Path.cwd()
CONTENT_DIRS = [ROOT / "content" / "blog", ROOT / "content" / "log"]
DATE_RE = re.compile(r"^date:\s*(.*)$")


def first_commit_date(rel):
    """Return the RFC3339 timestamp of the first commit touching rel, or None."""
    proc = subprocess.run(
        ["git", "log", "--reverse", "--format=%cI", "--", rel],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    if proc.returncode != 0:
        return None
    lines = [ln.strip() for ln in proc.stdout.splitlines() if ln.strip()]
    return lines[0] if lines else None


def set_date(text, iso):
    """Return (new_text, changed). new_text is None when no front matter."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None, False
    end = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end = i
            break
    if end is None:
        return None, False

    fm = lines[1:end]
    for i, line in enumerate(fm):
        match = DATE_RE.match(line)
        if match:
            current = match.group(1).strip().strip("'\"")
            if current == iso:
                return None, False
            fm[i] = f"date: {iso}"
            break
    else:
        for i, line in enumerate(fm):
            if line.startswith("title:"):
                fm.insert(i + 1, f"date: {iso}")
                break
        else:
            fm.insert(0, f"date: {iso}")

    new_text = "\n".join(lines[:1] + fm + lines[end:]).rstrip() + "\n"
    return new_text, True


def main():
    changed = []
    for content_dir in CONTENT_DIRS:
        if not content_dir.is_dir():
            continue
        for path in sorted(content_dir.rglob("index.md")):
            rel = path.relative_to(ROOT).as_posix()
            iso = first_commit_date(rel)
            if not iso:
                continue
            text = path.read_text(encoding="utf-8")
            new_text, is_changed = set_date(text, iso)
            if new_text is not None and is_changed:
                path.write_text(new_text, encoding="utf-8")
                changed.append(rel)

    if changed:
        print("已按首次提交时间更新 date 字段:")
        for rel in changed:
            print(f"  + {rel}")
    else:
        print("所有文章 date 已与首次提交时间一致，无需改动")


if __name__ == "__main__":
    main()
