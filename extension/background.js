// 题库网关面板 · Service Worker
const DEFAULT_PORTS = [8321, 8322, 8323, 8324, 8325];

// 点工具栏图标即打开侧边栏
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// 探测本地网关端口（网关被占用会自动 +1）
async function findPort() {
  for (const port of DEFAULT_PORTS) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/stats`, { signal: AbortSignal.timeout(800) });
      if (r.ok) return port;
    } catch {}
  }
  return null;
}

// 浏览器启动时：可选自动开一个网关标签页（默认关，用户可在面板里开启）
chrome.runtime.onStartup?.addListener(async () => {
  const { autoTab } = await chrome.storage.local.get({ autoTab: false });
  if (!autoTab) return;
  const port = await findPort();
  if (port) chrome.tabs.create({ url: `http://127.0.0.1:${port}/` });
});

// 供面板调用：探测端口
chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (msg?.type === 'findPort') {
    findPort().then((port) => send({ port }));
    return true;
  }
});
