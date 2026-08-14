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

// 媒体/字体文件扩展名：这些资源不再下载，引用一律直链原站绝对 URL
export const MEDIA_EXT_RE =
  /\.(?:png|jpe?g|webp|gif|svg|ico|avif|bmp|apng|mp4|webm|ogv|mov|mp3|wav|ogg|oga|flac|aac|m4a|woff2?|ttf|otf|eot)(?:[?#]|$)/i;

// 已知非媒体扩展名：这类文件不做魔数探测（避免误删 sitemap.xml 等文本文件）
export const SAFE_FILE_RE =
  /\.(?:html?|css|js|json|xml|txt|md|yml|yaml|map|webmanifest|gz|zip|pdf)(?:[?#]|$)/i;

// 部分友站用无扩展名的 URL 提供图片/视频（如 /api/v1/file/f/1），
// 按文件头魔数识别并删除，通用兜底所有站点。
const MEDIA_MAGIC = [
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38], // GIF
  [0x52, 0x49, 0x46, 0x46], // RIFF（WEBP/AVIF）
  [0x1a, 0x45, 0xdf, 0xa3], // WebM/Matroska
  [0x49, 0x44, 0x33], // MP3（ID3）
  [0x4f, 0x67, 0x67, 0x53], // Ogg
  [0x00, 0x01, 0x00, 0x00], // TTF
  [0x4f, 0x54, 0x54, 0x4f], // OTF（OTTO）
  [0x00, 0x00, 0x01, 0x00], // ICO
  [0x42, 0x4d], // BMP
  [0x49, 0x49, 0x2a, 0x00], // TIFF LE
  [0x4d, 0x4d, 0x00, 0x2a], // TIFF BE
  [0x77, 0x4f, 0x46, 0x46], // WOFF
  [0x77, 0x4f, 0x46, 0x32], // WOFF2
];

export async function looksLikeMedia(file) {
  try {
    const fh = await open(file, 'r');
    const buf = Buffer.alloc(32);
    const { bytesRead } = await fh.read(buf, 0, 32, 0);
    await fh.close();
    const b = buf.subarray(0, bytesRead);
    if (bytesRead < 4) return false;
    for (const magic of MEDIA_MAGIC) {
      if (b.length >= magic.length && magic.every((byte, i) => b[i] === byte)) return true;
    }
    // MP4/M4V：偏移 4 处为 ftyp 魔数（盒子大小可变，不能用固定字节序列）
    if (b.length >= 8 && b.subarray(4, 8).toString('latin1') === 'ftyp') return true;
    const head = b.toString('latin1').trimStart();
    return /^<svg[\s>]/i.test(head);
  } catch {
    return false;
  }
}

// 这些标签的 src 属性内容必定是媒体（即使 URL 无扩展名，如 Next.js /_next/image?...）
const MEDIA_SRC_TAGS = new Set(['img', 'video', 'audio', 'source', 'embed', 'track', 'image']);

function isMediaRef(value) {
  if (typeof value !== 'string') return false;
  try {
    return MEDIA_EXT_RE.test(new URL(value, 'http://x').pathname);
  } catch {
    return false;
  }
}

function originNoSlash(origin) {
  return (origin || '').replace(/\/$/, '');
}

// 镜像内相对路径 -> 原站目录（用于把相对媒体引用解析回原站绝对 URL）
function originDirOf(rel) {
  const dir = path.posix.dirname(rel.split(path.sep).join('/'));
  return dir === '.' ? '/' : `/${dir}/`;
}

function buildCsp(extraOrigins = []) {
  // 媒体不再镜像，img/video/audio/font 一律直链原站，放开 https；
  // 脚本/连接仍保持收紧（script-src 'self'、connect-src 'none'）
  const img = ["'self'", "'data:'", "https:", ...extraOrigins].join(' ');
  const media = ["'self'", "https:", ...extraOrigins].join(' ');
  const font = ["'self'", "data:", "https:", ...extraOrigins].join(' ');
  return `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src ${img}; font-src ${font}; media-src ${media}; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'`;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rewriteRoot(value, prefix, origin, { media = false, baseDir = '/' } = {}) {
  if (typeof value !== 'string') return value;
  const clean = value.replace(/\?width=[^&]*/, '');
  // 媒体引用：一律改写为原站绝对 URL（根相对/协议相对/站内相对 → 绝对；绝对 URL 原样保留）
  if (media) {
    if (clean.startsWith('/') && !clean.startsWith('//')) {
      return `${originNoSlash(origin)}${clean}`;
    }
    if (clean.startsWith('//')) return `https:${clean}`;
    if (/^[a-z][a-z0-9+.-]*:/i.test(clean)) return clean;
    if (origin) {
      try {
        return new URL(clean, `${originNoSlash(origin)}${baseDir}`).href;
      } catch {
        return clean;
      }
    }
    return clean;
  }
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

function cleanRef(value, prefix, origin, opts = {}) {
  if (typeof value !== 'string') return value;
  let v = rewriteAssetExt(rewriteRoot(value, prefix, origin, opts));
  // wget 把含查询串的资源存成字面 "?":main.css?v=1.0.6，引用需编码为 %3F，
  // 否则浏览器把 ? 当查询串、按 main.css 找文件 → 404（页面白屏）。
  // 绝对 URL（含媒体直链）保持真实查询串，不编码。
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

function rewriteSrcset(value, prefix, origin, baseDir) {
  return value
    .split(',')
    .map((part) => {
      const m = part.trim().match(/^(\S+)(\s+.+)?$/);
      if (!m) return part;
      return cleanRef(m[1], prefix, origin, { media: true, baseDir }) + (m[2] ?? '');
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

function rewriteJsonStrings(node, prefix, origin, baseDir) {
  if (typeof node === 'string') {
    return cleanRef(node, prefix, origin, { media: isMediaRef(node), baseDir });
  }
  if (Array.isArray(node)) {
    return node.map((v) => rewriteJsonStrings(v, prefix, origin, baseDir));
  }
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = rewriteJsonStrings(v, prefix, origin, baseDir);
    return out;
  }
  return node;
}

function rewriteCssUrls(css, prefix, origin, cssDir = '/') {
  const o = originNoSlash(origin);
  return css.replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g, (m, p) => {
    const target = p.trim();
    // data: 与函数式 url() 原样保留
    if (/^data:/i.test(target) || target.includes('(')) return m;
    const media = isMediaRef(target);
    if (target.startsWith('/') && !target.startsWith('//')) {
      return `url(${media ? o + target : prefix + target})`;
    }
    if (target.startsWith('//')) {
      return `url(${media ? 'https:' + target : target})`;
    }
    if (/^https?:/i.test(target)) {
      if (origin) {
        try {
          const u = new URL(target, origin);
          if (u.origin === new URL(origin).origin) {
            return `url(${media ? target : prefix + u.pathname + (u.search || '')})`;
          }
        } catch {
          // 解析失败则原样保留
        }
      }
      return `url(${target})`;
    }
    // 相对路径：媒体按 CSS 所在站内目录解析为原站绝对 URL；资源保持相对（本地文件同构）
    if (media && origin) {
      try {
        return `url(${new URL(target, o + cssDir).href})`;
      } catch {
        return `url(${target})`;
      }
    }
    // 去掉 .gz 后缀的引用（镜像内只有未压缩版）
    return `url(${rewriteAssetExt(target)})`;
  });
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

async function sanitizeHtml(file, { origin, prefix, base, outDir, extraOrigins = [], pageDir = '/' }) {
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
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'a') {
      // <a> 链接由下方专门的同源解析逻辑处理；指向媒体文件的链接直链原站
      if (isMediaRef(v)) {
        const nv = cleanRef(v, prefix, origin, { media: true, baseDir: pageDir });
        if (nv !== v) $(el).attr('href', nv);
      } else {
        const nv = cleanRef(v, prefix, null);
        if (nv !== v) $(el).attr('href', nv);
      }
      return;
    }
    const rel = ($(el).attr('rel') || '').toLowerCase();
    const media = (tag === 'link' && rel.includes('icon')) || isMediaRef(v);
    const nv = cleanRef(v, prefix, origin, { media, baseDir: pageDir });
    if (nv !== v) $(el).attr('href', nv);
  });
  $('[src]').each((_, el) => {
    const v = $(el).attr('src');
    const tag = (el.tagName || '').toLowerCase();
    const media = MEDIA_SRC_TAGS.has(tag) || isMediaRef(v);
    const nv = cleanRef(v, prefix, origin, { media, baseDir: pageDir });
    if (nv !== v) $(el).attr('src', nv);
    // 音乐组件等会把专辑封面误写成页面地址（xxx.html），
    // 转成透明占位图，避免满页破图图标
    if (tag === 'img' && /\.html?$/i.test(nv || '')) {
      $(el).attr(
        'src',
        'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
      );
    }
  });
  $('[srcset]').each((_, el) => {
    $(el).attr('srcset', rewriteSrcset($(el).attr('srcset'), prefix, origin, pageDir));
  });
  $('[poster]').each((_, el) => {
    const v = $(el).attr('poster');
    const nv = cleanRef(v, prefix, origin, { media: true, baseDir: pageDir });
    if (nv !== v) $(el).attr('poster', nv);
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
      // 媒体文件（图片/视频等）未镜像到本地，直链原站并在新标签打开，避免本地 404
      if (isMediaRef(url.pathname)) {
        $(el).attr('href', url.href);
        $(el).attr('target', '_blank');
        $(el).attr('rel', 'noopener');
        return;
      }
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
    const tag = (el.tagName || '').toLowerCase();
    const nv = cleanRef(v, prefix, origin, { media: tag === 'img' || isMediaRef(v), baseDir: pageDir });
    if (nv !== v) $(el).attr('data-src', nv);
  });
  $('[action]').each((_, el) => {
    const v = $(el).attr('action');
    const nv = rewriteRoot(v, prefix, origin);
    if (nv !== v) $(el).attr('action', nv);
  });
  $('meta[property^="og:"], meta[name^="twitter:"]').each((_, el) => {
    const v = $(el).attr('content');
    const key = ($(el).attr('property') || $(el).attr('name') || '').toLowerCase();
    const media =
      key === 'og:image' ||
      key === 'og:image:url' ||
      key === 'og:image:secure_url' ||
      key === 'twitter:image' ||
      key === 'twitter:image:src' ||
      isMediaRef(v);
    const nv = cleanRef(v, prefix, origin, { media, baseDir: pageDir });
    if (nv !== v) $(el).attr('content', nv);
  });
  $('[style]').each((_, el) => {
    const v = $(el).attr('style') || '';
    const nv = rewriteCssUrls(v, prefix, origin, pageDir);
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
      const data = rewriteJsonStrings(JSON.parse(raw), prefix, origin, pageDir);
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
  // 处理内联 <script> 中带引号的根绝对路径（themeConfig 等），
  // 只改脚本内容（保留 <script> 外壳），避免误伤文章正文里的路径示例
  html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (m, attrs, body) =>
    `<script${attrs}>${body.replace(
      KNOWN_ROOT_RE,
      (sub, q, dir, rest) =>
        isMediaRef(`/${dir}/${rest}`)
          ? `${q}${originNoSlash(origin)}/${dir}/${rest.replace(/\?width=[^&]*/, '')}`
          : `${q}${prefix}/${dir}/${rewriteAssetExt(rest)}`,
    )}</script>`,
  );
  await writeFile(file, html, 'utf8');
  return faviconPath;
}

async function sanitizeCss(file, prefix, origin, cssDir) {
  let css = await readFile(file, 'utf8');
  css = rewriteCssUrls(css, prefix, origin, cssDir);
  await writeFile(file, css, 'utf8');
}

async function sanitizeJs(file, prefix, origin) {
  let js = await readFile(file, 'utf8');
  js = js.replace(
    KNOWN_ROOT_RE,
    (m, q, dir, rest) =>
      isMediaRef(`/${dir}/${rest}`)
        ? `${q}${originNoSlash(origin)}/${dir}/${rest.replace(/\?width=[^&]*/, '')}`
        : `${q}${prefix}/${dir}/${rewriteAssetExt(rest)}`,
  );
  // 内联/外链 JS 里的同源绝对地址：媒体保持原站直链，资源（CSS/JS/页面）改为本地路径
  if (origin) {
    const o = originNoSlash(origin);
    js = js.replace(new RegExp(escapeRegExp(o) + '(/[^"\'\\s\\\\]*)', 'g'), (m, p) =>
      isMediaRef(p) ? m : prefix + p,
    );
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
}) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await copyTree(hostDir, outDir);
  await decompressGzAssets(outDir);

  const files = await listFiles(outDir);
  let faviconPath = null;

  for (const file of files) {
    const rel = path.relative(outDir, file);
    if (
      rel.includes('?width=') ||
      MEDIA_EXT_RE.test(rel) ||
      (!SAFE_FILE_RE.test(rel) && (await looksLikeMedia(file)))
    ) {
      await rm(file, { force: true });
      continue;
    }
    const pageDir = originDirOf(rel);
    const isHtml =
      rel.endsWith('.html') ||
      (!/\.(css|js|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|otf|eot|json|xml|txt|gz|zip|pdf|mp3|mp4|webm)$/i.test(rel) &&
        (await looksLikeHtml(file)));
    if (isHtml) {
      faviconPath =
        (await sanitizeHtml(file, { origin, prefix, base, outDir, extraOrigins, pageDir })) ||
        faviconPath;
    } else if (rel.endsWith('.css')) {
      await sanitizeCss(file, prefix, origin, pageDir);
    } else if (rel.endsWith('.js')) {
      await sanitizeJs(file, prefix, origin);
    }
  }

  if (faviconPath && existsSync(faviconPath)) {
    await copyFile(faviconPath, path.join(outDir, 'favicon.ico'));
  }
}
