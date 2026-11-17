import crypto from 'node:crypto';

/** LaTeX 线性化：\frac{a}{b} -> (a)/(b)，\sqrt -> √，\times -> * */
export function linearizeLatex(str) {
  if (typeof str !== 'string' || !str.includes('\\')) return str || '';
  let s = str;
  let prev = '';
  while (prev !== s) {
    prev = s;
    s = s.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1)/($2)');
  }
  return s
    .replace(/\\sqrt\s*\[([^\]]*)\]\s*\{([^{}]*)\}/g, '√[$1]($2)')
    .replace(/\\sqrt\s*\{([^{}]*)\}/g, '√($1)')
    .replace(/\\times|\\cdot/g, '*')
    .replace(/\\div/g, '/')
    .replace(/\\(left|right|displaystyle|limits)\b ?/g, '')
    .replace(/\\[,;!\s]/g, '')
    .replace(/\\(?:mathrm|mathbf|mathit|mathbb|mathcal|boldsymbol|text|operatorname)\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\([A-Za-z]+)/g, '$1')
    .replace(/[{}]/g, '');
}

/** 去掉 "A." / "A、" 之类的选项前缀，以及首部题号 */
export function removeRedundant(str) {
  const s = linearizeLatex((str ?? '').trim());
  return (
    s
      .replace(/^[A-Z]{1}[^A-Za-z0-9\u2E80-\u9FFF]+([A-Za-z0-9\u2E80-\u9FFF]+)/, '$1')
      .replace(/^[A-Z]{1}([\u2E80-\u9FFF][A-Za-z0-9\u2E80-\u9FFF]*)/, '$1')
      .replace(/^(\d{1,3})[.、)．]\s*/, '')
      || ''
  );
}

/** 只保留有效字符，全角转半角，转小写 */
export function clearString(str) {
  return String(str ?? '')
    .trim()
    .toLocaleLowerCase()
    .replace(/[\uFF21-\uFF3A\uFF41-\uFF5A\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 65248))
    .replace(/\uFF05/g, '%')
    .replace(/[^\u2E80-\u9FFF\uF900-\uFAFFA-Za-z0-9]/g, '');
}

/** 归一化（投票与匹配统一用这个） */
export function norm(str) {
  return clearString(removeRedundant(str));
}

/** Dice 双字母组系数，和 OCS 的 compareTwoStrings 同算法 */
export function dice(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const bigrams = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    bigrams.set(g, (bigrams.get(g) || 0) + 1);
  }
  let hit = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const c = bigrams.get(g) || 0;
    if (c > 0) {
      bigrams.set(g, c - 1);
      hit++;
    }
  }
  return (2 * hit) / (a.length + b.length - 2);
}

export function sha1(str) {
  return crypto.createHash('sha1').update(String(str), 'utf8').digest('hex');
}

const CORRECT = ['是', '对', '正确', '确定', '√', '对的', '是的', '正确的', 'true', 't', 'yes', '1', '√', '✓'];
const INCORRECT = ['非', '否', '错', '错误', '×', 'x', '错的', '不对', '不正确', '不是', 'false', 'f', 'no', '0', '✗'];

function wordHit(text, words) {
  const t = clearString(text);
  return words.some((w) => clearString(w) === t);
}

/** 判断题选项 → true/false；不是判断题返回 null */
export function judgementOf(options) {
  if (!Array.isArray(options) || options.length !== 2) return null;
  const hasC = options.some((o) => wordHit(o, CORRECT));
  const hasI = options.some((o) => wordHit(o, INCORRECT));
  return hasC && hasI ? { trueIndex: options.findIndex((o) => wordHit(o, CORRECT)) } : null;
}

/** 把任意表述的判断题答案归一成 'true' / 'false' */
export function normJudgement(value) {
  if (wordHit(value, CORRECT)) return 'true';
  if (wordHit(value, INCORRECT)) return 'false';
  return norm(value);
}
