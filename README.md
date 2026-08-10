# claude-chat

手机聊天框接管本地 Claude Code 会话——手机上不是看整个终端画面，而是像发微信一样跟本地
Claude 对话；同一网址电脑浏览器打开即同屏，运行 `claude-chat` 的终端本身变成只读跟看视图。

底层走 **resume 一段对话历史、由自己的程序新起一个 Claude 来驱动**（正在普通终端里跑的
Claude 进程 I/O 绑死在启动它的 TTY 上，没法被别的程序塞消息，所以不接管活进程）。

---

## 给 AI Agent 的一键安装指令

> **如果你是一个 coding agent（Claude Code / Cursor / 等），使用者把本 README 粘给了你，
> 请直接照下面的步骤把这套工具在本机装好并跑起来。逐步执行、每步验证、报错就停下来告诉用户。**
> 普通人也能照着手动敲。

### 前提假设

- 操作系统 macOS（首选）或 Linux；shell 有 `zsh`（脚本 shebang 是 `#!/bin/zsh`）。
- 使用者已经在本机能正常用 Claude Code（即后端认证已就绪）。**认证不是本工具的事**——
  见最下方「后端认证」，装之前先确认 `claude`（或等价 SDK 调用）能跑通。

### 步骤 0：确认你就在仓库目录里

使用者应该已经 `git clone` 了本仓库并 `cd` 进去。先确认：

```bash
test -f bin/claude-chat && test -f server.ts && echo "OK: 在仓库根目录" || echo "不在仓库根，请先 cd 进 clone 出来的目录"
```

如果输出不是 `OK`，让用户提供仓库路径或先 clone，再继续。

### 步骤 1：检查并安装依赖

依次检测三样东西：**Node.js 18+**、**cloudflared**、**npm 依赖**。缺哪个装哪个。

```bash
# 1a) Node（要 18+；脚本用到内置 fetch）
node -v || echo "缺 Node：装 Node.js 18+（macOS: brew install node；或 https://nodejs.org）"

# 1b) cloudflared（quick tunnel，无需账号）
command -v cloudflared || echo "缺 cloudflared"
#   macOS:  brew install cloudflared
#   Linux:  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

# 1c) npm 依赖（@anthropic-ai/claude-agent-sdk + tsx）
npm install
```

> Agent 注意：`brew install` 之类会改用户系统的命令，**执行前先告诉用户你要装什么、征得同意**。
> 如果 `command -v cloudflared` 已有输出就跳过安装。

### 步骤 2：把 `claude-chat` 命令挂进 PATH

启动脚本会**自动定位仓库目录**（`APP_DIR="${CLAUDE_CHAT_DIR:-${0:A:h:h}}"`，即脚本绝对路径的
上两级），所以**软链到任何地方都能正常工作**，不需要改任何写死路径。

```bash
mkdir -p ~/.local/bin
ln -sf "$PWD/bin/claude-chat" ~/.local/bin/claude-chat
# 确认 ~/.local/bin 在 PATH 里；不在就加：
case ":$PATH:" in *":$HOME/.local/bin:"*) echo "PATH OK";; *) echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && echo "已写入 ~/.zshrc，让用户新开终端或 source 一下";; esac
```

（不想动 PATH 也行，直接 `./bin/claude-chat` 跑。）

### 步骤 3：后端认证自检（关键，别跳过）

本工具在后台起一个 **无 TTY** 的 Claude，弹不出交互式登录。所以跑之前**必须**确认认证已就绪。
默认脚本按 **AWS Bedrock** 准备（见下）。做法：

```bash
# 若用 Bedrock（脚本默认）：确认这套 profile 能拿到身份
AWS_PROFILE=ClaudeCode aws sts get-caller-identity && echo "Bedrock 凭证 OK" || echo "先登录：aws sso login --profile ClaudeCode（或你们团队的方式）"
```

