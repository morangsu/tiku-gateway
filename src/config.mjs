import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const DEFAULTS = {
  port: 8321,
  course: 'default',
  mode: 'auto', // record | lookup | auto
  threshold: 2 / 3, // 投票一致阈值
  similarity: 0.85, // 答案文本 → 选项 的相似度下限
  ambiguousPolicy: 'blank', // blank（作业留空）| top（考试取最高票）
  zerror: {
    enabled: true,
    mode: 'zlast', // zfirst | zlast | off
    key: '', // 已弃用：token 只存 data/keys.json，这里永远保持空
    trustAI: false,
    remaining: null, // null = 未知，需要手动校准
    refillThreshold: 20, // 低于这个数就提醒去领
    used: 0,
    base: 'https://api.zaizhexue.top/api/query',
  },
  sources: [
    { id: 'web:deepseek', kind: 'web', label: 'DeepSeek', model: '', weight: 1, enabled: true, sessions: 1 },
    { id: 'web:doubao', kind: 'web', label: '豆包', model: '', weight: 1, enabled: true, sessions: 1 },
    { id: 'web:kimi', kind: 'web', label: 'Kimi', model: '', weight: 1, enabled: true, sessions: 1 },
    { id: 'web:zhipu', kind: 'web', label: '智谱清言', model: '', weight: 1, enabled: true, sessions: 1 },
    { id: 'web:qwen', kind: 'web', label: '通义', model: '', weight: 1, enabled: true, sessions: 1 },
    { id: 'zerror', kind: 'zerror', label: 'ZError', model: '', weight: 1, enabled: true, sessions: 1 },
  ],
  prompt: { batchSize: 20, maxTitleChars: 500 },
};

let cache = null;

export function load() {
  if (cache) return cache;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let raw = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch {
      raw = {};
    }
  }
  cache = deepMerge(structuredClone(DEFAULTS), raw);
  return cache;
}

export function save(patch) {
  const cur = load();
  const next = deepMerge(cur, patch || {});
  cache = next;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, CONFIG_FILE);
  return next;
}

export function reset() {
  cache = null;
  return load();
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (isPlainObject(v) && isPlainObject(base[k])) deepMerge(base[k], v);
    else base[k] = v;
  }
  return base;
}
