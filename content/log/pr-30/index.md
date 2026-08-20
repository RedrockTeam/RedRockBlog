---
title: 文章 date 自动取首次提交时间，CI 回写增加失败重试，并测试删除 date
date: 2026-08-16T11:56:14Z
summary: '文章与日志的 date 由 CI 按首次提交时间自动维护，回写 main 的工作流增加失败重试'
pr: 30
---

## 改动内容

- 新增 `generate_commit_dates.py`：文章/日志的 `date` 自动按首次提交时间（`git log --reverse`）填写
- 新增 `content-dates.yml`：合并进 main 后自动补齐 `date` 并推回；`hugo.yml` 构建前临时注入日期
- 文章 `date` 改为可选（CI 校验同步放宽），文档与贡献指南同步更新
- 三个回写 main 的工作流（authors / log / content-dates）推送失败自动重试（最多 5 次）

来源：[PR #30](https://github.com/RedrockTeam/RedRockBlog/pull/30)
