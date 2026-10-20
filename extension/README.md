# PlanA Chrome Extension

PlanA 是一个 Chrome MV3 扩展，用于在 X/Twitter 与生财有术页面复制原始 JSON，并把 JSON 原样保存为 usememos 私有 memo。

## 功能

- X/Twitter：捕获推文 GraphQL JSON，在推文卡片上注入 `JSON` 和 `↑` 按钮。
- 生财有术：捕获 `topicDetail` 响应，在文章发布时间后面注入同款 `JSON` 和 `↑` 按钮。
- `JSON`：复制原始 JSON。
- `↑`：保存到 Memos。

## 配置

1. 在 `chrome://extensions` 加载本目录。
2. 打开扩展设置页。
3. 填写：
   - `Memos API 地址`：例如 `https://memos.example.com/api/v1`
   - `Memos Access Token`：Memos Personal Access Token
4. 保存设置，并允许浏览器申请的 Memos 域名权限。

## 文件结构

```text
extension/
├── manifest.json         # MV3 配置与权限
├── content.js            # 注入 page.js，转发 storage/API 请求
├── page.js               # 捕获 JSON、注入按钮、构造 Memos 内容
├── background.js         # Service Worker：跨域请求、统计、badge
├── popup/                # 扩展弹窗
├── options/              # 扩展设置页
└── icons/                # 图标资源
```

## Memos 请求

保存按钮会发送：

```http
POST <Memos API 地址>/memos
Authorization: Bearer <Memos Access Token>
Content-Type: application/json
```

```json
{
  "state": "NORMAL",
  "visibility": "PRIVATE",
  "content": "#plana/tweet 或 #plana/scys\n\n[Open source](https://...)\n\n```json\n{...}\n```"
}
```

## 调试

- 未配置 Token：检查设置页是否保存了 Memos Access Token。
- Unauthorized：重新生成 Memos Personal Access Token 并覆盖保存。
- `Extension context invalidated`：扩展刚重载，刷新当前网页。
- 按钮不出现：刷新目标页面，确认页面已请求到对应 JSON 数据。

## 检查

```bash
node --check background.js
node --check content.js
node --check page.js
node --check options/options.js
node --check popup/popup.js
```
