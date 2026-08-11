# 接入 pi 引擎

这份文档写给「以后要把后端从 Claude 换/加成 pi」的人。目标是：**现在先按这份约定把
Claude 路径调稳，将来加 pi 时只写一个 `engine-pi.ts`，server 一行不用动。**

先读 [`docs/DESIGN.md`](./DESIGN.md) 了解整体架构，再看这里。

---

## 0. 现状：已经有干净的接缝

代码已按引擎解耦（见 commit「重构：抽出引擎层」）：

```
server.ts          与引擎无关：HTTP / 轮询 / 排队 / 暗号 / AskUserQuestion 挂起协调
  └─ engine.ts     引擎契约（Engine 接口 + EngineRunContext）
       ├─ engine-claude.ts   Claude 实现（现役，参考样板）
       └─ engine-pi.ts       ← 将来要写的 pi 实现
```

前端（`public/`）、`watch.mjs`、`bin/claude-chat` 的隧道/暗号逻辑**跟引擎完全无关**，
接 pi 时都不用碰。事件协议（`text_delta` / `tool_use` / `ask` / `session` / `done` …）也保持不变。

---

## 1. 你只需要实现这一个接口

`engine.ts`：

```ts
interface Engine {
  runPrompt(prompt: string, ctx: EngineRunContext): Promise<void>;
  readHistory(sessionId: string, cwd: string): any[];
}

interface EngineRunContext {
  resumeSessionId: string | undefined;   // resume 的会话 id（新开为 undefined）
  model: string | undefined;             // 指定模型（可选）
  cwd: string;                           // 会话工作目录
  signal: AbortSignal;                   // 中断信号（/interrupt、Ctrl-C 触发）
  emit: (event: any) => void;            // 把中性事件推给前端
  ask: (questions: any[]) => Promise<string[][]>;  // 需用户点选时挂起，返回 picks
  debug: boolean;                        // CC_DEBUG
}
```

**约定要点：**

- `emit` 出去的事件里，带 `sessionId` 字段的那条会被 server 捕获、更新当前会话 id。
  所以引擎拿到会话 id 时要 `ctx.emit({ type: "session", sessionId })`，不用自己存。
- `ask(questions)` 会广播成手机上的可交互按钮并挂起，用户点完 resolve 成 `picks`
  （`picks[i]` = 第 i 个问题选中的 label 数组）。引擎拿到 picks 后自己拼成后端要的入参。
- `signal` 是 web 标准 `AbortSignal`。若后端 SDK 要的是别的形态（如 `AbortController`），
  在引擎内转接一下即可（Claude 引擎就是这么做的，见下）。
- `runPrompt` 一轮结束就正常返回；报错就 throw（server 的 catch 会广播 error）。

server 侧驱动逻辑（不用改，供理解）：

```ts
const engine: Engine = process.env.ENGINE === "pi" ? piEngine : claudeEngine;
// ...
const emit = (ev) => { if (ev?.type === "done") sawDone = true; engineEmit(ev); };
await engine.runPrompt(prompt, { resumeSessionId: SESSION_ID, model, cwd, signal, emit, ask, debug });
```

---

## 2. Claude 引擎怎么映射的（照抄这个模式）

`engine-claude.ts` 是最好的样板。它把 SDK 的消息流翻译成中性事件：

| 中性事件（emit） | Claude SDK 来源 |
|---|---|
| `{ type:"session", sessionId }` | `system/init` 的 `session_id` |
| `{ type:"tool_start", name }` | `stream_event` 的 `content_block_start`（tool_use） |
| `{ type:"text_delta", text }` | `stream_event` 的 `text_delta` |
| `{ type:"block_stop" }` | `content_block_stop` |
| `{ type:"tool_use", name, summary, input }` | `assistant` 消息里完整的 tool_use 块 |
| `{ type:"done", subtype, sessionId }` | `result` 消息 |

中断转接、AskUserQuestion 挂起、短回复补发文字都在里面，直接对照。

---

## 3. 写 `engine-pi.ts` 的四个落点

pi 的 SDK 是 `@earendil-works/pi-coding-agent`（`createAgentSession` / `AgentSessionRuntime`）。
把上面的映射换成 pi 的等价物即可。四个需要动脑子的地方：

### 3.1 事件流：`session.subscribe()` → 中性事件

