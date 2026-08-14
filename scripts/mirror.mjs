import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir, stat, rm, open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import astroConfig from '../astro.config.mjs';
import { sanitizeChannel, MEDIA_EXT_RE, SAFE_FILE_RE, looksLikeMedia } from './sanitize.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = (astroConfig.base ?? '').replace(/\/$/, '');
const prefixRoot = `${base}/channels`;
const outRoot = path.join(ROOT, 'public/channels');
const stateRoot = path.join(ROOT, '.cache/state');
// 首页与归档列表不在 sitemap 中，但新文章会出现在这里，始终刷新
const ALWAYS_FETCH = ['/', '/archives'];
// 媒体/字体不再下载：wget 直接拒绝（含 ?width= 缩略图变体），
// 清洗阶段再把引用直链回原站。zip/pdf/xml 等非媒体附件仍下载。
const REJECT_MEDIA_RE =
  '(\\?width=)|\\.(png|jpe?g|webp|gif|svg|ico|avif|bmp|apng|mp4|webm|ogv|mov|mp3|wav|ogg|oga|flac|aac|m4a|woff2?|ttf|otf|eot)([?#]|$)';
// 单频道总时长上限：防止个别友站连接挂起导致整个 CI 卡死/进程异常退出
// （超时按该频道失败处理，不阻塞其他频道，镜像照常部署）
const CHANNEL_TIMEOUT_MS = 15 * 60 * 1000;

const channelsData = JSON.parse(await readFile(path.join(ROOT, 'src/data/channels.json'), 'utf8'));
const channels = (channelsData.channels ?? []).filter((c) => c.enabled !== false);

await mkdir(outRoot, { recursive: true });
const status = { updatedAt: new Date().toISOString(), channels: {} };

async function processChannel(channel) {
  const id = channel.id;
  const cacheDir = path.join(ROOT, '.cache/mirror', id);
  const outDir = path.join(outRoot, id);
  const prefix = `${prefixRoot}/${id}`;
  const entry = { id, name: channel.name, url: channel.url };

  try {
    // 清理缓存中无扩展名的页面文件：wget -E 会把它们存成 .html，
    // 旧的同名文件会阻塞分页目录（如 /tags/x/page/2）
    await cleanStaleCache(cacheDir);

    let hostDir = await findHostDir(cacheDir);
    let mode = 'full';
    let fetched = 0;
    let deleted = 0;

    // 缓存目录为空（首次 / 缓存丢失）时，先全量抓取并播种状态
    if (!hostDir) {
      const args = [
        '-m', '-p', '-np', '-E', '-nv', '--no-remove-listing',
        '--timeout=30', '--tries=3', '--reject-regex', REJECT_MEDIA_RE,
        '-P', cacheDir, channel.url,
      ];
      if (process.env.MIRROR_QUICK) args.push('--level=2');
      let lastErr = '';
      for (let attempt = 1; attempt <= 2 && !hostDir; attempt += 1) {
        const capture = attempt === 2;
        const res = spawnSync('wget', args, {
          stdio: capture ? ['ignore', 'inherit', 'pipe'] : 'inherit',
        });
        if (res.error) lastErr = res.error.message;
        else if (res.status !== 0) lastErr = `wget 退出码 ${res.status}`;
        if (capture && res.stderr) {
          const tail = res.stderr.toString('utf8').trim().split('\n').slice(-8).join('\n');
          if (tail) lastErr += `\n${tail}`;
        }
        hostDir = await findHostDir(cacheDir);
        if (!hostDir && attempt === 1) console.warn(`[${id}] 第 1 次抓取失败，重试中…`);
      }
      // 拉取失败直接丢弃该频道：不生成镜像目录、不部署旧缓存
      if (!hostDir) {
        entry.error = lastErr ? `抓取失败：${lastErr}` : '抓取失败：未产生镜像目录';
        console.error(`[${id}] ${entry.error}`);
        return entry;
      }
      await seedState(channel, hostDir);
    }

    const incremental = await tryIncremental(channel, cacheDir);
    if (incremental && incremental.mode === 'incremental') {
      hostDir = await findHostDir(cacheDir);
      if (hostDir) {
        mode = 'incremental';
        fetched = incremental.fetched;
        deleted = incremental.deleted;
      }
    }

    try {
      await sanitizeChannel({
        hostDir,
        outDir,
        id,
        origin: channel.url,
        prefix,
        base: base || '',
        extraOrigins: channel.extraOrigins || [],
      });
      // 镜像产物已无媒体；顺手清掉缓存里的旧媒体文件，避免 Actions 缓存滞留
      await purgeMediaFiles(hostDir);
      const { sizeBytes, fileCount } = await dirStats(outDir);
      entry.sizeBytes = sizeBytes;
      entry.fileCount = fileCount;
      entry.mode = mode;
      entry.fetched = fetched;
      entry.deleted = deleted;
      const detail = mode === 'incremental' ? `增量（新拉 ${fetched} 页、删除 ${deleted} 页）` : '全量';
      console.log(`[${id}] ${detail}：${fileCount} 个文件，${(sizeBytes / 1048576).toFixed(1)} MB`);
    } catch (e) {
      entry.error = `清洗失败：${e.message}`;
      console.error(`[${id}] ${entry.error}`);
    }
  } catch (e) {
    entry.error = `处理异常：${e.message}`;
    console.error(`[${id}] ${entry.error}`);
  }
  return entry;
}

