# claude-chat · 设计与细节

面向想了解内部实现、或需要改后端认证的人。安装/使用请看仓库根的 [`README.md`](../README.md)。

底层思路：**resume 一段对话历史、由自己的程序新起一个 Claude 来驱动**。正在普通终端里跑的
Claude 进程 I/O 绑死在启动它的 TTY 上，没法被别的程序塞消息，所以不接管活进程，而是新起一个
带完整历史上下文的 Claude。

## 架构

```
手机浏览器(聊天网页)  ┐
电脑浏览器(同屏)      ├─► 本地 Node 服务(轮询取事件) ─► Claude Agent SDK query() ─► Claude
电脑终端(只读跟看)    ┘        ▲                                思考 / 调工具
                        cloudflared quick tunnel                     │
                        + 隐藏路径暗号                    事件流 ◄─────┘
```

- **手机浏览器**（`public/index.html`）：暗色、手机友好的聊天 UI。每秒轮询 `/events?since=<seq>`
  取增量（**故意不用 SSE**——公司代理会把流式长连接憋死；短轮询更稳）。气泡长按复制，
  AskUserQuestion 渲染成可点选项，工具调用展示名称+摘要+可展开参数。
- **本地服务**（`server.ts`）：`/`(首页) `/events`(轮询增量，返回 `{events,seq,running}`)
  `/send`(发消息，`mode=queue|interrupt`) `/answer`(回答选择题) `/interrupt`(中断当前生成)。
  所有请求必须走 `/<SECRET>/…` 前缀，否则 404。
- **电脑终端只读跟看**（`watch.mjs`）：轮询本地服务，把事件 ANSI 彩色打印到终端；也能直接打字发消息。
- **启动脚本**（`bin/claude-chat`）：起服务 + cloudflared 隧道 + 生成暗号，探到公网首页真的 200
  才把网址交给用户，然后 `exec` 进跟看视图。

## 依赖

- Node.js 18+（用到内置 `fetch`）
- `@anthropic-ai/claude-agent-sdk`、`tsx`（由 `npm install` 装上）
- [`cloudflared`](https://github.com/cloudflare/cloudflared)（quick tunnel，无需账号）
- zsh（启动脚本 `#!/bin/zsh`）

`bin/claude-chat` 里的 `APP_DIR` / `cloudflared` / `node` 都是自动探测的，换机不用改。

## 后端认证（AWS Bedrock）

`bin/claude-chat` 开头默认按 **AWS Bedrock** 准备并**强制重置**成干净的一套（防当前 shell 被别的
工具污染成别的 region / 静态 key）：

```sh
export CLAUDE_CODE_USE_BEDROCK=1
export AWS_PROFILE=ClaudeCode
export AWS_REGION=us-west-2
export AWS_DEFAULT_REGION=us-west-2
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
```

凭证靠 `~/.aws` 的 credential_process 自动刷新；脚本会 `aws sts get-caller-identity` 预检，
失败就提示手动登录（后台进程弹不出 SSO）。

**改成你自己的登录态**：如果你不用 Bedrock，把上面这段删掉/替换成你的方式即可
（Agent SDK 支持标准 Anthropic 登录态 / API key，例如 `export ANTHROPIC_API_KEY=...`）。

## ⚠️ 安全

**MVP 阶段工具全自动允许**：`server.ts` 里用 `canUseTool` 回调对所有工具返回 `allow`
（只有 `AskUserQuestion` 会挂起、等你在手机上点选）。也就是说手机上发一条消息 = 直接授权
Claude 在你电脑上读写文件、跑命令。隐藏路径暗号让网址难猜，但**拿到完整网址的人就能操作你的
电脑**。切勿外泄网址。cloudflared quick tunnel 是公网可达的。生产用请自行加真正的鉴权。

## 姊妹工具

要完整掌控终端画面（而不是聊天框）用 `claude-web`（ttyd + cloudflared）；要手机上舒服聊天
用本工具 `claude-chat`。
