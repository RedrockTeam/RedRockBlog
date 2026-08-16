---
title: "Test: Automatic Author Profile"
date: 2026-08-16
summary: "Verify that the CI automatically creates author profiles from submitted posts."
tags:
  - test
  - ci
authors:
  - mkaaad
---

This post is used to test the automatic author profile generation.

## Flow

1. Submit a Markdown post with an `authors` field (GitHub username)
2. The pull request validates the required fields and fetches author info from GitHub
3. After merging into `main`, CI generates `data/authors/mkaaad.yaml` and the avatar, then pushes them back
