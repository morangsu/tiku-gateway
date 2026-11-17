import { load, save } from './config.mjs';
import { getKey } from './keys.mjs';

/** ZError 客户端：注意它的响应里没有剩余次数，只能本地记账 + 手动校准 */
export async function query({ title, options, type }, cfg = load()) {
  const z = cfg.zerror;
  const key = getKey('zerror');
  if (!z.enabled || !key) return { ok: false, reason: 'disabled' };
  const body = {
    v: '2',
    title,
    options: Array.isArray(options) ? options.join('\n') : String(options || ''),
    type,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const resp = await fetch(z.base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const json = await resp.json().catch(() => null);
    const d = json?.data || {};
    const msg = String(d.msg || '');

    if (/失效|无效|过期|重新复制/.test(msg)) {
      save({ zerror: { invalid: true } });
      return { ok: false, reason: 'invalid-key', msg };
    }
    if (d.code === 1 && d.data) {
      commit({ invalid: false, used: (load().zerror.used || 0) + 1 });
      // 实测：ai:true 有两种来源——source='ai'（实时现编，正确率低）与
      // source='redis_cache'/'local_db'（题库沉淀的缓存答案，虽带 ai 标记但已验证）。
      // 只丢实时 AI，缓存命中照常采纳，否则命中率会腰斩。
      const src = String(d.source || '');
      const realtime = src === 'ai';
      if (realtime && d.ai && !load().zerror.trustAI) {
        return { ok: false, reason: 'ai-answer-dropped', ai: true, source: src };
      }
      return { ok: true, answer: d.data, ai: !!d.ai, source: src, msg };
    }
    commit({ used: (load().zerror.used || 0) + 1 });
    return { ok: false, reason: 'no-answer', msg };
  } catch (e) {
    return { ok: false, reason: 'network', msg: String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

function commit(patch) {
  const z = load().zerror;
  const next = { ...patch };
  if (typeof patch.used === 'number') next.used = patch.used;
  if (z.remaining !== null && typeof patch.used === 'number') {
    next.remaining = Math.max(0, z.remaining - 1);
  }
  save({ zerror: next });
}

/** 额度是否够跑这批 */
export function quotaCheck(needed, cfg = load()) {
  const z = cfg.zerror;
  if (z.remaining === null) return { ok: true, known: false, needed, remaining: null };
  const ok = z.remaining >= needed;
  return {
    ok,
    known: true,
    needed,
    remaining: z.remaining,
    needRefill: !ok || z.remaining < z.refillThreshold,
    shortfall: ok ? 0 : needed - z.remaining,
  };
}

export function state() {
  const z = load().zerror;
  return {
    enabled: z.enabled,
    mode: z.mode,
    invalid: !!z.invalid,
    known: z.remaining !== null,
    remaining: z.remaining,
    used: z.used,
    refillThreshold: z.refillThreshold,
    trustAI: z.trustAI,
  };
}

export function setQuota(remaining) {
  save({ zerror: { remaining: remaining === '' || remaining === null ? null : Number(remaining), invalid: false } });
  return state();
}

/**
 * 逐题拉取，命中回调 onVote(hash, answer, meta)
 * 返回 { tried, hit, stopped, reason }
 */
export async function pull(items, onVote, { concurrency = 2, onProgress } = {}) {
  const cfg = load();
  if (!cfg.zerror.enabled || cfg.zerror.mode === 'off') return { tried: 0, hit: 0, stopped: true, reason: 'disabled' };
  const q = quotaCheck(items.length, cfg);
  if (!q.ok) return { tried: 0, hit: 0, stopped: true, reason: 'quota', quota: q };

  let tried = 0;
  let hit = 0;
  let stopped = false;
  let reason = '';
  let cursor = 0;

  const worker = async () => {
    while (cursor < items.length && !stopped) {
      const it = items[cursor++];
      const cur = quotaCheck(1);
      if (!cur.ok) {
        stopped = true;
        reason = 'quota';
        break;
      }
      const res = await query(it, load());
      tried++;
      if (res.ok) {
        hit++;
        try {
          onVote(it.hash, res.answer, res);
        } catch {
          /* 单题写库失败不中断 */
        }
      } else if (res.reason === 'invalid-key') {
        stopped = true;
        reason = 'invalid-key';
        break;
      }
      onProgress?.({ tried, hit, total: items.length });
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return { tried, hit, stopped, reason, quota: quotaCheck(0) };
}
