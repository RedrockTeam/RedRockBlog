---
title: "测试：自动作者写入"
date: 2026-08-16
summary: "验证提交文章后由 CI 自动生成作者档案的流程。"
tags:
  - test
  - ci
authors:
  - mkaaad
---

这是一篇用于测试自动作者写入的文章。

## 流程

1. 提交含 `authors` 字段（GitHub 用户名）的 Markdown 文章
2. PR 阶段校验必填字段，并尝试从 GitHub 获取作者信息
3. 合并到 `main` 后，CI 自动生成 `data/authors/mkaaad.yaml` 和头像并推回 `main`
