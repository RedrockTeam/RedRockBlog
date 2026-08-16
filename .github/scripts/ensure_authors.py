#!/usr/bin/env python3
"""Ensure author profiles exist for every author referenced in blog posts.

Usage: ensure_authors.py <changed-files-list>

For each changed post under content/blog/, parse front matter and:
1. Validate required fields (title, summary, authors).
2. For every author slug without a data/authors/<slug>.yaml, create one
   from the GitHub API (name, bio, link) and download their avatar.

Exits non-zero when validation fails, so CI can block the PR.
"""

import json
import os
import re
import sys
import urllib.request
from pathlib import Path

import yaml

ROOT = Path(os.getcwd())
BLOG_DIR = ROOT / "content" / "blog"
AUTHORS_DIR = ROOT / "data" / "authors"
MEDIA_DIR = ROOT / "assets" / "media" / "authors"
TOKEN = os.environ.get("GH_TOKEN", "")


def parse_front_matter(text):
    """Return the YAML front matter dict, or None if missing."""
    if not text.startswith("---"):
        return None
    parts = text.split("---", 2)
    if len(parts) < 3:
        return None
    return yaml.safe_load(parts[1]) or {}


def extract_authors(front_matter):
    """Normalize the authors field into a list of GitHub username slugs."""
    authors = front_matter.get("authors", [])
    if not authors:
        return []
    if isinstance(authors, str):
        authors = [authors]

    slugs = []
    for author in authors:
        if isinstance(author, dict):
            link = author.get("link", "") or ""
            match = re.search(r"github\.com/([^/?#]+)", link)
            slug = match.group(1) if match else (author.get("name") or "").strip()
        else:
            slug = str(author).strip()
        if slug:
            slugs.append(slug.lower())
    return slugs


def gh_user(username):
    """Fetch a GitHub user profile."""
    url = f"https://api.github.com/users/{username}"
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "redrock-blog-authors",
    }
    if TOKEN:
        headers["Authorization"] = f"Bearer {TOKEN}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.load(resp)


def download_avatar(username, dest):
    """Download a GitHub avatar; returns True on success."""
    try:
        req = urllib.request.Request(
            f"https://github.com/{username}.png",
            headers={"User-Agent": "redrock-blog-authors"},
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            if resp.status == 200 and resp.headers.get_content_type().startswith("image/"):
                dest.write_bytes(resp.read())
                return True
    except Exception:
        pass
    return False


def main():
    if len(sys.argv) < 2:
        print("usage: ensure_authors.py <changed-files-list>")
        sys.exit(1)

    list_file = Path(sys.argv[1])
    if list_file.exists():
        changed = [line.strip() for line in list_file.read_text().splitlines() if line.strip()]
    else:
        changed = []

    errors = []
    created = []
    slugs_needed = set()

    for rel in changed:
        path = ROOT / rel
        # _index.md 是分区页而非文章，跳过校验
        if not path.is_file() or BLOG_DIR not in path.parents or path.name.startswith("_index."):
            continue

        front_matter = parse_front_matter(path.read_text(encoding="utf-8"))
        if front_matter is None:
            errors.append(f"{rel}: 缺少 YAML front matter（文件必须以 --- 开头）")
            continue

        for field in ("title", "summary"):
            if not front_matter.get(field):
                errors.append(f"{rel}: 缺少必填字段 {field}")

        authors = extract_authors(front_matter)
        if not authors:
            errors.append(f"{rel}: authors 为空，请填写 GitHub 用户名")
        slugs_needed.update(authors)

    AUTHORS_DIR.mkdir(parents=True, exist_ok=True)
    for slug in sorted(slugs_needed):
        profile = AUTHORS_DIR / f"{slug}.yaml"
        if profile.exists():
            continue
        try:
            user = gh_user(slug)
        except Exception as exc:  # noqa: BLE001
            errors.append(
                f"作者 {slug}: 无法从 GitHub 获取信息（{exc}），"
                f"请手动创建 data/authors/{slug}.yaml"
            )
            continue

        profile.write_text(
            yaml.safe_dump(
                {
                    "name": {"display": user.get("name") or user.get("login") or slug},
                    "role": "",
                    "bio": (user.get("bio") or "").strip(),
                    "links": [
                        {
                            "icon": "brands/github",
                            "url": user.get("html_url") or f"https://github.com/{slug}",
                        }
                    ],
                },
                allow_unicode=True,
                sort_keys=False,
            ),
            encoding="utf-8",
        )
        created.append(f"data/authors/{slug}.yaml")

        MEDIA_DIR.mkdir(parents=True, exist_ok=True)
        avatar = MEDIA_DIR / f"{slug}.png"
        if download_avatar(slug, avatar):
            created.append(f"assets/media/authors/{slug}.png")

    print(f"需要处理的作者: {', '.join(sorted(slugs_needed)) or '（无）'}")
    print("新生成的档案:")
    for item in created:
        print(f"  + {item}")

    if errors:
        print("\n校验失败:")
        for err in errors:
            print(f"  ✗ {err}")
        sys.exit(1)

    print("\nOK: 所有文章的作者档案已就绪")


if __name__ == "__main__":
    main()
