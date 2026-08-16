# 红岩博客（RedRock Blog）

RedRock 团队的技术博客：多作者、组件化、纯 Markdown 写作，提交 PR 合并后自动部署上线。

## 技术栈

- Hugo (extended) + HugoBlox 主题
- Tailwind CSS
- GitHub Pages + GitHub Actions
- Python（CI 自动化脚本）

## 本地开发

```bash
# 安装 Hugo extended（≥ 0.161.1）、Go、Node 后：
npm install --prefix themes/hugo-blox-builder
npm install
hugo server
```

打开 `http://localhost:1313/` 预览。

## 如何投稿

见《[贡献博客指引](/blog/contribution-guide/)》：在 `content/blog/<英文短名>/index.md` 写文章，front matter 必填 `title` / `summary` / `authors`（`date` 可选，CI 自动按首次提交时间写入），发起 Pull Request，CI 校验通过后合并，站点自动重新部署。

## 日志栏（修复日志 / 公告）

站点 `/log/` 页按日期倒序展示日志条目（修复日志、公告等）。

**PR 自动生成日志：**

1. 在 PR 上打 `log` 标签
2. PR 合并进 `main` 后，CI 自动用 PR 标题生成日志标题、用 PR 描述第一段生成摘要
3. 自动生成 `content/log/pr-<编号>/index.md` 并推回仓库，站点随即重新部署

不想记录到日志栏的 PR 不需要打标签。也可以手动在 `content/log/<短名>/index.md` 写条目（必填 `title` / `summary`，`date` 自动）。

## CI/CD

| 工作流 | 作用 |
| --- | --- |
| `hugo.yml` | push 到 `main` 后构建并部署 GitHub Pages |
| `authors.yml` | 自动校验/生成作者档案 |
| `log.yml` | PR 带 `log` 标签时自动生成日志条目 |

面向 AI agent 的详细规则见 [AGENTS.md](AGENTS.md)。

## 目录结构

```text
content/blog/     博客文章
content/log/      日志 / 公告（可自动生成）
data/authors/     作者档案
layouts/          站点模板（覆盖主题）
assets/           静态资源（CSS、图片）
.github/          CI 工作流和脚本
```