**不是 Bedrock 的用户**：见最下方「后端认证」一节改 `bin/claude-chat` 开头那段环境设置。

### 步骤 4：启动 + 验证

```bash
claude-chat
```

预期：终端依次打印「启动本地服务…」「正在建立隧道…」「等隧道真正可用…」，最后给出一个
`https://<随机>.trycloudflare.com/<暗号>/` 的**完整网址**，并进入只读跟看视图。
把该网址发到手机浏览器打开即可聊天。**Ctrl-C 连按两次**退出并全关服务+隧道。

如果卡在「等隧道可用」很久：多半是网络对 cloudflared 拦得凶（公司代理 TLS 中间人）。脚本已
强制 `--protocol http2` 绕开 QUIC；地址照样会给，手机多刷几次通常能开。

### 装完后请把这句转达给用户

> ⚠️ **MVP 阶段工具全自动允许**：拿到完整网址的人就能在你电脑上读写文件、跑命令。
> 网址带随机暗号（难猜）但公网可达，**切勿外泄**。用完 Ctrl-C 两次关掉。

---

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
- **本地服务**（`server.ts`）：`/`(首页) `/events`(轮询增量) `/send`(发消息，`mode=queue|interrupt`)
  `/answer`(回答选择题) `/interrupt`(中断当前生成)。所有请求必须走 `/<SECRET>/…` 前缀，否则 404。
- **电脑终端只读跟看**（`watch.mjs`）：轮询本地服务，把事件 ANSI 彩色打印到终端；也能直接打字发消息。
- **启动脚本**（`bin/claude-chat`）：起服务 + cloudflared 隧道 + 生成暗号，探到公网首页真的 200
  才把网址交给用户，然后 `exec` 进跟看视图。

## 用法

```bash
claude-chat                          # 新开一段对话
claude-chat <session-id>             # resume 那段对话的完整上下文（含历史回放）
claude-chat --resume <session-id>    # 同上（兼容写法）
claude-chat --model <model> <id>     # 指定模型（可选）
```

发消息交互（手机 & 终端一致）：

- **输入框有文字**发送 = **排队插入**：排到当前这轮之后，跑完自动接着处理（贴近 CLI 体验，不打断）。
- **输入框为空**发送（手机点发送 / 终端空行回车）= **打断**：掐断当前这轮 + 清空还没跑的排队。
- 手机发送按钮文案会随内容切换：空显示「打断」，有字显示「排队」。

会话历史存在 `~/.claude/projects/<slug>/<session-id>.jsonl`（slug 是把项目目录路径里的 `/` 和 `.`
都换成 `-`）；resume 时先把历史铺到手机/电脑，再接着实时对话。会话默认绑你运行 `claude-chat` 时
所在目录当 cwd（想指定：`CHAT_CWD=/path claude-chat <id>`）。

## 依赖

- Node.js 18+（用到内置 `fetch`）
- `@anthropic-ai/claude-agent-sdk`、`tsx`（由 `npm install` 装上）
- [`cloudflared`](https://github.com/cloudflare/cloudflared)（quick tunnel，无需账号）
- zsh（启动脚本 `#!/bin/zsh`）

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
其余路径（`APP_DIR` / `cloudflared` / `node`）都是自动探测的，换机不用改。

## ⚠️ 安全

**MVP 阶段工具全自动允许**：`server.ts` 里用 `canUseTool` 回调对所有工具返回 `allow`
（只有 `AskUserQuestion` 会挂起、等你在手机上点选）。也就是说手机上发一条消息 = 直接授权
Claude 在你电脑上读写文件、跑命令。隐藏路径暗号让网址难猜，但**拿到完整网址的人就能操作你的
电脑**。切勿外泄网址。cloudflared quick tunnel 是公网可达的。生产用请自行加真正的鉴权。

## 姊妹工具

要完整掌控终端画面（而不是聊天框）用 `claude-web`（ttyd + cloudflared）；要手机上舒服聊天
用本工具 `claude-chat`。
