---
title: "贡献博客指引"
summary: "给红岩博客投稿：在 content/blog/ 下新建一篇 Markdown 文章，填好必填字段，提一个 Pull Request，合并后自动部署上线。"
tags:
  - 指南
authors:
  - mkaaad
---

红岩博客欢迎投稿。写一篇文章只需要一个 Markdown 文件，剩下的自动化和部署都交给 CI。

## 文章放在哪里

每篇文章是一个目录：

```text
content/blog/<文章英文短名>/index.md
```

目录名建议用英文小写和短横线，比如 `content/blog/contribution-guide/index.md`。这样文章地址就是 `/blog/contribution-guide/`。

## 必填 front matter

文件开头必须用 `---` 包裹一段 YAML，包含以下字段：

```yaml
---
title: "文章标题"
summary: "一句话简介，会显示在博客卡片和分享描述里。"
tags:
  - 指南
authors:
  - 你的GitHub用户名
---
```

- `title`：文章标题
- `summary`：一句话简介
- `authors`：你的 GitHub 用户名（不是昵称）
- `tags`：可选，一个或多个标签
- `date`：可选，不用写。CI 会自动按文章首次提交时间填写，并用于排序和显示

## 正文怎么写

正文用 Markdown，直接跟在 front matter 后面。建议：

- 标题从 `##` 开始，`#` 留给页面大标题
- 代码块写清楚语言，比如 ` ```yaml `
- 图片可以放在文章目录里，用相对路径引用，比如 `![配图](cover.png)`

## 作者档案自动生成

如果 `authors` 里填的用户名还没有档案（`data/authors/<用户名>.yaml`），CI 会：

1. 从 GitHub 抓取你的名字、简介和主页
2. 自动创建 `data/authors/<用户名>.yaml` 和头像
3. 已存在的档案不会被覆盖，你手动维护的内容始终保留

想自定义档案（职务、社交链接、个人简介），见《[作者如何维护自己的档案](/blog/author-profile-guide/)》。

## 怎么提交

两种方式任选：

1. **GitHub 网页直接写**：在仓库里进入 `content/blog/`，点 "Add file" 新建目录和 `index.md`，写完在下方 "Commit changes" 里选择创建一个新分支，再点 "Compare & pull request" 发起 Pull Request。
2. **本地提交**：clone 仓库，新建分支写文章，提交推送到远程，然后在 GitHub 上发起 Pull Request。

PR 提交后 CI 会自动校验：缺少必填字段会报错并阻止合并。合并到 `main` 后网站自动重新部署，文章就上线了。

## 日志栏自动记录

如果这次改动希望自动记录到[日志栏](/log/)（修复日志、公告等），请在 PR 上打上 `log` 标签。PR 合并进 `main` 后，CI 会自动：

1. 用 PR 标题生成日志标题
2. 用 PR 描述的第一段生成日志摘要
3. 生成 `content/log/pr-<编号>/index.md` 并推回仓库，站点随即重新部署

不需要记录到日志栏的 PR 不用打标签。

## 本地预览

在仓库根目录运行：

```bash
hugo server
```

然后打开 `http://localhost:1313/` 即可预览。写完记得确认：

- 地址能正常访问
- 文章卡片上的标题、简介、作者显示正常
- 作者头像和档案链接正确
