#!/usr/bin/env python3
"""Generate log entries in content/log/ from merged PRs labeled `log`.

Usage: generate_log.py <commits-list>

For each commit sha in the list:
1. Skip commits authored by the bot (they have no PR and would otherwise
   re-trigger this workflow).
2. Find the associated pull request via the commits/{sha}/pulls API,
   falling back to parsing the commit message for a PR number.
3. If the PR carries the `log` label, create content/log/pr-<n>/index.md:
   title/date/summary come from PR data, body is the PR description plus a
   source link back to the PR.
4. Idempotent: existing entries (by path or `pr` field) are skipped, so a
   re-run never produces a second commit.
"""

import json
import os
import re
import subprocess
import sys
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import yaml

ROOT = Path.cwd()
LOG_DIR = Path(os.environ.get("LOG_DIR", ROOT / "content" / "log"))
REPO = os.environ.get("GITHUB_REPOSITORY", "")
TOKEN = os.environ.get("GH_TOKEN", "")
LABEL = os.environ.get("LOG_LABEL", "log")
BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com"
SUMMARY_MAX = 120
TZ = ZoneInfo("Asia/Shanghai")


def gh_api(path):
    """Call the GitHub REST API; return parsed JSON or None on failure."""
    url = f"https://api.github.com{path}"
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "redrock-blog-loggen",
    }
    if TOKEN:
        headers["Authorization"] = f"Bearer {TOKEN}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.load(resp)
    except Exception as exc:  # noqa: BLE001
        print(f"  ⚠ API 请求失败 {path}: {exc}")
        return None


def commit_author_email(sha):
    """Return the committer email for a commit."""
    proc = subprocess.run(
        ["git", "log", "-1", "--format=%ae", sha],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    return proc.stdout.strip() if proc.returncode == 0 else ""


def is_bot_commit(sha):
    """Bot-authored commits must never produce log entries."""
    return commit_author_email(sha) == BOT_EMAIL


def find_prs_for_commit(sha):
    """Return PR objects associated with a commit, or []."""
    if REPO:
        prs = gh_api(f"/repos/{REPO}/commits/{sha}/pulls")
        if isinstance(prs, list):
            return prs
    # Fallback: parse the commit subject for "Merge pull request #N" / "(#N)".
    proc = subprocess.run(
        ["git", "log", "-1", "--format=%s", sha],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    subject = proc.stdout.strip() if proc.returncode == 0 else ""
    match = re.search(r"(?:Merge pull request #|#)(\d+)", subject)
    if match and REPO:
        pr = gh_api(f"/repos/{REPO}/pulls/{match.group(1)}")
        return [pr] if isinstance(pr, dict) else []
    return []


def has_log_label(pr):
    for label in pr.get("labels") or []:
        if isinstance(label, dict) and label.get("name", "").lower() == LABEL.lower():
            return True
    return False


def plainify(text):
    """Rough markdown → plain text for the summary line."""
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)  # images
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)  # links → label
    text = text.replace("**", "").replace("`", "").replace("~~", "")
    return text


def first_paragraph(body):
    """First non-empty paragraph of the PR description, plainified."""
    if not body:
        return ""
    for para in re.split(r"\n\s*\n", body):
        cleaned = re.sub(r"\s+", " ", plainify(para)).strip()
        if cleaned:
            return cleaned
    return ""


def make_summary(pr):
    summary = first_paragraph(pr.get("body") or "")
    if not summary:
        summary = (pr.get("title") or "").strip()
    if len(summary) > SUMMARY_MAX:
        summary = summary[:SUMMARY_MAX].rstrip() + "…"
    return summary


def entry_exists(number):
    return (LOG_DIR / f"pr-{number}" / "index.md").exists()


def generate_entry(pr):
    """Write one log entry and return its repo-relative path."""
    number = pr["number"]
    title = (pr.get("title") or f"PR #{number}").strip()
    merged_at = pr.get("merged_at") or ""
    if merged_at:
        date = (
            datetime.fromisoformat(merged_at.replace("Z", "+00:00"))
            .astimezone(TZ)
            .strftime("%Y-%m-%d")
        )
    else:
        date = datetime.now(TZ).strftime("%Y-%m-%d")
    summary = make_summary(pr)
    body = (pr.get("body") or "").strip()
    pr_url = pr.get("html_url") or f"https://github.com/{REPO}/pull/{number}"
    source = f"来源：[PR #{number}]({pr_url})"

    entry_dir = LOG_DIR / f"pr-{number}"
    entry_dir.mkdir(parents=True, exist_ok=True)
    entry = entry_dir / "index.md"

    front = yaml.safe_dump(
        {"title": title, "date": date, "summary": summary, "pr": number},
        allow_unicode=True,
        sort_keys=False,
    )
    parts = ["---", front.rstrip(), "---", ""]
    if body:
        parts.append(body)
        parts.append("")
    parts.append(source)
    parts.append("")
    entry.write_text("\n".join(parts), encoding="utf-8")
    return os.path.relpath(entry, ROOT).replace(os.sep, "/")


def main():
    if len(sys.argv) < 2:
        print("usage: generate_log.py <commits-list>")
        sys.exit(1)

    list_file = Path(sys.argv[1])
    shas = (
        [line.strip() for line in list_file.read_text().splitlines() if line.strip()]
        if list_file.exists()
        else []
    )

    if not shas:
        print("没有需要处理的提交。")
        return

    created = []
    for sha in shas:
        if is_bot_commit(sha):
            print(f"跳过 bot 提交 {sha[:8]}")
            continue
        print(f"处理提交 {sha[:8]}")
        prs = find_prs_for_commit(sha)
        matched = [pr for pr in prs if isinstance(pr, dict) and has_log_label(pr)]
        if not matched:
            continue
        for pr in matched:
            number = pr["number"]
            if entry_exists(number):
                print(f"  日志已存在（PR #{number}），跳过")
                continue
            path = generate_entry(pr)
            created.append(path)
            print(f"  + {path}")

    print(f"新生成的日志条目: {len(created)}")
    for item in created:
        print(f"  + {item}")


if __name__ == "__main__":
    main()
