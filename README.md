# GLM-Free-API-node

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-4169e1.svg)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-176%20passing-brightgreen.svg)](#测试)

> 把 [chat.z.ai](https://chat.z.ai) 的网页聊天能力封装成 **OpenAI / Anthropic 兼容 API**。
> 本项目是上游 Go 项目 [izaart95-jpg/GLM-Free-API](https://github.com/izaart95-jpg/GLM-Free-API) 的 **Node.js 移植版**，行为与上游保持一致。

---

## 目录

- [特性](#特性)
- [快速开始](#快速开始)
- [API 文档](#api-文档)
- [配置](#配置)
- [高级功能](#高级功能)
- [项目结构](#项目结构)
- [测试](#测试)
- [与 Go 原版的差异](#与-go-原版的差异)
- [安全须知](#安全须知)
- [License](#license)

---

## 特性

| | 能力 |
|---|---|
| **双协议** | OpenAI `/v1/chat/completions` + Anthropic `/v1/messages`，流式（SSE）与非流式 |
| **纯 HTTP** | 运行期不依赖浏览器，Node 原生 `fetch` / HTTP2 / keep-alive |
| **Agent 模式** | 把 OpenAI 的 `tools` / `role` 翻译成 Z.AI 兼容的提示词，并把 `<<<TOOL_CALL>>>` 还原成原生 `tool_calls` / `tool_use` |
| **视觉能力** | 两个端点均支持图片（URL / base64），自动上传到 Z.AI 文件接口后引用 |
| **联网搜索** | `webSearch` / `advancedSearch` 开关，对应上游的 `auto_web_search` 与 `advanced-search` MCP |
| **一次性会话** | 每个请求独立 chat，响应结束即在 Z.AI 侧删除，服务端不留历史 |
| **异步会话池** | 默认预热 5 个会话备用；`--sync-mode` 可切回旧的每请求新建流程 |
| **WAF 熔断** | 检测到阿里云 WAF 拦截后快速失败（503），后台探测器指数退避自愈 |
| **上游限速** | 进程级共享 pacing gate，避免突发流量触发 WAF |
| **模型热更新** | 实时拉取 Z.AI `/api/models`（缓存 5 分钟），带兜底列表 |
| **Token 热切换** | `POST /sqlite` 不重启即可切换 token 库 |
| **优雅退出** | 10 秒排空在途请求，随后清除所有仍驻留的 Z.AI 会话 |
| **零运行时依赖** | 主服务只用 Node 内置模块（`node:sqlite`、`node:http`、`node:crypto` …） |

---

## 快速开始

### 环境要求

- **Node.js ≥ 22**（依赖内置 `node:sqlite` 模块；开发测试于 v24.15.0）
- 仅 `cmd/token-collector` 需要额外依赖：Playwright + Chromium

### 1. 安装

```sh
git clone https://github.com/htmambo/GLM-Free-API-node.git
cd GLM-Free-API-node
npm install          # 主服务本身零依赖，这一步只是生成锁文件
```

### 2. 配置验证码凭证

每次对话请求都要用阿里云验证码 AccessKey 签名，因此这两个值是**必填**。仓库里不存放任何密钥字面量，需要自己填：

```sh
cp .env.example .env
# 编辑 .env，填入 ALIYUN_CAPTCHA_ACCESS_KEY_ID 与 ALIYUN_CAPTCHA_ACCESS_KEY_SECRET
```

> 这两个值是 chat.z.ai 前端公开的站点常量，可从站点 JS 包中提取，或参考上游 Go 项目。缺失时服务会在启动阶段直接报错退出，而不是等到第一次请求才失败。

### 3. 采集设备 Token

服务端需要一份设备 token 才能工作，先运行采集器：

```sh
cd cmd/token-collector
npm install
npx playwright install chromium
node index.js --tokens 850      # 最多 1500 个
```

采集器会在**当前工作目录**生成 `tokens.sqlite`。

> ⚠️ 浏览器必须以 **headful（有界面）** 模式运行 —— 无头设备会话会被阿里云风控拒绝，产出的 token 无法通过校验。
> 无图形界面的服务器请使用 Xvfb：`xvfb-run -a node index.js`。

### 4. 启动服务

```sh
cd ../..                     # 回到仓库根目录
npm start                    # 已内置 .env 加载与库路径（见 package.json）
```

或手动指定路径与参数：

```sh
node --env-file=.env main.js --db-path cmd/token-collector/tokens.sqlite
npm start -- --db-path /path/to/other.sqlite   # 覆盖内置的库路径
```

看到启动横幅即表示成功：

```
╔═══════════════════════════════════════════════════════════════╗
║           Z.AI Direct Bridge Server Started                   ║
╠═══════════════════════════════════════════════════════════════╣
║  Health:        http://localhost:3001/health                 ║
║  OpenAI API:    http://localhost:3001/v1/chat/completions     ║
║  Anthropic API: http://localhost:3001/v1/messages             ║
║  Auth Token:    Waguri                                        ║
╚═══════════════════════════════════════════════════════════════╝
```

### 5. 调用

**curl（OpenAI 协议）**

```sh
curl http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer Waguri" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-5.2",
    "stream": false,
    "messages": [{"role": "user", "content": "用一句话介绍你自己"}]
  }'
```

**curl（Anthropic 协议）**

```sh
curl http://localhost:3001/v1/messages \
  -H "x-api-key: Waguri" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-5.2",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

**OpenAI SDK**

```js
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:3001/v1',
  apiKey: 'Waguri',            // AUTH_TOKEN 的值
});

const stream = await client.chat.completions.create({
  model: 'glm-5',
  messages: [{ role: 'user', content: '写一个快速排序' }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
}
```

**Claude Code（Anthropic 协议）**

```sh
export ANTHROPIC_BASE_URL=http://localhost:3001
export ANTHROPIC_AUTH_TOKEN=Waguri
claude
```

---

## API 文档

### 端点一览

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|:--:|---|
| `GET` | `/health` | — | 健康检查，返回 `healthy` 与剩余 token 数量 |
| `GET` | `/status` | — | 会话状态、会话池水位、WAF 熔断状态 |
| `GET` | `/v1/models` | ✅ | OpenAI 风格模型列表（含 `architecture` 模态信息） |
| `GET` | `/models` | ✅ | 简易模型列表 `{ models, currentModel }` |
| `POST` | `/v1/chat/completions` | ✅ | **OpenAI 协议**对话补全 |
| `POST` | `/v1/messages` | ✅ | **Anthropic 协议**消息 |
| `GET` | `/features?model=<id>` | ✅ | 查询指定模型的特性开关与能力 |
| `POST` | `/features` | ✅ | 设置指定模型的特性开关 |
| `GET` | `/admin/stats` | — | 运行统计 |
| `GET` | `/admin/health` | — | 健康检查（同 `/health`） |
| `GET` | `/admin/clients` | — | 客户端连接列表 |
| `POST` | `/sqlite` | ✅ | 热切换 token 数据库，无需重启 |
| `GET` | `/inject.js` | — | 直连模式占位响应 |
| `POST` | `/stop` | ✅ | 占位响应 |
| `GET` | `/` | — | 302 跳转至 `/health` |

> 鉴权方式：`Authorization: Bearer <token>` 或 `x-api-key: <token>`（Anthropic 客户端用后者）。
> 默认 token 为 `Waguri`，**生产环境请务必通过 `AUTH_TOKEN` 修改**。

### 请求体扩展参数

除标准 OpenAI 字段外，`/v1/chat/completions` 与 `/v1/messages` 支持：

| 参数 | 类型 | 说明 |
|---|---|---|
| `reasoning` | `boolean` | 是否开启深度思考（映射到上游 `enable_thinking`） |
| `thinking` | `{ "type": "enabled" \| "disabled" }` | 同上，另一种写法 |
| `reasoning_effort` | `"high"` \| `"max"` | 仅当模型能力声明支持时才透传 |
| `webSearch` | `boolean` | 开启联网搜索（上游 `auto_web_search`） |
| `search` | `boolean` | `webSearch` 的别名 |
| `advancedSearch` | `boolean` | 高级搜索（挂载 `advanced-search` MCP），隐含开启 `webSearch` |
| `tools` | `array` | OpenAI 工具定义，Agent 模式下会被翻译成提示词 |
| `stream` | `boolean` | 默认 `true` |

### 热切换 token 库

```sh
curl -X POST http://localhost:3001/sqlite \
  -H "Authorization: Bearer Waguri" \
  -H "Content-Type: application/json" \
  -d '{"db_path": "/path/to/new/tokens.sqlite"}'
```

候选库会先在独立连接上校验，通过后再以指针交换方式热替换；切换期间到达的请求只会看到旧库或新库，不会报错。

---

## 配置

所有配置项均可用 **环境变量** 或 **命令行参数** 指定，命令行参数优先级更高。

### 环境变量

#### 验证码凭证（必填）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ALIYUN_CAPTCHA_ACCESS_KEY_ID` | 无 | 阿里云验证码 AccessKey ID。**必填**，缺失则服务启动即退出 |
| `ALIYUN_CAPTCHA_ACCESS_KEY_SECRET` | 无 | 阿里云验证码 AccessKey Secret。**必填** |
| `ALIYUN_CAPTCHA_SCENE_ID` | `didk33e0` | 验证码场景标识，通常无需修改 |

#### 服务

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3001` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `AUTH_TOKEN` | `Waguri` | API 鉴权 token（**生产环境必须修改**） |
| `TIMEOUT` | `300000` | 上游请求超时（毫秒） |

#### 上游

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ZAI_BASE_URL` | `https://chat.z.ai` | 上游站点地址。境内部署可设为 `https://zchat.z.ai` |
| `ZAI_REGION` | 按站点推导 | `x-region` 请求头取值。`chat.z.ai` 推导为 `overseas`，其余（如 `zchat.z.ai`）为 `domestic` |
| `ZAI_TOKEN` | 空 | **强烈建议配置**：登录用户的 token。游客会话随时可能因上游策略变动而返回 401，配置后可用性与配额都更稳定 |
| `ZAI_TOKEN_FILE` | 空 | token 文件路径。设置后其内容优先于 `ZAI_TOKEN`，并在启动与 401 重试时重新读取（配合 `cmd/zai-token-refresher` 实现自动续期） |
| `ZAI_MODEL` | 空 | 固定使用的模型 id。留空时按上游 `/api/models` 实时目录解析 |
| `ZAI_CLIENT_VERSION` | `0.0.1` | 上游 `version` 查询参数。取线上 web 客户端实际发送的值；上游会拒绝过低的版本 |
| `UPSTREAM_MIN_INTERVAL_MS` | 随机 `200–500` | 上游请求最小间隔（毫秒）。`0` 关闭限速 |
| `TOKEN_COUNT_TTL_MS` | `1000` | `/health` 中 token 计数的缓存时长 |

#### Agent 模式

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AGENT_MODE` | `false` | `1/true/yes/on/modern` 开启；`legacy` 同时开启并切到旧版 shim；`0/false/no/off` 关闭 |
| `AGENT_MODE_VARIANT` | `modern` | `modern`（XML 分段提示词）或 `legacy`（`[ROLE: ...]` 改写） |
| `AGENT_MODE_LEVEL` | 空 | 仅 `ultra` 启用 ToolParserLLM 修复层（需同时开启 agent 模式） |
| `FORCE_CPU` / `TOOLPARSER_LLM_FORCE_CPU` | `false` | 允许在纯 CPU 主机上运行 ultra 修复层（性能降级） |

#### 会话

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SESSION_POOL_SIZE` | `5` | 异步模式下预热的会话数量 |
| `SESSION_ACQUIRE_TIMEOUT` | `10` | 等待会话池可用的超时（秒）。`0` 表示无限等待 |
| `SESSION_REUSE_COUNT` | `10` | 单个会话服务多少个请求后被删除并轮换 |
| `SYNC_MODE` | `false` | 切回旧的同步会话流程（每请求自建会话） |

#### 网络与日志

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CURL_IMPERSONATE` | 空 | 指向 `curl-impersonate` 可执行文件（如 `curl_chrome120`）以使用 Chrome TLS 指纹 |
| `NODE_USE_ENV_PROXY` | — | 设为 `1` 让内置 `fetch` 识别 `HTTP_PROXY` / `HTTPS_PROXY` |
| `LOG_LEVEL` | `debug` | 日志级别 |
| `LOG_FORMAT` | `text` | 日志格式 |

### 命令行参数

```
node main.js [flags]

  --db-path string          SQLite 数据库路径（默认 "tokens.sqlite"）
  --verbose                 输出详细日志
  --agent-mode              开启 Agent 模式（默认使用 modern shim）
  --agent-mode-variant      modern（默认，XML 分段提示词）或 legacy（[ROLE: ...] 改写）
  --agent-mode-level        空（默认，仅用内置解析器）或 ultra（启用 ToolParserLLM 修复）
  --force-cpu               允许在纯 CPU 主机上运行 ultra 修复层
  --sync-mode               旧的同步会话流程
  --session-reuse-count int 单会话服务多少个请求后轮换（默认 10）
```

---

## 高级功能

### Agent 模式

Z.AI 的网页端只接受 `user` 角色的消息，无法直接处理 OpenAI 的多角色与工具调用。开启 Agent 模式后：

1. **入站** —— 把 `system` / `assistant` / `tool` 等角色与 `tools` 定义，重写成模型可读的提示词；
2. **出站** —— 解析模型输出的 `<<<TOOL_CALL>>>` 块，还原成标准的 `tool_calls` / `tool_use` 增量。

两套 shim 可选：

- **modern（默认）** —— XML 分段式提示词，标记清晰、有近因锚点，避免长工具历史全量重放导致的「上下文腐烂」。
- **legacy** —— 早期的 `[ROLE: ...]` 扁平改写方案，保留以兼容旧行为。

```sh
node main.js --agent-mode --agent-mode-variant modern
```

### 联网搜索

```jsonc
{
  "model": "glm-5.2",
  "webSearch": true,        // → 上游 auto_web_search
  "advancedSearch": false   // → 挂载 advanced-search MCP
}
```

> Agent 模式下两个开关会被强制关闭 —— 工具调用与搜索同时开启会显著降低成功率。

### 模型解析与降级

上游对**未知 model id** 的回答是裸 `500 Internal Server Error`，和"请求体字段不对"的报错完全一样，无法区分。而模型目录是会变的：部署站点当前提供 `glm-5.4` / `x-preview-l` / `glm-5.3` / `glm-5.2`，而旧客户端习惯的 `glm-5` 并不在其中。

因此桥接器在发送前先按**上游实时目录**（`GET /api/models`）解析 model id：

| 情况 | 行为 |
|---|---|
| 客户端指定的模型在目录中 | 原样使用（大小写不敏感） |
| 客户端未指定模型 | 使用 `x-preview-l`（Flash）—— 旗舰模型对付费档生效，免费账号会收到 `Model not available for current user level` |
| 客户端指定的模型已下线 | 回落到目录中最易获得的模型，日志记录替换 |
| 需要固定模型 | 设置 `ZAI_MODEL` |

此外，上游的三种服务端状态会触发**自动换模型重试一次**（日志中会记录替换过程）：

- `MODEL_CONCURRENCY_LIMIT` —— 模型满载，稍后重试即可
- `403 Model not available for current user level` —— 模型对付费档生效
- `INTERNAL_ERROR` —— 上游自身的临时故障（实测线上原样请求同样会命中）

当这些状态无法通过降级解决时，桥接器返回 **503**（可重试）而不是 500 —— 这些故障不在客户端，请求本身没有问题，值得稍后重试。

### 视觉能力

`/v1/chat/completions` 与 `/v1/messages` 均可携带图片（需选用支持视觉的模型，如 `glm-5.4`；实际可用模型以 `GET /v1/models` 为准）：

```jsonc
{
  "model": "glm-5.4",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "这张图里有什么？" },
      { "type": "image_url", "image_url": { "url": "https://example.com/a.png" } }
    ]
  }]
}
```

图片会先上传到 Z.AI 的文件接口，再以 `files` 数组引用。限制：**每请求最多 10 张**，**单张最大 50 MB**。

### WAF 熔断与限速

持续的 Agent 流量会触发 chat.z.ai 前置的阿里云 WAF —— 被封的是**出口 IP**，且会持续一段时间。桥接器对此做了两层保护：

- **共享 pacing gate** —— 所有上游调用（含验证码、DELETE、池补充）统一限速，突发流量永远不会形成；
- **熔断器** —— 检测到拦截页后立即快速失败（503 + `Retry-After`），不再消耗宝贵的设备 token；后台探测器按指数退避重试，一旦封禁解除自动恢复。

可通过 `GET /status` 的 `waf` 字段观察当前状态。

### Ultra 修复层（实验性）

上游部分模型偶尔会输出**结构损坏**的工具调用。`--agent-mode-level=ultra` 会启用一个基于 Qwen2.5-0.5B-Instruct + LoRA 的修复层：先整段缓冲模型输出，只把损坏的片段送进修复模型，重新校验后拼接回原响应。

该层**默认完全休眠**，且需要额外准备 Python / SGLang / GPU 环境，未在真实 GPU 环境下完整验证，生产请谨慎使用。

---

## 常见问题

### 配了 `.env` 却仍然报错

**`.env` 不会覆盖 shell 里已导出的同名变量。** Node 的 `--env-file` 只补充环境中不存在的键；如果你之前 `export ZAI_TOKEN=...` 过，shell 里的旧值会一直赢。症状是：明明换了新 token，接口还是 401。

```sh
unset ZAI_TOKEN          # 关键：先清掉 shell 里的旧值
npm start
```

排查：

```sh
node --env-file=.env -e "console.log(process.env.ZAI_TOKEN?.length)"   # 确认读到的是 .env 里的值
```

### `ZAI_TOKEN` 过期了怎么办

Z.AI 的会话 token 是**约 60 分钟**有效期的 JWT。过期后所有聊天请求都会返回 401。桥接器启动时会解析 token 并在过期（或即将过期）时打印告警：

```
[Startup] WARNING: ZAI_TOKEN expired at 2026-11-27T07:59:19.000Z (32 min ago) — every chat request will fail with 401.
```

刷新方式：登录站点 → devtools → Application → Local Storage → 复制 `token` → 更新 `.env` → 重启进程。

> **无法用纯 bearer token 自动续期。** 上游已转向 `cookie_v2` / `token_v2` 会话模型：
> `POST /api/v1/auths/refresh` 对 JWT 返回 `LEGACY_TOKEN_INVALID`，对纯 cookie 返回 `SESSION_MISSING`；
> `token_v2` 的令牌则需要通过 `POST /api/v1/auths/signin`（邮箱+密码+验证码）签发。

#### 自动续期（可选）

站点前端在登录 cookie 有效时会自己刷新 `localStorage.token`。`cmd/zai-token-refresher`
用持久化 Chromium profile 保留登录态，定期读出该值并原子写入文件；桥接器在启动时和
401 之后重新读取：

```sh
cd cmd/zai-token-refresher
npm install
npx playwright install chromium
node index.js                 # 首次：在弹出的窗口里手动登录

# .env
ZAI_TOKEN_FILE=runtime/zai-token
```

- `ZAI_TOKEN_FILE` 优先于 `ZAI_TOKEN`；文件缺失、为空、过期或损坏时**不会**覆盖仍有效的值。
- 401 时只有文件内容确实变化才会重建会话并重试一次，不会凭同一个失效 token 空转。
- 登录态本身有效期是数天到数周，到期后仍需在窗口中重登一次——无法做到完全无人值守。
- 无桌面的服务器：`xvfb-run -a node index.js`（浏览器必须 headful，否则会被站点的风控拒绝）。

### 返回 503 怎么办

503 表示**上游暂时不可用**，请求本身没有问题，通常稍后重试即可。桥接器会自动换用目录中的其他模型重试一次，日志里会记录替换过程：

```
[Model] glm-5.4 is unavailable upstream (Z.AI error: Model is currently at capacity... ) — retrying with x-preview-l
```

常见的两种情况：

- `MODEL_CONCURRENCY_LIMIT` —— 免费额度下并发会话数超限。桥接器一次只发一个请求，但仍可能撞上网页端同时在用的会话；等几分钟再试。
- `INTERNAL_ERROR` —— 上游自身的临时故障。实测**线上原样请求**同样会命中，与本桥接器的请求体无关。

如果持续出现，检查并发会话是否堆积在上游（`GET /api/v1/chats` 能看到状态为 `running` 的会话）。

---

## 项目结构

```
GLM-Free-API-node/
├── main.js                     # 入口（对应 Go 版 main.go）
├── .env.example                # 配置文件模板（复制为 .env 后填写）
├── .gitignore                  # 排除 node_modules、token 库、.env 等
├── src/                        # 桥接核心（对应 internal/zbridge/）
│   ├── server.js               #   HTTP 路由表、CLI 解析、优雅退出
│   ├── handlers.js             #   除 /v1/messages 外的全部路由
│   ├── anthropic.js            #   Anthropic /v1/messages 协议
│   ├── zai.js                  #   Z.AI 上游协议与 SSE 解析
│   ├── config.js               #   配置加载与常量
│   ├── state.js                #   全局状态
│   ├── middleware.js           #   JSON 输出、鉴权、CORS
│   ├── models.js               #   模型列表与能力查询
│   ├── features.js             #   按模型解析特性开关
│   ├── agent.js                #   Agent 模式（modern shim）
│   ├── agentLegacy.js          #   Agent 模式（legacy shim）
│   ├── agentUltra.js           #   Ultra 修复层的缓冲与校验
│   ├── toolparserLLM.js        #   ToolParserLLM / SGLang 客户端
│   ├── captcha.js              #   阿里云验证码与 token 缓存
│   ├── db.js                   #   可热切换的 token 数据库
│   ├── sessionPool.js          #   一次性会话与异步会话池
│   ├── vision.js               #   图片上传与引用
│   ├── waf.js                  #   WAF 检测与熔断器
│   ├── ratelimit.js            #   上游 pacing gate
│   ├── httpClient.js           #   HTTP 客户端与 cookie jar
│   ├── tokenFile.js            #   ZAI_TOKEN_FILE 热加载（配合自动续期）
│   ├── util.js                 #   通用工具与签名算法
│   ├── format.js               #   OpenAI 响应 / 错误封装
│   └── logger.js               #   日志
├── cmd/token-collector/        # 独立的设备 token 采集器
│   ├── index.js                #   CLI 入口
│   ├── harvest.js              #   浏览器采集 + token 铸造
│   ├── feilin.js               #   Fielin 纯计算（AES-128-CBC + MD5 封装）
│   └── README.md
├── scripts/
│   └── push-via-api.sh         #   git 传输不稳时经 REST API 推送
├── tests/                      # node:test 测试套件
└── docs/Task/                  # 任务索引与归档
```

---

## 测试

```sh
npm test
```

使用 Node 内置的 `node:test` 运行器，覆盖配置解析、鉴权、CORS、SSE 流式输出、工具调用增量、推理内容拆分、请求 ID、Agent shim、Ultra 门控、会话池与复用、token 库热切换、WAF 熔断、限速、视觉上传、联网搜索与 Fielin 黄金向量等。

其中 `tests/requestShape.test.js` 把**上游请求契约**钉死：签名算法、浏览器指纹查询参数、v2 消息标识字段、容器字段与验证码场景推导 —— 这些一旦漂移，上游只会回一句没有线索的 `500 Internal Server Error`。`tests/modelResolution.test.js` 与 `tests/upstreamErrors.test.js` 覆盖模型解析，以及上游错误的降级与状态码映射。

当前状态：**207 个测试全部通过**（Node v24.15.0）。

> 测试默认关闭上游限速（`UPSTREAM_MIN_INTERVAL_MS=0`）以保证速度，测试本身不访问真实上游。

---

## 与 Go 原版的差异

本移植版在保持上游行为一致的前提下，有以下**已知差异**：

1. **TLS 指纹** —— Go 版使用 uTLS 模拟 Chrome ClientHello。Node 没有内置指纹伪装能力，默认使用原生 `fetch`（BoringSSL，HTTP/2，keep-alive，本身就不是 Go 指纹）；如需更接近，可用 `CURL_IMPERSONATE` 指向 `curl-impersonate` 可执行文件。
2. **代理支持** —— Node 24 中 `undici` 不可作为模块导入，无法使用 `ProxyAgent`；改为通过 `NODE_USE_ENV_PROXY=1` 让内置 `fetch` 识别环境变量代理。
3. **SQLite 驱动** —— Go 版用纯 Go 的 `modernc.org/sqlite`（无 CGO），本移植版用 Node 内置 `node:sqlite`（需 Node ≥ 22）。
4. **TUI** —— Go 版采集器带 Bubble Tea 交互界面，本移植版为纯 CLI 日志（`--no-tui` 被接受但无实际作用）。
5. **Ultra 层** —— 已等价移植资产下载、校验、SGLang 启动与客户端，但**未在真实 GPU 环境验证**。
6. **上游 10 MB 单行上限** —— Go 版 `bufio.Scanner` 的行长保护未在 JS 侧重建（病态上游会直接缓冲）。
7. **验证码凭证来源** —— 上游 Go 版把阿里云 AccessKey 硬编码在 `config.go` 里；本移植版改为从环境变量读取，仓库中不含任何密钥字面量（GitHub Push Protection 会拦截阿里云 AccessKey 模式）。行为等价，但使用者需自行提供这两个值。
8. **上游 API 漂移** —— Z.AI 近期的接口演进（会话模式 `token_v2` / `cookie_v2`、客户端版本参数、`x-fe-Version` 随前端构建滚动、v2 请求体新增 `current_user_message_id`）已超出上游 Go 版（`3b23a69`）的适配范围。本移植版已按部署中的 prod 构建（`prod-fe-1.2.x`）逐项对齐：

   - 启动时抓取当前 `x-fe-Version`（此前配置了 `ZAI_TOKEN` 时永远抓不到）；
   - URL 的 `version` 参数与线上客户端一致（`0.0.1`），可用 `ZAI_CLIENT_VERSION` 覆盖；
   - URL 的 `user_agent` 与 `User-Agent` 请求头保持一致；
   - 补齐线上客户端发送的 30 项浏览器指纹参数；
   - 请求体补齐 v2 要求的 `current_user_message_id` / `current_user_message_parent_id`，以及 `params` / `variables` / `extra` / `session_id`；
   - 请求头补齐 `Accept-Language`。

   签名算法与盐值经与线上客户端逐字节比对确认一致（`HMAC-SHA256(salt, 5min-bucket)` → `HMAC-SHA256(key, sortedPayload|base64(prompt)|timestamp)`），无需改动。请求契约由 `tests/requestShape.test.js` 固定，防止再次漂移。

   > ⚠️ **未解决**：对齐后上游仍可能返回 `500 Internal Server Error`。该错误没有字段名也没有提示，剩余差异集中在验证码参数的有效性上——桥接器用自己的阿里云 AccessKey 现场签发 `captcha_verify_param`，而线上客户端走的是浏览器 SDK；若上游按当前场景校验该参数，需要同步更新采集器所用的场景与 AccessKey。

---

## 安全须知

- **默认 `AUTH_TOKEN=Waguri` 是占位值**，公网部署前务必通过环境变量替换为强随机值。
- `tokens.sqlite` 内含**设备 token**，属于敏感凭据；`.gitignore` 已将其排除，**请勿提交到版本库**。
- **仓库中不存放任何密钥字面量**。阿里云验证码 AccessKey 改为从环境变量读取（`ALIYUN_CAPTCHA_ACCESS_KEY_ID` / `ALIYUN_CAPTCHA_ACCESS_KEY_SECRET`），本地放在 git-ignored 的 `.env` 中；上游 Go 版则是硬编码在源码里的。
- 本项目通过非官方渠道访问 Z.AI，请自行确保使用方式符合 [Z.AI 服务条款](https://z.ai/terms)，并控制使用频率。
- 持续高频调用会触发阿里云 WAF 封禁出口 IP，请保留默认的限速与熔断配置。

---

## License

[MIT](LICENSE)

本项目是 [izaart95-jpg/GLM-Free-API](https://github.com/izaart95-jpg/GLM-Free-API)（MIT）的 Node.js 移植版，在此致谢并遵循原始许可证。

## 致谢

- [izaart95-jpg/GLM-Free-API](https://github.com/izaart95-jpg/GLM-Free-API) —— Go 原版
- [DeepseekFreeAPI](https://github.com/ThinkInAIXYZ/deepseek-free-api) —— 会话池与一次性会话设计参考
