import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { ROOT, load, save } from './config.mjs';
import { backendKind, store } from './store.mjs';
import { norm, normJudgement, sha1 } from './normalize.mjs';
import { answerToVotes, detectType, inspect, resolveQuestion, setKey } from './decide.mjs';
import { buildPrompt, dedupeRows, findMissing, parseResponse, preprocessOptions, preprocessTitle } from './prompt.mjs';
import * as zerror from './zerror.mjs';
import * as keys from './keys.mjs';
import * as api from './apiprovider.mjs';

const WEB = path.join(ROOT, 'web');
const LOG_DIR = path.join(ROOT, 'data', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const inflight = new Set();
const log = (...a) => {
  const line = `[${new Date().toLocaleString()}] ${a.join(' ')}`;
  console.log(line);
  try {
    fs.appendFileSync(path.join(LOG_DIR, 'gateway.log'), line + '\n');
  } catch {
    /* 忽略 */
  }
};

/* ------------------------------ 工具 ------------------------------ */

function json(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 8 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      if (!buf) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch {
        try {
          resolve(Object.fromEntries(new URLSearchParams(buf)));
        } catch {
          resolve({});
        }
      }
    });
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.ico': 'image/x-icon' };

/** sqlite 后端把 options 存成 JSON 字符串，这里统一解回数组 */
function optsOf(q) {
  if (!q) return [];
  if (Array.isArray(q.options)) return q.options;
  try {
    return JSON.parse(q.options || '[]');
  } catch {
    return [];
  }
}

function serveStatic(res, file) {
  const full = path.join(WEB, file);
  if (!full.startsWith(WEB) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404).end('404');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
  res.end(fs.readFileSync(full));
}

