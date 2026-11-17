/**
 * 离线自测：不碰 OCS、不写数据库，验证「答案文本 ↔ 乱序选项」这套地基
 * 运行：node src/selftest.mjs
 */
import { dice, judgementOf, norm, normJudgement, removeRedundant, sha1 } from './normalize.mjs';
import { answerToVotes, detectType, matchOption, resolveQuestion, setKey } from './decide.mjs';
import { buildPrompt, extractArrays, parseResponse, preprocessTitle } from './prompt.mjs';
import { quotaCheck } from './zerror.mjs';
import { renderTemplate, getByPath, isReady } from './apiprovider.mjs';
import { maskSecret } from './keys.mjs';

let pass = 0;
let fail = 0;
const fails = [];

function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ✓', name);
  } else {
    fail++;
    fails.push(name + (extra ? ' → ' + JSON.stringify(extra) : ''));
    console.log('  ✗', name, extra ? '→ ' + JSON.stringify(extra) : '');
  }
}
function eq(name, a, b) {
  ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });
}

const cfg = {
  course: 'test',
  threshold: 2 / 3,
  similarity: 0.85,
  ambiguousPolicy: 'blank',
  sources: [
    { id: 'web:deepseek', kind: 'web', weight: 1, enabled: true },
    { id: 'web:doubao', kind: 'web', weight: 1, enabled: true },
    { id: 'web:kimi', kind: 'web', weight: 1, enabled: true },
    { id: 'web:zhipu', kind: 'web', weight: 0, enabled: false },
    { id: 'zerror', kind: 'zerror', weight: 1, enabled: true },
  ],
  zerror: { enabled: true, mode: 'zlast', remaining: 25, refillThreshold: 20, used: 0 },
};

console.log('\n[1] 归一化 / 去前缀');
eq('去 A. 前缀', removeRedundant('A. 细胞膜'), '细胞膜');
eq('去题号', removeRedundant('12. 下列关于'), '下列关于');
eq('归一化去标点', norm('细胞膜（半透膜）！'), '细胞膜半透膜');
eq('全角转半角', norm('ＡＢＣ１２３'), 'abc123');
ok('dice 相同为 1', dice('abcd', 'abcd') === 1);
ok('dice 近似 > 0.5', dice('细胞膜的选择透过性', '细胞膜的选择透过') > 0.5);

console.log('\n[2] 题型判定');
eq('两选项对错 → judgement', detectType('single', ['对', '错']), 'judgement');
eq('radio 单选', detectType('single', ['甲', '乙', '丙', '丁']), 'single');
eq('多选', detectType('multiple', ['甲', '乙', '丙']), 'multiple');
eq('有 input 无候选 → completion', detectType('completion', []), 'completion');
eq('有 input 有候选 → completion_choice', detectType('completion', ['词A', '词B']), 'completion_choice');

console.log('\n[3] 选项乱序免疫（核心）');
const optsA = ['自由扩散', '选择透过性', '主动运输', '胞吞'];
const optsB = ['主动运输', '胞吞', '自由扩散', '选择透过性']; // 老师打乱后的顺序
const idxA = matchOption('选择透过性', optsA);
const idxB = matchOption('选择透过性', optsB);
ok('正序定位到 1', idxA === 1, idxA);
ok('乱序定位到 3', idxB === 3, idxB);
eq('两种顺序取到的文本一致', optsA[idxA], optsB[idxB]);
ok('答案带标点也能命中', matchOption('“选择透过性”。', optsB) === 3);
ok('不存在的答案不硬凑', matchOption('细胞壁的成分', optsA) === -1);

console.log('\n[4] 单题投票');
const q1 = { hash: 'h1', type: 'single', options: optsA };
const votes1 = [
  { slot: 0, norm: norm(optsA[1]), raw: optsA[1], source_id: 'web:deepseek' },
  { slot: 0, norm: norm(optsA[1]), raw: optsA[1], source_id: 'web:doubao' },
  { slot: 0, norm: norm(optsA[2]), raw: optsA[2], source_id: 'web:kimi' },
];
const r1 = resolveQuestion({ question: q1, votes: votes1, answers: [], cfg });
ok('2/3 一致 → 采纳', r1.ok && r1.a === optsA[1], r1);

const r1b = resolveQuestion({ question: q1, votes: votes1, answers: [], cfg: { ...cfg, ambiguousPolicy: 'top' } });
ok('分歧时 top 策略仍给最高票', r1b.ok && r1b.a === optsA[1], r1b);

const votes1c = [
  { slot: 0, norm: norm(optsA[1]), raw: optsA[1], source_id: 'web:deepseek' },
  { slot: 0, norm: norm(optsA[2]), raw: optsA[2], source_id: 'web:kimi' },
];
const r1c = resolveQuestion({ question: q1, votes: votes1c, answers: [], cfg });
ok('1:1 分歧 → 留空', !r1c.ok && r1c.reason === 'disputed', r1c);

