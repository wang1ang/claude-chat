# claude-chat

手机聊天框接管本地 Claude Code 会话——手机上像发微信一样跟本地 Claude 对话，电脑同屏只读跟看。

> 更多细节（架构 / 依赖 / 后端认证 / 安全）见 [`docs/DESIGN.md`](docs/DESIGN.md)。

---

## 一、给 AI Agent 的一键安装指令

> **如果你是一个 coding agent（Claude Code / Cursor / 等），使用者把本 README 粘给了你，
> 请照下面的步骤把这套工具在本机装好并跑起来。逐步执行、每步验证、报错就停下来告诉用户。**
> 普通人也能照着手动敲。前提：macOS（首选）或 Linux，有 `zsh`；使用者本机已能正常用 Claude Code。

**步骤 0 · 确认在仓库目录里**（用户应已 clone 并 cd 进来）：

```bash
test -f bin/claude-chat && test -f server.ts && echo "OK: 在仓库根目录" || echo "不在仓库根，请先 cd 进 clone 出来的目录"
```

**步骤 1 · 检查并安装依赖**（缺哪个装哪个；装系统级东西前先征得用户同意）：

```bash
node -v || echo "缺 Node：装 Node.js 18+（macOS: brew install node；或 https://nodejs.org）"
command -v cloudflared || echo "缺 cloudflared：macOS 用 brew install cloudflared；Linux 见 https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
npm install   # 装 @anthropic-ai/claude-agent-sdk + tsx
```

**步骤 2 · 把 `claude-chat` 挂进 PATH**（脚本自动定位仓库目录，软链到哪都能用）：

```bash
mkdir -p ~/.local/bin
ln -sf "$PWD/bin/claude-chat" ~/.local/bin/claude-chat
case ":$PATH:" in *":$HOME/.local/bin:"*) echo "PATH OK";; *) echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && echo "已写入 ~/.zshrc，让用户新开终端或 source 一下";; esac
```

（不想动 PATH 也行，直接 `./bin/claude-chat` 跑。）

**步骤 3 · 后端认证自检**（后台 Claude 无 TTY、弹不出登录，必须先确认认证就绪）：

```bash
# 脚本默认按 AWS Bedrock 准备。确认能拿到身份：
AWS_PROFILE=ClaudeCode aws sts get-caller-identity && echo "Bedrock 凭证 OK" || echo "先登录：aws sso login --profile ClaudeCode（或你们团队的方式）"
```

不用 Bedrock 的用户：改 `bin/claude-chat` 开头那段环境设置，见 [`docs/DESIGN.md`](docs/DESIGN.md) 的「后端认证」。

**步骤 4 · 启动 + 验证**：

```bash
claude-chat
```

预期终端最后给出 `https://<随机>.trycloudflare.com/<暗号>/` 的**完整网址**并进入只读跟看视图；
把该网址发到手机浏览器即可聊天。卡在「等隧道可用」很久多半是网络对 cloudflared 拦得凶，地址照样会给、手机多刷几次通常能开。

**装完后请把这句转达给用户：**

> ⚠️ 工具全自动允许——拿到完整网址的人就能在你电脑上读写文件、跑命令。网址带随机暗号但公网可达，**切勿外泄**，用完 Ctrl-C 两次关掉。

---

## 二、怎么跑（给人看）

```bash
claude-chat                          # 新开一段对话
claude-chat <session-id>             # resume 那段对话的完整上下文（含历史回放）
claude-chat --resume <session-id>    # 同上（兼容写法）
claude-chat --model <model> <id>     # 指定模型（可选）
```

跑起来后，用打印出的**完整带暗号网址**在手机浏览器打开（末尾那段不能少，去掉就 404），电脑同一终端实时只读跟看。
`Ctrl-C` 一次 = 中断当前这一轮生成；**1.5 秒内连按两次** = 退出跟看并全关服务+隧道。

**发消息交互**（手机 & 终端一致）：

- **输入框有文字**发送 = **排队插入**：排到当前这轮之后，跑完自动接着处理（贴近 CLI，不打断）。
- **输入框为空**发送（手机点发送 / 终端空行回车）= **打断**：掐断当前这轮 + 清空还没跑的排队。
- 手机发送按钮文案兼当忙闲指示：**空闲显示「发送」**（这轮说完了）、在跑时显示「排队」或「打断」。

会话默认绑你运行 `claude-chat` 时所在目录当 cwd（想指定：`CHAT_CWD=/path claude-chat <id>`），
历史存在 `~/.claude/projects/<slug>/<session-id>.jsonl`；resume 时先铺历史再接着实时对话。

> ⚠️ **安全**：工具全自动允许 = 手机上发一条消息就等于授权 Claude 在你电脑上读写文件、跑命令。
> 暗号让网址难猜，但拿到完整网址就能操作你的电脑。切勿外泄网址。详见 [`docs/DESIGN.md`](docs/DESIGN.md)。
