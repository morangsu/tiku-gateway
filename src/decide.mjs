import { dice, judgementOf, norm, normJudgement } from './normalize.mjs';

/** 题型判定：OCS 只给 single/multiple/judgement/completion/unknown，这里再细分 */
export function detectType(ocsType, options = []) {
  const opts = (options || []).filter((o) => String(o).trim() !== '');
  if (judgementOf(opts)) return 'judgement';
  if (ocsType === 'multiple') return 'multiple';
  if (ocsType === 'completion') return opts.length ? 'completion_choice' : 'completion';
  if (ocsType === 'judgement') return 'judgement';
  if (ocsType === 'single') return 'single';
  if (ocsType === 'unknown') return opts.length > 2 ? 'single' : 'completion';
  return opts.length > 1 ? 'single' : 'completion';
}

const LETTERS = 'ABCDEFGHIJ';

export function lettersOf(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim().toUpperCase()).filter((v) => LETTERS.includes(v));
  const s = String(value ?? '').toUpperCase();
  return (s.match(/[A-J]/g) || []).filter((v) => LETTERS.includes(v));
}

export function indexOfLetter(ch) {
  return LETTERS.indexOf(String(ch).toUpperCase());
}

/** 答案文本 → 当前选项下标（乱序免疫的核心） */
export function matchOption(text, options, similarity = 0.85) {
  const target = norm(text);
  if (!target) return -1;
  const norms = options.map((o) => norm(o));
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < norms.length; i++) {
    if (!norms[i]) continue;
    if (norms[i] === target) return i;
    if (norms[i].includes(target) || target.includes(norms[i])) {
      const score = 0.95;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
      continue;
    }
    const s = dice(norms[i], target);
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  }
  return bestScore >= similarity ? best : -1;
}

/** 多选集合的投票键：排序后拼接，保证同名集合同键 */
export function setKey(norms) {
  return [...new Set(norms.filter(Boolean))].sort().join('|');
}

/**
 * 把某一路票的原始答案转成若干票记录
 * value: "B" | ["A","C"] | "对" | ["答案1","答案2"]
 */
