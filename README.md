# RedRock 友链阅读器

RedRockBlog 的 Astro 静态站点。`/tv` 左侧展示构建时缓存的友链 RSS，右侧展示对应博客的静态镜像。

## 本地使用

```bash
npm install
npm run mirror       # 拉取并清洗友链镜像（需要 wget，产物在 public/channels/）
npm run rss          # 拉取并清洗 RSS，缓存数据和封面到 public/rss/
npm run build        # Astro 构建（含镜像）
npm run dev          # 本地预览
```

本地快速验证可加环境变量：`MIRROR_QUICK=1 npm run mirror`（只抓两层页面）。

镜像只下载 HTML/CSS/JS 及少量非媒体附件（zip/pdf/xml），图片、视频、音频、字体一律不落盘，
清洗时把引用改写为原站绝对 URL（直链），因此镜像体积小（总量约 28MB 量级）、CI 拉取快；
代价是访客浏览时由浏览器直接向友站请求媒体流量，友站若有防盗链（Referer 校验）可能破图。
多频道并发抓取（最多 3 路）。

增量同步：有状态后按 `sitemap.xml` 的 `lastmod` 对比，只拉新增/更新的文章页，源站删除的页面会同步删除；首页与归档列表始终刷新；首次运行或 sitemap 不可用时自动回退全量抓取。状态文件在 `.cache/state/`，随 Actions 缓存保留。

RSS 缓存只保留文章标题、原文链接、纯文本摘要、作者、分类和发布时间，并把 RSS 提供的封面下载到本地；不会把 RSS 中的原始 HTML 注入页面。点击文章会在新标签页打开原文，右侧网站镜像保持独立浏览。单个源拉取失败时会继续沿用已有缓存。

## 友链申请（PR）

编辑 `src/data/channels.json`，在 `channels` 数组中新增一项：

```json
{
  "id": "example",
  "name": "博客名",
  "url": "https://example.com/",
  "rssUrl": "https://example.com/rss.xml",
  "description": "一句话简介",
  "enabled": true
}
```

可选字段（按需填写）：

- `rssUrl`：博客 RSS 地址；不填写时隐藏左侧文章栏，让镜像预览占满页面。
- `extraOrigins`：图片放在独立图床时，把图床域名加进 `img-src` 白名单，如 `["https://image.example.com:443"]`。
- `alwaysFetch`：sitemap 未收录但希望始终刷新的页面，如 `["/links"]`。

提交 PR 即视为同意本站对博客做静态镜像（保留署名、功能引导回原站）。CI 会自动校验格式。

## 部署

`mirror.yml` 在推送到 `main` 时、每天 03:00 UTC 定时、以及 `workflow_dispatch` 手动触发时，都会刷新网站镜像与 RSS 缓存并部署到 GitHub Pages。仓库需在 Settings → Pages 中启用 GitHub Actions 作为发布源。
