---
title: "作者如何维护自己的档案"
date: 2026-08-16T17:48:45+08:00
summary: "作者页由 data/authors/<用户名>.yaml 驱动，作者可以自己维护：补充简介、职务，添加任意社交链接，改完提个 PR 即可。"
tags:
  - 指南
authors:
  - mkaaad
---

每个作者的简介页都由仓库里的一个 YAML 文件驱动：`data/authors/<你的用户名>.yaml`。维护它不需要懂代码，改完提个 PR 就行。

## 档案长什么样

```yaml
name:
  display: mkaaad
role: 后端工程师
bio: 喜欢折腾各种技术。
links:
  - icon: brands/github
    url: https://github.com/mkaaad
```

## 可以维护哪些信息

- `name.display`：页面显示的名字
- `role`：职务 / 角色（会显示在作者页和文章卡片上）
- `bio`：个人简介
- `affiliations`：所属组织（可选）
- `links`：社交链接列表，每项是 `icon` + `url`

## 链接图标怎么填

两种方式任选：

1. **内置品牌图标**：`icon: brands/github`。主题内置 3600+ 品牌图标，常用的 GitHub、B 站（`brands/bilibili`）、X（`brands/x`）、微信（`brands/wechat`）、知乎（`brands/zhihu`）、QQ（`brands/qq`）、邮箱（`brands/gmail`）都有。
2. **直接填图片地址**：`icon: https://example.com/favicon.ico`。任何以 `http(s)` 开头的图片地址都可以直接当图标用，适合没有内置图标的网站。

## CI 会自动做什么

- 当一篇新文章引用了**还没有档案**的作者时，CI 会自动从 GitHub 抓取名字、简介和头像，创建 `data/authors/<用户名>.yaml`。
- **已存在的档案不会被覆盖**——你手动维护的内容始终保留。
- 文章 front matter 必须包含 `title`、`date`、`summary`、`authors`（填 GitHub 用户名），否则 PR 校验会报错。

## 怎么提交修改

1. 打开仓库里的 `data/authors/<你的用户名>.yaml`。
2. 点右上角铅笔图标进入编辑，改完在下方 "Commit changes" 里选择创建一个新分支。
3. 发起 Pull Request，合并后网站自动重新部署，你的作者页就更新了。

## 显示位置

修改后以下位置都会同步更新：

- 作者详情页：`/authors/<用户名>/`
- 文章页左侧作者栏（大屏）
- 文章底部作者卡片（小屏）
- 博客卡片上的作者信息