// 增量更新：对照 sitemap + 状态文件，只拉新增/更新的页面，并删除源站已移除的页面
async function tryIncremental(channel, cacheDir) {
  const stateFile = path.join(stateRoot, `${channel.id}.json`);
  let known = {};
  if (existsSync(stateFile)) {
    try {
      const state = JSON.parse(await readFile(stateFile, 'utf8'));
      known = state.pages || {};
    } catch {
      known = {};
    }
  }

  const pages = await fetchSitemapPages(channel.url);
  if (!pages) return { mode: 'full' };

  const hostDir = await findHostDir(cacheDir);
  const toFetch = [];
  const stale = [];
  let changed = false;

  for (const [p, lm] of pages) {
    const prev = Object.prototype.hasOwnProperty.call(known, p) ? known[p] : undefined;
    const missingLocally = !hostDir || !pageExists(hostDir, p);
    if (prev === undefined) {
      toFetch.push(p);
      changed = true; // 新增页面：源站内容变化
    } else if (lm && prev !== lm) {
      toFetch.push(p);
      changed = true; // 页面更新：源站内容变化
    } else if (missingLocally) {
      toFetch.push(p); // 本地缺失：自愈，不触发列表页整批刷新
    }
  }
  for (const p of Object.keys(known)) {
    if (!pages.has(p)) {
      stale.push(p);
      changed = true;
    }
  }

  // 无 lastmod 的列表页（标签/分类等）：仅在内容有变化时整批刷新
  const listings = [...pages].filter(([, lm]) => !lm).map(([p]) => p);
  if (changed) toFetch.push(...listings);

  const origin = new URL(channel.url).origin;
  const urls = new Set(toFetch.map((p) => origin + p));
  const always = new Set(ALWAYS_FETCH);
  for (const p of channel.alwaysFetch || []) always.add(p);
  for (const p of always) urls.add(origin + p);

  let fetched = 0;
  if (urls.size) {
    fetched = urls.size;
    const args = [
      '-E', '-p', '-np', '-N', '-nv', '--timeout=30', '--tries=3',
      '--reject-regex', REJECT_MEDIA_RE, '-P', cacheDir, ...urls,
    ];
    const res = spawnSync('wget', args, { stdio: 'inherit' });
    if (res.status !== 0) {
      console.warn(`[${channel.id}] 增量抓取 wget 退出码 ${res.status}，沿用本地已有缓存`);
    }
  }

  // 删除源站 sitemap 中已消失的页面
  let deleted = 0;
  if (hostDir) {
    for (const p of stale) {
      for (const c of pathCandidates(p)) {
        const target = path.join(hostDir, c);
        if (existsSync(target)) {
          await rm(target, { force: true });
          deleted += 1;
          break;
        }
      }
    }
  }

  const next = { ...known };
  for (const p of stale) delete next[p];
  for (const p of toFetch) {
    if (pages.has(p)) next[p] = pages.get(p);
  }
  await mkdir(stateRoot, { recursive: true });
  await writeFile(stateFile, JSON.stringify({ updatedAt: new Date().toISOString(), pages: next }, null, 2));

  return { mode: 'incremental', fetched, deleted };
}

