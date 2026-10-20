// ============= 配置管理 =============
const DEFAULT_CONFIG = {
  apiUrl: 'https://memos.example.com/api/v1',
};

function requestRuntimeState(requestType, responseType) {
  return new Promise((resolve) => {
    const handler = (event) => {
      if (event.source !== window) return;
      if (event.data.type !== responseType) return;
      window.removeEventListener('message', handler);
      resolve(event.data);
    };
    window.addEventListener('message', handler);
    window.postMessage({ type: requestType }, '*');

    setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve(null);
    }, 2000);
  });
}

async function getConfig() {
  const payload = await requestRuntimeState('PLANA_GET_CONFIG', 'PLANA_CONFIG_RESPONSE');
  return {
    ...DEFAULT_CONFIG,
    ...(payload?.config || {}),
    version: payload?.version || 'unknown',
  };
}

function getToken() {
  // 在扩展环境中，token 存储在 chrome.storage
  // page.js 无法直接访问 chrome API，需要通过 content.js 中转
  log('[getToken] 请求 token...');
  return requestRuntimeState('PLANA_GET_TOKEN', 'PLANA_TOKEN_RESPONSE').then((payload) => {
    const token = payload?.token || null;
    log('[getToken] 收到 token:', token ? `${token.substring(0, 20)}...` : 'null');
    return token;
  });
}

// 全局缓存：tweetId -> tweet 对象
const tweetCache = new Map();
let latestScysTopic = null;
let scysFloatingUi = null;

// 简易日志
const log = (...args) => console.log('[planA]', ...args);
const warn = (...args) => console.warn('[planA]', ...args);
const error = (...args) => console.error('[planA]', ...args);

// 归一化 Tweet 结构（Tweet/TweetWithVisibilityResults）
function normalizeTweet(result) {
  if (!result) return null;
  if (result.__typename === 'Tweet') return result;
  if (result.__typename === 'TweetWithVisibilityResults') return result.tweet ?? null;
  return null;
}

function isTwitterPage() {
  return /(^|\.)x\.com$|(^|\.)twitter\.com$/.test(location.hostname);
}

function isScysPage() {
  return /(^|\.)scys\.com$/.test(location.hostname);
}

// 递归/广度遍历提取 tweet_results
function collectTweetsFromJson(json) {
  const queue = [json];
  let visited = 0;
  const maxVisit = 8000; // 简单保护，避免意外巨型对象

  while (queue.length && visited < maxVisit) {
    const node = queue.shift();
    visited++;

    if (!node || typeof node !== 'object') continue;

    // 命中 tweet_results 结构
    if (node.tweet_results && typeof node.tweet_results === 'object') {
      const normalized = normalizeTweet(node.tweet_results.result);
      if (normalized?.rest_id) {
        tweetCache.set(normalized.rest_id, normalized);
      }
    }

    // 一些接口直接有 tweet 字段
    if (node.tweet && typeof node.tweet === 'object') {
      const normalized = normalizeTweet(node.tweet);
      if (normalized?.rest_id) {
        tweetCache.set(normalized.rest_id, normalized);
      }
    }

    // 遍历子节点
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (value && typeof value === 'object') {
        // 数组或对象都入队
        if (Array.isArray(value)) {
          for (const item of value) queue.push(item);
        } else {
          queue.push(value);
        }
      }
    }
  }
}

function collectScysTopicDetail(json, requestBodyText) {
  latestScysTopic = {
    id: extractScysEntityId(requestBodyText, json),
    sourceUrl: location.href,
    capturedAt: new Date().toISOString(),
    rawJson: json,
    requestBody: parseJsonOrNull(requestBodyText),
  };
  refreshScysFloatingUi();
}

