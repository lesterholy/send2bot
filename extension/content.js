// Content Script - 将 page.js 注入到页面上下文
// 这样才能访问页面 XHR 和 DOM

(function() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('page.js');
  script.onload = function() {
    this.remove();
  };
  (document.head || document.documentElement).appendChild(script);

  console.log('[PlanA Extension] Page script injected');
})();

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

// 监听来自 page.js 的消息（用于统计等功能）
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!event.data?.type || !String(event.data.type).startsWith('PLANA_')) return;
  handlePageMessage(event).catch((error) => {
    if (isExtensionContextInvalidated(error)) {
      console.warn('[PlanA Content] 扩展上下文已失效，请刷新页面后继续使用');
    } else {
      console.error('[PlanA Content] 处理页面消息失败:', error);
    }

    if (event.data?.type === 'PLANA_GET_TOKEN') {
      postToPageSafely({ type: 'PLANA_TOKEN_RESPONSE', token: null });
    }

    if (event.data?.type === 'PLANA_GET_CONFIG') {
      postToPageSafely({ type: 'PLANA_CONFIG_RESPONSE', config: null, version: 'unknown' });
    }

    if (event.data?.type === 'PLANA_API_REQUEST') {
      postToPageSafely({
        type: 'PLANA_API_RESPONSE',
        requestId: event.data.requestId,
        result: {
          success: false,
          error: isExtensionContextInvalidated(error)
            ? 'Extension context invalidated. 请刷新页面后重试'
            : error.message,
        },
      });
    }
  });
});

async function handlePageMessage(event) {
  // 处理 token 请求
  if (event.data.type === 'PLANA_GET_TOKEN') {
    console.log('[PlanA Content] 收到 token 请求');
    const result = await storageGet(['access_token']);
    const token = result.access_token || null;
    console.log('[PlanA Content] 返回 token:', token ? `${token.substring(0, 20)}...` : 'null');
    postToPageSafely({
      type: 'PLANA_TOKEN_RESPONSE',
      token: token
    }, '*');
    return;
  }

  // 处理配置请求
  if (event.data.type === 'PLANA_GET_CONFIG') {
    console.log('[PlanA Content] 收到配置请求');
    const { config } = await storageGet(['config']);
    postToPageSafely({
      type: 'PLANA_CONFIG_RESPONSE',
      config: config || null,
      version: chrome.runtime.getManifest().version,
    }, '*');
    return;
  }

  // 处理 API 请求（转发到 background service worker）
  if (event.data.type === 'PLANA_API_REQUEST') {
    console.log('[PlanA Content] 收到 API 请求，转发到 background worker:', event.data.requestId);
    const { requestId, payload } = event.data;

    // 转发请求到 background service worker
    sendRuntimeMessage({
      type: 'PLANA_API_REQUEST',
      requestId,
      payload
    }).then((response) => {
      console.log('[PlanA Content] 从 background 收到响应:', response);
      // 将响应转发回 page.js
      postToPageSafely({
        type: 'PLANA_API_RESPONSE',
        requestId,
        result: response
      });
    }).catch((error) => {
      console.warn('[PlanA Content] 转发 API 请求失败:', error);
      postToPageSafely({
        type: 'PLANA_API_RESPONSE',
        requestId,
        result: {
          success: false,
          error: isExtensionContextInvalidated(error)
            ? 'Extension context invalidated. 请刷新页面后重试'
            : error.message,
        },
      });
    });
    return;
  }

  if (event.data.type === 'PLANA_TWEET_SAVED') {
    // 通知 background script 更新 badge
    sendRuntimeMessage({
      type: 'TWEET_SAVED',
      data: event.data.data
    }).catch(() => {});
  }

  if (event.data.type === 'PLANA_STATS') {
    // 保存统计数据到 storage
    await storageSet({
      stats: event.data.data
    });
  }
}

function sendRuntimeMessage(message) {
  return chromeCall(chrome.runtime.sendMessage.bind(chrome.runtime), message);
}

function postToPageSafely(message) {
  try {
    window.postMessage(message, '*');
  } catch (error) {
    console.warn('[PlanA Content] 回传页面消息失败:', error);
  }
}

function isExtensionContextInvalidated(error) {
  return /Extension context invalidated/i.test(error?.message || '');
}
