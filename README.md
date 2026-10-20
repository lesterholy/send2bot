# PlanA JSON to Memos

PlanA 是一个 Chrome MV3 扩展和本地同步工具，用来把 X/Twitter 与生财有术页面中捕获到的原始 JSON 保存到 usememos，再由本地 CLI 同步进 Obsidian。

核心原则很简单：插件只负责捕获、复制和原样保存 JSON，不在浏览器端改写数据。

## 功能

- X/Twitter：从页面 GraphQL 响应中捕获推文 JSON，在推文卡片上显示 `JSON` 和 `↑` 按钮。
- 生财有术 `scys.com`：从 `topicDetail` 接口响应中捕获原始 JSON，在文章时间后面显示同款 `JSON` 和 `↑` 按钮。
- `JSON`：复制捕获到的原始 JSON。
- `↑`：把原始 JSON 保存为 usememos 私有 memo。
- 本地 CLI：从 Memos 拉取 `#plana/tweet` 和 `#plana/scys` memo，写入 Obsidian vault。

## 项目结构

```text
extension/             Chrome MV3 扩展
  manifest.json        权限、注入页面和 service worker 配置
  content.js           注入 page.js，并桥接 chrome API
  page.js              捕获 JSON、注入按钮、构造 Memos 内容
  background.js        转发跨域 Memos 请求，更新统计
  options/             Memos API 和 Access Token 设置页
  popup/               扩展弹窗

plana-memos-sync/      本地 Obsidian 同步 CLI
```

## 安装扩展

1. 打开 `chrome://extensions`。
2. 开启 Developer mode。
3. 点击 Load unpacked。
4. 选择本仓库的 `extension/` 目录。
5. 打开扩展设置页，填写：
   - `Memos API 地址`：例如 `https://memos.example.com/api/v1`
   - `Memos Access Token`：Memos 账号中创建的 Personal Access Token
6. 保存设置。若浏览器弹出域名权限申请，允许对应的 Memos 域名。

Dia、Chrome、Edge 这类 Chromium 浏览器都按“加载未打包扩展”的方式使用。

## 使用

### X/Twitter

打开 X/Twitter 的首页、详情页、个人主页或搜索页。页面加载到对应 GraphQL 数据后，推文卡片上会出现：

- `JSON`：复制当前推文的原始 JSON。
- `↑`：保存到 Memos，memo 标签为 `#plana/tweet`。

如果提示未捕获到数据，先打开推文详情或刷新页面，让页面重新请求对应接口。

### 生财有术

打开 `https://scys.com` 的文章详情页。页面请求 `topicDetail` 后，PlanA 会把 `JSON` / `↑` 按钮插入到发布时间后面：

- `JSON`：复制 `topicDetail` 原始响应。
- `↑`：保存到 Memos，memo 标签为 `#plana/scys`。

插件不会保存你的生财登录 token，也不会把 curl 里的请求头硬编码进项目；它只读取当前页面已经返回的接口 JSON。

## Memos 保存格式

扩展请求：

```http
POST <Memos API 地址>/memos
Authorization: Bearer <Memos Access Token>
Content-Type: application/json
```

请求体：

```json
{
  "state": "NORMAL",
  "visibility": "PRIVATE",
  "content": "#plana/tweet\n\n[Open source](https://x.com/...)\n\n```json\n{...}\n```"
}
```

内容里的 JSON 会包含：

- `data_source`
- `id`
- `tweet_id` 或 `scys_entity_id`
- `source_url`
- `captured_at`
- `client_version`
- `raw_json`

## 同步到 Obsidian

本地 CLI 需要 Node.js 22 或更新版本。

```bash
cd plana-memos-sync
npm install
npm test
```

运行同步：

```bash
node bin/plana-memos-sync.js \
  --api-url https://memos.example.com/api/v1 \
  --token memos_pat_xxx \
  --vault /path/to/ObsidianVault
```

也可以用环境变量：

```bash
export MEMOS_API_URL=https://memos.example.com/api/v1
export MEMOS_ACCESS_TOKEN=memos_pat_xxx
export OBSIDIAN_VAULT=/path/to/ObsidianVault

node bin/plana-memos-sync.js
```

默认写入结构：

```text
ObsidianVault/
  PlanA/
    2026-06-18/
      tweet-1234567890.md
    raw/
      2026-06-18/
        tweet-1234567890.json
  .plana-memos-sync/
    state.json
```

常用参数：

```text
--tag <tag>              默认 #plana/tweet,#plana/scys
--output-dir <dir>       默认 PlanA
--archive-after-sync     写入本地成功后归档 Memos memo
--dry-run                只预览，不写入
--force                  即使 updateTime 未变化也重新写入
--verbose                输出写入文件路径
```

## 开发检查

扩展没有构建步骤，修改后在浏览器扩展页 Reload，再刷新目标页面。

```bash
node --check extension/background.js
node --check extension/content.js
node --check extension/page.js
node --check extension/options/options.js
node --check extension/popup/popup.js

cd plana-memos-sync
npm run check
npm test
```

手动回归建议覆盖：

- X/Twitter 首页、详情页、个人主页、搜索页
- SCYS 文章详情页
- JSON 复制
- 保存到 Memos 成功和失败提示
- Options 保存 API 地址和 Token
- Popup 显示配置状态和统计

## 常见问题

### 提示未配置 Token

打开扩展设置页，填写并保存 `Memos Access Token`。保存后刷新 X/SCYS 页面。

### 保存失败或 Unauthorized

重新生成 Memos Personal Access Token，覆盖保存。若之前的 token 已失效，扩展会清除本地 token。

### 修改扩展后页面报 `Extension context invalidated`

这是 Chromium 扩展重载后的旧页面上下文失效。刷新当前 X/SCYS 页面即可。

### SCYS 按钮不出现

确认当前页面已经加载文章详情，并触发了 `topicDetail` 请求。必要时刷新页面或重新进入文章详情。

## 安全说明

- 不要提交真实 Memos token。
- token 存在 `chrome.storage.local`。
- 扩展会把捕获到的原始 JSON 发送到你配置的 Memos 实例。
- SCYS 登录态只由当前浏览器页面自己使用，项目不保存站点 cookie 或 `x-token`。
