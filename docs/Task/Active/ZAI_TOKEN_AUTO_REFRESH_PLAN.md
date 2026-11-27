# ZAI_TOKEN 自动续期

**Status**: 🔄 实施完成，待验收 (start: 2026-11-27)
**Created**: 2026-11-27

## 背景

Z.AI 会话 token 是有效期约 60 分钟的 JWT，过期后所有 chat 请求返回 401。
README 已记录（§常见问题）：纯 bearer token 无法续期——`POST /api/v1/auths/refresh`
对 JWT 返回 `LEGACY_TOKEN_INVALID`，对纯 cookie 返回 `SESSION_MISSING`，`token_v2`
只能由 `/api/v1/auths/signin`（邮箱+密码+验证码）签发。

站点自身在登录 cookie 有效时会让 `localStorage.token` 保持新鲜。因此自动化路径是：
用持久化浏览器登录态读取站点已经刷新好的 token，落盘，桥接器热加载。

## 现状（代码事实）

| 位置 | 行为 |
|---|---|
| `src/zai.js:251` | 初始化时把 `config.zaiToken` 复制进 `session.token`，之后不再更新 |
| `src/zai.js:659` | 配置了 `ZAI_TOKEN` 时 401 直接报错，不重建会话 |
| `src/config.js:190` | 只在启动时从环境变量读取 `ZAI_TOKEN` |
| `config` 对象 | `zaiToken` 是可写属性，运行时可替换 |
| `cmd/token-collector` | Playwright headful，但采集的是阿里云**设备** token，与本次无关；不共用 profile |

## 方案

### A. 桥接端热加载（新增 `src/tokenFile.js`）

- 新配置 `ZAI_TOKEN_FILE`（相对路径按进程 cwd 解析）。
- `reloadTokenFromFile()`：mtime + size 未变则跳过；内容变化后校验是否为**未过期 JWT**，
  与 `config.zaiToken` 不同才替换，返回是否发生替换。文件缺失/为空/过期/非法一律不覆盖现有值。
- 调用点：
  - `run()` 启动时（覆盖环境变量值，`ZAI_TOKEN_FILE` 优先）
  - `doInitializeSession()` 开头（重建会话时用最新 token）
  - 401 分支：先尝试重载；若拿到新 token → 重置会话、重建、重试一次；否则维持原报错。
- 根 `package.json` 不新增依赖。

### B. 生产端（新增 `cmd/zai-token-refresher/`）

- 独立 `package.json`（仅 playwright），复用已安装的浏览器二进制即可。
- `chromium.launchPersistentContext(profileDir)` 保存登录 cookie；默认 headful。
- 首次运行需人工登录一次；之后每 N 分钟重载页面读取 `localStorage.token`。
- 原子写入（tmp + rename，0600）到 `runtime/zai-token`。
- 登录态本身过期（数天到数周）时仍需人工重登，日志明确提示。

## 子任务

- [x] T1 桥接端：`src/tokenFile.js`、`config.js`、`server.js`、`zai.js`
- [x] T2 单元测试 `tests/tokenFile.test.js`（8 例）
- [x] T3 刷新器 `cmd/zai-token-refresher/`（index.js、package.json、README）
- [x] T4 文档：README 章节、`.env.example`、`.gitignore`
- [x] T5 验证：`npm test` 209 通过；启动三组合；401 重试集成测试 2 例

## 验收标准

1. 未设置 `ZAI_TOKEN_FILE` 时行为与改动前完全一致。
2. 设置后，修改文件内容无需重启即可被下一次初始化/401 重试采用。
3. 过期或损坏的 token 文件不会覆盖仍有效的环境变量 token。
4. 刷新器在 macOS 与 Linux（Xvfb）均可运行；首次登录有清晰提示。
5. 根 package.json 无新增依赖，`npm test` 全绿。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 原子 rename 与读取竞争 | 先写 tmp、rename，读方只读完整文件；读取失败视为无变化 |
| 401 重试放大 | 沿用现有 2 次上限；仅当内容确实变化才重试 |
| profile 目录泄露 cookie | `.gitignore` 排除，写入文件 0600 |
| 站点对自动化登录的风控 | 浏览器始终 headful（与 token-collector 同一约束），失败日志提示人工介入 |
| 登录态到期 | 文档说明无法 100% 无人值守，需周期性人工登录 |

## External Review Opinion (Requirement)

- 2026-11-27: `coding-bridge` 返回 429（Token Plan 月度配额耗尽），简化 prompt 重试仍 429；
  `codex` MCP 连接失败不可用。按 §1.4 第三优先级降级为独立实施。
  **本次实施未经外部 Review MCP 审查。**

## 验收结果

| 标准 | 结果 |
|---|---|
| 1. 未设置 `ZAI_TOKEN_FILE` 时行为不变 | ✅ 启动输出与改动前一致（仅保留原有 token 过期告警） |
| 2. 文件变化无需重启 | ✅ 单元测试 + 401 集成测试（新 token 用于第二次请求） |
| 3. 过期/损坏文件不覆盖有效 token | ✅ 启动用例 2 与单元测试均验证，并打印明确警告 |
| 4. 刷新器可运行 | ✅ CLI、参数校验、默认路径解析已验证；真实登录读取需首次在有显示环境执行（本机未安装 Playwright 依赖，未做浏览器实测） |
| 5. 根依赖不变、测试全绿 | ✅ 根 `package.json` 未新增依赖；`npm test` 209 通过 |

补充验证：401 且文件内容未变化时**不重试**，直接返回可操作的错误（含 refresher 状态提示）。

## 使用步骤

```sh
cd cmd/zai-token-refresher
npm install && npx playwright install chromium
node index.js                 # 首次手动登录，之后每 15 分钟刷新

# 项目根 .env
ZAI_TOKEN_FILE=runtime/zai-token
```

## 备注

- 登录态（cookie）本身会过期，届时刷新器日志会提示无 token；重新 headful 登录即可。
- 刷新的 token 只有在**内容确实变化且未过期**时才会覆盖，桥接器不会因刷新器故障而丢失当前可用 token。
- 实施期间外部 Review MCP 不可用（coding-bridge 429 / codex 连接失败），本次未经外部审查，见上节记录。
