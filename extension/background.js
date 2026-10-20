// Background Service Worker
// 处理消息传递和 badge 更新

const DEFAULT_CONFIG = {
  apiUrl: 'https://memos.example.com/api/v1',
};

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

// 监听来自 content script 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 处理推文保存事件
  if (message.type === 'TWEET_SAVED') {
    updateDailyCount();
    updateTotalCount();
    return;
  }

  // 处理 API 请求（从 content.js 转发）
  if (message.type === 'PLANA_API_REQUEST') {
    console.log('[PlanA Background] 收到 API 请求:', message.requestId);
    const { payload } = message;
    const { url, method, token, body } = payload;

    // 使用 async 处理
    handleApiRequest(url, method, token, body).then((result) => {
      console.log('[PlanA Background] API 请求完成:', result);
      sendResponse(result);
    }).catch((error) => {
      console.error('[PlanA Background] API 请求失败:', error);
      sendResponse({ success: false, error: error.message });
    });

    // 返回 true 表示异步响应
    return true;
  }
});

// 处理 API 请求
async function handleApiRequest(url, method, token, body) {
  try {
    console.log('[PlanA Background] 发送请求到:', url);
    const response = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body)
    });

    console.log('[PlanA Background] 响应状态:', response.status);
    const result = await parseResponseBody(response);

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        await storageRemove('access_token');
        return { success: false, error: 'Unauthorized' };
      }
      return {
        success: false,
        error: extractErrorMessage(result, response.status),
        status: response.status,
      };
    }

    if (result?.success === false) {
      return {
        success: false,
        error: extractErrorMessage(result, response.status),
        status: response.status,
        error_code: result.error_code,
      };
    }

    console.log('[PlanA Background] 请求成功');
    return {
      success: true,
      data: result?.data ?? result,
      message: result?.message || 'OK',
      error_code: result?.error_code || 'success',
      status: response.status,
      meta: result,
    };
  } catch (err) {
    console.error('[PlanA Background] 请求异常:', err);
    return { success: false, error: err.message };
  }
}

async function parseResponseBody(response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json().catch(() => null);
  }

  const text = await response.text().catch(() => '');
  if (!text) return null;
  return { detail: text };
}

function extractErrorMessage(result, status) {
  return result?.message || result?.detail || result?.error || `HTTP ${status}`;
}

// 更新 badge
async function updateBadge(count) {
  if (count > 0) {
    chrome.action.setBadgeText({ text: count.toString() });
    chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

// 更新今日保存计数
async function updateDailyCount() {
  const today = new Date().toDateString();
  const result = await storageGet(['dailyCount', 'lastDate']);

  let dailyCount = 1;
  if (result.lastDate === today) {
    dailyCount = (result.dailyCount || 0) + 1;
  }

  await storageSet({
    dailyCount,
    lastDate: today
  });

  await updateBadge(dailyCount);
}

// 更新总计保存计数
async function updateTotalCount() {
  const result = await storageGet(['totalCount']);
  const totalCount = (result.totalCount || 0) + 1;

  await storageSet({
    totalCount
  });
}

// 初始化
chrome.runtime.onInstalled.addListener(() => {
  console.log('PlanA Extension installed');
  storageGet(['config']).then(({ config }) => {
    storageSet({
      config: {
        ...DEFAULT_CONFIG,
        ...(config || {}),
      },
    });
  });
});