const r1d = resolveQuestion({
  question: q1, votes: votes1c, answers: [{ slot: 0, text: optsA[3], norm: norm(optsA[3]), manual: 1 }], cfg,
});
ok('人工答案压过一切', r1d.ok && r1d.a === optsA[3], r1d);

console.log('\n[5] 乱序下的投票落点');
const r2 = resolveQuestion({ question: { hash: 'h2', type: 'single', options: optsB }, votes: votes1, answers: [], cfg });
ok('同样的票，在乱序页面上给出等价文本', r2.ok && r2.a === '选择透过性', r2);

console.log('\n[6] 多选');
const q3 = { hash: 'h3', type: 'multiple', options: ['甲', '乙', '丙', '丁'] };
const v3 = answerToVotes('multiple', q3.options, 'AC');
const v3b = answerToVotes('multiple', q3.options, ['丙', '甲']); // 顺序不同、写法不同
ok('多选集合键与书写顺序无关', v3[0].norm === v3b[0].norm, { a: v3[0].norm, b: v3b[0].norm });
eq('集合键是两段', v3[0].norm.split('|').length, 2);
const r3 = resolveQuestion({ question: q3, votes: [
  { ...v3[0], source_id: 'web:deepseek' }, { ...v3[0], source_id: 'web:doubao' },
], answers: [], cfg });
ok('多选两票一致 → 按页面顺序的 JSON 数组', r3.ok && JSON.parse(r3.a).join(',') === '甲,丙', r3);

console.log('\n[7] 判断');
const q4 = { hash: 'h4', type: 'judgement', options: ['正确', '错误'] };
const v4 = answerToVotes('judgement', q4.options, '对');
eq('「对」归一为 true', v4[0].norm, 'true');
const r4 = resolveQuestion({ question: q4, votes: [
  { ...v4[0], source_id: 'web:deepseek' }, { ...v4[0], source_id: 'web:kimi' },
  { slot: 0, norm: 'false', raw: '错', source_id: 'web:doubao' },
], answers: [], cfg });
ok('判断题输出「对」', r4.ok && r4.a === '对', r4);

console.log('\n[8] 填空：多空 + 长答案 + 含分隔符');
const q5 = { hash: 'h5', type: 'completion', options: [] };
const long1 = '北京';
const long2 = '2024年6月，#1 号文件；含 ; 与 | 的答案';
const v5 = answerToVotes('completion', [], [long1, long2]);
eq('两空 → 两个 slot', v5.map((x) => x.slot), [1, 2]);
const r5 = resolveQuestion({ question: q5, votes: [
  { ...v5[0], source_id: 'web:deepseek' }, { ...v5[1], source_id: 'web:deepseek' },
  { ...v5[0], source_id: 'web:kimi' }, { ...v5[1], source_id: 'web:kimi' },
], answers: [], cfg });
ok('填空输出 JSON 数组而不是分隔符', r5.ok && JSON.parse(r5.a).length === 2, r5);
eq('长答案原样保留（不被分隔符切碎）', r5.ok ? JSON.parse(r5.a)[1] : null, long2);

const r5b = resolveQuestion({ question: q5, votes: [
  { slot: 1, norm: norm('北京'), raw: '北京', source_id: 'web:deepseek' },
  { slot: 1, norm: norm('北京'), raw: '北京', source_id: 'web:kimi' },
  { slot: 2, norm: norm('上海'), raw: '上海', source_id: 'web:deepseek' },
  { slot: 2, norm: norm('广州'), raw: '广州', source_id: 'web:kimi' },
], answers: [], cfg });
ok('第 2 空 1:1 分歧 → 整题留空（作业）', !r5b.ok && r5b.reason === 'disputed', r5b);

console.log('\n[9] 预处理');
eq('剥题型后缀', preprocessTitle('下列关于细胞膜的说法，正确的是（单选题, 2.0分）'), '下列关于细胞膜的说法，正确的是');
eq('剥题号', preprocessTitle('3. 马克思主义'), '马克思主义');
eq('剥【单选题】', preprocessTitle('【单选题】1+1=?'), '1+1=?');

console.log('\n[10] 解析：五家的脏回复');
const prompt = buildPrompt([{ i: 7, title: '题干', options: ['甲', '乙'] }], 'single');
ok('prompt 含题号', prompt.includes('7. [单选]'));
ok('prompt 要求 JSON 数组', prompt.includes('第一个字符必须是 ['));

