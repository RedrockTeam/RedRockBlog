---
title: "如何新建作者与文章"
date: 2026-08-16
summary: "Hugo Blox 新建作者和博客文章的完整流程。"
tags:
  - hugo-blox
  - guide
authors:
  - xiaolin
featured: false
---

在 Hugo Blox 里新建作者和文章，本质上就是**添加文件**，不需要数据库或后台。

## 新建作者

在 `data/authors/` 下新建 `<slug>.yaml`：

```yaml
name:
  display: 小林
role: 内容编辑
bio: 简介文字。
links:
  - icon: brands/github
    url: https://github.com/xiaolin
```

作者页会自动出现在 `/authors/<slug>/`。

## 新建文章

在 `content/blog/` 下新建 `<slug>/index.md`：

```yaml
---
title: "文章标题"
date: 2026-08-16
summary: "摘要"
tags: [hugo]
authors: [xiaolin]
featured: false
---
```

博客列表和作者页会**自动更新**。
