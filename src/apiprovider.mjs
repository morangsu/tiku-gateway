import { load } from './config.mjs';
import { getKey } from './keys.mjs';
import { buildPrompt, dedupeRows, parseResponse } from './prompt.mjs';

/**
 * 通用自定义 API 票源。
 *
 * 每个 kind:'api' 的 source 自带一份请求规格（全由用户填）：
 *   {
 *     id: 'api:deepseek', label: 'DeepSeek API', kind: 'api',
 *     enabled: true, weight: 1, batchSize: 20,
 *     spec: {
 *       url: 'https://api.deepseek.com/chat/completions',
 *       method: 'POST',
 *       headers: { 'Content-Type': 'application/json' },
 *       authHeader: 'Authorization',         // 留空则不注入
 *       authValue: 'Bearer {{key}}',          // {{key}} = 该源独立密钥
 *       body: '{"model":"deepseek-chat","messages":[{"role":"user","content":"{{prompt}}"}]}',
 *       answerPath: 'choices.0.message.content', // 响应里答案文本的路径（点号）
 *       format: 'rows'                        // rows=批量 [{i,a}] | single=单题答案
 *     }
 *   }
 *
 * 占位符：{{prompt}} {{title}} {{options}} {{type}} {{i}} {{key}} {{model}}
 * 密钥只从 keys.json 取（getKey('api', id)），绝不写进 config / 日志。
 */

const PLACEHOLDERS = ['prompt', 'title', 'options', 'type', 'i', 'key', 'model'];

/**
 * 把模板里的 {{x}} 或 {{x|json}} 换成值。
 *  - {{prompt}}      原样替换（适合纯文本 / form 表单）
 *  - {{prompt|json}} 做 JSON 字符串转义后替换（放 JSON body 的引号里必须用这个，
 *                    否则 prompt 里的换行/引号会把 body 撑坏）
 * 未知占位符或未知过滤器原样保留，便于用户发现填错。
 */
export function renderTemplate(tpl, vars) {
  return String(tpl ?? '').replace(/\{\{\s*([\w]+)\s*(?:\|\s*([\w]+)\s*)?\}\}/g, (m, name, filter) => {
    if (!PLACEHOLDERS.includes(name)) return m;
    if (filter && filter !== 'json') return m;
    const v = vars[name];
    if (v === undefined || v === null) return '';
    const s = String(v);
    if (filter === 'json') {
      // 取 JSON.stringify 的内容部分（去掉两端引号），方便直接放进 "..." 里
      return JSON.stringify(s).slice(1, -1);
    }
    return s;
  });
}

/** 按点号路径取对象里的值：choices.0.message.content */
export function getByPath(obj, path) {
  if (!path) return obj;
  let cur = obj;
  for (const seg of String(path).split('.')) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function renderHeaders(headers, vars) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (!k) continue;
    out[k] = renderTemplate(v, vars);
  }
  return out;
}

function makeBody(spec, vars) {
  const raw = renderTemplate(spec.body ?? '', vars);
  // 空 body 允许（GET 场景）；否则必须是合法 JSON，给出明确报错
  if (!raw.trim()) return { body: undefined };
  try {
    JSON.parse(raw);
    return { body: raw };
  } catch (e) {
    return { error: 'body 不是合法 JSON：' + e.message + '\n渲染后：' + raw.slice(0, 200) };
  }
}