const ds = parseResponse('web:deepseek', '好的，以下是答案：\n[{"i":7,"a":"B"},{"i":8,"a":"A"}]');
eq('DeepSeek 去掉前言', ds.rows.length, 2);
const db = parseResponse('web:doubao', '```json\n[{"i":7,"a":"B"}]\n```');
eq('豆包剥代码块', db.rows.length, 1);
const km = parseResponse('web:kimi', '**答案如下**\n\n1. 我分析了一下\n\n```json\n[{"i":7,"a":"B"}]\n```\n希望有帮助');
eq('Kimi 剥加粗+代码块', km.rows.length, 1);
const qw = parseResponse('web:qwen', '| 题号 | 答案 |\n|---|---|\n| 7 | B |\n| 8 | A |');
ok('通义表格 → 明确拒绝', !!qw.error, qw.error);
const stacked = parseResponse('web:deepseek', '[{"i":1,"a":"A"}]\n[{"i":2,"a":"B"}]\n[{"i":3,"a":"C"}]');
eq('多批堆在一起 → 3 段', stacked.batches.length, 3);
eq('多批合并行数', stacked.rows.length, 3);
const broken = parseResponse('web:doubao', '[{"i":1,"a":"A"},{"i":2,"a":}]');
ok('坏 JSON 不抛异常', Array.isArray(broken.rows));
eq('空内容报错', parseResponse('web:kimi', '').error !== undefined, true);
eq('extractArrays 忽略字符串里的括号', extractArrays('x["a]b"] y [1]').length, 2);

console.log('\n[11] ZError 额度判定');
eq('剩余 25 够 3 题', quotaCheck(3, cfg).ok, true);
const qShort = quotaCheck(40, { ...cfg, zerror: { ...cfg.zerror, remaining: 18 } });
ok('剩余 18 不够 40 → 阻断', !qShort.ok && qShort.needRefill, qShort);
const qWarn = quotaCheck(5, { ...cfg, zerror: { ...cfg.zerror, remaining: 12 } });
ok('剩余 12 够 5 题但要提醒领次数', qWarn.ok && qWarn.needRefill, qWarn);
eq('次数未知 → 放行但标记未知', quotaCheck(999, { ...cfg, zerror: { ...cfg.zerror, remaining: null } }).ok, true);

console.log('\n[12] 自定义 API：模板渲染 / 路径提取 / 就绪判定');
eq('prompt 占位符替换', renderTemplate('{"q":"{{prompt}}"}', { prompt: '1+1=?' }), '{"q":"1+1=?"}');
eq('key 占位符替换', renderTemplate('Bearer {{key}}', { key: 'sk-abc' }), 'Bearer sk-abc');
eq('多个占位符一起替换', renderTemplate('{{type}}:{{title}}|{{i}}', { type: '单选', title: '题干', i: 3 }), '单选:题干|3');
eq('未知占位符原样保留', renderTemplate('{{model}}-{{unknown}}', { model: 'gpt' }), 'gpt-{{unknown}}');
ok('|json 转义换行', !renderTemplate('{{prompt|json}}', { prompt: 'a\nb' }).includes('\n'));
ok('|json 转义引号', renderTemplate('"{{prompt|json}}"', { prompt: '说"hi"' }).indexOf('"hi"') === -1 || renderTemplate('"{{prompt|json}}"', { prompt: '说"hi"' }).includes('\\"'));
ok('|json 结果可塞进 JSON body', (() => { try { JSON.parse('{"q":"' + renderTemplate('{{prompt|json}}', { prompt: 'a\n"b"' }) + '"}'); return true; } catch { return false; } })());
eq('缺失变量替换成空', renderTemplate('a{{key}}b', {}), 'ab');
eq('路径取嵌套', getByPath({ choices: [{ message: { content: '[{"i":1,"a":"B"}]' } }] }, 'choices.0.message.content'), '[{"i":1,"a":"B"}]');
eq('路径不存在返回 undefined', getByPath({ a: 1 }, 'x.y.z'), undefined);
eq('空路径返回整个对象', getByPath({ a: 1 }, ''), { a: 1 });
ok('ready：填了 url+body 且启用', isReady({ enabled: true, spec: { url: 'https://x', body: '{}' } }));
ok('未启用不参与', !isReady({ enabled: false, spec: { url: 'https://x', body: '{}' } }));
ok('没填 url 不参与', !isReady({ enabled: true, spec: { body: '{}' } }));
ok('没填 body 不参与', !isReady({ enabled: true, spec: { url: 'https://x' } }));
const apiRows = parseResponse('api:custom', '[{"i":1,"a":"B"},{"i":2,"a":"AC"}]');
eq('自定义 API 的 rows 解析', apiRows.rows.length, 2);

console.log('\n[13] 密钥拆分');
eq('短密钥全遮', maskSecret('abc'), 'a…');
ok('长密钥只露头尾', maskSecret('sk-1234567890abcdef').startsWith('sk-1') && maskSecret('sk-1234567890abcdef').endsWith('cdef'));
eq('空密钥遮成空', maskSecret(''), '');

console.log('\n[14] 其他');
ok('sha1 稳定', sha1('abc') === sha1('abc'));
eq('判断题选项识别', judgementOf(['√', '×'])?.trueIndex, 0);
eq('非判断两选项', judgementOf(['甲', '乙']), null);
eq('setKey 排序去重', setKey(['b', 'a', 'b']), 'a|b');

console.log(`\n${fail === 0 ? '✅' : '❌'}  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log('\n失败项：');
  fails.forEach((f) => console.log(' -', f));
  process.exit(1);
}
