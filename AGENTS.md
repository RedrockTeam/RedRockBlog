# AGENTS.md

## 项目概览

红岩博客（RedRock Blog）：Hugo + HugoBlox 构建的团队技术博客，多作者、组件化、纯 Markdown 写作。站点自动部署到 GitHub Pages。

- Hugo (extended) ≥ 0.161.1
- Go、Node（Tailwind 编译）
- GitHub Actions（部署 / 作者档案 / 日志生成）
- Python 3.12 + PyYAML（CI 脚本）
- 默认语言 zh-CN，时区 Asia/Shanghai

## 常用命令

- 本地预览：`hugo server`
- 构建验证：`hugo build --gc --minify`
- 安装依赖（如需）：`npm install --prefix themes/hugo-blox-builder && npm install`

## 内容规则

### 博客文章 `content/blog/<英文短名>/index.md`

必填 front matter：`title`、`summary`、`authors`（GitHub 用户名）；`tags` 可选；`date` 可选，由 CI 自动从文章首次提交时间写入。缺少必填字段时 CI 会阻止合并。

### 日志条目 `content/log/<短名>/index.md`

必填 front matter：`title`、`summary`；不需要作者字段；`date` 由 CI 自动写入。由 CI 自动生成的条目额外带 `pr` 字段（PR 编号），用于幂等去重，手工维护时不要删除。

### 显示与排序时间

页面显示和排序使用 front matter 的 `date`，其值由 CI（`.github/scripts/generate_commit_dates.py`）自动维护为文章的首次提交时间（`git log --reverse`）；CI 生成的日志条目取 PR 合并时间。作者无需手写 `date`，也不要手动改它（会被 CI 覆盖为首次提交时间）。

### 模板定制

不要直接修改 `themes/` 下的主题文件。需要定制时在 `layouts/` 或 `assets/` 里覆盖同名文件。

## 页面区块

页面由 HugoBlox 预设区块（blox）拼装，配置在 `data/pages/*.yaml` 的 `sections` 里。新增页面区块时**先从下面的预设列表里选**，不要自己写模板；没有合适预设时，再在 `layouts/` 或 `assets/` 里自定义。

预设区块（`themes/hugo-blox-builder/modules/blox/blox/`）：

| block | 用途 |
| --- | --- |
| `hero` | 首屏大标题 + 双 CTA 按钮 |
| `dev-hero` | 开发者风格首屏：渐变背景、社交链接、头像、CTA |
| `search-hero` | 带搜索框的知识库首屏 |
| `features` | 图标 + 描述的特色网格 |
| `comparison-table` | 方案/竞品对比表 |
| `logos` | 伙伴/友链 logo 墙（grid / 轮播 / 跑马灯） |
| `stats` | 带动画的数字统计 |
| `testimonials` | 用户评价引语卡片 |
| `team-showcase` | 团队成员展示 |
| `focus-areas` | 重点领域/服务卡片（卡片、六边形、时间线） |
| `cta-card` | 高对比 CTA 卡片 |
| `cta-button-list` | 竖排链接按钮列表（link-in-bio） |
| `cta-image-paragraph` | 图文交替 + 要点 + CTA |
| `content-collection` | 按文件夹聚合文章/日志等内容的集合区块 |
| `portfolio` | 可筛选的项目卡片 |
| `gallery` | 图片画廊（网格/瀑布流 + 灯箱） |
| `faq` | 常见问题手风琴 |
| `help-categories` | 帮助中心分类卡片 |
| `help-questions` | 热门/精选问题列表 |
| `pricing` | 价格档位 + 月/年切换 |
| `steps` | 步骤流程（垂直/水平/时间线） |
| `markdown` | 自由 Markdown 长文 |
| `map` | 开源交互地图 + 地址卡片 |
| `contact-info` | 联系信息卡片（地址/电话/邮箱/社交链接） |
| `resume-biography` / `resume-biography-3` | 个人简介（含头像、社交链接） |
| `resume-experience` | 工作/教育经历时间线 |
| `resume-skills` | 技能进度条 |
| `resume-languages` | 语言熟练度环形图 |
| `resume-awards` | 奖项/证书卡片 |
| `tech-stack` | 技术栈图标分组 |

## CI/CD 规则

- `.github/workflows/hugo.yml`：push 到 `main` 后构建并部署 GitHub Pages；构建前临时生成文章引用的作者档案，确保部署包含作者页。
- `.github/workflows/authors.yml`：PR 阶段校验作者字段；push 到 `main` 时自动生成/回写 `data/authors/` 和头像。
- `.github/workflows/log.yml`：push 到 `main` 时查找带 `log` 标签的关联 PR，自动生成 `content/log/pr-<编号>/index.md` 并推回 `main`，随后手动调度一次部署让日志立即上线。
- 自动生成提交使用 `github-actions[bot]`；脚本必须跳过 bot 提交，避免递归触发。
- 所有回写 `main` 的工作流必须：`permissions: contents: write`、独立 `concurrency` 组（`cancel-in-progress: false`）、push 前 `git pull --rebase origin main`。
- `GITHUB_TOKEN` 的推送不会触发新的 workflow run；如需部署，显式用 `gh workflow run hugo.yml --ref main`。

## 开发约定

- 默认分支 `main`；新功能在 `feat/*` 分支开发，通过 PR 合入。
- 提交信息用中文，建议前缀 `feat:` / `fix:` / `chore:` 等。
- PR 标题用中文，不要带 `feat:` / `fix:` / `chore:` 等提交前缀，直接描述改动即可。
- PR 正文写中文，简洁描述改动即可，第一段是简述，不要带验证/测试内容。示例：

  ````markdown
  # 友链现可根据git commit时间自动注入重排
  ## 改动内容
  - 新增友链 `added_at` 字段，CI 按首次添加提交时间自动补写并按从新到旧重排
  - 新增 friend-links 工作流在 push 后回写 main，构建前临时重排保证部署用最新文件
  - 更新《名人堂怎么加友链》指南，并去掉各板块文案句尾句号
  ````

- Python 脚本放在 `.github/scripts/`，使用 PyYAML，中文输出，GitHub API 用 `GH_TOKEN`。
- 新增 CI 工作流后检查：YAML 可解析、权限最小化、并发安全、无递归触发风险。