export function answerToVotes(type, options, value, similarity = 0.85) {
  const opts = options || [];
  if (type === 'judgement') {
    const n = normJudgement(value);
    return n === 'true' || n === 'false' ? [{ slot: 0, norm: n, raw: String(value) }] : [];
  }
  if (type === 'single') {
    const letters = lettersOf(value);
    if (letters.length === 1) {
      const idx = indexOfLetter(letters[0]);
      if (idx >= 0 && idx < opts.length) return [{ slot: 0, norm: norm(opts[idx]), raw: opts[idx] }];
    }
    const idx = matchOption(Array.isArray(value) ? value[0] : value, opts, similarity);
    if (idx >= 0) return [{ slot: 0, norm: norm(opts[idx]), raw: opts[idx] }];
    return [];
  }
  if (type === 'multiple' || type === 'completion_choice') {
    const letters = lettersOf(value);
    if (letters.length >= 1 && type === 'multiple') {
      const texts = [...new Set(letters.map(indexOfLetter))].filter((i) => i >= 0 && i < opts.length).map((i) => opts[i]);
      if (texts.length) return [{ slot: 0, norm: setKey(texts.map(norm)), raw: texts.join(' / ') }];
    }
    const arr = Array.isArray(value) ? value : String(value).split(/[#|,，、]/).map((s) => s.trim()).filter(Boolean);
    const mapped = arr.map((v) => {
      const i = matchOption(v, opts, similarity);
      return i >= 0 ? opts[i] : String(v);
    });
    if (!mapped.length) return [];
    if (type === 'completion_choice') {
      return mapped.map((text, i) => ({ slot: i + 1, norm: norm(text), raw: text }));
    }
    return [{ slot: 0, norm: setKey(mapped.map(norm)), raw: mapped.join(' / ') }];
  }
  // completion / short_answer：一空一票
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .map((v) => String(v ?? '').trim())
    .filter((v, i) => v !== '' || arr.length > 1)
    .map((text, i) => ({ slot: i + 1, norm: norm(text), raw: text }));
}

/** 加权计票 */
export function tally(votes, weightOf, threshold = 2 / 3) {
  const buckets = new Map();
  for (const v of votes) {
    const w = weightOf(v.source_id) ?? 1;
    if (!w) continue;
    const cur = buckets.get(v.norm) || { norm: v.norm, weight: 0, sources: [], raw: '' };
    cur.weight += w;
    if (!cur.sources.includes(v.source_id)) cur.sources.push(v.source_id);
    if (!cur.raw) cur.raw = v.raw;
    buckets.set(v.norm, cur);
  }
  const groups = [...buckets.values()].sort((a, b) => b.weight - a.weight);
  const total = groups.reduce((s, g) => s + g.weight, 0);
  const top = groups[0];
  const second = groups[1];
  const resolved = !!top && total > 0 && top.weight / total >= threshold;
  const margin = top && second ? (top.weight - second.weight) / total : top ? 1 : 0;
  return { groups, total, top, resolved, margin };
}

export function weightMap(cfg) {
  const map = {};
  for (const s of cfg.sources || []) map[s.id] = s.enabled === false ? 0 : s.weight ?? 1;
  map['manual'] = 999;
  return map;
}

const splitSet = (k) => (k || '').split('|').filter(Boolean);

/**
 * 汇总一题的最终答案
 * 返回 { ok, a?, reason?, slots }
 */
export function resolveQuestion({ question, votes, answers, cfg }) {
  const type = question.type;
  const options = question.options || [];
  const manual = (answers || []).filter((x) => x.manual);
  if (manual.length) {
    return { ok: true, a: serialize(type, manual, options), via: 'manual' };
  }

  const weightOf = (id) => weightMap(cfg)[id] ?? 1;
  const bySlot = new Map();
  for (const v of votes || []) {
    if (!bySlot.has(v.slot)) bySlot.set(v.slot, []);
    bySlot.get(v.slot).push(v);
  }

  if (type === 'completion' || type === 'completion_choice' || type === 'short_answer') {
    const slots = [...bySlot.keys()].filter((s) => s > 0).sort((a, b) => a - b);
    if (!slots.length) return { ok: false, reason: 'no-votes', slots: [] };
    const out = [];
    const detail = [];
    let allResolved = true;
    for (const slot of slots) {
      const t = tally(bySlot.get(slot), weightOf, cfg.threshold);
      detail.push({ slot, resolved: t.resolved, top: t.top?.raw, margin: +t.margin.toFixed(2), groups: t.groups.length });
      if (!t.resolved) {
        allResolved = false;
        if (cfg.ambiguousPolicy !== 'top') continue;
      }
      out.push(t.top.raw);
    }
    if (!allResolved && cfg.ambiguousPolicy !== 'top') {
      return { ok: false, reason: 'disputed', slots: detail };
    }
    return { ok: true, a: JSON.stringify(out), via: 'votes', slots: detail };
  }

  const t = tally(bySlot.get(0) || [], weightOf, cfg.threshold);
  if (!t.top) return { ok: false, reason: 'no-votes', slots: [] };
  if (!t.resolved && cfg.ambiguousPolicy !== 'top') {
    return { ok: false, reason: 'disputed', slots: [{ slot: 0, top: t.top.raw, margin: +t.margin.toFixed(2) }] };
  }

  if (type === 'judgement') return { ok: true, a: t.top.norm === 'true' ? '对' : '错', via: 'votes' };
  if (type === 'single') {
    const idx = matchOption(t.top.raw, options, cfg.similarity);
    return { ok: true, a: idx >= 0 ? options[idx] : t.top.raw, via: 'votes', index: idx };
  }
  // multiple：输出顺序跟随当前页面选项顺序，便于人工核对
  const pairs = splitSet(t.top.norm).map((n) => ({ n, idx: options.findIndex((o) => norm(o) === n) }));
  const texts = pairs
    .sort((a, b) => (a.idx < 0 ? 1e9 : a.idx) - (b.idx < 0 ? 1e9 : b.idx))
    .map((p) => (p.idx >= 0 ? options[p.idx] : p.n));
  return { ok: true, a: JSON.stringify(texts), via: 'votes' };
}

function serialize(type, rows, options) {
  const sorted = [...rows].sort((a, b) => a.slot - b.slot);
  if (type === 'judgement') return sorted[0].norm === 'true' ? '对' : '错';
  if (type === 'single') return sorted[0].text;
  if (type === 'multiple') return JSON.stringify(splitSet(sorted[0].norm).map((n) => options.find((o) => norm(o) === n) || n));
  return JSON.stringify(sorted.filter((r) => r.slot > 0).map((r) => r.text));
}

/** 供 review 页使用：列出每空的所有票 */
export function inspect({ question, votes, answers, cfg }) {
  const weightOf = (id) => weightMap(cfg)[id] ?? 1;
  const bySlot = new Map();
  for (const v of votes || []) {
    if (!bySlot.has(v.slot)) bySlot.set(v.slot, []);
    bySlot.get(v.slot).push(v);
  }
  return [...bySlot.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([slot, list]) => ({ slot, ...tally(list, weightOf, cfg.threshold) }));
}
