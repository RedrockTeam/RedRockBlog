import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(ROOT, 'src/data/channels.json');
const raw = await readFile(file, 'utf8');

let data;
try {
  data = JSON.parse(raw);
} catch (e) {
  console.error(`channels.json 不是合法 JSON: ${e.message}`);
  process.exit(1);
}

const errors = [];
if (!Array.isArray(data.channels)) errors.push('缺少 channels 数组');

const ids = new Set();
for (const [i, c] of (data.channels ?? []).entries()) {
  const at = `channels[${i}]`;
  if (!c.id || typeof c.id !== 'string') {
    errors.push(`${at}: 缺少 id`);
  } else if (!/^[a-z0-9][a-z0-9-]*$/.test(c.id)) {
    errors.push(`${at}: id 只能是小写字母/数字/中划线`);
  }
  if (ids.has(c.id)) errors.push(`${at}: id "${c.id}" 重复`);
  ids.add(c.id);
  if (!c.name || typeof c.name !== 'string') errors.push(`${at}: 缺少 name`);
  if (!c.url) {
    errors.push(`${at}: 缺少 url`);
  } else {
    let u;
    try {
      u = new URL(c.url);
    } catch {
      u = null;
    }
    if (!u || !/^https?:$/.test(u.protocol)) errors.push(`${at}: url 必须是 http(s) 地址`);
  }
  if (c.enabled !== undefined && typeof c.enabled !== 'boolean') {
    errors.push(`${at}: enabled 必须是布尔值`);
  }
}

if (errors.length) {
  console.error('校验失败：');
  errors.forEach((e) => console.error(` - ${e}`));
  process.exit(1);
}
console.log(`channels.json 校验通过（${data.channels.length} 个频道）`);
