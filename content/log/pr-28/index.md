---
title: 'fix: 日志生成后先暂存再提交（修复 PR #25 未生成日志）'
date: '2026-08-16'
summary: '## 说明'
pr: 28
---

## 说明

本 PR 是 PR #25《博客卡片改版、新增日志栏、PR 自动生成日志、cupcake 主题》的修复版：

- 博客卡片改为横条布局，整张卡片可点击，去掉大号页面标题
- 新增日志栏 `/log/`（使用 HugoBlox 自带 date-title-summary 预设），首页新增“最近日志”区块，导航栏加入口
- PR 带 `log` 标签合并后自动生成 `content/log/pr-<编号>/index.md` 并重新部署
- 默认主题切换为 cupcake
- 文档：新增 AGENTS.md、README.md，更新贡献指南，新增博客《PR 自动生成日志》

来源：[PR #28](https://github.com/RedrockTeam/RedRockBlog/pull/28)