async function seedState(channel, hostDir) {
  const stateFile = path.join(stateRoot, `${channel.id}.json`);
  const next = {};
  const pages = await fetchSitemapPages(channel.url);
  if (pages) {
    for (const [p, lm] of pages) next[p] = lm;
  } else {
    // sitemap 不可用时，用本地镜像目录反推页面清单（lastmod 置空）
    for (const rel of await listHtmlFiles(hostDir)) {
      next['/' + rel.replace(/\.html$/, '')] = null;
    }
  }
  await mkdir(stateRoot, { recursive: true });
  await writeFile(stateFile, JSON.stringify({ updatedAt: new Date().toISOString(), pages: next }, null, 2));
}

async function fetchSitemapPages(channelUrl) {
  let xml = await httpText(new URL('/sitemap.xml', channelUrl).href);
  if (!xml) xml = await httpText(new URL('/sitemap.xml', channelUrl).href); // 瞬时失败重试一次
  if (!xml) return null;
  const pages = new Map();
  if (/<sitemapindex/i.test(xml) && !/<urlset/i.test(xml)) {
    const children = [...xml.matchAll(/<sitemap>\s*<loc>\s*([^<]+?)\s*<\/loc>/gi)]
      .map((m) => m[1].trim());
    for (const child of children.slice(0, 20)) {
      const childXml = await httpText(child.startsWith('http') ? child : new URL(child, channelUrl).href);
      if (childXml) mergeSitemapPages(pages, childXml);
    }
  } else {
    mergeSitemapPages(pages, xml);
  }
  return pages.size ? pages : null;
}

function mergeSitemapPages(pages, xml) {
  const blocks = xml.split(/<url>/gi).slice(1);
  for (const block of blocks) {
    const loc = block.match(/<loc>\s*([^<]+?)\s*<\/loc>/i);
    if (!loc) continue;
    try {
      const p = new URL(loc[1].trim().replace(/&amp;/g, '&')).pathname;
      const lm = block.match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/i);
      pages.set(p, lm ? lm[1].trim() : null);
    } catch {
      // 忽略无法解析的 URL
    }
  }
}

async function httpText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    // 连接阶段也要竞速：个别友站（如 GitHub Runner 访问国内站）握手可能一直挂起
    const res = await Promise.race([
      fetch(url, { signal: ctrl.signal, redirect: 'follow' }),
      new Promise((resolve) => setTimeout(() => resolve(null), 20000)),
    ]);
    if (!res || !res.ok) return null;
    // 响应体读取可能被服务器挂起，abort 不一定能终止 res.text()，
    // 用 Promise.race 硬性超时，保证函数一定会收敛
    const textPromise = res.text();
    const text = await Promise.race([
      textPromise,
      new Promise((resolve) => {
        const t = setTimeout(() => resolve(null), 25000);
        textPromise.then(() => clearTimeout(t), () => clearTimeout(t));
      }),
    ]);
    return text;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// sitemap 中的 URL 路径 -> 可能的本地镜像文件相对路径。
