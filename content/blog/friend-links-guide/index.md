---
title: "名人堂怎么加友链"
date: 2026-08-17T00:28:33+08:00
summary: "名人堂（友链墙）的维护方法：在 data/pages/links.yaml 里加一条记录，填上站名和链接即可，卡片会自动按添加时间排序。"
tags:
  - 指南
authors:
  - mkaaad
---

[名人堂](/links/)页面展示的是和红岩互通的伙伴站点。数据集中放在 `data/pages/links.yaml` 这一个文件里，加友链只需要改它。

## 怎么加

打开 `data/pages/links.yaml`，在 `links` 列表里加一条：

```yaml
- name: 站点名
  url: https://站点地址
  description: 一句话介绍（可选）
  image: https://站点/头像.png（可选）
```

`added_at`（首次添加时间）一般不用填：合并后 CI 会自动按这条记录的首次提交时间写入，再按它排序。

## 字段说明

- `name`：站点名，必填
- `url`：站点地址，必填
- `description`：一句话介绍，可选，会直接显示在卡片上
- `image`：头像，可选
- `added_at`：首次添加时间，由 CI 自动写入，无需自己填；已经存在的值不会被覆盖

## 排序

名人堂卡片会按 `added_at` 从新到旧排列，最新添加的站点排在最前面。排序由 CI 自动处理，普通加友链不需要关心顺序；如果确实想手动调整某条的先后，直接改它对应的 `added_at` 即可，CI 会尊重已有值。

## 头像规则

- 填了 `image`：直接用它。支持填图片 URL，也支持本地文件（`assets/media/` 下的路径，比如 `friends/xxx.png`）
- 没填：自动取 `https://站点/favicon.ico`
- 图标加载失败：回退成站名首字

注意：有的站点根路径并没有 `favicon.ico`（图标被放在了别处），这种情况自动抓取会失败，卡片显示首字占位。想让头像正常显示，就去站点页面的 HTML 里找 `<link rel="icon" ...>` 声明的地址，填到 `image` 字段即可。

## 提交

改完这一个文件后，按《[贡献博客指引](/blog/contribution-guide/)》提一个 Pull Request，合并后网站会自动重新部署，新友链就上线了。
