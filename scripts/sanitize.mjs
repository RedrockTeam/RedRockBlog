import { readFile, writeFile, mkdir, rm, copyFile, readdir, open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { load } from 'cheerio';

const REMOVE_SCRIPT_RE =
  /(halo-tracker|PluginCommentWidget|PluginSearchWidget|metmusic|summaraid|analytics|umami|plausible|goatcounter|matomo|tracker)/i;
const INLINE_REMOVE_RE = /\/plugins\/(PluginCommentWidget|PluginSearchWidget)/;
const KNOWN_ROOT_RE =
  /(["'])\/(upload|themes|plugins|archives|tags|categories|links|pages|images|search|rss|sitemap|favicon|about-me|met-website)\/([^"'\s\\]*)/g;
// 部分友站会把图片/头像放在独立图床，镜像不抓跨域资源，
// 需要把这些来源加进 img-src 白名单，页面才能正常显示图片。
function buildCsp(extraOrigins = []) {
  const img = ["'self'", "'data:'", ...extraOrigins].join(' ');
  const media = ["'self'", ...extraOrigins].join(' ');
  return `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src ${img}; font-src 'self' data:; media-src ${media}; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'`;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rewriteRoot(value, prefix, origin) {
  if (typeof value !== 'string') return value;
  const clean = value.replace(/\?width=[^&]*/, '');
  if (clean.startsWith('/') && !clean.startsWith('//')) {
    return prefix + clean;
  }
  // 同源绝对链接（http(s)://原站/... 或 //原站/...）也改写为镜像本地路径，
  // 否则会被 CSP img-src 'self' 拦截成破图。
  if (origin && /^(https?:)?\/\//i.test(clean)) {
    try {
      const u = new URL(clean, origin);
      if (u.origin === new URL(origin).origin) {
        return prefix + u.pathname + (u.search || '');
      }
    } catch {
      // 解析失败则原样保留
    }
  }
  return clean;
}

// 源站可能引用预压缩的 .css.gz / .js.gz（含带查询串形式），镜像里只有未压缩版，去掉 .gz
function rewriteAssetExt(value) {
  return typeof value === 'string'
    ? value.replace(/(\.(?:css|js)(?:(?:[?#]|%3[fF])[^"'\s]*)?)\.gz$/i, '$1')
    : value;
}

function cleanRef(value, prefix, origin) {
  if (typeof value !== 'string') return value;
  let v = rewriteAssetExt(rewriteRoot(value, prefix, origin));
  // wget 把含查询串的资源存成字面 "?":main.css?v=1.0.6，引用需编码为 %3F，
  // 否则浏览器把 ? 当查询串、按 main.css 找文件 → 404（页面白屏）
  if (!/^(https?:)?\/\//i.test(v)) v = v.replace(/\?/g, '%3F');
  return v;
}

// 把原站绝对链接的路径解析为镜像里真实存在的相对文件（与 wget -E 落盘规则一致）
function resolveLocalPath(pathname, outDir) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname.split('?')[0]);
  } catch {
    decoded = pathname.split('?')[0];
  }
  let rel = decoded.replace(/^\//, '');
  if (decoded.endsWith('/')) rel += 'index';
  const candidates = [rel];
  if (!rel.endsWith('.html') && !rel.endsWith('.htm')) candidates.push(`${rel}.html`);
  candidates.push(path.posix.join(rel, 'index.html'));
  for (const c of candidates) {
    if (c && existsSync(path.join(outDir, c))) return c;
  }
  return null;
}

function rewriteSrcset(value, prefix, origin) {
  return value
    .split(',')
    .map((part) => {
      const m = part.trim().match(/^(\S+)(\s+.+)?$/);
      if (!m) return part;
      return cleanRef(m[1], prefix, origin) + (m[2] ?? '');
    })
    .join(', ');
}

function resolveIconPath(iconHref, file, outDir, prefix) {
  const clean = iconHref.split('?')[0];
  if (clean.startsWith(prefix)) {
    return path.join(outDir, clean.slice(prefix.length).replace(/^\//, ''));
  }
  if (clean.startsWith('/')) {
    return path.join(outDir, clean.replace(/^\//, ''));
  }
  const relDir = path.relative(outDir, path.dirname(file)).split(path.sep).join('/');
  const resolved = path.posix.normalize(path.posix.join(relDir, clean));
  return path.join(outDir, resolved);
}

async function looksLikeHtml(file) {
  try {
    const fh = await open(file, 'r');
    const buf = Buffer.alloc(512);
    const { bytesRead } = await fh.read(buf, 0, 512, 0);
    await fh.close();
    return /^\s*<(?:!doctype\s+html|html)/i.test(buf.subarray(0, bytesRead).toString('utf8'));
  } catch {
    return false;
  }
}

function rewriteJsonStrings(node, prefix, origin) {
  if (typeof node === 'string') {
    return cleanRef(node, prefix, origin);
  }
  if (Array.isArray(node)) {
    return node.map((v) => rewriteJsonStrings(v, prefix, origin));
  }
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = rewriteJsonStrings(v, prefix, origin);
    return out;
  }
  return node;
}

function rewriteCssUrls(css, prefix, origin) {
  // 根相对路径 url(/upload/...)
  css = css.replace(/(url\(\s*['"]?)\//g, `$1${prefix}/`);
  // 同源绝对路径 url(https://原站/upload/...)
  if (origin) {
    const o = origin.replace(/\/$/, '');
    css = css.replace(new RegExp(`(url\\(\\s*['"]?)${escapeRegExp(o)}`, 'g'), `$1${prefix}`);
  }
  // 去掉 .gz 后缀的引用（镜像内只有未压缩版）
  css = css.replace(/(url\(\s*['"]?)([^)'"]+)/g, (m, pre, p) => pre + rewriteAssetExt(p));
  return css;
}

// 部分友站对 CSS/JS 下发的是 gzip 字节（Content-Encoding: gzip），
// wget 会原样存成 *.css/*.js，浏览器从 GitHub Pages 拿到后无法解析。
// 这里把缓存里的 gzip 资源解压为明文；.gz 后缀的再落到无后缀文件名。
async function decompressGzAssets(dir) {
  for (const file of await listFiles(dir)) {
    if (!/\.gz$/i.test(file)) continue;
    try {
      const buf = await readFile(file);
      const out = gunzipSync(buf);
      const target = file.replace(/\.gz$/i, '');
      await writeFile(target, out);
      await rm(file, { force: true });
      console.log(`[sanitize] 解压 ${path.relative(dir, file)} -> ${path.relative(dir, target)}`);
    } catch (e) {
      console.warn(`[sanitize] 跳过无法解压的 ${path.relative(dir, file)}: ${e.message}`);
    }
  }
  for (const file of await listFiles(dir)) {
    if (!/\.(css|js|html?|svg|xml|json|txt)(\?.*)?$/i.test(file)) continue;
    try {
      const fh = await open(file, 'r');
      const magic = Buffer.alloc(2);
      const { bytesRead } = await fh.read(magic, 0, 2, 0);
      await fh.close();
      if (bytesRead < 2 || magic[0] !== 0x1f || magic[1] !== 0x8b) continue;
      const data = await readFile(file);
      await writeFile(file, gunzipSync(data));
      console.log(`[sanitize] 解压 ${path.relative(dir, file)}`);
    } catch (e) {
      console.warn(`[sanitize] 跳过无法解压的 ${path.relative(dir, file)}: ${e.message}`);
    }
  }
}

async function copyTree(src, dest) {
  await mkdir(dest, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyTree(s, d);
    else if (entry.isFile()) await copyFile(s, d);
  }
}

async function listFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(p)));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

async function sanitizeHtml(file, { origin, prefix, base, outDir, extraOrigins = [], assetMap = {} }) {
  let html = await readFile(file, 'utf8');
  const $ = load(html, { decodeEntities: false });
  let faviconPath = null;

  $('script').each((_, el) => {
    const src = $(el).attr('src') || '';
    const text = $(el).text() || '';
    if (REMOVE_SCRIPT_RE.test(src) || /^https?:\/\//.test(src) || INLINE_REMOVE_RE.test(text)) {
      $(el).remove();
    }
  });

  $('link').each((_, el) => {
    const href = $(el).attr('href') || '';
    const rel = ($(el).attr('rel') || '').toLowerCase();
    if (REMOVE_SCRIPT_RE.test(href) || (rel === 'modulepreload' && /comment|search/i.test(href))) {
      $(el).remove();
    }
  });

  $('[href]').each((_, el) => {
    const v = $(el).attr('href');
    // <a> 链接由下方专门的同源解析逻辑处理，避免把外站/未镜像链接误改成本地 404
    const nv = cleanRef(v, prefix, (el.tagName || '').toLowerCase() === 'a' ? null : origin);
    if (nv !== v) $(el).attr('href', nv);
  });
  $('[src]').each((_, el) => {
    const v = $(el).attr('src');
    const nv = cleanRef(v, prefix, origin);
    if (nv !== v) $(el).attr('src', nv);
    // 音乐组件等会把专辑封面误写成页面地址（xxx.html），
    // 转成透明占位图，避免满页破图图标
    if ((el.tagName || '').toLowerCase() === 'img' && /\.html?$/i.test(nv || '')) {
      $(el).attr(
        'src',
        'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
      );
    }
  });
  $('[srcset]').each((_, el) => {
    $(el).attr('srcset', rewriteSrcset($(el).attr('srcset'), prefix, origin));
  });
  // 同源绝对链接改写为镜像本地路径（点击后仍在 iframe 内导航）；
  // 外站或找不到本地文件的链接一律新标签打开，避免跨域导航被 X-Frame-Options
  // 拦成白屏、并让电视壳的返回/前进/刷新因跨域安全限制而失效
  const channelOrigin = new URL(origin).origin;
  $('a[href]').each((_, el) => {
    let href = $(el).attr('href');
    if (typeof href !== 'string') return;
    // 已被通用规则加过前缀的根相对链接：解析为真实本地文件（补 .html）
    if (href.startsWith(prefix + '/')) {
      const resolved = resolveLocalPath(href.slice(prefix.length), outDir);
      if (resolved) $(el).attr('href', `${prefix}/${resolved}`);
      return;
    }
    if (!/^(https?:)?\/\//i.test(href)) return;
    let url;
    try {
      url = new URL(href, origin);
    } catch {
      return;
    }
    if (url.origin === channelOrigin) {
      const resolved = resolveLocalPath(url.pathname, outDir);
      if (resolved) {
        $(el).attr('href', `${prefix}/${resolved}`);
        return;
      }
    }
    $(el).attr('target', '_blank');
    $(el).attr('rel', 'noopener');
  });
  $('[data-src]').each((_, el) => {
    const v = $(el).attr('data-src');
    const nv = cleanRef(v, prefix, origin);
    if (nv !== v) $(el).attr('data-src', nv);
  });
  $('[action]').each((_, el) => {
    const v = $(el).attr('action');
    const nv = rewriteRoot(v, prefix, origin);
    if (nv !== v) $(el).attr('action', nv);
  });
  $('meta[property^="og:"], meta[name^="twitter:"]').each((_, el) => {
    const v = $(el).attr('content');
    const nv = cleanRef(v, prefix, origin);
    if (nv !== v) $(el).attr('content', nv);
  });
  $('[style]').each((_, el) => {
    const v = $(el).attr('style') || '';
    const nv = rewriteCssUrls(v, prefix, origin);
    if (nv !== v) $(el).attr('style', nv);
  });

  // 注入 CSP 与镜像提示资源（放在属性重写之后，避免被二次加前缀）
  $('head').prepend(`<meta http-equiv="Content-Security-Policy" content="${buildCsp(extraOrigins)}">`);
  $('head').prepend(`<meta name="mirror-origin" content="${origin}">`);
  $('head').prepend(`<meta name="mirror-base" content="${prefix}/">`);
  $('head').append(`<link rel="stylesheet" href="${base}/mirror-hint/mirror-hint.css">`);
  $('head').append(`<script src="${base}/mirror-hint/mirror-hint.js" defer></script>`);

  $('script[type="application/json"]').each((_, el) => {
    const raw = $(el).text();
    try {
      const data = rewriteJsonStrings(JSON.parse(raw), prefix, origin);
      $(el).text(JSON.stringify(data));
    } catch {
      // 非 JSON 原样保留
    }
  });

  const iconHref =
    $('link[rel="icon"]').first().attr('href') ||
    $('link[rel="shortcut icon"]').first().attr('href') ||
    '';
  if (iconHref) {
    const candidate = resolveIconPath(iconHref, file, outDir, prefix);
    if (existsSync(candidate)) faviconPath = candidate;
  }

  html = $.html();
  // 镜像到本地的外站资源（如动态壁纸视频）：把原站地址精确替换为本地副本，
  // 保持原页面结构与主题配置不变（type 仍为 video，<video> 元素原样保留）
  for (const [from, to] of Object.entries(assetMap)) {
    if (html.includes(from)) html = html.split(from).join(to);
  }
  // 处理内联 <script> 中带引号的根绝对路径（themeConfig 等），
  // 只改脚本内容（保留 <script> 外壳），避免误伤文章正文里的路径示例
  html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (m, attrs, body) =>
    `<script${attrs}>${body.replace(KNOWN_ROOT_RE, (sub, q, dir, rest) => `${q}${prefix}/${dir}/${rewriteAssetExt(rest)}`)}</script>`,
  );
  await writeFile(file, html, 'utf8');
  return faviconPath;
}

async function sanitizeCss(file, prefix, origin) {
  let css = await readFile(file, 'utf8');
  css = rewriteCssUrls(css, prefix, origin);
  await writeFile(file, css, 'utf8');
}

async function sanitizeJs(file, prefix, origin) {
  let js = await readFile(file, 'utf8');
  js = js.replace(
    KNOWN_ROOT_RE,
    (m, q, dir, rest) => `${q}${prefix}/${dir}/${rewriteAssetExt(rest)}`,
  );
  // 内联/外链 JS 里的同源绝对地址（如 themeConfig 中的 /upload/...）也改为本地路径
  if (origin) {
    js = js.split(origin.replace(/\/$/, '')).join(prefix);
  }
  await writeFile(file, js, 'utf8');
}

export async function sanitizeChannel({
  hostDir,
  outDir,
  id,
  origin,
  prefix,
  base,
  extraOrigins = [],
  extraAssets = [],
}) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await copyTree(hostDir, outDir);
  await decompressGzAssets(outDir);

  // 已成功镜像到本地的外站资源：url -> 本地路径（只映射真实存在的文件）
  const assetMap = {};
  for (const asset of extraAssets) {
    if (!asset?.url || !asset?.path || asset.path.includes('..')) continue;
    if (existsSync(path.join(outDir, asset.path))) {
      assetMap[asset.url] = `${prefix}/${asset.path}`;
    }
  }

  const files = await listFiles(outDir);
  let faviconPath = null;

  for (const file of files) {
    const rel = path.relative(outDir, file);
    if (rel.includes('?width=')) {
      await rm(file, { force: true });
      continue;
    }
    const isHtml =
      rel.endsWith('.html') ||
      (!/\.(css|js|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|otf|eot|json|xml|txt|gz|zip|pdf|mp3|mp4|webm)$/i.test(rel) &&
        (await looksLikeHtml(file)));
    if (isHtml) {
      faviconPath =
        (await sanitizeHtml(file, { origin, prefix, base, outDir, extraOrigins, assetMap })) ||
        faviconPath;
    } else if (rel.endsWith('.css')) {
      await sanitizeCss(file, prefix, origin);
    } else if (rel.endsWith('.js')) {
      await sanitizeJs(file, prefix, origin);
    }
  }

  if (faviconPath && existsSync(faviconPath)) {
    await copyFile(faviconPath, path.join(outDir, 'favicon.ico'));
  }
}
