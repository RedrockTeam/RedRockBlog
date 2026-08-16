#!/usr/bin/env python3
"""Generate data/author_contrib.yaml: per-post author order by line contribution.

For every post under content/blog/, use `git blame --line-porcelain` to
attribute each current line of the file to an author, then map git identities
to front-matter author slugs. Authors with the most lines are listed first.

Usage: author_contrib.py  (run from repo root, before hugo build)
"""

import collections
import re
import subprocess
import sys
from pathlib import Path

import yaml

ROOT = Path.cwd()
BLOG_DIRS = [
    ROOT / "content" / "blog",
    ROOT / "content" / "zh" / "blog",
    ROOT / "content" / "en" / "blog",
]
AUTHORS_DIR = ROOT / "data" / "authors"
OUTPUT = ROOT / "data" / "author_contrib.yaml"


def norm(value):
    return re.sub(r"\s+", "", str(value).lower())


def author_aliases(slug):
    """Return normalized aliases for an author slug (name, display, GitHub user)."""
    aliases = {norm(slug)}
    profile = AUTHORS_DIR / f"{slug}.yaml"
    if profile.exists():
        data = yaml.safe_load(profile.read_text(encoding="utf-8")) or {}
        name = data.get("name")
        if isinstance(name, dict) and name.get("display"):
            aliases.add(norm(name["display"]))
        for link in data.get("links") or []:
            if not isinstance(link, dict):
                continue
            match = re.search(r"github\.com/([^/?#]+)", link.get("url") or "")
            if match:
                aliases.add(norm(match.group(1)))
    return aliases


def main():
    blog_dirs = [d for d in BLOG_DIRS if d.is_dir()]
    if not blog_dirs:
        print("未找到博客目录，跳过。")
        return

    result = {}
    markdowns = []
    for blog_dir in blog_dirs:
        markdowns.extend(blog_dir.rglob("index.md"))
    for markdown in sorted(markdowns):
        text = markdown.read_text(encoding="utf-8")
        if not text.startswith("---"):
            continue
        try:
            front_matter = yaml.safe_load(text.split("---", 2)[1]) or {}
        except yaml.YAMLError:
            continue

        authors = front_matter.get("authors") or []
        if isinstance(authors, str):
            authors = [authors]
        if not authors:
            continue

        key = markdown.relative_to(ROOT).as_posix()
        proc = subprocess.run(
            ["git", "log", "--follow", "--format=%aN|%aE", "--", key],
            capture_output=True,
            text=True,
            cwd=ROOT,
        )
        if proc.returncode != 0:
            print(f"跳过 {key}：git log 失败（{proc.stderr.strip()}）")
            continue

        git_counts = collections.Counter()
        current_name = ""
        for line in proc.stdout.splitlines():
            if line.startswith("author "):
                current_name = line[len("author "):].strip()
            elif line.startswith("author-mail ") and current_name:
                email = line[len("author-mail "):].strip().strip("<>")
                git_counts[(current_name, email)] += 1

        aliases = {slug: author_aliases(slug) for slug in authors}
        slug_counts = collections.defaultdict(int)
        for (name, email), count in git_counts.items():
            email_local = email.split("@", 1)[0]
            for slug in authors:
                if norm(name) in aliases[slug] or norm(email_local) in aliases[slug]:
                    slug_counts[slug] += count
                    break

        result[key] = sorted(
            authors,
            key=lambda slug: (-slug_counts.get(slug, 0), authors.index(slug)),
        )

    OUTPUT.write_text(
        yaml.safe_dump(result, allow_unicode=True, sort_keys=True),
        encoding="utf-8",
    )
    print(f"已生成 {OUTPUT}：{len(result)} 篇文章的作者行数贡献排序")


if __name__ == "__main__":
    sys.exit(main())
