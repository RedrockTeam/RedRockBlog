---
title: 新增编辑与写新文章入口
date: 2026-08-20T15:32:35+0800
summary: '# 为博客、日志新增编辑与写新文章入口，为作者、名人堂新增编辑入口'
pr: 60 61
---

# 为博客新增编辑与写新文章入口

## 改动内容
- 博客文章、日志底部，作者界面，名人堂新增「编辑本页」链接，跳转到该文章对应的 GitHub 在线编辑页面
- 博客列表页新增「写新文章」按钮，日志列表页新增「写新日志」跳转到 GitHub 新建文件页面并预填文件名为 `new/index.md`
- 新增 `hugoblox.repository` 配置项，供主题拼接编辑与新建 URL

来源：[PR #60](https://github.com/RedrockTeam/RedrockBlog/pull/60) [PR #62](https://github.com/RedrockTeam/RedrockBlog/pull/62)
