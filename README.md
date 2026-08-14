# RedRock 友链电视

RedRockBlog 的 Astro 重构（进行中）：整站静态输出，`/tv` 为友链电视板块——把友链博客的每日静态镜像以"电视调台"的方式展示。

## 本地使用

```bash
npm install
npm run mirror       # 拉取并清洗友链镜像（需要 wget，产物在 public/channels/）
npm run build        # Astro 构建（含镜像）
npm run dev          # 本地预览
```

本地快速验证可加环境变量：`MIRROR_QUICK=1 npm run mirror`（只抓两层页面）。

镜像默认不下载 Halo 的 `?width=` 缩略图变体（静态托管下无收益），页面 `srcset` 会自动收敛到原图；多频道并发抓取（最多 3 路）。

## 友链申请（PR）

编辑 `src/data/channels.json`，在 `channels` 数组中新增一项：

```json
{
  "id": "example",
  "name": "博客名",
  "url": "https://example.com/",
  "description": "一句话简介",
  "enabled": true
}
```

提交 PR 即视为同意本站对博客做静态镜像（保留署名、功能引导回原站）。CI 会自动校验格式。

## 部署

`mirror.yml` 每天 03:00 UTC 定时镜像并部署到 GitHub Pages，也支持 `workflow_dispatch` 手动触发。仓库需在 Settings → Pages 中启用 GitHub Actions 作为发布源。
