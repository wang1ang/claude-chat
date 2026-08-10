// claude-chat 的电脑端跟看：连本地轮询接口，把事件 pretty-print 到终端；
// 还能直接在终端打字发消息（跟手机同一个 /send 接口），方便调试。
// 用法（由 claude-chat-watch 调用）：PORT=.. SECRET=.. node watch.mjs
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const PORT = process.env.PORT;
const SECRET = process.env.SECRET;
const FULL_URL = process.env.FULL_URL || "";
if (!PORT || !SECRET) { console.error("缺 PORT/SECRET"); process.exit(1); }

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", cyan: "\x1b[36m", yellow: "\x1b[33m", blue: "\x1b[34m", red: "\x1b[31m", gray: "\x1b[90m",
};
const stamp = () => { const d = new Date(); return C.gray + d.toTimeString().slice(0, 8) + C.reset; };

let aiOpen = false;          // 当前是否正在打印一段 AI 文本
let inHistory = false;
let termAsk = null;          // 当前待回答的 AskUserQuestion：{ id, questions }（终端可用数字回答）

// ── 底部固定输入行 ─────────────────────────────────────────────────────────
// 目标：AI 流式输出刷在上方，用户输入始终在屏幕最底部独立一行，生成中打字不被冲掉。
// 手段：所有向上方"内容区"的写入都必须走 out()／outRaw()，它们保证顺序：
//   擦掉底部输入行 → 写内容 → 重画底部输入行。
// 只有真·TTY 时才启用；非 TTY（管道）退化成朴素打印，行为跟以前一致。
const IS_TTY = !!(process.stdout.isTTY && process.stdin.isTTY);
let inputBuf = "";           // 当前输入缓冲（raw mode 下自己维护，按 Unicode 码点）
const PROMPT = `${C.green}${C.bold}你 ▸${C.reset} `;

// 屏幕模型：内容区在上、输入行永远固定在最底一行，两者之间隔一个换行。
//   - 静止时：光标停在输入行末尾（提示符 + 已输入内容）。
//   - 写内容时：先擦掉输入行 → 把内容写进内容区 → 另起一行重画输入行。
// AI 流式文本是"内容区最后一段"，其下方紧跟输入行。为了续写而不错位、也不让
// 提示符闪烁，这里把当前这段 AI 文本整段缓存在 aiLine 里：每来一个碎片就
//   上移到 AI 行行首 → 清掉 AI 行和下面的输入行 → 重写整段 aiLine → 换行画输入行。
// 单行重画对流式速度完全够用，且天然正确处理光标定位。
let aiFragOpen = false;   // 内容区最后一段是不是没收尾的 AI 流式文本
let aiLine = "";          // 当前这段 AI 文本已累积的内容（含前缀 "Claude ◂ "）

function clearInputLine() { if (IS_TTY) process.stdout.write("\r\x1b[K"); }   // 光标回行首、清到行尾
function drawInputLine() { if (IS_TTY) process.stdout.write(PROMPT + inputBuf); }

// 把没收尾的 AI 流式段落收个尾：光标此刻在输入行，上移清掉它、让 AI 行定格，
// 之后调用方会另起内容。收尾后 aiFragOpen=false。
function sealAiFrag() {
  if (!aiFragOpen) return;
  // 光标在输入行 → 擦掉输入行（AI 行保留在上面，作为已定格的历史）
  clearInputLine();
  aiFragOpen = false;
  aiLine = "";
}

// 安全打印整行（自带换行）：内容永远落在输入行上方，输入行随后固定在下面。
function out(line) {
  if (!IS_TTY) { console.log(line); return; }
  if (aiFragOpen) sealAiFrag();     // 先给上方没收尾的 AI 段落定格
  else clearInputLine();            // 否则擦掉输入行
  process.stdout.write(line + "\n");
  drawInputLine();
}

// 流式碎片（text_delta 用）：累积到 aiLine，重画"AI 段落 + 底部输入行"。
// 输入行始终留在 AI 文本下面一行，Claude 说到一半也看得到 你 ▸。
function outRaw(frag) {
  if (!IS_TTY) { process.stdout.write(frag); return; }
  if (!aiFragOpen) {
    // 首个碎片：擦掉输入行，就地起一段 AI 文本；下一行留给输入行。
    clearInputLine();
    aiFragOpen = true;
    aiLine = "";
  } else {
    // 后续碎片：光标在输入行。上移一行回到 AI 行、回行首、清掉 AI 行准备重写。
    process.stdout.write("\x1b[1A\r\x1b[K");
  }
  aiLine += frag;
  process.stdout.write(aiLine);     // 重写整段 AI 文本
  process.stdout.write("\n");        // 换行——输入行永远在它下面
  drawInputLine();
}

function endAI() {
  if (!aiOpen) return;
  if (IS_TTY) {
    // outRaw 后画面是 [AI 行]\n[输入行]，光标在输入行。把这段 AI 文本定格即可：
    // AI 行上方那个 \n 已经把它和后续内容分隔开，这里只需清掉 aiFragOpen 状态，
    // 输入行本就在最底部、无需再动。（不要再补 \n，否则会多出一空行。）
    aiFragOpen = false; aiLine = "";
  } else {
    process.stdout.write("\n");
  }
  aiOpen = false;
}

// 把手机网址钉一遍——醒目高亮，免得被历史回放刷走看不到。
function printUrl() {
  if (!FULL_URL) return;
  const bar = "═".repeat(Math.max(20, FULL_URL.length + 6));
  out(`${C.yellow}${C.bold}${bar}${C.reset}`);
  out(`${C.yellow}${C.bold}  📱 手机浏览器打开（末尾暗号不能少）:${C.reset}`);
  out(`${C.cyan}${C.bold}  ${FULL_URL}${C.reset}`);
  out(`${C.yellow}${C.bold}${bar}${C.reset}`);
}

function render(o) {
  switch (o.type) {
    case "hello":
      out(`${C.dim}── 已连接跟看${o.sessionId ? "，会话 " + o.sessionId.slice(0, 8) : "（新会话）"} ──${C.reset}`);
      printUrl();
      break;
    case "history_start":
      inHistory = true;
      out(`${C.dim}┄┄ 历史（${o.count} 条）┄┄${C.reset}`);
      break;
    case "history_end":
      inHistory = false;
      out(`${C.dim}┄┄ 以上为历史，下面是实时 ┄┄${C.reset}`);
      printUrl();   // 历史刷完再钉一遍，网址就在最新位置、不会被顶走
      break;
    case "user":
      endAI();
      out(`${stamp()} ${C.green}${C.bold}你 ▸${C.reset} ${o.text}`);
      break;
    case "ai": // 历史里的整条 AI
      endAI();
      out(`${stamp()} ${C.cyan}${C.bold}Claude ◂${C.reset} ${o.text}`);
      break;
    case "status":
      if (!inHistory) out(`${C.gray}   … ${o.text}${C.reset}`);
      break;
    case "tool_start":
      // stream 占位（参数还没到）——留给紧随其后的 tool_use 打详情，这里不再单独打一行避免重复。
      break;
    case "tool_use":
      endAI();
      out(`${stamp()} ${C.yellow}🔧 ${o.name}${o.summary ? " " + C.dim + o.summary + C.reset : ""}${C.reset}`);
      break;
    case "ask": {
      endAI();
      if (inHistory) break;   // 历史里的旧问题不再接受回答
      termAsk = { id: o.id, questions: Array.isArray(o.questions) ? o.questions : [] };
      out(`${C.yellow}${C.bold}❓ Claude 在提问（回复选项编号即可，多题用 ; 分隔，多选用逗号）：${C.reset}`);
      termAsk.questions.forEach((q, qi) => {
        out(`${C.bold}  Q${qi + 1}. ${q.question || ""}${C.reset}${q.multiSelect ? C.dim + "（可多选）" + C.reset : ""}`);
        (q.options || []).forEach((op, oi) => {
          const label = typeof op === "string" ? op : (op.label || "");
          const desc = typeof op === "string" ? "" : (op.description || "");
          out(`     ${C.cyan}${oi + 1})${C.reset} ${label}${desc ? C.dim + " — " + desc + C.reset : ""}`);
        });
      });
      out(`${C.dim}     例：单题单选输 1；单题多选输 1,3；两题输 1;2${C.reset}`);
      break;
    }
    case "ask_answered":
      if (termAsk && termAsk.id === o.id) termAsk = null;
      break;
    case "ask_clear":
      if (termAsk && termAsk.id === o.id) { termAsk = null; out(`${C.dim}   （问题已取消）${C.reset}`); }
      break;
    case "text_delta":
      if (!aiOpen) { outRaw(`${stamp()} ${C.cyan}${C.bold}Claude ◂${C.reset} `); aiOpen = true; }
      outRaw(o.text);
      break;
    case "block_stop":
      endAI();
      break;
    case "done":
      endAI();
      out(`${C.dim}   ✓ 完成${C.reset}`);
      break;
    case "error":
      endAI();
      out(`${C.red}   ⚠️ ${o.message}${C.reset}`);
      break;
  }
}

// 轮询客户端（跟前端同一套 /events?since= 协议；server 已去掉 SSE 改轮询）。
// 电脑端跟看：每秒拉一次增量事件，render 出来。
async function connect() {
  const base = `http://127.0.0.1:${PORT}/${SECRET}/`;
  let since = 0;
  for (;;) {
    try {
      const res = await fetch(`${base}events?since=${since}`);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      for (const ev of data.events || []) {
        if (ev.seq > since) since = ev.seq;
        render(ev);
      }
    } catch (e) {
      // 静默重试；只有持续失败才提示，别刷屏
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
// Ctrl-C：第一次中断 claude 当前生成；1.5s 内再按一次 → 退出并全关（服务+隧道）。
const PID_FILE = process.env.PID_FILE;
let lastSigint = 0;

async function postInterrupt() {
  try { await fetch(`http://127.0.0.1:${PORT}/${SECRET}/interrupt`, { method: "POST" }); } catch {}
}
async function postSend(text, mode = "queue") {
  try {
    await fetch(`http://127.0.0.1:${PORT}/${SECRET}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, mode }),
    });
  } catch (e) {
    out(`${C.red}   ⚠️ 发送失败：${e.message}${C.reset}`);
  }
}
async function postAnswer(id, picks) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/${SECRET}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, picks }),
    });
    if (!r.ok) { const j = await r.json().catch(() => ({})); out(`${C.red}   ⚠️ 回答失败：${j.error || r.status}${C.reset}`); }
  } catch (e) {
    out(`${C.red}   ⚠️ 回答失败：${e.message}${C.reset}`);
  }
}
// 把终端输入（"1;2"、"1,3"）解析成 picks: string[][]（每题选中的 label 数组）。
function parseAnswer(line, questions) {
  const perQ = line.split(";").map(s => s.trim());
  return questions.map((q, qi) => {
    const opts = q.options || [];
    const chunk = perQ[qi] ?? perQ[0] ?? "";   // 单题时允许不带分号
    const nums = chunk.split(/[, ]+/).map(s => parseInt(s, 10)).filter(n => n >= 1 && n <= opts.length);
    const labels = nums.map(n => { const op = opts[n - 1]; return typeof op === "string" ? op : (op.label || ""); });
    return [...new Set(labels)];
  });
}
function shutdownAll() {
  // 1) kill pid 文件里记录的父进程（连同进程组）
  try {
    for (const line of readFileSync(PID_FILE, "utf8").split("\n")) {
      const pid = parseInt(line.trim(), 10);
      if (pid) { try { process.kill(pid, "SIGTERM"); } catch {} }
    }
  } catch {}
  // 2) 兜底按名清这一份的 server（tsx/node 子进程树）+ cloudflared（按端口，无 $ 锚点更稳）
  const kill = (pat) => { try { execSync(`pkill -f ${JSON.stringify(pat)}`, { stdio: "ignore" }); } catch {} };
  kill(`/claude-chat/server.ts`);
  kill(`cloudflared tunnel --url http://127.0.0.1:${PORT}`);
}

function doInterruptOrQuit() {
  const now = Date.now();
  if (now - lastSigint < 1500) {
    out(`${C.dim}正在关闭服务和隧道…${C.reset}`);
    shutdownAll();
    out(`${C.dim}已全部停止。再见 👋${C.reset}`);
    process.exit(0);
  }
  lastSigint = now;
  out(`${C.yellow}↯ 已请求中断当前生成${C.reset} ${C.dim}(1.5秒内再按一次 Ctrl-C 退出并全关)${C.reset}`);
  postInterrupt();
}

// 提交当前输入行（回车触发）：跟手机同一套 /send / /answer 语义。空缓冲=打断当前这轮。
function submitLine() {
  const text = inputBuf.trim();
  inputBuf = "";
  // 有待回答的选择题时，输入按"选项编号"解析并走 /answer；否则当普通消息发。
  if (termAsk) {
    if (!text) return;
    const picks = parseAnswer(text, termAsk.questions);
    if (picks.every(p => p.length === 0)) {
      out(`${C.dim}   （没识别到有效编号；每题至少选一个，如 1 或 1,3 或 1;2）${C.reset}`);
      return;
    }
    const { id } = termAsk;
    termAsk = null;   // 乐观清掉，服务端确认后也会广播 ask_answered
    postAnswer(id, picks);
    return;
  }
  // 跟手机一致：有文字=排队插入（不打断）；空行=打断当前这轮。
  // 不在本地回显——server 会 broadcast 一个 user 事件，轮询拉回来由 render 统一显示，
  // 避免同一句话打印两次。
  if (!text) postSend("", "interrupt");
  else postSend(text, "queue");
}

// ── 输入层 ─────────────────────────────────────────────────────────────────
// TTY：raw mode 自管缓冲。关键点：
//   - 按 Unicode 码点（[...str]）删除，一次退格删掉整个汉字/emoji，不再是半个字节。
//   - 每次缓冲变化只重画底部输入行，AI 输出照常刷在上方、互不干扰。
//   - Ctrl-C 在这里处理（中断 / 双击退出），保持擦/重画画面整洁。
// 非 TTY（被管道/重定向）：退回 readline 整行读，SIGINT 走信号，行为跟以前一致。
if (IS_TTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");   // 按 UTF-8 解码成完整字符，不会把汉字拆成字节
  process.stdin.on("data", (chunk) => {
    // 转义序列（方向键/Home/End 等 \x1b[… 或 \x1bO…）：整段吞掉，别让 [A 之类漏进缓冲。
    if (chunk.charCodeAt(0) === 0x1b) return;
    for (const ch of chunk) {
      if (ch === "\r" || ch === "\n") {           // 回车：提交
        clearInputLine();
        submitLine();
        drawInputLine();
      } else if (ch === "\x7f" || ch === "\b") {   // 退格 / Delete：删末尾一个码点（整字符）
        if (inputBuf.length) {
          const cps = [...inputBuf];
          cps.pop();
          inputBuf = cps.join("");
          clearInputLine();
          drawInputLine();
        }
      } else if (ch === "\x03") {                   // Ctrl-C：中断 / 双击退出
        doInterruptOrQuit();
      } else if (ch === "\x15") {                   // Ctrl-U：清空当前输入行
        inputBuf = "";
        clearInputLine();
        drawInputLine();
      } else if (ch === "\x04") {                   // Ctrl-D：忽略（别让终端 EOF 退出）
        // no-op
      } else if (ch >= " ") {                        // 可见字符（含多字节汉字/emoji）
        inputBuf += ch;
        process.stdout.write(ch);                   // 直接回显，无需重画整行
      }
      // 其它控制字符吞掉，避免污染缓冲
    }
  });
} else {
  process.on("SIGINT", doInterruptOrQuit);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  rl.on("line", (line) => { inputBuf = line; submitLine(); });
}

out(`${C.dim}claude-chat 跟看中。直接打字回车发消息；Ctrl-C 中断当前生成，连按两次退出并全关。${C.reset}`);
printUrl();   // 一进来先钉一遍网址（不再依赖 SSE 的 hello 事件；历史铺完 history_end 还会再钉）
// out() 末尾已经画好底部输入行，这里不再重复 drawInputLine（否则会出现两行"你 ▸"）。
connect();
