import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir, stat, rm, open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import astroConfig from '../astro.config.mjs';
import { sanitizeChannel } from './sanitize.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = (astroConfig.base ?? '').replace(/\/$/, '');
const prefixRoot = `${base}/channels`;
const outRoot = path.join(ROOT, 'public/channels');

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

  const args = [
    '-m',
    '-p',
    '-np',
    '-E',
    '-k',
    '-nv',
    '--no-remove-listing',
    '--timeout=30',
    '--tries=3',
    '--reject-regex',
    '\\?width=',
    '-P',
    cacheDir,
    channel.url,
  ];
  if (process.env.MIRROR_QUICK) args.push('--level=2');

  // 清理缓存中无扩展名的页面文件：wget -E 会把它们存成 .html，
  // 旧的同名文件会阻塞分页目录（如 /tags/x/page/2）
  await cleanStaleCache(cacheDir);

  let hostDir = null;
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
  if (!existsSync(hostDir)) {
    entry.error = lastErr ? `抓取失败：${lastErr}` : '抓取失败：未产生镜像目录';
    console.error(`[${id}] ${entry.error}`);
    return entry;
  }

  try {
    await sanitizeChannel({
      hostDir,
      outDir,
      id,
      origin: channel.url,
      prefix,
      base: base || '',
    });
    const { sizeBytes, fileCount } = await dirStats(outDir);
    entry.sizeBytes = sizeBytes;
    entry.fileCount = fileCount;
    console.log(`[${id}] 清洗完成：${fileCount} 个文件，${(sizeBytes / 1024 / 1024).toFixed(1)} MB`);
  } catch (e) {
    entry.error = `清洗失败：${e.message}`;
    console.error(`[${id}] ${entry.error}`);
  }
  return entry;
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
async function worker() {
  while (next < channels.length) {
    const entry = await processChannel(channels[next++]);
    status.channels[entry.id] = entry;
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

await writeFile(path.join(outRoot, 'status.json'), JSON.stringify(status, null, 2));
console.log('镜像状态已写入 public/channels/status.json');

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
        (entry.name.includes('?width=') || (await looksLikeHtml(p)))
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
