---
title: 名人堂（友链）页面与添加指南
date: 2026-08-17T00:30:00+0800
summary: '## 改动内容'
pr: 41
---

## 改动内容

- 新增 /links 名人堂页面：友链卡片区块，整卡可点，支持 URL 头像，未填自动取站点 favicon，加载失败回退站名首字；数据在 data/pages/links.yaml 维护
- 导航栏加入口，当前收录 6 个站点
- 新增《名人堂怎么加友链》指南
- 作者档案移除 affiliations 字段支持与文档说明

## 验证

- hugo build --gc --minify 通过

来源：[PR #41](https://github.com/RedrockTeam/RedRockBlog/pull/41)
