# 上游同步：GLM-Free-API (Go) → Node 移植版

**Status**: ✅ Completed (2026-11-27)
**Baseline**: `../GLM-Free-API-go`（无 git 快照）
**Target**: `../GLM-Free-API` HEAD `3b23a69`
**Backup**: `../.GLM-Free-API-node-backup-2026-11-27`

## 目标
把上游 Go 仓库自移植基线以来的全部行为变更同步到 Node 版，保持 API 行为一致。

## 变更清单与状态

| # | 模块 | 内容 | 状态 |
|---|---|---|---|
| T1 | config/server/state | FE 1.1.93、UA Chrome/133、agentModeLevel/forceCPU/sessionReuseCount + CLI flag | ✅ |
| T2 | src/waf.js（新） | WAF 检测、熔断器、后台 prober、503+Retry-After、错误体截断 | ✅ |
| T3 | src/ratelimit.js | 进程级共享 pacing gate | ✅ |
| T4 | src/db.js（新） | 可热切换 SQLite、token 计数 TTL、POST /sqlite | ✅ |
| T5 | src/sessionPool.js | SESSION_REUSE_COUNT 复用/轮换、sync sticky session | ✅ |
| T6 | src/zai.js | 签名 query 参数、Origin/Referer、搜索开关/MCP、WAF、issue #45/#36 | ✅ |
| T7 | handlers/anthropic/middleware | advancedSearch、WAF 拦截、流式修正、/status waf | ✅ |
| T8 | src/agent.js | 严格字面契约、示例调用、删除 native fallback 与二次抽取 | ✅ |
| T9 | agentUltra.js/toolparserLLM.js（新） | Ultra 修复层（默认休眠） | ✅ |
| T10 | cmd/token-collector | Fielin 纯计算 + headful harvest 重写 | ✅ |
| T11 | tests/docs | 移植上游新增测试、更新 README | ✅ |

## 实施顺序
T1 → T2/T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11，每步 `npm test`。

## 风险
- Node 无 uTLS 指纹伪装，只能靠 `CURL_IMPERSONATE` 后端（文档标注差异）。
- Ultra 层依赖 Python/SGLang/GPU，默认休眠，不影响常规路径。
- token-collector 必须 headful 浏览器。
- 项目非 git 仓库：改动前已整目录备份。

## 外部评审
- coding-bridge: HTTP 429（月度配额超限）
- codex MCP: CONNECTION_CLOSED
- 结论：本次未获得外部评审，独立完成，已向用户声明。

## 验收结果

- `npm test`：**173/173 通过**（原 123 + 新增 waf/db/sessionReuse/websearch/ultra/feilin/sse #45/sse #36 等）
- 启动冒烟：`node main.js --db-path ... --session-reuse-count 3`
  - `GET /health` → `{"healthy":true,"mode":"direct","tokenCount":13500}`
  - `GET /status` → 含 `sessionPool.reuse=true, maxUses=3` 与 `waf:{blocked:false,state:0}`
  - `POST /sqlite` 非 POST→405、缺失/非法路径→400、成功→200 `{swapped_in:"3ms", token_count:...}`
- feilin golden 向量（DeviceConfig 解密、140 字段 payload 字节级重封、md5 seal）全部通过

## 未同步项 / 已知差异

1. **uTLS 指纹**：Go 改为 `HelloChrome_Auto`；Node 无等价能力，继续使用 undici 或 `CURL_IMPERSONATE` 后端（已在 README 标注）。
2. **ToolParserLLM**：等价移植（资产下载/校验/SGLang 启动/SGLang 客户端），但未在真实 GPU 环境验证；默认休眠。
3. **token-collector**：headful 采集路径未在本次会话实际跑通（需图形环境 + 真实上游）；Fielin 纯计算部分已用 golden 向量验证。
4. **外部评审**：coding-bridge 429 + codex 连接关闭，本次未获得外部评审。

## 备注

- 改动前整目录备份：`../.GLM-Free-API-node-backup-2026-11-27`。
- 项目非 git 仓库，建议后续初始化 git 以便评审 diff。