/** 发一次请求，返回 { ok, text } 或 { ok:false, error } */
export async function callApi(source, vars, { timeoutMs = 60000 } = {}) {
  const spec = source.spec || {};
  const key = getKey('api', source.id);
  const allVars = { ...vars, key, model: spec.model ?? vars.model ?? '', type: vars.type ?? '' };
  const headers = renderHeaders(spec.headers, allVars);
  if (spec.authHeader) {
    headers[spec.authHeader] = renderTemplate(spec.authValue || '{{key}}', allVars);
  }
  const built = makeBody(spec, allVars);
  if (built.error) return { ok: false, error: built.error };

  const method = String(spec.method || 'POST').toUpperCase();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(spec.url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : built.body,
      signal: ctrl.signal,
    });
    const text = await resp.text();
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}`, detail: text.slice(0, 300) };

    // 先尝试按 answerPath 从 JSON 里抠出答案文本；抠不到就把整段当文本（兼容纯文本 API）
    let answerText = text;
    let parsedJson = null;
    try {
      parsedJson = JSON.parse(text);
      if (spec.answerPath) {
        const got = getByPath(parsedJson, spec.answerPath);
        if (got !== undefined && got !== null) {
          answerText = typeof got === 'string' ? got : JSON.stringify(got);
        }
      }
    } catch {
      /* 非 JSON 响应：整段当文本 */
    }
    return { ok: true, text: answerText, raw: text, json: parsedJson };
  } catch (e) {
    const name = e?.name === 'AbortError' ? `请求超时（>${timeoutMs}ms）` : String(e?.message || e);
    return { ok: false, error: name };
  } finally {
    clearTimeout(timer);
  }
}

/** 固定探针题，用于「测试连通」 */
export const PROBE = {
  i: 1,
  title: '水的化学式是什么？',
  options: ['H2O', 'CO2', 'O2', 'H2O2'],
  type: 'single',
};

/** 是否具备可请求的最小条件（只填了内容的源才参与） */
export function isReady(source) {
  const spec = source?.spec || {};
  return !!(source.enabled !== false && spec.url && spec.body !== undefined && spec.body !== '');
}

/** 测试一个 API 源：发探针题，报告是否拿到可解析的答案 */
export async function testApi(source) {
  if (!source.spec?.url) return { ok: false, error: '未填 URL' };
  const key = getKey('api', source.id);
  if (source.spec.authHeader && !key) return { ok: false, error: '未填该源的密钥（key 已拆到独立文件，请在票源页填写）' };
  const prompt = buildPrompt([PROBE], 'single');
  const vars = {
    prompt,
    title: PROBE.title,
    options: PROBE.options.join('\n'),
    type: 'single',
    i: '1',
  };
  const r = await callApi(source, vars);
  if (!r.ok) return r;
  const parsed = parseResponse(source.id, r.text);
  return {
    ok: true,
    keySet: !!key,
    answerText: r.text.slice(0, 300),
    parsed: parsed.rows.slice(0, 5),
    parseError: parsed.error || null,
    hint: parsed.rows.length ? '连通且答案可解析' : '连通，但答案格式没解析出来——检查 answerPath 与 body 里的输出要求',
  };
}

/**
 * 批量拉取：对 items 按题型分批 → 构造 prompt → 请求 → 解析 → 回调 onVote(hash, answer)
 * items: [{ hash, i, title(已预处理), options(数组), type }]
 */
export async function pull(source, items, onVote, { onProgress } = {}) {
  const cfg = load();
  if (!isReady(source)) return { tried: 0, hit: 0, stopped: true, reason: 'not-ready' };
  const spec = source.spec || {};
  const size = Math.max(1, Math.min(40, Number(spec.batchSize || cfg.prompt?.batchSize || 20)));

  const groups = {};
  for (const it of items) (groups[it.type] ||= []).push(it);

  let tried = 0;
  let hit = 0;
  const errors = [];
  for (const [type, list] of Object.entries(groups)) {
    for (let start = 0; start < list.length; start += size) {
      const batch = list.slice(start, start + size);
      const prompt = buildPrompt(
        batch.map((x) => ({ i: x.i, title: x.title, options: x.options })),
        type
      );
      const r = await callApi(source, {
        prompt,
        title: batch[0].title,
        options: batch[0].options?.join('\n') || '',
        type,
        i: String(batch[0].i ?? ''),
      });
      tried++;
      if (!r.ok) {
        errors.push(`${type} 批 ${start + 1}: ${r.error}`);
        onProgress?.({ tried, hit, total: Math.ceil(items.length / size) });
        continue;
      }
      const parsed = parseResponse(source.id, r.text);
      if (parsed.error) {
        errors.push(`${type} 批 ${start + 1}: 解析失败 ${parsed.error}`);
        onProgress?.({ tried, hit, total: Math.ceil(items.length / size) });
        continue;
      }
      const rows = dedupeRows(parsed.rows);
      const byI = new Map(batch.map((x) => [Number(x.i), x]));
      for (const row of rows) {
        const it = byI.get(Number(row.i));
        if (!it || row.a === '' || row.a === undefined || row.a === null) continue;
        hit++;
        try {
          onVote(it.hash, row.a, it);
        } catch {
          /* 单条写库失败不中断整批 */
        }
      }
      onProgress?.({ tried, hit, total: Math.ceil(items.length / size) });
    }
  }
  return { tried, hit, errors, sourceId: source.id };
}

/** 列出所有启用的 API 源 */
export function enabledApiSources(cfg = load()) {
  return (cfg.sources || []).filter((s) => s.kind === 'api' && isReady(s));
}