function toArray(options) {
  if (Array.isArray(options)) return options.map((o) => String(o));
  return String(options || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ---------------------------- OCS 查询入口 ---------------------------- */

async function handleQuery(req, res) {
  const cfg = load();
  const body = await readBody(req);
  const rawTitle = String(body.title ?? body.q ?? body.question ?? '');
  const options = toArray(body.options);
  const ocsType = String(body.type || 'unknown').toLowerCase();

  const title = preprocessTitle(rawTitle);
  const titleNorm = norm(title);
  if (!titleNorm) return json(res, { code: 0, reason: 'empty-title' });

  const hash = sha1(`${cfg.course}:${titleNorm}`);
  const type = detectType(ocsType, preprocessOptions(options));
  store.upsertQuestion({
    hash,
    course: cfg.course,
    titleRaw: rawTitle,
    titleNorm,
    type,
    options,
    blanks: type === 'completion' || type === 'completion_choice' ? null : null,
  });

  if (cfg.mode === 'record') {
    maybePull(hash, { title, options, type }, cfg);
    return json(res, { code: 0, reason: 'record' });
  }

  const answers = store.answersFor(hash);
  const votes = store.votesFor(hash);
  const out = resolveQuestion({ question: { ...store.getQuestion(hash), options }, votes, answers, cfg });

  if (out.ok) {
    log('HIT', type, title.slice(0, 24), '→', String(out.a).slice(0, 40), `(${out.via})`);
    return json(res, { code: 1, q: title, a: out.a });
  }

  if (out.reason === 'disputed' && !cfg.zerror.invalid) maybePull(hash, { title, options, type }, cfg);
  return json(res, { code: 0, reason: out.reason, slots: out.slots });
}

/** 异步拉 ZError（不阻塞 OCS 请求） */
function maybePull(hash, item, cfg) {
  const z = cfg.zerror;
  if (!z.enabled || z.mode === 'off' || !keys.getKey('zerror')) return;
  const q = zerror.quotaCheck(1, cfg);
  if (!q.ok) {
    if (!cfg.zerror.needRefillNotified) save({ zerror: { needRefillNotified: true } });
    return;
  }
  if (inflight.has(hash)) return;
  inflight.add(hash);
  zerror
    .pull([{ hash, ...item }], (h, answer) => {
      const question = store.getQuestion(h);
      if (!question) return;
      const opts = JSON.parse(question.options || '[]');
      const votes = answerToVotes(question.type, opts, answer, cfg.similarity);
      for (const v of votes) {
        store.addVote({ hash: h, slot: v.slot, norm: v.norm, raw: v.raw, sourceId: 'zerror', session: 'auto' });
      }
    }, { concurrency: 1 })
    .finally(() => inflight.delete(hash));
}

/* ------------------------------ 轮次 ------------------------------ */

function unresolved(course) {
  const cfg = load();
  return store
    .questionsByCourse(course)
    .filter((q) => {
      const out = resolveQuestion({ question: { ...q, options: q.options }, votes: store.votesFor(q.hash), answers: store.answersFor(q.hash), cfg });
      return !out.ok;
    });
}

async function handleRound(res) {
  const cfg = load();
  const round = store.activeRound(cfg.course);
  const items = store.roundItems(round.id);
  const byType = {};
  const done = {};
  for (const it of items) {
    const q = store.getQuestion(it.hash);
    if (!q) continue;
    byType[q.type] = (byType[q.type] || 0) + 1;
    const has = store.votesFor(it.hash).some((v) => v.source_id && v.source_id !== 'zerror') || store.answersFor(it.hash).length;
    if (has) done[q.type] = (done[q.type] || 0) + 1;
  }
  json(res, { id: round.id, total: items.length, byType, done, course: cfg.course, mode: cfg.mode, backend: backendKind });
}

async function handleNewRound(res) {
  const cfg = load();
  const round = store.newRound(cfg.course);
  const list = unresolved(cfg.course);
  list.forEach((q, idx) => store.addRoundItem(round.id, idx + 1, q.hash));
  log('NEW-ROUND', round.id, 'items', list.length);
  json(res, { id: round.id, total: list.length });
}

/* ------------------------------ 导出 ------------------------------ */

async function handlePrompt(url, res) {
  const cfg = load();
  const round = store.activeRound(cfg.course);
  let items = store.roundItems(round.id);
  if (!items.length) return json(res, { error: '本轮还没有题目，请先在 OCS 里用 record/auto 模式跑一遍' }, 400);

  const type = url.searchParams.get('type') || 'single';
  const size = Math.max(1, Math.min(40, Number(url.searchParams.get('size') || cfg.prompt.batchSize)));
  const batch = Math.max(0, Number(url.searchParams.get('batch') || 0));

  const list = [];
  for (const it of items) {
    const q = store.getQuestion(it.hash);
    if (q && q.type === type) list.push({ i: it.i, hash: it.hash, q });
  }
  const totalBatches = Math.max(1, Math.ceil(list.length / size));
  const slice = list.slice(batch * size, batch * size + size);
  if (!slice.length) return json(res, { type, batch, totalBatches, empty: true });

  const prompt = buildPrompt(
    slice.map((x) => ({ i: x.i, title: preprocessTitle(x.q.title_raw), options: preprocessOptions(optsOf(x.q)) })),
    type
  );
  json(res, {
    type,
    batch,
    totalBatches,
    size,
    count: slice.length,
    from: slice[0].i,
    to: slice[slice.length - 1].i,
    ids: slice.map((x) => x.i),
    prompt,
  });
}

/* ------------------------------ 导入 ------------------------------ */

async function handleImport(req, res) {
  const cfg = load();
  const body = await readBody(req);
  const sourceId = String(body.sourceId || '');
  const session = String(body.session || '1');
  const raw = String(body.raw || '');
  if (!sourceId || !raw.trim()) return json(res, { error: '缺少 sourceId 或内容为空' }, 400);
  if (!(cfg.sources || []).some((s) => s.id === sourceId)) return json(res, { error: '未知票源 ' + sourceId }, 400);

  const round = store.activeRound(cfg.course);
  const parsed = parseResponse(sourceId, raw);
  if (parsed.error) return json(res, { error: parsed.error, batches: parsed.batches }, 400);

  const rows = dedupeRows(parsed.rows);
  const expected = store.roundItems(round.id).map((x) => x.i);
  const missing = findMissing(rows, expected);

  const applied = [];
  const rejected = [];
  for (const r of rows) {
    const hash = store.hashByI(round.id, r.i);
    if (!hash) {
      rejected.push({ i: r.i, reason: '轮次里没有这个题号（可能是上一轮的题）' });
      continue;
    }
    const q = store.getQuestion(hash);
    if (!q) {
      rejected.push({ i: r.i, reason: '题目丢失' });
      continue;
    }
    const opts = JSON.parse(q.options || '[]');
    const votes = answerToVotes(q.type, opts, r.a, cfg.similarity);
    if (!votes.length) {
      rejected.push({ i: r.i, reason: `答案「${JSON.stringify(r.a).slice(0, 30)}」无法对应到选项/空` });
      continue;
    }
    for (const v of votes) {
      store.addVote({ hash, slot: v.slot, norm: v.norm, raw: v.raw, sourceId, session, batch: parsed.batches.length > 1 ? 0 : 0 });
    }
    applied.push(r.i);
  }

  log('IMPORT', sourceId, '#' + session, `rows=${rows.length}`, `applied=${applied.length}`, `rejected=${rejected.length}`, `batches=${parsed.batches.join(',')}`);
  json(res, {
    sourceId,
    session,
    parsed: rows.length,
    applied: applied.length,
    batches: parsed.batches,
    rejected,
    missing: missing.slice(0, 50),
    missingCount: missing.length,
    fallback: parsed.fallback || null,
  });
}

/* ------------------------------ 复核 ------------------------------ */

async function handleReview(url, res) {
  const cfg = load();
  const only = url.searchParams.get('only') || 'pending';
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') || 40)));
  const out = [];
  for (const q of store.questionsByCourse(cfg.course)) {
    const votes = store.votesFor(q.hash);
    const answers = store.answersFor(q.hash);
    const r = resolveQuestion({ question: { ...q, options: q.options }, votes, answers, cfg });
    if (only === 'pending' && r.ok) continue;
    out.push({
      hash: q.hash,
      title: preprocessTitle(q.title_raw),
      raw: q.title_raw,
      type: q.type,
      options: q.options,
      resolved: r.ok,
      answer: r.ok ? r.a : null,
      reason: r.reason || null,
      slots: inspect({ question: q, votes, answers, cfg }).map((s) => ({
        slot: s.slot,
        resolved: s.resolved,
        groups: s.groups.map((g) => ({ raw: g.raw, weight: g.weight, sources: g.sources })),
      })),
    });
  }
  json(res, { total: out.length, items: out.slice(0, limit) });
}

async function handleDecide(req, res) {
  const cfg = load();
  const body = await readBody(req);
  const hash = String(body.hash || '');
  const slots = Array.isArray(body.slots) ? body.slots : [{ slot: Number(body.slot ?? 0), text: String(body.text ?? '') }];
  const q = store.getQuestion(hash);
  if (!q) return json(res, { error: '题目不存在' }, 404);
  for (const s of slots) {
    const slot = Number(s.slot ?? 0);
    const text = String(s.text ?? '');
    let n;
    if (q.type === 'judgement') n = normJudgement(text);
    else if (q.type === 'multiple' && slot === 0) n = setKey(text.split('|').map((x) => norm(x)));
    else n = norm(text);
    store.setAnswer({ hash, slot, text, norm: n, manual: 1 });
  }
  log('DECIDE', q.type, preprocessTitle(q.title_raw).slice(0, 20), JSON.stringify(slots).slice(0, 60));
  json(res, { ok: true });
}

/* ------------------------------ 其它 API ------------------------------ */

async function handleZerror(url, req, res, action) {
  if (action === 'state') return json(res, zerror.state());
  if (action === 'quota') {
    const body = await readBody(req);
    return json(res, zerror.setQuota(body.remaining));
  }
  if (action === 'test') {
    // 用固定常见题探测：命中 → token 有效且题库可用；no-answer 但非 invalid → token 有效（只是这题没收录）
    const r = await zerror.query({ title: '水的化学式是什么？', options: 'H2O\nCO2\nO2\nH2O2', type: 'single' });
    save({ zerror: { needRefillNotified: false } });
    const tokenOk = r.ok || r.reason === 'no-answer' || r.reason === 'ai-answer-dropped';
    return json(res, { ...r, tokenOk, hint: tokenOk ? 'token 有效' : 'token 无效，请去 tiku.zerror.cc 重新复制配置' });
  }
  if (action === 'pull') {
    const cfg = load();
    const body = await readBody(req);
    const scope = body.scope || 'disputed';
    const list = [];
    for (const q of store.questionsByCourse(cfg.course)) {
      const votes = store.votesFor(q.hash);
      const answers = store.answersFor(q.hash);
      const r = resolveQuestion({ question: { ...q, options: q.options }, votes, answers, cfg });
      if (r.ok) continue;
      const mine = votes.some((v) => v.source_id === 'zerror');
      if (mine) continue;
      if (scope === 'disputed' && r.reason !== 'disputed') continue;
      list.push({ hash: q.hash, title: preprocessTitle(q.title_raw), options: q.options, type: q.type });
    }
    const q = zerror.quotaCheck(list.length, cfg);
    if (!q.ok) return json(res, { stopped: true, reason: 'quota', quota: q, need: list.length });
    log('ZERROR-PULL', 'items', list.length, 'scope', scope);
    const result = await zerror.pull(list, (hash, answer) => {
      const question = store.getQuestion(hash);
      const opts = JSON.parse(question.options || '[]');
      const votes = answerToVotes(question.type, opts, answer, cfg.similarity);
      for (const v of votes) store.addVote({ hash, slot: v.slot, norm: v.norm, raw: v.raw, sourceId: 'zerror', session: 'pull' });
    }, { concurrency: 2 });
    return json(res, { ...result, need: list.length });
  }
  json(res, { error: 'unknown action' }, 404);
}

async function handleStats(res) {
  const cfg = load();
  const s = store.stats();
  const round = store.activeRound(cfg.course);
  json(res, { ...s, backend: backendKind, course: cfg.course, mode: cfg.mode, round: { id: round.id, total: store.roundItems(round.id).length }, zerror: zerror.state(), apiSources: api.enabledApiSources(cfg).map((x) => x.id) });
}

/* ------------------------------ 密钥（独立文件） ------------------------------ */

async function handleKeys(req, res) {
  if (req.method === 'POST') {
    const body = await readBody(req);
    const out = keys.setKey(body.kind, body.id, body.value);
    return json(res, out);
  }
  return json(res, keys.state());
}

/* ------------------------------ 自定义 API 票源 ------------------------------ */

async function handleApi(url, req, res, action) {
  const cfg = load();
  if (action === 'test') {
    const body = await readBody(req);
    const source = (cfg.sources || []).find((s) => s.id === body.sourceId);
    if (!source || source.kind !== 'api') return json(res, { error: '未找到该 API 票源' }, 404);
    return json(res, await api.testApi(source));
  }
  if (action === 'pull') {
    const body = await readBody(req);
    const sources = body.sourceId
      ? (cfg.sources || []).filter((s) => s.id === body.sourceId)
      : api.enabledApiSources(cfg);
    const round = store.activeRound(cfg.course);
    const rows = store.roundItems(round.id);
    const items = [];
    for (const it of rows) {
      const q = store.getQuestion(it.hash);
      if (!q) continue;
      const votes = store.votesFor(it.hash);
      const answers = store.answersFor(it.hash);
      const resolved = resolveQuestion({ question: { ...q, options: q.options }, votes, answers, cfg });
      if (resolved.ok) continue; // 只拉未解的题，省 API 费用
      items.push({
        hash: it.hash,
        i: it.i,
        title: preprocessTitle(q.title_raw),
        options: optsOf(q),
        type: q.type,
      });
    }
    if (!items.length) return json(res, { sources: sources.length, tried: 0, hit: 0, hint: '本轮没有未解的题' });

    const results = [];
    for (const source of sources) {
      const sourceItems = (body.sourceId || body.scope === 'all') ? items : items; // 每个启用的源都跑
      const result = await api.pull(source, sourceItems, (hash, answer, it) => {
        const question = store.getQuestion(hash);
        const votes = answerToVotes(question.type, optsOf(question), answer, cfg.similarity);
        for (const v of votes) {
          store.addVote({ hash, slot: v.slot, norm: v.norm, raw: v.raw, sourceId: source.id, session: 'api' });
        }
      });
      results.push(result);
    }
    return json(res, {
      items: items.length,
      results,
      totalTried: results.reduce((s, r) => s + (r.tried || 0), 0),
      totalHit: results.reduce((s, r) => s + (r.hit || 0), 0),
    });
  }
  json(res, { error: 'unknown action' }, 404);
}

/* ------------------------------ 路由 ------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  try {
    if (req.method === 'OPTIONS') return json(res, {}, 204);
    if (p === '/' || p === '/index.html') return serveStatic(res, 'index.html');
    if (p === '/app.css') return serveStatic(res, 'app.css');
    if (['/export', '/import', '/review', '/sources'].includes(p)) return serveStatic(res, p.slice(1) + '.html');

    if (p === '/query') return await handleQuery(req, res);
    if (p === '/api/round') return await handleRound(res);
    if (p === '/api/round/new') return await handleNewRound(res);
    if (p === '/api/prompt') return await handlePrompt(url, res);
    if (p === '/api/import') return await handleImport(req, res);
    if (p === '/api/review') return await handleReview(url, res);
    if (p === '/api/decide') return await handleDecide(req, res);
    if (p === '/api/stats') return await handleStats(res);
    if (p === '/api/config') {
      if (req.method === 'POST') return json(res, save(await readBody(req)));
      return json(res, load());
    }
    if (p === '/api/sources') {
      if (req.method === 'POST') {
        const body = await readBody(req);
        return json(res, save({ sources: body.sources }));
      }
      return json(res, load().sources);
    }
    if (p.startsWith('/api/zerror/')) return await handleZerror(url, req, res, p.split('/').pop());
    if (p === '/api/keys') return await handleKeys(req, res);
    if (p.startsWith('/api/api/')) return await handleApi(url, req, res, p.split('/').pop());

    json(res, { error: 'not found', path: p }, 404);
  } catch (e) {
    log('ERROR', p, String(e?.stack || e));
    json(res, { error: String(e?.message || e) }, 500);
  }
});

const cfg = load();
// 一次性迁移：老配置里的 ZError token 搬进 keys.json，config.json 不再存密钥
try {
  if (keys.migrateFromConfig()) log('已把 ZError token 从 config.json 迁到 data/keys.json');
} catch (e) {
  log('密钥迁移失败：', String(e?.message || e));
}
let port = cfg.port;
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    port += 1;
    log('端口占用，尝试', port);
    server.listen(port, '127.0.0.1');
  } else {
    throw e;
  }
});
server.listen(port, '127.0.0.1', () => {
  log(`tiku gateway ready → http://127.0.0.1:${port}  backend=${backendKind} course=${cfg.course} mode=${cfg.mode}`);
  if (cfg.zerror.invalid) log('⚠ ZError 配置已失效，请到 tiku.zerror.cc 重新复制 token');
  if (cfg.zerror.remaining !== null && cfg.zerror.remaining < cfg.zerror.refillThreshold) {
    log(`⚠ ZError 剩余次数 ${cfg.zerror.remaining} 低于 ${cfg.zerror.refillThreshold}，可以先去领免费次数`);
  }
});
