import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DATA_DIR } from './config.mjs';

const require = createRequire(import.meta.url);

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  DatabaseSync = null;
}

const SQLITE_FILE = path.join(DATA_DIR, 'bank.sqlite');
const JSON_FILE = path.join(DATA_DIR, 'bank.json');

const now = () => new Date().toISOString();

/* ------------------------------------------------------------------ */
/* SQLite 后端                                                          */
/* ------------------------------------------------------------------ */

function createSqliteBackend() {
  const db = new DatabaseSync(SQLITE_FILE);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS question(
      hash TEXT PRIMARY KEY, course TEXT, title_raw TEXT, title_norm TEXT,
      type TEXT, options TEXT, blanks INTEGER, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS vote(
      id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT, slot INTEGER, norm TEXT,
      raw TEXT, source_id TEXT, session TEXT, batch INTEGER, created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_vote_hash ON vote(hash);
    CREATE TABLE IF NOT EXISTS answer(
      hash TEXT, slot INTEGER, text TEXT, norm TEXT, manual INTEGER,
      updated_at TEXT, PRIMARY KEY(hash, slot)
    );
    CREATE TABLE IF NOT EXISTS round(
      id INTEGER PRIMARY KEY AUTOINCREMENT, course TEXT, created_at TEXT, status TEXT
    );
    CREATE TABLE IF NOT EXISTS round_item(
      round_id INTEGER, i INTEGER, hash TEXT, PRIMARY KEY(round_id, i)
    );
  `);

  const q = {
    upsert: db.prepare(`
      INSERT INTO question(hash, course, title_raw, title_norm, type, options, blanks, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(hash) DO UPDATE SET
        title_raw=excluded.title_raw, updated_at=excluded.updated_at`),
    get: db.prepare('SELECT * FROM question WHERE hash = ?'),
    byCourse: db.prepare('SELECT * FROM question WHERE course = ? ORDER BY created_at'),
    count: db.prepare('SELECT COUNT(*) AS n FROM question'),
  };
  const v = {
    add: db.prepare('INSERT INTO vote(hash,slot,norm,raw,source_id,session,batch,created_at) VALUES(?,?,?,?,?,?,?,?)'),
    byHash: db.prepare('SELECT * FROM vote WHERE hash = ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM vote'),
    dedupe: db.prepare('DELETE FROM vote WHERE hash=? AND slot=? AND norm=? AND source_id=? AND session=?'),
  };
  const a = {
    set: db.prepare(`
      INSERT INTO answer(hash,slot,text,norm,manual,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(hash,slot) DO UPDATE SET text=excluded.text, norm=excluded.norm,
        manual=excluded.manual, updated_at=excluded.updated_at`),
    byHash: db.prepare('SELECT * FROM answer WHERE hash = ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM answer'),
    manualCount: db.prepare('SELECT COUNT(*) AS n FROM answer WHERE manual = 1'),
  };
  const r = {
    active: db.prepare("SELECT * FROM round WHERE course=? AND status='open' ORDER BY id DESC LIMIT 1"),
    create: db.prepare("INSERT INTO round(course,created_at,status) VALUES(?,?,'open')"),
    closeAll: db.prepare("UPDATE round SET status='done' WHERE course=? AND status='open'"),
    items: db.prepare('SELECT i, hash FROM round_item WHERE round_id=? ORDER BY i'),
    addItem: db.prepare('INSERT INTO round_item(round_id,i,hash) VALUES(?,?,?)'),
    itemByI: db.prepare('SELECT hash FROM round_item WHERE round_id=? AND i=?'),
  };

  return {
    kind: 'sqlite',
    upsertQuestion(x) {
      q.upsert.run(x.hash, x.course, x.titleRaw, x.titleNorm, x.type, JSON.stringify(x.options || []), x.blanks ?? null, now(), now());
    },
    getQuestion: (hash) => q.get.get(hash),
    questionsByCourse: (course) =>
      q.byCourse.all(course).map((row) => ({ ...row, options: safeParse(row.options) })),
    addVote(x) {
      v.dedupe.run(x.hash, x.slot, x.norm, x.sourceId, x.session || '');
      v.add.run(x.hash, x.slot, x.norm, x.raw ?? '', x.sourceId, x.session || '', x.batch ?? 0, now());
    },
    votesFor: (hash) => v.byHash.all(hash),
    setAnswer(x) {
      a.set.run(x.hash, x.slot, x.text, x.norm, x.manual ? 1 : 0, now());
    },
    answersFor: (hash) => a.byHash.all(hash),
    activeRound(course) {
      let row = r.active.get(course);
      if (!row) {
        r.create.run(course, now());
        row = r.active.get(course);
      }
      return row;
    },
    newRound(course) {
      r.closeAll.run(course);
      r.create.run(course, now());
      return r.active.get(course);
    },
    roundItems: (roundId) => r.items.all(roundId),
    addRoundItem: (roundId, i, hash) => r.addItem.run(roundId, i, hash),
    hashByI: (roundId, i) => (r.itemByI.get(roundId, i) || {}).hash,
    stats() {
      return {
        questions: q.count.get().n,
        votes: v.count.get().n,
        answers: a.count.get().n,
        manual: a.manualCount.get().n,
      };
    },
    raw: db,
  };
}

/* ------------------------------------------------------------------ */
/* JSON 后端（Node 无 node:sqlite 时自动降级）                            */
/* ------------------------------------------------------------------ */

function createJsonBackend() {
  let data = { question: {}, vote: [], answer: {}, round: [], roundItem: [] };
  if (fs.existsSync(JSON_FILE)) {
    try {
      data = Object.assign(data, JSON.parse(fs.readFileSync(JSON_FILE, 'utf8')));
    } catch {
      /* 忽略损坏文件，重建 */
    }
  }
  let timer = null;
  const flush = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const tmp = JSON_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, JSON_FILE);
    }, 50);
  };
  const akey = (h, s) => `${h}#${s}`;

  return {
    kind: 'json',
    upsertQuestion(x) {
      const prev = data.question[x.hash];
      data.question[x.hash] = {
        hash: x.hash,
        course: x.course,
        title_raw: x.titleRaw,
        title_norm: x.titleNorm,
        // 选项顺序以首次见到的为准：prompt 与导入必须用同一份顺序，否则字母会错位
        type: prev?.type || x.type,
        options: prev?.options || JSON.stringify(x.options || []),
        blanks: prev?.blanks ?? (x.blanks ?? null),
        created_at: prev?.created_at || now(),
        updated_at: now(),
      };
      flush();
    },
    getQuestion: (hash) => data.question[hash],
    questionsByCourse: (course) =>
      Object.values(data.question)
        .filter((x) => x.course === course)
        .map((row) => ({ ...row, options: safeParse(row.options) })),
    addVote(x) {
      data.vote = data.vote.filter(
        (v) => !(v.hash === x.hash && v.slot === x.slot && v.norm === x.norm && v.source_id === x.sourceId && v.session === (x.session || ''))
      );
      data.vote.push({
        hash: x.hash, slot: x.slot, norm: x.norm, raw: x.raw ?? '', source_id: x.sourceId,
        session: x.session || '', batch: x.batch ?? 0, created_at: now(),
      });
      flush();
    },
    votesFor: (hash) => data.vote.filter((v) => v.hash === hash),
    setAnswer(x) {
      data.answer[akey(x.hash, x.slot)] = {
        hash: x.hash, slot: x.slot, text: x.text, norm: x.norm,
        manual: x.manual ? 1 : 0, updated_at: now(),
      };
      flush();
    },
    answersFor: (hash) =>
      Object.values(data.answer).filter((x) => x.hash === hash),
    activeRound(course) {
      let row = data.round.filter((x) => x.course === course && x.status === 'open').pop();
      if (!row) {
        row = { id: (data.round.at(-1)?.id || 0) + 1, course, created_at: now(), status: 'open' };
        data.round.push(row);
        flush();
      }
      return row;
    },
    newRound(course) {
      data.round.forEach((x) => {
        if (x.course === course && x.status === 'open') x.status = 'done';
      });
      const row = { id: (data.round.at(-1)?.id || 0) + 1, course, created_at: now(), status: 'open' };
      data.round.push(row);
      flush();
      return row;
    },
    roundItems: (roundId) => data.roundItem.filter((x) => x.round_id === roundId).sort((a, b) => a.i - b.i),
    addRoundItem: (roundId, i, hash) => {
      data.roundItem.push({ round_id: roundId, i, hash });
      flush();
    },
    hashByI: (roundId, i) => (data.roundItem.find((x) => x.round_id === roundId && x.i === i) || {}).hash,
    stats() {
      return {
        questions: Object.keys(data.question).length,
        votes: data.vote.length,
        answers: Object.keys(data.answer).length,
        manual: Object.values(data.answer).filter((x) => x.manual).length,
      };
    },
    raw: data,
  };
}

function safeParse(s) {
  try {
    return JSON.parse(s || '[]');
  } catch {
    return [];
  }
}

fs.mkdirSync(DATA_DIR, { recursive: true });
export const store = DatabaseSync ? createSqliteBackend() : createJsonBackend();
export const backendKind = store.kind;