// wget -E 对含点名的落盘有歧义（如 "5.1声道"、"dr.com"），用候选集兜底。
function pathCandidates(p) {
  let decoded;
  try {
    decoded = decodeURIComponent(p.split('?')[0]);
  } catch {
    decoded = p.split('?')[0];
  }
  let rel = decoded.replace(/^\//, '');
  if (decoded.endsWith('/')) rel += 'index';
  const out = [rel];
  if (!rel.endsWith('.html') && !rel.endsWith('.htm')) out.push(`${rel}.html`);
  out.push(path.posix.join(rel, 'index.html'));
  return out;
}

function pageExists(hostDir, p) {
  return pathCandidates(p).some((c) => c && existsSync(path.join(hostDir, c)));
}

async function listHtmlFiles(dir) {
  const out = [];
  async function walk(d) {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.isFile() && p.endsWith('.html')) out.push(path.relative(dir, p));
    }
  }
  await walk(dir);
  return out;
}

async function findHostDir(cacheDir) {
  if (!existsSync(cacheDir)) return null;
  const dirs = (await readdir(cacheDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => path.join(cacheDir, d.name));
  if (dirs.length === 0) return null;
  for (const dir of dirs) {
    if (existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return dirs[0];
}

const CONCURRENCY = Math.min(3, channels.length);
let next = 0;

// 看门狗：单频道超时按失败处理，保证 Promise.all 一定会收敛，
// 避免个别友站连接挂起导致 Node "未决 top-level await" 退出（exit 13）
async function processChannelWithTimeout(channel) {
  try {
    return await Promise.race([
      processChannel(channel),
      new Promise((resolve) =>
        setTimeout(() => {
          console.error(`[${channel.id}] 处理超时（超过 ${CHANNEL_TIMEOUT_MS / 60000} 分钟），跳过`);
          resolve({
            id: channel.id,
            name: channel.name,
            url: channel.url,
            error: `处理超时（超过 ${CHANNEL_TIMEOUT_MS / 60000} 分钟）`,
          });
        }, CHANNEL_TIMEOUT_MS),
      ),
    ]);
  } catch (e) {
    return { id: channel.id, name: channel.name, url: channel.url, error: `处理异常：${e.message}` };
  }
}

async function worker() {
  while (next < channels.length) {
    const entry = await processChannelWithTimeout(channels[next++]);
    status.channels[entry.id] = entry;
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

await writeFile(path.join(outRoot, 'status.json'), JSON.stringify(status, null, 2));
console.log('镜像状态已写入 public/channels/status.json');
// 兜底：清理可能残存的连接句柄，避免进程被挂起的 socket 拖住
process.exit(0);

async function dirStats(dir) {
  let sizeBytes = 0;
  let fileCount = 0;
  async function walk(d) {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.isFile()) {
        fileCount += 1;
        sizeBytes += (await stat(p)).size;
      }
    }
  }
  await walk(dir);
  return { sizeBytes, fileCount };
}

async function cleanStaleCache(cacheDir) {
  if (!existsSync(cacheDir)) return;
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (
        entry.isFile() &&
        (entry.name.includes('?width=') ||
          ((await looksLikeHtml(p)) && !p.endsWith('.html')))
      ) {
        await rm(p, { force: true });
      }
    }
  }
  await walk(cacheDir);
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

async function listAllFiles(dir) {
  const out = [];
  async function walk(d) {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.isFile()) out.push(p);
    }
  }
  await walk(dir);
  return out;
}

// 删除缓存中遗留的媒体/字体文件（wget 新拉取已按 REJECT_MEDIA_RE 拒绝）
async function purgeMediaFiles(dir) {
  if (!existsSync(dir)) return;
  let removed = 0;
  for (const file of await listAllFiles(dir)) {
    const rel = path.relative(dir, file);
    if (MEDIA_EXT_RE.test(rel) || (!SAFE_FILE_RE.test(rel) && (await looksLikeMedia(file)))) {
      await rm(file, { force: true });
      removed += 1;
    }
  }
  if (removed) console.log(`[cache] 清理 ${removed} 个媒体/字体缓存文件`);
}
