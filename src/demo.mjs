/**
 * 一键演示：在 course=demo 下造 4 道题 + 两次导入 + 乱序验证 + 分歧 → 人工裁决
 * 用法：先启动网关（start.cmd），再 node src/demo.mjs
 * 不会污染你的 default 课程
 */
const B = process.env.TIKU_BASE || 'http://127.0.0.1:8321';

const post = async (p, b) =>
  (await fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) })).json();
const get = async (p) => (await fetch(B + p)).json();
const q = (title, options, type) => post('/query', { title, options, type });

const line = (t) => console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 46 - t.length)));
const log = (t, v) => console.log('  ' + t.padEnd(30), JSON.stringify(v));

(async () => {
  try {
    await get('/api/stats');
  } catch {
    console.error('连不上 ' + B + '，请先运行 start.cmd');
    process.exit(1);
  }

  await post('/api/config', { course: 'demo', mode: 'auto' });
  console.log('已切到 course=demo（跑完会切回 default）');

  line('1. 记录题目（模拟 OCS 第一遍）');
  const S1 = '下列关于细胞膜的说法，正确的是（单选题, 2.0分）';
  const O1 = ['自由扩散', '选择透过性', '主动运输', '胞吞'];
  const O1s = ['主动运输', '胞吞', '自由扩散', '选择透过性']; // 老师打乱
  log('单选 →', await q(S1, O1, 'single'));
  log('判断 →', await q('细胞膜具有选择透过性。', '正确\n错误', 'judgement'));
  log('两空填空 →', await q('请填空：中国的首都是____，2024年是____年', '', 'completion'));
  const S4 = '下列哪个是质膜的主要成分？（单选题）';
  const O4 = ['蛋白质', '脂肪', '核酸'];
  log('冲突题 →', await q(S4, O4, 'single'));

  line('2. 开始一轮');
  log('round', await post('/api/round/new'));

  line('3. 导出（看一眼喂给 AI 的内容）');
  const p1 = await get('/api/prompt?type=single&batch=0&size=20');
  console.log('  ids=' + JSON.stringify(p1.ids));
  console.log(p1.prompt.split('\n').slice(0, 6).map((l) => '  | ' + l).join('\n'));

  line('4. 导入两个 AI 的回答（模拟粘贴）');
  const imp = async (src, sess, raw) => {
    const r = await post('/api/import', { sourceId: src, session: sess, raw });
    log(src + ' #' + sess, { applied: r.applied, batches: r.batches, missing: r.missingCount, rejected: r.rejected?.length });
    return r;
  };
  // deepseek：只答了单选和填空，且分两段粘过来
  await imp('web:deepseek', '1', '好的，以下是答案：\n[{"i":1,"a":"B"}]\n[{"i":3,"a":["北京","甲辰"]}]');
  // kimi：全会
  await imp('web:kimi', '1', '```json\n[{"i":1,"a":"B"},{"i":2,"a":"对"},{"i":3,"a":["北京","甲辰"]}]\n```');
  // 冲突题：两家各说一个
  await post('/api/import', { sourceId: 'web:deepseek', session: '2', raw: '[{"i":4,"a":"A"}]' });
  await post('/api/import', { sourceId: 'web:kimi', session: '2', raw: '[{"i":4,"a":"B"}]' });

  line('5. 结果');
  log('单选取文本而非字母', await q(S1, O1, 'single'));
  log('同一题乱序后仍正确', await q(S1, O1s, 'single'));
  log('判断', await q('细胞膜具有选择透过性。', '正确\n错误', 'judgement'));
  log('填空（JSON 数组穿过 OCS 契约）', await q('请填空：中国的首都是____，2024年是____年', '', 'completion'));
  log('1:1 冲突 → 留空', await q(S4, O4, 'single'));

  line('6. 人工裁决');
  const rv = await get('/api/review?only=pending&limit=10');
  const it = rv.items.find((x) => x.title.includes('质膜'));
  if (it) {
    console.log('  待裁决：' + it.title);
    console.log('  两票：' + it.slots[0].groups.map((g) => g.raw + '(' + g.weight + ')').join('  vs  '));
    await post('/api/decide', { hash: it.hash, slots: [{ slot: 0, text: '蛋白质' }] });
    log('裁决后', await q(S4, O4, 'single'));
    log('乱序后仍正确', await q(S4, ['核酸', '脂肪', '蛋白质'], 'single'));
  }

  line('7. 统计');
  log('stats', await get('/api/stats'));
  log('待复核剩余', (await get('/api/review?only=pending&limit=10')).total);

  await post('/api/config', { course: 'default' });
  console.log('\n已切回 course=default。演示数据留在 course=demo 下，不影响正式题库。');
  console.log('想清掉演示数据：删掉 data/bank.sqlite* 即可（会清空所有课程）\n');
})();
