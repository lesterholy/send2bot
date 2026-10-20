// Popup Panel Logic

document.addEventListener('DOMContentLoaded', async () => {
  await loadPopup();
});

function chromeCall(fn, ...args) {
  return new Promise((resolve, reject) => {
    try {
      const maybePromise = fn(...args, (result) => {
        const lastError = chrome.runtime?.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }
        resolve(result);
      });
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(resolve, reject);
      }
    } catch (error) {
      reject(error);
    }
  });
}

const storageGet = (keys) => chromeCall(chrome.storage.local.get.bind(chrome.storage.local), keys);
const storageRemove = (keys) => chromeCall(chrome.storage.local.remove.bind(chrome.storage.local), keys);

async function loadPopup() {
  const content = document.getElementById('content');

  // 获取配置
  const { config } = await storageGet(['config']);
  const apiUrl = config?.apiUrl || 'https://memos.example.com/api/v1';

  // 检查 token 状态
  const token = await getToken();
  const hasToken = !!token;

  // 获取统计数据
  const { dailyCount, totalCount } = await getStats();

  // 渲染界面
  content.innerHTML = renderUI(hasToken, dailyCount || 0, totalCount || 0, apiUrl);

  // 绑定按钮事件
  bindEvents(hasToken, apiUrl);
}

function renderUI(hasToken, dailyCount, totalCount, apiUrl) {
  return `
    <div class="status ${hasToken ? '' : 'logged-out'}">
      <div class="status-icon">${hasToken ? '✅' : '❌'}</div>
      <div class="status-text">
        <div class="title">${hasToken ? '已配置 Token' : '未配置 Token'}</div>
        <div class="subtitle">${hasToken ? `Memos API：${apiUrl}` : '请先在设置页填写 Memos API 地址和 Access Token'}</div>
      </div>
    </div>

    ${hasToken ? `
      <div class="stats">
        <div class="stat-card">
          <div class="number">${dailyCount}</div>
          <div class="label">今日保存</div>
        </div>
        <div class="stat-card">
          <div class="number">${totalCount}</div>
          <div class="label">总计</div>
        </div>
      </div>
    ` : ''}

    <div class="actions">
      ${hasToken ? `
        <button class="btn btn-primary" id="btnDocs">
          📘 打开 Memos
        </button>
        <button class="btn btn-danger" id="btnLogout">
          🧹 清除 Token
        </button>
      ` : `
        <button class="btn btn-success" id="btnOpenSettings">
          🔑 去配置
        </button>
      `}
    </div>
  `;
}

function bindEvents(hasToken, apiUrl) {
  if (hasToken) {
    document.getElementById('btnDocs')?.addEventListener('click', () => {
      chrome.tabs.create({ url: getDocsUrl(apiUrl) });
    });

    document.getElementById('btnLogout')?.addEventListener('click', async () => {
      await clearToken();
      await loadPopup();
    });
  } else {
    document.getElementById('btnOpenSettings')?.addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
    });
  }
}

// 获取 token（从 chrome.storage 读取）
async function getToken() {
  try {
    const result = await storageGet(['access_token']);
    return result.access_token || null;
  } catch (error) {
    console.error('Failed to get token:', error);
    return null;
  }
}

// 清除 token
async function clearToken() {
  try {
    await storageRemove('access_token');
    console.log('Token cleared from chrome.storage');
  } catch (error) {
    console.error('Failed to clear token:', error);
  }
}

// 获取统计数据
async function getStats() {
  const { dailyCount, totalCount } = await storageGet(['dailyCount', 'totalCount']);
  return {
    dailyCount: dailyCount || 0,
    totalCount: totalCount || 0
  };
}

function getDocsUrl(apiUrl) {
  try {
    const url = new URL(apiUrl);
    return url.origin;
  } catch (error) {
    return apiUrl;
  }
}
