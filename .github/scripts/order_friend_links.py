#!/usr/bin/env python3
"""Add `added_at` to friend links and reorder them newest-first.

Usage: order_friend_links.py  (run from repo root)

For every record under `links` in data/pages/links.yaml that lacks an
`added_at:` field, derive the first commit that introduced the record's lines
(git log -L) and inject that timestamp. Then reorder the records by
`added_at` descending (newest first), tie-broken by ascending site name.
Existing `added_at` values are never overwritten, so manual overrides are
respected.

Idempotent: if every record already has `added_at` and the order is correct,
running this changes nothing.
"""

import re
import subprocess
from datetime import datetime
from pathlib import Path

import yaml

ROOT = Path.cwd()
LINKS_YAML = ROOT / "data" / "pages" / "links.yaml"
LINKS_REL = "data/pages/links.yaml"
FIELD = "added_at"

NAME_RE = re.compile(r"^(\s*)-\s+name:\s*(.*)$")
FIELD_RE = re.compile(r"^\s*added_at:\s*(.*)$")


def first_seen_date(start, end):
    """Return the RFC3339 time of the first commit touching a line range."""
    proc = subprocess.run(
        [
            "git",
            "log",
            "--reverse",
            "--no-patch",
            "--format=%cI",
            f"-L {start},{end}:{LINKS_REL}",
        ],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    if proc.returncode != 0:
        return None
    lines = [ln.strip() for ln in proc.stdout.splitlines() if ln.strip()]
    dates = [ln for ln in lines if re.match(r"^\d{4}-\d{2}-\d{2}", ln)]
    return dates[0] if dates else None


def find_links_index(lines):
    for i, ln in enumerate(lines):
        if re.match(r"^\s*links:\s*$", ln):
            return i
    return None


def list_end_line(lines, links_idx, links_indent):
    """Index just past the last record (first line at/below links indent)."""
    for i in range(links_idx + 1, len(lines)):
        ln = lines[i]
        if not ln.strip():
            continue
        indent = len(ln) - len(ln.lstrip())
        if indent <= links_indent:
            return i
    return len(lines)


def block_name(raw):
    for ln in raw:
        m = NAME_RE.match(ln)
        if m:
            return m.group(2).strip().strip("'\"")
    return ""


def block_added_at(raw):
    for ln in raw:
        m = FIELD_RE.match(ln)
        if m:
            return m.group(1).strip().strip("'\"")
    return None


def field_indent(raw):
    for ln in raw:
        m = NAME_RE.match(ln)
        if m:
            return len(m.group(1)) + 2
    return 2


def inject_added_at(raw, iso):
    """Insert `added_at` right after the `- name:` line of a record block."""
    indent = field_indent(raw)
    line = f"{' ' * indent}{FIELD}: {iso}"
    for i, ln in enumerate(raw):
        if NAME_RE.match(ln):
            raw.insert(i + 1, line)
            return raw
    raw.append(line)
    return raw


def to_epoch(iso):
    if not iso:
        return float("inf")
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return float("inf")


def parse_blocks(lines, links_idx, links_indent, end_line):
    starts = []
    for i in range(links_idx + 1, end_line):
        m = NAME_RE.match(lines[i])
        if m and len(m.group(1)) > links_indent:
            starts.append(i)

    blocks = []
    for idx, s in enumerate(starts):
        if idx + 1 < len(starts):
            e = starts[idx + 1] - 1
        else:
            e = end_line - 1
        while e > s and not lines[e].strip():
            e -= 1
        if e < s:
            e = s
        blocks.append(
            {
                "start": s,
                "end": e,
                "raw": lines[s : e + 1],
            }
        )
    return blocks


def main():
    if not LINKS_YAML.is_file():
        print("未找到 data/pages/links.yaml，跳过")
        return

    text = LINKS_YAML.read_text(encoding="utf-8")
    lines = text.splitlines()
    links_idx = find_links_index(lines)
    if links_idx is None:
        print("未在 data/pages/links.yaml 中找到 links 列表，跳过")
        return

    links_indent = len(lines[links_idx]) - len(lines[links_idx].lstrip())
    end_line = list_end_line(lines, links_idx, links_indent)
    blocks = parse_blocks(lines, links_idx, links_indent, end_line)
    if not blocks:
        print("links 列表为空，无需处理")
        return

    for b in blocks:
        existing = block_added_at(b["raw"])
        if existing:
            b["added_at"] = existing
            continue
        # Line numbers refer to the untouched file, so computing before we
        # mutate the in-memory block is safe.
        iso = first_seen_date(b["start"] + 1, b["end"] + 1)
        if iso:
            b["added_at"] = iso
            inject_added_at(b["raw"], iso)
        else:
            b["added_at"] = None
            name = block_name(b["raw"]) or f"第 {b['start'] + 1} 行"
            print(f"  ⚠ 无法定位 {name} 的首次提交时间，保持原序")

    # Deterministic target order: newest first, then name ascending. Undated
    # records (no git attribution) are carried to the end in original order.
    ordered = sorted(blocks, key=lambda b: b["start"])
    ordered = sorted(ordered, key=lambda b: block_name(b["raw"]))
    ordered = sorted(ordered, key=lambda b: -to_epoch(b["added_at"]))

    prefix = lines[: links_idx + 1]
    suffix = lines[end_line:]
    new_lines = prefix + [ln for b in ordered for ln in b["raw"]] + suffix
    new_text = "\n".join(new_lines).rstrip() + "\n"

    # Validate the reordered YAML still parses the same number of records.
    before = yaml.safe_load(text)["sections"][0]["content"]["links"]
    after = yaml.safe_load(new_text)["sections"][0]["content"]["links"]
    if len(after) != len(before):
        print(f"校验失败：记录数从 {len(before)} 变为 {len(after)}，放弃写入")
        return

    if new_text == text:
        print("友链 added_at 与顺序已一致，无需改动")
        return

    LINKS_YAML.write_text(new_text, encoding="utf-8")
    print("已按首次添加时间写入 added_at 并重排友链:")
    for b in ordered:
        print(f"  + {block_name(b['raw']) or b['start']}  {b['added_at']}")


if __name__ == "__main__":
    main()
