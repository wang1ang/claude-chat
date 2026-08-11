# claude-chat · 需求与行为契约（改动前必读）

> **给未来迭代这个项目的 agent**：这份文档记录了一系列**已经确定、经过真人验证**的需求和
> 设计决策。每一条都是踩过坑或反复讨论后定下来的。**动到相关代码前先读对应条目**，别把
> 已经解决的问题又改回去。文档按「需求 → 为什么 → 怎么实现的 → 别破坏什么」组织。
>
> 架构总览看 [`DESIGN.md`](./DESIGN.md)；这里只讲**行为约束**和**为什么这么做**。

---

## 0. 项目定位（不要偏离）

手机聊天框接管本地 Claude Code 会话：**resume 一段对话历史、由自己的程序新起一个 Claude 来
驱动**，手机 + 电脑浏览器 + 电脑终端三端看同一份事件流。不接管正在 TTY 里跑的活进程
（那个 I/O 绑死在 TTY 上塞不进消息）。

---

## 1. 消息要插入到 agent 的「内部轮次」，像真实 Claude ⭐核心

**需求**：用户在手机上发消息，如果 agent 正忙（在多步工具循环里跑），这条消息要能**插进
当前内部轮次的间隙**，agent 保留上下文、接着把新指令纳进来——就跟真实 Claude Code CLI 里
你打字回车的体验一样。**不是**「排到整轮彻底跑完之后才处理」。

**为什么**：这是用户明确、反复强调的核心诉求（「我要的就是排队到内部轮次里」）。旧实现每条
消息新起一次 `query()`（string prompt，单轮即关），插入的消息只能等整轮跑完，体验差。

**怎么实现的**（当前方案，勿退回旧的单轮模型）：
- 整段会话**只开一次** `query()`，`prompt` 传一个**不结束的异步输入流**
  （`AsyncIterable<SDKUserMessage>`，见 `engine-claude.ts` 的 `InputStream`），会话存活期间绝不 `done`。
- 引擎接口是 `startSession(ctx) → { send, interrupt, abort, close }`（`engine.ts`）：
  - **空闲发消息** = `send(text)`：往流里 push，正常开一轮。
  - **忙时发消息** = `interrupt(text)`：push 进流 **+ 调 `query.interrupt()`**，SDK 在当前内部
    轮次边界暂停、**保留上下文接上继续**。这是 CLI 语义，**不是**丢弃重来。
  - **空发送** = `abort()`：硬中断，掐断当前生成、丢弃在途工作（Ctrl-C 语义）。
- `server.ts` 里 `submitPrompt()` 按 `running` 决定走 `send` 还是 `interrupt`；会话**懒起**
  （首条消息时 `ensureSession()`）。

**别破坏**：
- 不要改回「每条消息一个 `query()`」的单轮模型。
- `interrupt()` ≠ 丢弃。它保留上下文接着干。别把它实现成 abort。
- 不能用 `bypassPermissions`——那样 SDK 跳过 `canUseTool`，就拦不到 AskUserQuestion 了（见 §5）。

---

## 2. 中断后的「迟到事件」不能把状态翻回忙 ⭐已修的竞态

**需求/坑**：硬中断（abort）后，被作废那段会话的 SDK 流循环**收尾时仍会吐几条迟到事件**
（text_delta / tool_use 等）。如果照单全收，会把 `running` 又翻回 `true`，界面显示还在忙。

**怎么实现的**：`server.ts` 用**会话代次** `sessionGen`：每 `startSession` 绑定一个 gen，
`abortSession()` 时 `sessionGen++`。`engineEmit(gen, ev)` 里 `gen !== sessionGen` 的事件**整条丢弃**。

**别破坏**：改中断/会话生命周期逻辑时，务必保留这个代次门。已经真机验证过：abort 后 `running`
稳定为 `false` 不回弹。

---

## 3. `running` 忙闲状态的语义

- `running` = agent 当前是否在生成（含内部工具循环），**只是给前端看的忙闲指示**。
- 由引擎事件驱动：`text_delta / tool_start / tool_use / ask` → 忙；`done` → 闲（见 `engineEmit`）。
- 前端每秒 `poll()` 拿 `running` 校准按钮文案。
- 前端发送按钮文案兼当忙闲指示：空闲=**「发送」**、忙+有字=**「插入」**、忙+空=**「打断」**。
  （注意：「插入」不是旧的「排队」——语义已随 §1 改变，文案也改了。）

---

## 4. 长命令默认丢后台，别卡住手机对话

**需求**：agent 有时会跑长命令（构建/测试/装依赖/sleep/长轮询），手机场景下**用户没法用
Ctrl+B 转后台、也打断不了已在执行的子进程**，长命令会一直卡住对话。