pi 用 `createAgentSession()` 拿到 `session`，`session.subscribe(cb)` 收事件，
`session.prompt(text)` 发起一轮。大致对应：

| 中性事件 | pi 事件（`session.subscribe`） |
|---|---|
| `text_delta` | `message_update` 且 `assistantMessageEvent.type === "text_delta"` |
| `tool_start` | `tool_execution_start`（`event.toolName`） |
| `tool_use` | 从 `turn_end` 的 assistant 消息里取工具调用（拿完整入参） |
| `done` | `agent_end` / 一轮结束 |
| `session` | `session.sessionId`（创建后就有，直接 emit 一次） |

> 细节以 pi 的 SDK 文档为准：`docs/sdk.md` 的 Events 一节。事件比 Claude 更细，挑需要的用。

### 3.2 工具授权 + 提问：pi 没有 `canUseTool`

pi 的模型不同：
- **工具默认放行**：不需要做任何事（不像 Claude 要显式 `canUseTool` 返回 allow）。
- **要「挂起等用户点选」**：Claude 的 `AskUserQuestion` 在 pi 里对应内置 `ask_question` 工具
  + 扩展钩子 `pi.on("tool_call", ...)`。在钩子里拦到该工具时 `await ctx.ask(questions)`，
  再决定放行/改写。**这是接 pi 时最需要验证的一环**（问题结构、答案回填格式都要对齐）。

> 需确认：pi 的 `ask_question` 入参/回参结构，以及在 SDK（非 TUI）模式下钩子怎么挂。
> 查 `docs/extensions.md` 的 `tool_call` 钩子和 `docs/sdk.md`。

### 3.3 会话历史：路径和格式都不一样

- Claude：`~/.claude/projects/<slug>/<id>.jsonl`
- pi：`~/.pi/agent/sessions/`，jsonl 格式不同（见 pi 的 `docs/session-format.md`）

`readHistory(sessionId, cwd)` 要照 pi 的格式重解析成同样的气泡事件序列
（`{type:'user'|'ai'|'tool_use', ...}`）。resume 用 `AgentSessionRuntime.switchSession(path)`
或 `importFromJsonl()`。

### 3.4 工具名摘要映射

`toolSummary()` 现在写死了 Claude 的工具名（`Bash`/`Read`/`WebSearch`…）。
pi 的工具名是小写（`bash`/`read`/`edit`…）。在 `engine-pi.ts` 里复制一份、改成 pi 的名字。
（这个函数是引擎私有的，两边各留一份即可，别硬抽公共。）

---

## 4. 后端认证（跟引擎配套，改 `bin/claude-chat`）

- Claude 现状：`bin/claude-chat` 开头强制 Bedrock（`CLAUDE_CODE_USE_BEDROCK` + `AWS_PROFILE`
  + `aws sts get-caller-identity` 预检）。
- pi：走自己的 `ModelRuntime`（`~/.pi/agent/auth.json` 或 `ANTHROPIC_API_KEY` 等环境变量）。

接 pi 时，把启动脚本里那段 AWS 预检换成 pi 的鉴权自检（后台进程弹不出交互登录，
必须在启动脚本里先探明、失败就提示用户手动处理）。可以按 `ENGINE` 分支走不同预检。

---

## 5. 接入步骤（将来照做）

1. `npm i @earendil-works/pi-coding-agent`
2. 新建 `engine-pi.ts`，实现 `Engine`（对照 §2、§3）。
3. `server.ts` 顶部已有开关位：
   ```ts
   const engine: Engine = process.env.ENGINE === "pi" ? piEngine : claudeEngine;
   ```
   把 `piEngine` import 进来即可。**Claude 路径完全不受影响。**
4. `bin/claude-chat` 里按 `ENGINE` 分支切鉴权预检（§4）。
5. 用 `ENGINE=pi claude-chat` 单独测 pi，回归对照清单：
   流式文字 / 工具卡片+摘要 / resume 历史回放 / 提问点选 / 中断 / 排队。

---

## 6. 为什么现在这样最省事

你现在把 **Claude 路径调稳** = 同时把「中性事件协议」和「Engine 契约」验对了。
将来加 pi 只是**再写一个符合同一契约的实现**，不回头改 server / 前端 / 隧道，
也不会把 Claude 路径改出回归。两路各自独立、互不干扰。