// Hook XHR：拦截帖子相关接口
(function hookXHR() {
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.addEventListener('load', function () {
      if (this.status !== 200) return;
      if (!url) return;

      const urlText = String(url);
      const isTweetApi =
        isTwitterPage() &&
        /graphql\/.+(TweetDetail|ModeratedTimeline|UserTweets|HomeTimeline|HomeLatestTimeline|Bookmarks|Likes|Retweeters|SearchTimeline)/.test(
          urlText,
        );
      const isScysTopicApi =
        isScysPage() && urlText.includes('/shengcai-web/client/homePage/topicDetail');
      if (!isTweetApi && !isScysTopicApi) return;

      try {
        const json = JSON.parse(this.responseText);
        if (isTweetApi) {
          collectTweetsFromJson(json);
        }
        if (isScysTopicApi) {
          collectScysTopicDetail(json, this.__planARequestBody || null);
        }
      } catch (err) {
        warn('解析响应失败', err);
      }
    });

    return originalOpen.apply(this, arguments);
  };

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) {
    if (typeof body === 'string') {
      this.__planARequestBody = body;
    }
    return originalSend.apply(this, arguments);
  };

  log('XHR hook installed');
})();

// 提示气泡
function showToast(text, type = 'info') {
  const toast = document.createElement('div');
  toast.textContent = text;
  toast.style.position = 'fixed';
  toast.style.top = '16px';
  toast.style.right = '16px';
  toast.style.zIndex = 999999;
  toast.style.padding = '8px 12px';
  toast.style.borderRadius = '8px';
  toast.style.fontSize = '14px';
  toast.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
  toast.style.transition = 'opacity 0.3s ease';

  // 根据类型设置颜色
  const colors = {
    info: { bg: 'rgba(0,0,0,0.85)', color: '#fff' },
    success: { bg: 'rgba(76,175,80,0.9)', color: '#fff' },
    error: { bg: 'rgba(244,67,54,0.9)', color: '#fff' },
    warning: { bg: 'rgba(255,152,0,0.9)', color: '#fff' },
  };
  const style = colors[type] || colors.info;
  toast.style.background = style.bg;
  toast.style.color = style.color;

  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

// ============= 保存到 Memos =============
async function sendToMemos(entry) {
  log('[sendToMemos] 开始保存:', entry.id);

  const config = await getConfig();
  log('[sendToMemos] 配置:', config);

  const token = await getToken();

  if (!token) {
    log('[sendToMemos] token 为空，显示配置提示');
    showToast('请先在扩展设置页填写 Memos Access Token', 'warning');
    return { success: false, error: 'No token', code: 'NO_TOKEN' };
  }

  log('[sendToMemos] Token 存在，通过 content.js 发送请求');
  const apiUrl = normalizeMemosApiUrl(config.apiUrl);
  const memoBody = buildMemosMemoBody(entry, config.version);

  // 通过 content.js 发送请求（绕过页面 CSP 限制）
  return new Promise((resolve) => {
    const requestId = `req_${Date.now()}_${Math.random()}`;

    // 监听响应
    const handler = (event) => {
      if (event.source !== window) return;
      if (event.data.type === 'PLANA_API_RESPONSE' && event.data.requestId === requestId) {
        window.removeEventListener('message', handler);
        log('[sendToMemos] 收到响应:', event.data.result);
        resolve(event.data.result);
      }
    };
    window.addEventListener('message', handler);

    // 发送请求给 content.js
    window.postMessage({
      type: 'PLANA_API_REQUEST',
      requestId,
      payload: {
        url: `${apiUrl}/memos`,
        method: 'POST',
        token,
        body: memoBody,
      },
    }, '*');

    // 超时处理
    setTimeout(() => {
      window.removeEventListener('message', handler);
      error('[sendToMemos] 请求超时');
      resolve({ success: false, error: 'Request timeout' });
    }, 10000); // 10秒超时
  });
}

function normalizeMemosApiUrl(apiUrl) {
  const rawUrl = (apiUrl || DEFAULT_CONFIG.apiUrl).trim().replace(/\/+$/, '');
  try {
    const url = new URL(rawUrl);
    if (url.pathname === '' || url.pathname === '/') {
      url.pathname = '/api/v1';
      return url.toString().replace(/\/+$/, '');
    }
  } catch (err) {
    return rawUrl;
  }
  return rawUrl;
}

function buildTwitterSourceUrl(tweetId, data) {
  const screenName = data?.core?.user_results?.result?.core?.screen_name;
  if (!screenName) return `https://x.com/i/status/${tweetId}`;
  return `https://x.com/${screenName}/status/${tweetId}`;
}

function createTwitterEntry(tweetId, data) {
  const id = data?.rest_id || String(tweetId);
  const sourceUrl = buildTwitterSourceUrl(id, data);
  return {
    kind: 'tweet',
    tag: '#plana/tweet',
    title: `PlanA Tweet ${id}`,
    id,
    sourceUrl,
    rawJson: data,
    meta: {
      tweet_id: id,
      source_url: sourceUrl,
    },
  };
}

function createScysEntry(topic) {
  const id = topic.id || extractScysEntityId(null, topic.rawJson) || `scys-${Date.now()}`;
  return {
    kind: 'scys_topic',
    tag: '#plana/scys',
    title: `PlanA SCYS Topic ${id}`,
    id,
    sourceUrl: topic.sourceUrl || location.href,
    rawJson: topic.rawJson,
    meta: {
      scys_entity_id: id,
      source_url: topic.sourceUrl || location.href,
      request_body: topic.requestBody || null,
    },
  };
}

function buildMemosMemoBody(entry, extensionVersion) {
  const capturedAt = new Date().toISOString();
  const rawPayload = {
    data_source: entry.kind,
    id: entry.id,
    ...entry.meta,
    raw_json: entry.rawJson,
    source_url: entry.sourceUrl,
    captured_at: capturedAt,
    client_version: `extension/${extensionVersion}`,
  };
  const jsonText = JSON.stringify(rawPayload, null, 2);
  const fence = buildMarkdownFence(jsonText);

  return {
    state: 'NORMAL',
    visibility: 'PRIVATE',
    content: [
      entry.tag,
      '',
      `[Open source](${entry.sourceUrl})`,
      '',
      `- Source: ${entry.kind}`,
      `- ID: ${entry.id}`,
      `- Captured at: ${capturedAt}`,
      `- Client: extension/${extensionVersion}`,
      '',
      `${fence}json`,
      jsonText,
      fence,
    ].join('\n'),
  };
}

function buildMarkdownFence(text) {
  const matches = text.match(/`+/g) || [];
  const longestRun = matches.reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(3, longestRun + 1));
}

function parseJsonOrNull(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractScysEntityId(requestBodyText, json) {
  const requestBody = parseJsonOrNull(requestBodyText);
  if (requestBody?.entityId) return String(requestBody.entityId);
  const queue = [json];
  let visited = 0;
  while (queue.length && visited < 2000) {
    const node = queue.shift();
    visited++;
    if (!node || typeof node !== 'object') continue;
    const candidate = node.entityId || node.topicId || node.id;
    if (candidate && typeof candidate !== 'object') return String(candidate);
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') {
        if (Array.isArray(value)) {
          queue.push(...value);
        } else {
          queue.push(value);
        }
      }
    }
  }
  return null;
}

// 从帖子卡片 DOM 提取 tweetId
function extractTweetIdFromArticle(article) {
  if (!article) return null;
  // 链接中通常包含 /status/{id}
  const anchor = article.querySelector('a[href*="/status/"]');
  const match = anchor?.getAttribute('href')?.match(/status\/(\d+)/);
  if (match) return match[1];
  // data-tweet-id 兜底（若存在）
  return article.getAttribute('data-tweet-id') || null;
}

// 按钮基础样式
function createButtonBase(text, color) {
  const btn = document.createElement('button');
  btn.textContent = text;
  btn.style.padding = '2px 6px';
  btn.style.marginLeft = '6px';
  btn.style.fontSize = '11px';
  btn.style.fontWeight = '700';
  btn.style.border = `1px solid ${color}`;
  btn.style.borderRadius = '8px';
  btn.style.background = color;
  btn.style.color = '#fff';
  btn.style.cursor = 'pointer';
  btn.style.boxShadow = '0 2px 6px rgba(0,0,0,0.25)';
  btn.style.opacity = '0.9';
  btn.style.verticalAlign = 'middle';
  btn.style.transition = 'transform 0.15s ease, opacity 0.15s ease';

  btn.addEventListener('mouseenter', () => {
    btn.style.transform = 'scale(1.05)';
    btn.style.opacity = '1';
  });
  btn.addEventListener('mouseleave', () => {
    btn.style.transform = 'scale(1)';
    btn.style.opacity = '0.9';
  });

  return btn;
}

// 创建复制按钮
function createCopyButton(tweetId) {
  const btn = createButtonBase('JSON', '#ff9800');
  btn.title = '复制帖子 JSON';

  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (!tweetId) {
      warn('未能识别 tweetId');
      showToast('未找到帖子 ID', 'error');
      return;
    }

    const data = tweetCache.get(tweetId);
    if (!data) {
      warn('缓存中无数据，可能尚未加载 TweetDetail', tweetId);
      showToast('未捕获到帖子数据，请点开详情后重试', 'warning');
      return;
    }

    try {
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      showToast('✓ 已复制 JSON', 'success');
    } catch (err) {
      error('复制失败', err);
      showToast('复制失败', 'error');
    }
  });

  return btn;
}

// 创建发送按钮
function createSendButton(tweetId) {
  const btn = createButtonBase('↑', '#4CAF50');
  btn.title = '保存到 Memos';

  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (!tweetId) {
      warn('未能识别 tweetId');
      showToast('未找到帖子 ID', 'error');
      return;
    }

    const data = tweetCache.get(tweetId);
    if (!data) {
      warn('缓存中无数据', tweetId);
      showToast('未捕获到帖子数据，请点开详情后重试', 'warning');
      return;
    }

    // 发送中提示
    btn.textContent = '...';
    btn.disabled = true;
    btn.style.opacity = '0.5';

    let result;
    try {
      result = await sendToMemos(createTwitterEntry(tweetId, data));
    } catch (err) {
      error('保存到 Memos 异常', err);
      result = { success: false, error: err.message || '未知错误' };
    } finally {
      // 恢复按钮状态
      btn.textContent = '↑';
      btn.disabled = false;
      btn.style.opacity = '0.9';
    }

    if (result.success) {
      showToast('✓ 已保存到 Memos', 'success');
      // 短暂显示成功状态
      btn.style.background = '#2196F3';
      setTimeout(() => {
        btn.style.background = '#4CAF50';
      }, 1000);

      // 通知 extension (如果在扩展环境中)
      try {
        window.postMessage({
          type: 'PLANA_TWEET_SAVED',
          data: { tweetId, timestamp: Date.now(), operation: 'created' }
        }, '*');
      } catch (e) {
        // 忽略错误，可能不在扩展环境
      }
    } else {
      if (result.code === 'NO_TOKEN') return;
      // 显示具体错误信息
      let errorMsg = '保存失败';
      if (result.error === 'Unauthorized') {
        errorMsg = 'Token 无效或已过期，请重新配置';
      } else if (result.error === 'Request timeout') {
        errorMsg = '请求超时，请重试';
      } else if (/Extension context invalidated/i.test(result.error || '')) {
        errorMsg = '扩展已重载，请刷新页面后重试';
      } else if (result.error) {
        errorMsg = `保存到 Memos 失败: ${result.error}`;
      }
      showToast(`✗ ${errorMsg}`, 'error');
    }
  });

  return btn;
}

// 创建按钮容器
function createButtonGroup(tweetId) {
  const container = document.createElement('span');
  container.style.display = 'inline-flex';
  container.style.alignItems = 'center';
  container.style.gap = '4px';

  const copyBtn = createCopyButton(tweetId);
  const sendBtn = createSendButton(tweetId);

  container.appendChild(copyBtn);
  container.appendChild(sendBtn);

  return container;
}

function refreshScysFloatingUi() {
  if (!isScysPage()) return;
  const dateElement = findScysDateElement();
  if (!dateElement) return;

  if (!scysFloatingUi || !scysFloatingUi.root.isConnected) {
    scysFloatingUi = createScysInlineUi();
  }
  const dateRow = ensureScysDateRow(dateElement);
  if (dateRow && scysFloatingUi.root.parentElement !== dateRow) {
    dateRow.appendChild(scysFloatingUi.root);
  }

  const hasData = Boolean(latestScysTopic?.rawJson);
  const statusText = hasData ? `已捕获 ${latestScysTopic.id || 'topicDetail'}` : '等待 topicDetail';
  scysFloatingUi.root.title = statusText;
  scysFloatingUi.copyButton.disabled = !hasData;
  scysFloatingUi.saveButton.disabled = !hasData;
  setScysButtonEnabled(scysFloatingUi.copyButton, hasData);
  setScysButtonEnabled(scysFloatingUi.saveButton, hasData);
  scysFloatingUi.root.style.opacity = hasData ? '1' : '0.76';
}

function findScysDateElement() {
  return document.querySelector('.post-item-top-right .date, .post-item-top .date');
}

function ensureScysDateRow(dateElement) {
  if (!dateElement) return null;
  const existingRow = dateElement.closest('[data-plana-scys-date-row="true"]');
  if (existingRow) return existingRow;

  const row = document.createElement('span');
  row.dataset.planaScysDateRow = 'true';
  row.style.display = 'flex';
  row.style.flexWrap = 'wrap';
  row.style.alignItems = 'center';
  row.style.columnGap = '8px';
  row.style.rowGap = '4px';
  row.style.marginTop = getComputedStyle(dateElement).marginTop || '';

  dateElement.style.marginTop = '0';
  dateElement.insertAdjacentElement('beforebegin', row);
  row.appendChild(dateElement);
  return row;
}

function createScysInlineUi() {
  const root = document.createElement('span');
  root.dataset.planaScysActions = 'true';
  root.style.zIndex = 999999;
  root.style.display = 'inline-flex';
  root.style.alignItems = 'center';
  root.style.gap = '4px';
  root.style.verticalAlign = 'middle';

  const copyButton = createScysToolButton('JSON', '复制 SCYS JSON');
  copyButton.addEventListener('click', async () => {
    if (!latestScysTopic?.rawJson) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(latestScysTopic.rawJson, null, 2));
      showToast('✓ 已复制 SCYS JSON', 'success');
    } catch (err) {
      error('复制 SCYS JSON 失败', err);
      showToast('复制失败', 'error');
    }
  });

  const saveButton = createScysToolButton('↑', '保存到 Memos');
  saveButton.addEventListener('click', async () => {
    if (!latestScysTopic?.rawJson) return;
    saveButton.textContent = '...';
    saveButton.disabled = true;
    let result;
    try {
      result = await sendToMemos(createScysEntry(latestScysTopic));
    } catch (err) {
      error('保存 SCYS 到 Memos 异常', err);
      result = { success: false, error: err.message || '未知错误' };
    } finally {
      saveButton.textContent = '↑';
      saveButton.disabled = false;
      setScysButtonEnabled(saveButton, Boolean(latestScysTopic?.rawJson));
    }
    if (result.success) {
      showToast('✓ 已保存 SCYS 到 Memos', 'success');
      window.postMessage({
        type: 'PLANA_TWEET_SAVED',
        data: { source: 'scys', id: latestScysTopic.id, timestamp: Date.now(), operation: 'created' }
      }, '*');
    } else if (result.code === 'NO_TOKEN') {
      return;
    } else if (/Extension context invalidated/i.test(result.error || '')) {
      showToast('✗ 扩展已重载，请刷新页面后重试', 'error');
    } else {
      showToast(`✗ 保存到 Memos 失败: ${result.error || '未知错误'}`, 'error');
    }
  });

  root.appendChild(copyButton);
  root.appendChild(saveButton);

  return { root, copyButton, saveButton };
}

function createScysToolButton(text, title) {
  const color = text === 'JSON' ? '#ff9800' : '#4CAF50';
  const button = createButtonBase(text, color);
  button.title = title;
  button.style.marginLeft = '0';
  button.style.minWidth = text === 'JSON' ? '42px' : '28px';
  button.style.textAlign = 'center';
  return button;
}

function setScysButtonEnabled(button, enabled) {
  button.style.opacity = enabled ? '1' : '0.42';
  button.style.cursor = enabled ? 'pointer' : 'not-allowed';
  button.style.filter = enabled ? 'none' : 'grayscale(0.45)';
}

// 监听并注入按钮
function observeTimeline() {
  const seen = new WeakSet();

  const inject = (article) => {
    if (!article || seen.has(article)) return;

    // 跳过广告推文
    if (article.querySelector('[data-testid="placementTracking"]')) {
      seen.add(article);
      return;
    }

    const tweetId = extractTweetIdFromArticle(article);
    const btnGroup = createButtonGroup(tweetId);

    // 判断是否在详情页
    const isDetailPage = /\/status\/\d+/.test(location.pathname);

    if (isDetailPage) {
      // 详情页：放在发布时间行的最末尾
      const timeElement = article.querySelector('a time');
      if (timeElement) {
        // 找到包含时间的最外层容器（通常包含"时间·日期·浏览量"）
        // 向上查找，直到找到包含多个子元素的flex容器
        let timeRow = timeElement.closest('a');
        // 继续向上找到包含时间和浏览量的完整行
        while (timeRow && timeRow.parentElement && timeRow.parentElement !== article) {
          const parent = timeRow.parentElement;
          // 检查是否是包含时间和其他信息的行容器
          const siblings = parent.children;
          if (siblings.length > 1) {
            // 找到了包含多个元素的容器
            btnGroup.style.marginLeft = '8px';
            parent.appendChild(btnGroup);
            seen.add(article);
            return;
          }
          timeRow = parent;
        }
      }
    }

    // 列表页：放在时间戳右边
    const timeAnchor = article.querySelector('a time')?.parentElement;
    if (timeAnchor?.parentElement) {
      timeAnchor.insertAdjacentElement('afterend', btnGroup);
      seen.add(article);
      return;
    }

    // 最终兜底：放在卡片内相对靠上的位置
    article.style.position = article.style.position || 'relative';
    btnGroup.style.position = 'absolute';
    btnGroup.style.top = '10px';
    btnGroup.style.right = '10px';
    btnGroup.style.zIndex = 9999;
    article.appendChild(btnGroup);

    seen.add(article);
  };

  // 初次扫描
  const scan = () => {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    articles.forEach(inject);
  };

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((node) => {
        if (node.nodeType !== 1) return;
        const el = node;
        if (el.matches?.('article[data-testid="tweet"]')) {
          inject(el);
        } else {
          const nested = el.querySelectorAll?.('article[data-testid="tweet"]');
          nested?.forEach(inject);
        }
      });
    }
  });

  observer.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true,
  });

  // 首次
  document.addEventListener('DOMContentLoaded', scan);
  // 兜底定时扫描（应对懒加载）
  setInterval(scan, 3000);

  // 监听 URL 变化（Twitter SPA 路由切换）
  let lastUrl = location.href;
  const urlObserver = new MutationObserver(() => {
    const currentUrl = location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      log('URL changed, re-scanning...', currentUrl);
      // URL 变化后延迟扫描，等待 DOM 渲染
      setTimeout(scan, 500);
      setTimeout(scan, 1500);
    }
  });
  urlObserver.observe(document.querySelector('title'), { childList: true, subtree: true });

  log('Timeline observer started');
}

function observeScysPage() {
  refreshScysFloatingUi();
  document.addEventListener('DOMContentLoaded', refreshScysFloatingUi);
  setTimeout(refreshScysFloatingUi, 1000);

  const observer = new MutationObserver(() => {
    refreshScysFloatingUi();
  });
  observer.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true,
  });
}

// 启动
if (isTwitterPage()) {
  observeTimeline();
}
if (isScysPage()) {
  observeScysPage();
}
getConfig().then((config) => {
  log('PlanA initialized. Config:', config);
});
