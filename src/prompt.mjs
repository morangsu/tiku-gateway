import { norm } from './normalize.mjs';

const TYPE_LABEL = {
  single: '单选',
  multiple: '多选',
  judgement: '判断',
  completion: '填空',
  completion_choice: '选词填空',
  short_answer: '简答',
};

const BLOAT_PATTERNS = [
  /[（(【\[]\s*(单选题?|多选题?|判断题?|填空题?|简答题?|问答题?|名词解释|不定项|单选题?\(必考\)|多选题?\(必考\))[^）)】\]]{0,12}[）)】\]]/g,
  /[（(]\s*\d+(\.\d+)?\s*分\s*[）)]/g,
  /题型[:：]\s*\S{1,8}/g,
  /^\s*第?\s*\d{1,3}\s*[题.、)．]\s*/,
  /^\s*[（(]\s*\d{1,3}\s*[）)]\s*/,
];

/** 复制给 AI 之前的预处理：剥题型后缀、题号、压缩空白 */
export function preprocessTitle(raw) {
  let t = String(raw || '');
  for (const re of BLOAT_PATTERNS) t = t.replace(re, '');
  t = t.replace(/[ \t\u00a0]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  return t;
}

export function preprocessOptions(options = []) {
  return (options || []).map((o) => {
    let t = String(o || '');
    for (const re of BLOAT_PATTERNS) t = t.replace(re, '');
    return t.replace(/\s+/g, ' ').trim();
  });
}

export function hasImage(text) {
  return /\[图片|<img|data:image|<image/i.test(String(text || ''));
}

const RULES = {
  single: '单选：a 只给 1 个大写字母，例如 "B"',
  multiple: '多选：a 给多个大写字母按字母序，例如 "AC"',
  judgement: '判断：a 填 "对" 或 "错"，不要填字母',
  completion: '填空：a 是字符串数组，长度必须等于空数，按空的先后顺序，每项一个字都不许省',
  completion_choice: '选词填空：a 是字符串数组，填所选词语本身（不要字母），按空的先后顺序',
  short_answer: '简答：a 是字符串数组，只有一个元素，内容为完整答案',
};

/** 生成一批 prompt（五家共用同一份，保证投票公平） */
export function buildPrompt(items, type) {
  const head = [
    '你是答题器。只输出 JSON 数组，第一个字符必须是 [，不要任何解释、不要 markdown 代码块、不要标题。',
    '',
    '规则：',
    '1 每道题输出一个对象 {"i":题号,"a":答案}',
    `2 ${RULES[type] || RULES.single}`,
    '3 完全无法判断时 a 填空字符串 ""，不要编造',
    '输出示例：[{"i":1,"a":"B"},{"i":2,"a":["北京","2024"]}]',
    '',
    '题目：',
  ].join('\n');

  const body = items.map((it) => {
    const label = `[${TYPE_LABEL[type] || type}]`;
    const lines = [`${it.i}. ${label} ${it.title}`];
    if (it.options?.length) {
      it.options.forEach((o, idx) => lines.push(`   ${'ABCDEFGHIJ'[idx]}. ${o}`));
    }
    return lines.join('\n');
  });

  return head + '\n' + body.join('\n') + '\n';
}

/* ---------------- 解析：从杂乱回复里抠出 [{i,a}] ---------------- */

/** 扫描所有平衡的顶层 JSON 数组 */
export function extractArrays(text) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === ']') {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
        if (out.length > 200) break;
      }
      if (depth < 0) depth = 0;
    }
  }
  return out;
}

function rowsFromJson(arr) {
  return arr
    .filter((x) => x && typeof x === 'object' && 'i' in x)
    .map((x) => ({ i: Number(x.i), a: x.a ?? x.answer ?? x.ans ?? '' }))
    .filter((x) => Number.isFinite(x.i));
}

/** 逐行兜底：3. B   /  3、AC */
function rowsFromLines(text) {
  const rows = [];
  const re = /^\s*(\d{1,4})\s*[.、)．:：]\s*([A-J]{1,10})\s*$/gim;
  let m;
  while ((m = re.exec(text))) rows.push({ i: Number(m[1]), a: m[2].toUpperCase() });
  return rows;
}

const CLEANERS = {
  deepseek: (t) => t,
  doubao: (t) => t.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, ''),
  kimi: (t) => t.replace(/\*\*|__|`/g, '').replace(/^[\s\S]*?(?=\[\s*\{)/, ''),
  zhipu: (t) => t.replace(/\*\*|__|`/g, '').replace(/^[\s\S]*?(?=\[\s*\{)/, ''),
  qwen: (t) => t,
};

export function cleanFor(sourceId, raw) {
  const key = String(sourceId).split(':')[1]?.split('#')[0] || '';
  let t = String(raw || '');
  if (key === 'qwen') {
    const tableLines = t.split('\n').filter((l) => (l.match(/\|/g) || []).length >= 2).length;
    if (tableLines >= 2) return { ok: false, reason: '疑似表格输出，请让它重新按 JSON 数组回答' };
  }
  const fn = CLEANERS[key];
  if (fn) t = fn(t);
  return { ok: true, text: t.trim() };
}

/**
 * 解析一段粘贴内容 → { rows, batches, error }
 * batches: 每个顶层数组解析出的条数，便于发现"漏了一批"
 */
export function parseResponse(sourceId, raw) {
  const cleaned = cleanFor(sourceId, raw);
  if (!cleaned.ok) return { rows: [], batches: [], error: cleaned.reason };
  const text = cleaned.text;

  // 1) 整段就是数组
  const whole = text.trim();
  if (whole.startsWith('[') && whole.endsWith(']')) {
    try {
      const rows = rowsFromJson(JSON.parse(whole));
      if (rows.length) return { rows, batches: [rows.length] };
    } catch {
      /* 继续尝试 */
    }
  }

  // 2) 抠所有平衡数组
  const arrays = extractArrays(text);
  const rows = [];
  const batches = [];
  for (const a of arrays) {
    try {
      const parsed = JSON.parse(a);
      const rs = rowsFromJson(parsed);
      if (rs.length) {
        rows.push(...rs);
        batches.push(rs.length);
      }
    } catch {
      /* 单个数组坏了不影响其他 */
    }
  }
  if (rows.length) return { rows, batches };

  // 3) 逐行兜底（只对选择题有效）
  const lineRows = rowsFromLines(text);
  if (lineRows.length) return { rows: lineRows, batches: [lineRows.length], fallback: 'lines' };

  return { rows: [], batches: [], error: '没有解析到任何答案，检查是否复制了完整回复' };
}

/** 校验并去重：同一 i 出现多次以最后一次为准 */
export function dedupeRows(rows) {
  const map = new Map();
  for (const r of rows) map.set(r.i, r);
  return [...map.values()].sort((a, b) => a.i - b.i);
}

/** 检查缺号 */
export function findMissing(rows, expectedIs) {
  const got = new Set(rows.map((r) => r.i));
  return expectedIs.filter((i) => !got.has(i));
}

export function keywordOf(title) {
  return norm(preprocessTitle(title)).slice(0, 12);
}
