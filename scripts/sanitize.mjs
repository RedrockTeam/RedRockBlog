import { readFile, writeFile, mkdir, rm, copyFile, readdir, open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { load } from 'cheerio';

const REMOVE_SCRIPT_RE =
  /(halo-tracker|PluginCommentWidget|PluginSearchWidget|metmusic|summaraid|analytics|umami|plausible|goatcounter|matomo|tracker)/i;
const INLINE_REMOVE_RE = /\/plugins\/(PluginCommentWidget|PluginSearchWidget)/;
const KNOWN_ROOT_RE = /^(["'])\/(upload|themes|plugins|archives|tags|categories|links|pages|images|search|rss|sitemap|favicon|about-me|met-website)\//;
const CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; media-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'";

function rewriteRoot(value, prefix) {
  if (typeof value !== 'string') return value;
  const clean = value.replace(/\?width=[^&]*/, '');
  if (clean.startsWith('/') && !clean.startsWith('//')) {
    return prefix + clean;
  }
  return clean;
}

// 源站可能引用预压缩的 .css.gz / .js.gz（含带查询串形式），镜像里只有未压缩版，去掉 .gz
function rewriteAssetExt(value) {
  return typeof value === 'string'
    ? value.replace(/(\.(?:css|js)(?:(?:[?#]|%3[fF])[^"'\s]*)?)\.gz$/i, '$1')
    : value;
}

function cleanRef(value, prefix) {
  if (typeof value !== 'string') return value;
  return rewriteAssetExt(rewriteRoot(value, prefix));
}

function rewriteSrcset(value, prefix) {
  return value
    .split(',')
    .map((part) => {
      const m = part.trim().match(/^(\S+)(\s+.+)?$/);
      if (!m) return part;
      return cleanRef(m[1], prefix) + (m[2] ?? '');
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

function rewriteJsonStrings(node, prefix) {
  if (typeof node === 'string') {
    return cleanRef(node, prefix);
  }
  if (Array.isArray(node)) {
    return node.map((v) => rewriteJsonStrings(v, prefix));
  }
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = rewriteJsonStrings(v, prefix);
    return out;
  }
  return node;
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

async function sanitizeHtml(file, { origin, prefix, base, outDir }) {
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
    const nv = cleanRef(v, prefix);
    if (nv !== v) $(el).attr('href', nv);
  });
  $('[src]').each((_, el) => {
    const v = $(el).attr('src');
    const nv = cleanRef(v, prefix);
    if (nv !== v) $(el).attr('src', nv);
  });
  $('[srcset]').each((_, el) => {
    $(el).attr('srcset', rewriteSrcset($(el).attr('srcset'), prefix));
  });
  $('[data-src]').each((_, el) => {
    const v = $(el).attr('data-src');
    const nv = cleanRef(v, prefix);
    if (nv !== v) $(el).attr('data-src', nv);
  });
  $('[action]').each((_, el) => {
    const v = $(el).attr('action');
    const nv = rewriteRoot(v, prefix);
    if (nv !== v) $(el).attr('action', nv);
  });
  $('meta[property^="og:"], meta[name^="twitter:"]').each((_, el) => {
    const v = $(el).attr('content');
    const nv = cleanRef(v, prefix);
    if (nv !== v) $(el).attr('content', nv);
  });
  $('[style]').each((_, el) => {
    const v = $(el).attr('style');
    const nv = v.replace(/(url\(\s*['"]?)\//g, `$1${prefix}/`);
    if (nv !== v) $(el).attr('style', nv);
  });

  // 注入 CSP 与镜像提示资源（放在属性重写之后，避免被二次加前缀）
  $('head').prepend(`<meta http-equiv="Content-Security-Policy" content="${CSP}">`);
  $('head').prepend(`<meta name="mirror-origin" content="${origin}">`);
  $('head').prepend(`<meta name="mirror-base" content="${prefix}/">`);
  $('head').append(`<link rel="stylesheet" href="${base}/mirror-hint/mirror-hint.css">`);
  $('head').append(`<script src="${base}/mirror-hint/mirror-hint.js" defer></script>`);

  $('script[type="application/json"]').each((_, el) => {
    const raw = $(el).text();
    try {
      const data = JSON.parse(raw);
      $(el).text(JSON.stringify(rewriteJsonStrings(data, prefix)));
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
  // 处理内联 JS 中带引号的根绝对路径（themeConfig 等）
  html = html.replace(
    KNOWN_ROOT_RE,
    (m, q, dir, rest) => `${q}${prefix}/${dir}/${rewriteAssetExt(rest)}`,
  );
  await writeFile(file, html, 'utf8');
  return faviconPath;
}

async function sanitizeCss(file, prefix) {
  let css = await readFile(file, 'utf8');
  css = css.replace(/(url\(\s*['"]?)\//g, `$1${prefix}/`);
  css = css.replace(/(url\(\s*['"]?)([^)'"]+)/g, (m, pre, p) => pre + rewriteAssetExt(p));
  await writeFile(file, css, 'utf8');
}

async function sanitizeJs(file, prefix) {
  let js = await readFile(file, 'utf8');
  js = js.replace(
    KNOWN_ROOT_RE,
    (m, q, dir, rest) => `${q}${prefix}/${dir}/${rewriteAssetExt(rest)}`,
  );
  await writeFile(file, js, 'utf8');
}

export async function sanitizeChannel({ hostDir, outDir, id, origin, prefix, base }) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await copyTree(hostDir, outDir);

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
      faviconPath = (await sanitizeHtml(file, { origin, prefix, base, outDir })) || faviconPath;
    } else if (rel.endsWith('.css')) {
      await sanitizeCss(file, prefix);
    } else if (rel.endsWith('.js')) {
      await sanitizeJs(file, prefix);
    }
  }

  if (faviconPath && existsSync(faviconPath)) {
    await copyFile(faviconPath, path.join(outDir, 'favicon.ico'));
  }
}
