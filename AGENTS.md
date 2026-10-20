# Repository Guidelines

## 项目结构与模块组织

当前产品保留两部分：`extension/` 是 Chrome MV3 扩展，负责在 X/Twitter 页面捕获推文 GraphQL JSON、在 scys.com 捕获 `topicDetail` JSON、保留复制 JSON 按钮，并通过 usememos API 将捕获数据保存为私有 memo；`plana-memos-sync/` 是本地 CLI，负责从 Memos API 拉取带 `#plana/tweet` 或 `#plana/scys` 标签的 memo 并写入 Obsidian vault。

`extension/background.js` 负责跨域 API 请求代理与 badge/统计更新；`extension/content.js` 注入页面脚本并桥接消息；`extension/page.js` 负责 XHR 捕获、推文缓存、按钮注入、复制和保存到 Memos；`extension/options/` 负责 Memos API 地址与 Access Token 配置；`extension/popup/` 显示配置状态和保存计数。`plana-memos-sync/src/sync.js` 负责分页拉取、幂等状态、Markdown/JSON 写入和可选 archive ack。

## 构建、测试与开发命令

扩展没有打包步骤，修改后在 `chrome://extensions` 重新加载 `extension/`，再刷新 X/Twitter 页面。

```bash
node --check extension/background.js
node --check extension/options/options.js
node --check extension/popup/popup.js
node --check extension/content.js
node --check extension/page.js
cd plana-memos-sync && npm run check && npm test
```

## 代码风格与命名约定

JavaScript 统一使用 2 空格缩进、单引号和分号。变量与函数使用 `camelCase`，常量使用 `UPPER_SNAKE_CASE`。复杂抓取逻辑可加简短中文注释；API 相关代码保持明确的认证边界和错误提示。

## 测试指南

提交前至少手动验证 X/Twitter 首页、详情页、个人主页和搜索页的按钮注入与 JSON 复制；修改保存逻辑时，还要验证 Memos Access Token 缺失、Token 无效、请求超时、保存成功、Popup 统计、Options 保存和 API 域名权限申请。修改 `plana-memos-sync/` 时，至少验证 `npm run check` 和 `npm test`。

## 提交与 Pull Request 规范

提交信息遵循 Lore Commit Protocol 或现有 Conventional Commit 风格，主题行聚焦单一变更。PR 需说明影响范围、验证步骤、剩余风险；涉及按钮、Popup 或设置页界面变更时附截图。

## 安全与配置提示

不要提交真实 Memos Access Token 或无必要的扩展权限。扩展通过 `chrome.storage.local` 保存 Access Token，并以 Bearer Token 发送给配置的 Memos API。新增外部域名、权限或消息通道时，应同步更新 README。
