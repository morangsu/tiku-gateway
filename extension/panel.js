// 题库网关面板 · 侧边栏逻辑
const $ = (id) => document.getElementById(id);
let base = null;

async function findPort() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'findPort' }, (r) => resolve(r?.port || null));
    } catch {
      resolve(null);
    }
  });
}

async function stats() {
  if (!base) return null;
  try {
    const r = await fetch(base + '/api/stats', { signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function boot() {
  const port = await findPort();
  const dot = $('dot');
  const st = $('status');

  if (!port) {
    dot.className = 'dot off';
    st.className = 'err';
    st.textContent = '网关离线（未探测到 8321–8325）';
    $('tabs').style.display = 'none';
    $('frame').style.display = 'none';
    $('gate').style.display = 'block';
    return;
  }

  base = `http://127.0.0.1:${port}`;
  const s = await stats();
  dot.className = 'dot on';
  st.className = '';
  if (s) {
    const rem = s.zerror?.known ? `${s.zerror.remaining} 次` : '未校准';
    st.textContent = `${base} · 题库 ${s.questions} 题 · 本轮 ${s.round?.total || 0} · ZError ${rem}`;
  } else {
    st.textContent = `${base} 已连接`;
  }

  $('gate').style.display = 'none';
  $('tabs').style.display = 'flex';
  $('frame').style.display = 'block';
  navigate('/');
}

function navigate(path) {
  if (!base) return;
  $('frame').src = base + path;
  document.querySelectorAll('#tabs button').forEach((b) => {
    b.className = b.dataset.p === path ? 'on' : '';
  });
}

$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) navigate(b.dataset.p);
});

$('reload').addEventListener('click', boot);
$('full').addEventListener('click', () => {
  if (base) chrome.tabs.create({ url: base + '/' });
});

// 启动时自动开标签 开关
chrome.storage.local.get({ autoTab: false }, ({ autoTab }) => { $('autotab').checked = autoTab; });
$('autotab').addEventListener('change', (e) => {
  chrome.storage.local.set({ autoTab: e.target.checked });
});

boot();
