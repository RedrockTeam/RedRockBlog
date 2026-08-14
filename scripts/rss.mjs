import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_ROOT = path.join(ROOT, 'public/rss');
const channelsData = JSON.parse(await readFile(path.join(ROOT, 'src/data/channels.json'), 'utf8'));
const channels = (channelsData.channels ?? []).filter(
  (channel) => channel.enabled !== false && channel.rssUrl,
);
const MAX_COVER_BYTES = 6 * 1024 * 1024;

await mkdir(OUT_ROOT, { recursive: true });

const updatedAt = new Date().toISOString();
const status = { updatedAt, feeds: {} };
let successCount = 0;

for (const channel of channels) {
  const cacheFile = path.join(OUT_ROOT, `${channel.id}.json`);
  try {
    const xml = await fetchFeed(channel.rssUrl);
    const feed = parseFeed(xml, channel, updatedAt);
    if (!feed.items.length) throw new Error('RSS 中没有文章');
    feed.items = await cacheCovers(feed.items, channel);
    await writeJsonAtomic(cacheFile, feed);
    const coverCount = feed.items.filter((item) => item.image).length;
    status.feeds[channel.id] = { itemCount: feed.items.length, coverCount, fetchedAt: updatedAt };
    successCount += 1;
    console.log(`[${channel.id}] 已缓存 ${feed.items.length} 篇文章、${coverCount} 张封面`);
  } catch (error) {
    const cached = await readCachedFeed(cacheFile);
    status.feeds[channel.id] = {
      error: error.message,
      usingCache: Boolean(cached),
      itemCount: cached?.items?.length ?? 0,
      fetchedAt: cached?.fetchedAt ?? null,
    };
    if (cached) {
      console.warn(`[${channel.id}] 拉取失败，继续使用 ${cached.items.length} 篇旧缓存：${error.message}`);
    } else {
      console.error(`[${channel.id}] 拉取失败且没有缓存：${error.message}`);
    }
  }
}

await writeJsonAtomic(path.join(OUT_ROOT, 'status.json'), status);
if (!successCount && channels.length && !Object.values(status.feeds).some((feed) => feed.usingCache)) {
  process.exitCode = 1;
}

async function fetchFeed(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8',
      'user-agent': 'RedRockBlog-RSS/1.0 (+https://github.com/RedrockTeam/RedRockBlog)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

function parseFeed(xml, channel, fetchedAt) {
  const $ = load(xml, { xmlMode: true, decodeEntities: true });
  const root = $('channel').first();
  if (!root.length) throw new Error('无法识别 RSS 2.0 channel');

  const items = root
    .children('item')
    .slice(0, 40)
    .map((_, element) => {
      const item = $(element);
      const link = item.children('link').first().text().trim();
      const rawDescription = item.children('description').first().text();
      const publishedRaw = item.children('pubDate').first().text().trim();
      const publishedAt = normalizeDate(publishedRaw);
      const categories = item
        .children('category')
        .map((__, category) => $(category).text().trim())
        .get()
        .filter(Boolean)
        .slice(0, 6);

      return {
        id: item.children('guid').first().text().trim() || link,
        title: item.children('title').first().text().trim() || '无标题文章',
        link,
        summary: htmlToText(rawDescription).slice(0, 320),
        author: item.children('dc\\:creator').first().text().trim(),
        categories,
        publishedAt,
        image: extractCoverUrl($, item, rawDescription, channel.url),
      };
    })
    .get()
    .filter((item) => isSafeHttpUrl(item.link));

  return {
    version: 2,
    channel: {
      id: channel.id,
      name: root.children('title').first().text().trim() || channel.name,
      url: channel.url,
      rssUrl: channel.rssUrl,
      description: root.children('description').first().text().trim() || channel.description || '',
    },
    fetchedAt,
    sourceUpdatedAt: normalizeDate(root.children('lastBuildDate').first().text().trim()),
    items,
  };
}

function extractCoverUrl($, item, rawDescription, baseUrl) {
  const enclosure = item
    .children('enclosure')
    .filter((_, element) => ($(element).attr('type') || '').startsWith('image/'))
    .first()
    .attr('url');
  const media = item.children('media\\:content').first().attr('url');
  let descriptionImage = null;
  if (rawDescription) {
    const fragment = load(rawDescription, { decodeEntities: true });
    fragment('img').each((_, element) => {
      if (descriptionImage) return;
      const image = fragment(element);
      const src = image.attr('src') || '';
      const width = Number.parseInt(image.attr('width') || '', 10);
      const height = Number.parseInt(image.attr('height') || '', 10);
      if (/telemetry|tracking|pixel/i.test(src) || width === 1 || height === 1) return;
      descriptionImage = src;
    });
  }
  const candidate = enclosure || media || descriptionImage;
  if (!candidate) return null;
  try {
    const url = new URL(candidate, baseUrl);
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

async function cacheCovers(items, channel) {
  const result = [];
  for (const item of items) {
    if (!item.image) {
      result.push(item);
      continue;
    }
    result.push({ ...item, image: await cacheCover(item.image, channel.id) });
  }
  return result;
}

async function cacheCover(url, channelId) {
  const imageRoot = path.join(OUT_ROOT, 'images', channelId);
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 20);
  await mkdir(imageRoot, { recursive: true });
  const existing = await findExistingCover(imageRoot, hash);

  try {
    const response = await fetch(url, {
      headers: {
        accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.8',
        'user-agent': 'RedRockBlog-RSS/1.0 (+https://github.com/RedrockTeam/RedRockBlog)',
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const length = Number.parseInt(response.headers.get('content-length') || '0', 10);
    if (length > MAX_COVER_BYTES) throw new Error('图片超过 6 MB');
    const extension = extensionFor(response.headers.get('content-type'));
    if (!extension) throw new Error('不支持的图片格式');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_COVER_BYTES) throw new Error('图片大小无效');
    const filename = `${hash}${extension}`;
    const target = path.join(imageRoot, filename);
    await writeBinaryAtomic(target, bytes);
    return `images/${channelId}/${filename}`;
  } catch (error) {
    if (existing) return `images/${channelId}/${existing}`;
    console.warn(`[${channelId}] 封面缓存失败：${error.message}`);
    return null;
  }
}

async function findExistingCover(directory, hash) {
  try {
    return (await readdir(directory)).find((name) => name.startsWith(`${hash}.`)) || null;
  } catch {
    return null;
  }
}

function extensionFor(contentType) {
  const type = (contentType || '').split(';')[0].trim().toLowerCase();
  return {
    'image/avif': '.avif',
    'image/gif': '.gif',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
  }[type] || null;
}

function htmlToText(html) {
  if (!html) return '';
  const $ = load(html, { decodeEntities: true });
  $('script, style, img').remove();
  return $.root().text().replace(/\s+/g, ' ').trim();
}

function normalizeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isSafeHttpUrl(value) {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

async function readCachedFeed(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}

async function writeBinaryAtomic(file, value) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, value);
  await rename(temporary, file);
}