**为什么这么解**：调研过——SDK stream-json 模式下 **Ctrl+B 后台化不可用**（只在 TTY/Ink 模式有），
也**没有对应的 control 消息**能把已启动的命令转后台。唯一可行的是命令**启动时**就
`run_in_background: true`。而 server 端拿不到 SDK 起的 detached bash 子进程的 PID，事后也杀不动。

**怎么实现的**：**只加 prompt 指引**（用户明确选的方案，不做复杂拦截）。`engine-claude.ts` 的
`query()` options 里 `systemPrompt: { type:"preset", preset:"claude_code", append: "…" }`，
指引 agent 把预计超过几秒的命令默认用 `run_in_background: true` 起，快速命令照常前台。

**别破坏**：保留 `preset:"claude_code"`（别丢掉 Claude Code 默认 system prompt）。别试图去做
「运行中转后台」——已确认技术上做不到，白费力气。

---

## 5. AskUserQuestion 选框：挂起等手机作答

**需求**：agent 用 AskUserQuestion 提问时，要在手机上渲染成可点选项，用户点了才继续。

**怎么实现的**：`canUseTool` 回调拦下 `AskUserQuestion`，调 `ctx.ask(questions)` 挂起，广播 `ask`
事件给前端渲染按钮；`/answer` 带 `{id, picks}` 进来时 resolve。`picks` 是 `string[][]`
（picks[i]=第 i 题选中的 label 数组）。自由文字回答传 `[[text]]`，引擎 `join` 后就是原文。
SDK 期望 `updatedInput.answers` = `Record<问题文本, 答案字符串>`（多选逗号拼），见 `buildAskUpdatedInput`。

**别破坏**：其它工具全 `allow`（MVP），唯独 AskUserQuestion 要挂起，否则手机没法回答。

---

## 6. 选框弹出前后发的消息不能被吞 ⭐已修的竞态

**需求/坑**：用户发消息的时机如果**刚好卡在选框弹出前后**，消息会被忽略——空消息误触打断把
选框那轮 abort 掉、文字消息被 askUser 的 Promise 堵住永不处理。

**怎么实现的（已定行为）**：**发消息 = 自动把这段文字当成对选框的回答**。
- 后端 `/send`：`pendingAsk` 存在时，有文字 → `answerAsk(id, [[text]])`；空消息 → 直接忽略
  （不 abort 选框那轮）。这是后端权威兜底。
- 前端 `send()`：检测到未回答选框（`.ask:not(.answered)`）时，文字走 `/answer`、空发送忽略。

**别破坏**：这条兜底前后端都要在，别只留一边（消息可能比选框事件早到、或前端判断没跟上）。

---

## 7. 隧道：默认 cloudflared QUIC，别写死 `--protocol http2` ⭐踩过的坑

**坑**：曾有人给 cloudflared 写死 `--protocol http2` → 走 TCP/443 TLS → 撞上 Zscaler 这类
TLS 中间人 → `x509: certificate signed by unknown authority` → 隧道一次都连不上、手机 Cloudflare 1033。

**定论**：`bin/claude-chat` 里起 cloudflared **用默认协议（QUIC，UDP/7844）**，绝大多数网络能直连，
QUIC 通常绕过 TLS 中间人。真遇到禁 UDP 出站的网络，cloudflared precheck 会自己回退，不用写死。
极少数连 QUIC edge 都拦死的网络才用 ngrok 兜底（`TUNNEL=ngrok`，走标准 443）。

**别破坏**：**永远不要**给 cloudflared 加 `--protocol http2`。ngrok 兜底实现保留，但 README 里表述
最小化（细节挪 DESIGN.md）。

---

## 8. 轮询而非 SSE

**为什么**：某些网络（公司 TLS 中间人代理）会缓冲流式响应，把 `text/event-stream` 这种永不结束
的长连接整个憋住，手机端一字节都收不到（首页短请求却能过）。

**怎么实现的**：所有事件追加进内存数组、各带递增 `seq`；前端每秒 `GET /events?since=<seq>` 取增量。
短请求稳穿代理。**别改回 SSE / WebSocket。**

---

## 9. 隐藏路径暗号 + 安全边界

- 所有请求必须走 `/<SECRET>/…` 前缀，否则 404（防护层）。环境变量是 `SECRET`（**不是** `CHAT_SECRET`）。
- **MVP 阶段工具全自动允许**：拿到完整网址的人就能操作你的电脑。这是已知的 MVP 取舍，不是 bug；
  生产用需自行加真正鉴权。别外泄网址。

---

