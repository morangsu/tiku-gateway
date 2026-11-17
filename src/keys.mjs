import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, load, save } from './config.mjs';

/**
 * 密钥独立存储：所有 key 只放 data/keys.json，绝不写进 config.json。
 * 这样 config.json / 题库可以整包分享，密钥不跟着泄露。
 * 结构：{ zerror: "<token>", api: { "<sourceId>": "<key>" } }
 */
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');
let cache = null;

function read() {
  if (cache) return cache;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let raw = {};
  if (fs.existsSync(KEYS_FILE)) {
    try {
      raw = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
    } catch {
      raw = {};
    }
  }
  cache = {
    zerror: typeof raw.zerror === 'string' ? raw.zerror : '',
    api: raw.api && typeof raw.api === 'object' && !Array.isArray(raw.api) ? raw.api : {},
  };
  return cache;
}

function flush() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = KEYS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
  fs.renameSync(tmp, KEYS_FILE);
}

export function loadKeys() {
  return read();
}

export function getKey(kind, id) {
  const k = read();
  if (kind === 'zerror') return k.zerror;
  if (kind === 'api') return k.api[String(id || '')] || '';
  return '';
}

/** value 为空 = 删除该 key */
export function setKey(kind, id, value) {
  const k = read();
  const v = String(value ?? '').trim();
  if (kind === 'zerror') {
    k.zerror = v;
  } else if (kind === 'api') {
    const key = String(id || '').trim();
    if (!key) return state();
    if (v) k.api[key] = v;
    else delete k.api[key];
  }
  flush();
  return state();
}

export function maskSecret(s) {
  s = String(s || '');
  if (!s) return '';
  if (s.length <= 8) return s[0] + '…';
  return s.slice(0, 4) + '…' + s.slice(-4);
}

/** 前端只拿得到「是否设置 + 掩码」，明文永不出网关 */
export function state() {
  const k = read();
  return {
    zerror: { set: !!k.zerror, preview: maskSecret(k.zerror) },
    api: Object.fromEntries(
      Object.entries(k.api).map(([id, v]) => [id, { set: !!v, preview: maskSecret(v) }])
    ),
  };
}

/**
 * 一次性迁移：把旧 config.json 里的 zerror.key 搬到 keys.json 并清空原字段。
 * 老用户升级后 token 不丢，新用户 config 里本来就是空的。
 */
export function migrateFromConfig() {
  const cfg = load();
  const legacy = String(cfg?.zerror?.key || '').trim();
  if (!legacy) return false;
  setKey('zerror', null, legacy);
  save({ zerror: { key: '' } });
  return true;
}
