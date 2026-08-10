# claude-chat

手机聊天框接管本地 Claude Code 会话——手机上不是看整个终端画面，而是像发微信一样跟本地
Claude 对话；同一网址电脑浏览器打开即同屏，运行 `claude-chat` 的终端本身变成只读跟看视图。

底层走 **resume 一段对话历史、由自己的程序新起一个 Claude 来驱动**（正在普通终端里跑的
Claude 进程 I/O 绑死在启动它的 TTY 上，没法被别的程序塞消息，所以不接管活进程）。

## 架构

```
手机浏览器(聊天网页)  ┐
电脑浏览器(同屏)      ├─► 本地 Node 服务(SSE 推流) ─► Claude Agent SDK query() ─► Claude
电脑终端(只读跟看)    ┘        ▲                                思考 / 调工具
                        cloudflared quick tunnel                     │
                        + 隐藏路径暗号                    事件流 ◄─────┘
```

- 手机浏览器（`public/index.html`）：暗色、手机友好的聊天 UI，SSE 自动重连，气泡长按复制。
- 本地服务（`server.ts`）：`/`(首页) `/stream`(SSE) `/send`(发消息) `/interrupt`(中断当前生成)。
  暗号防护做在服务里——所有请求必须走 `/<SECRET>/…` 前缀，否则 404。
- 电脑终端只读跟看（`watch.mjs`）：连本地 SSE，把事件 ANSI 彩色打印到终端。
- 启动脚本（`bin/claude-chat`）：起服务 + cloudflared 隧道 + 生成暗号，打印带暗号完整网址，
  然后 `exec` 进跟看视图。

## 安装

```bash
# 1) 拿到代码
git clone <this-repo> ~/models/claude-chat
cd ~/models/claude-chat

# 2) 装 Node 依赖（@anthropic-ai/claude-agent-sdk + tsx）
npm install

# 3) 装 cloudflared（quick tunnel，无需账号）
brew install cloudflared          # macOS；其它平台见 cloudflared 官方文档

# 4) 让 claude-chat 命令可用：把启动脚本软链进 PATH
ln -s "$PWD/bin/claude-chat" ~/.local/bin/claude-chat   # 确保 ~/.local/bin 在 $PATH 里
# 或者直接 export PATH="$PWD/bin:$PATH"
```

**换机必改**：`bin/claude-chat` 开头有两行按作者本机写死的路径，clone 到别的机器后要改成你自己的：

```sh
APP_DIR=/Users/yang.wang/.local/claude-chat   # 改成你的项目目录，例：$HOME/models/claude-chat
CFD=/opt/homebrew/bin/cloudflared             # 改成 `which cloudflared` 的结果
```

（`node`/`npx` 脚本会自己 `command -v` 找，不用改。AWS Bedrock 那段见下方「后端认证」。）

验证：

```bash
claude-chat        # 应打印带暗号的手机网址，并进入只读跟看视图；Ctrl-C 两次退出
```

## 用法

```bash
claude-chat                          # 新开一段对话
claude-chat <session-id>             # resume 那段对话的完整上下文（含历史回放）
claude-chat --resume <session-id>    # 同上（兼容写法）
claude-chat --model <model> <id>     # 指定模型（可选）
```

跑起来后：
1. 用打印出的**完整带暗号网址**在手机浏览器打开（末尾那段不能少，去掉就 404）。
2. 手机上发消息 = 聊天气泡驱动本地 Claude；电脑同一终端实时只读跟看。
3. `Ctrl-C` 一次 = 中断 Claude 当前这一轮生成；**1.5 秒内连按两次** = 退出跟看并全关服务+隧道。

会话历史存在 `~/.claude/projects/<slug>/<session-id>.jsonl`；resume 时会先把历史铺到
手机/电脑，再接着实时对话。

## 依赖

- Node.js 18+（用到内置 `fetch`；watch.mjs 的 SSE 客户端依赖它）
- `@anthropic-ai/claude-agent-sdk`、`tsx`（由 `npm install` 装上）
- [`cloudflared`](https://github.com/cloudflare/cloudflared)（quick tunnel，无需账号）
- zsh（启动脚本用 `#!/bin/zsh`）

安装步骤见上方「安装」。

## 后端认证（AWS Bedrock）

本仓库的启动脚本按**作者本机的 AWS Bedrock**环境准备：`CLAUDE_CODE_USE_BEDROCK=1` +
`AWS_PROFILE=ClaudeCode` + `AWS_REGION=us-west-2`，凭证靠 `~/.aws` 的 credential_process
自动刷新。脚本开头会强制重置这套环境（防止当前 shell 被别的工具污染成别的 region/静态 key），
并 `aws sts get-caller-identity` 预检，失败就提示手动登录。

如果你用的不是 Bedrock，把 `bin/claude-chat` 开头那段 AWS 环境重置删掉/改成你的登录态即可
（Agent SDK 本身支持标准登录态 / API key）。脚本里的路径也是作者本机的绝对路径，换机需要相应调整。

## ⚠️ 安全

**MVP 阶段工具全自动允许**（`bypassPermissions` + `allowDangerouslySkipPermissions`）：
手机上发一条消息 = 直接授权 Claude 在你电脑上读写文件、跑命令。隐藏路径暗号让网址难猜，
但**拿到完整网址的人就能操作你的电脑**。切勿外泄网址。cloudflared quick tunnel 是公网可达的。

## 姊妹工具

要完整掌控终端画面（而不是聊天框）用 `claude-web`（ttyd + cloudflared）；要手机上舒服聊天
用本工具 `claude-chat`。
