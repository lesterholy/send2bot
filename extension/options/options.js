// Options Page Logic

const DEFAULT_CONFIG = {
  apiUrl: 'https://memos.example.com/api/v1',
};

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();

  // 保存设置
  document.getElementById('btnSave').addEventListener('click', saveSettings);

  // 恢复默认
  document.getElementById('btnReset').addEventListener('click', resetSettings);
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
const storageSet = (items) => chromeCall(chrome.storage.local.set.bind(chrome.storage.local), items);
const storageRemove = (keys) => chromeCall(chrome.storage.local.remove.bind(chrome.storage.local), keys);
const permissionContains = (permissions) => chromeCall(chrome.permissions.contains.bind(chrome.permissions), permissions);
const permissionRequest = (permissions) => chromeCall(chrome.permissions.request.bind(chrome.permissions), permissions);

// 加载设置
async function loadSettings() {
  const { config, access_token: accessToken } = await storageGet(['config', 'access_token']);
  const settings = { ...DEFAULT_CONFIG, ...config };

  document.getElementById('apiUrl').value = settings.apiUrl;
  document.getElementById('accessToken').value = accessToken || '';
}

// 保存设置
async function saveSettings() {
  const apiUrl = normalizeApiUrl(document.getElementById('apiUrl').value.trim() || DEFAULT_CONFIG.apiUrl);
  const accessToken = document.getElementById('accessToken').value.trim();

  const config = {
    apiUrl,
  };

  await storageSet({ config });
  if (accessToken) {
    await storageSet({ access_token: accessToken });
  } else {
    await storageRemove('access_token');
  }

  const saved = await storageGet(['config', 'access_token']);
  if (saved.config?.apiUrl !== apiUrl || (accessToken && saved.access_token !== accessToken)) {
    throw new Error('设置写入失败，请检查浏览器扩展存储权限');
  }

  try {
    await ensureApiPermission(apiUrl);
    showAlert('设置已保存！', 'success');
  } catch (error) {
    showAlert(`设置已保存；${error.message || '域名权限申请失败'}`, 'info');
  }
}

// 恢复默认
async function resetSettings() {
  if (!confirm('确定要恢复默认设置吗？')) return;

  await storageSet({ config: DEFAULT_CONFIG });
  await storageRemove('access_token');
  await loadSettings();

  showAlert('已恢复默认设置！', 'success');
}

// 显示提示
function showAlert(message, type = 'info') {
  const alert = document.getElementById('alert');
  alert.textContent = message;
  alert.className = `alert alert-${type} show`;

  setTimeout(() => {
    alert.classList.remove('show');
  }, 3000);
}

function normalizeApiUrl(apiUrl) {
  const rawUrl = (apiUrl || DEFAULT_CONFIG.apiUrl).trim().replace(/\/+$/, '');
  try {
    const url = new URL(rawUrl);
    if (url.pathname === '' || url.pathname === '/') {
      url.pathname = '/api/v1';
      return url.toString().replace(/\/+$/, '');
    }
  } catch (error) {
    return rawUrl;
  }
  return rawUrl;
}

async function ensureApiPermission(apiUrl) {
  let url;
  try {
    url = new URL(apiUrl);
  } catch (error) {
    throw new Error('API 地址格式不正确');
  }

  const originPattern = `${url.origin}/*`;
  if (!chrome.permissions?.contains || !chrome.permissions?.request) {
    throw new Error('当前浏览器不支持自动申请域名权限，请确认扩展拥有该站点权限');
  }

  const hasPermission = await permissionContains({
    origins: [originPattern],
  });
  if (hasPermission) return;

  const granted = await permissionRequest({
    origins: [originPattern],
  });
  if (!granted) {
    throw new Error('未授予该 API 域名权限，扩展将无法发送请求');
  }
}