## 10. 引擎解耦（可换后端）

`server.ts` 与具体后端无关（只管 HTTP / 轮询 / 排队 / 暗号 / AskUserQuestion 挂起协调）；跟
Claude 绑定的代码收在 `engine-claude.ts`，通过 `engine.ts` 的 `Engine` 接口接入。想换/加 pi 后端
见 [`PI_ENGINE.md`](./PI_ENGINE.md)。**改 server 时保持这个边界**：引擎特有逻辑别漏进 server。

---

## 11. 部署/同步注意

- 通过 PATH 启动 `claude-chat` 时，`APP_DIR` 经 `${0:A}` 解析软链后 = **仓库目录**
  `~/models/claude-chat`。所以**仓库就是实际运行的那份**。
- `~/.local/claude-chat/` 是另一份拷贝（历史遗留 / 另一个 agent 维护），改核心文件时顺手同步过去
  保持一致，但仓库是权威。
- 历史存 `~/.claude/projects/<slug>/<session-id>.jsonl`；resume 时先铺历史再接实时对话。
- 手机往前滑到顶自动懒加载更早历史（`GET /history?before=<idx>`）。

---

## 12. CLI 输入：Shift+Enter 换行、Enter 才发送

**需求**：电脑端跟看的 TUI（`watch.mjs`）底部输入框，要能 **Shift+Enter 插换行、普通 Enter 发送**，
跟手机网页端（`public/index.html` 桌面行为）和真实 Claude Code CLI 一致。

**为什么这么实现**：终端默认把 Shift+Enter 和 Enter **都发成 `\r`**，程序区分不了。要区分
必须开 **Kitty keyboard protocol**（iTerm2 3.5+/Kitty/Ghostty/WezTerm 支持）——开启后
Shift+Enter 发 `CSI 13;2u`，Ink 7 把它解析成 `key.return && key.shift`。已在 iTerm2 3.6.11 实测。

**怎么实现的**（`watch.mjs`）：
- `render()` 之后 `process.stdout.write("\x1b[>1u")` push 协议；退出时 `\x1b[<u` pop，
  挂在 `process.on("exit", popKitty)` 上、幂等，**任何退出路径都兜底 pop**。
- `Input` 组件：`key.return && key.shift` → 在光标处插 `\n`（不提交）；`key.return` → 提交。
- `Input` 支持多行：光标前文本按 `\n` 拆逻辑行，正确算真实光标 x/y（中文输入法候选框才跟手）。

**别破坏**：
- 退出时**必须** pop 协议（`\x1b[<u`），否则残留会污染之后的终端会话。
- 不支持 Kitty 协议的终端会自动降级成「Enter 发送」（`key.shift` 恒 false），**这是可接受的降级，别报错**。

---

## 13. 关闭一份不能误杀别份的后台 ⭐已修的坑

**坑**：多份 `claude-chat` 并存时（第 1 份、第 2 份…都在**同一个仓库路径**跑），关掉一份会把
别份的后台 server 也一起杀掉。根因是 `shutdownAll()` 里按 `server.ts` **路径** `pkill -f`——
同路径必然命中每一份的 server 进程。

**怎么实现的**（`watch.mjs` 的 `shutdownAll()`）：server 兜底改用 **`lsof -ti tcp:<PORT> -sTCP:LISTEN`**
按**本份端口**精确定位监听进程再 SIGTERM。端口每份唯一，只命中本份；且直达真正 `listen` 的
node（顺带绕开「npm exec 不转发信号」的老坑）。隧道清理（cloudflared/ngrok）本就按本份 `PORT`
精确匹配，无此问题。

**别破坏**：**不要**再按 `server.ts` 路径 `pkill` 来清 server——多份并存必误伤。任何进程清理都要
用**本份唯一标识**（端口 / 本份 PID_FILE），别用所有份共享的路径特征。

---

## 附：本项目已确认「做不到 / 不做」的事（省得重复调研）

- **把正在运行的命令转后台**：SDK stream-json 模式下无此能力（Ctrl+B 仅 TTY 模式、无 control 消息、
  server 拿不到 detached 子进程 PID）。只能靠 §4 的启动即后台。
- **从 server 中断已启动的 bash 子进程**：`abort()` 只 SIGTERM 掉 CLI（CLI 再 tree-kill），
  server 拿不到子进程 PID，做不到精准中断单个子进程。
- **纯排队插入 agent 内部轮次而不 interrupt**：光 push 进流不调 `interrupt()` 的话，消息还是排到
  当前工具循环之后——连真实 Claude Code 也是这样。要真插进内部轮次**必须** push + `interrupt()`（见 §1）。
