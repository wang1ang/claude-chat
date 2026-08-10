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

function endAI() { if (aiOpen) { process.stdout.write("\n"); aiOpen = false; } }

// 把手机网址钉一遍——醒目高亮，免得被历史回放刷走看不到。
function printUrl() {
  if (!FULL_URL) return;
  const bar = "═".repeat(Math.max(20, FULL_URL.length + 6));
  console.log(`${C.yellow}${C.bold}${bar}${C.reset}`);
  console.log(`${C.yellow}${C.bold}  📱 手机浏览器打开（末尾暗号不能少）:${C.reset}`);
  console.log(`${C.cyan}${C.bold}  ${FULL_URL}${C.reset}`);
  console.log(`${C.yellow}${C.bold}${bar}${C.reset}`);
}

function render(o) {
  switch (o.type) {
    case "hello":
      console.log(`${C.dim}── 已连接跟看${o.sessionId ? "，会话 " + o.sessionId.slice(0, 8) : "（新会话）"} ──${C.reset}`);
      printUrl();
      break;
    case "history_start":
      inHistory = true;
      console.log(`${C.dim}┄┄ 历史（${o.count} 条）┄┄${C.reset}`);
      break;
    case "history_end":
      inHistory = false;
      console.log(`${C.dim}┄┄ 以上为历史，下面是实时 ┄┄${C.reset}`);
      printUrl();   // 历史刷完再钉一遍，网址就在最新位置、不会被顶走
      break;
    case "user":
      endAI();
      console.log(`${stamp()} ${C.green}${C.bold}你 ▸${C.reset} ${o.text}`);
      break;
    case "ai": // 历史里的整条 AI
      endAI();
      console.log(`${stamp()} ${C.cyan}${C.bold}Claude ◂${C.reset} ${o.text}`);
      break;
    case "status":
      if (!inHistory) console.log(`${C.gray}   … ${o.text}${C.reset}`);
      break;
    case "tool_start":
      // stream 占位（参数还没到）——留给紧随其后的 tool_use 打详情，这里不再单独打一行避免重复。
      break;
    case "tool_use":
      endAI();
      console.log(`${stamp()} ${C.yellow}🔧 ${o.name}${o.summary ? " " + C.dim + o.summary + C.reset : ""}${C.reset}`);
      break;
    case "ask": {
      endAI();
      if (inHistory) break;   // 历史里的旧问题不再接受回答
      termAsk = { id: o.id, questions: Array.isArray(o.questions) ? o.questions : [] };
      console.log(`${C.yellow}${C.bold}❓ Claude 在提问（回复选项编号即可，多题用 ; 分隔，多选用逗号）：${C.reset}`);
      termAsk.questions.forEach((q, qi) => {
        console.log(`${C.bold}  Q${qi + 1}. ${q.question || ""}${C.reset}${q.multiSelect ? C.dim + "（可多选）" + C.reset : ""}`);
        (q.options || []).forEach((op, oi) => {
          const label = typeof op === "string" ? op : (op.label || "");
          const desc = typeof op === "string" ? "" : (op.description || "");
          console.log(`     ${C.cyan}${oi + 1})${C.reset} ${label}${desc ? C.dim + " — " + desc + C.reset : ""}`);
        });
      });
      console.log(`${C.dim}     例：单题单选输 1；单题多选输 1,3；两题输 1;2${C.reset}`);
      break;
    }
    case "ask_answered":
      if (termAsk && termAsk.id === o.id) termAsk = null;
      break;
    case "ask_clear":
      if (termAsk && termAsk.id === o.id) { termAsk = null; console.log(`${C.dim}   （问题已取消）${C.reset}`); }
      break;
    case "text_delta":
      if (!aiOpen) { process.stdout.write(`${stamp()} ${C.cyan}${C.bold}Claude ◂${C.reset} `); aiOpen = true; }
      process.stdout.write(o.text);
      break;
    case "block_stop":
      endAI();
      break;
    case "done":
      endAI();
      console.log(`${C.dim}   ✓ 完成${C.reset}`);
      break;
    case "error":
      endAI();
      console.log(`${C.red}   ⚠️ ${o.message}${C.reset}`);
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
async function postSend(text) {
  try {
    await fetch(`http://127.0.0.1:${PORT}/${SECRET}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (e) {
    console.log(`${C.red}   ⚠️ 发送失败：${e.message}${C.reset}`);
  }
}
async function postAnswer(id, picks) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/${SECRET}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, picks }),
    });
    if (!r.ok) { const j = await r.json().catch(() => ({})); console.log(`${C.red}   ⚠️ 回答失败：${j.error || r.status}${C.reset}`); }
  } catch (e) {
    console.log(`${C.red}   ⚠️ 回答失败：${e.message}${C.reset}`);
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

process.on("SIGINT", () => {
  const now = Date.now();
  if (now - lastSigint < 1500) {
    console.log(`\n${C.dim}正在关闭服务和隧道…${C.reset}`);
    shutdownAll();
    console.log(`${C.dim}已全部停止。再见 👋${C.reset}`);
    process.exit(0);
  }
  lastSigint = now;
  console.log(`\n${C.yellow}↯ 已请求中断当前生成${C.reset} ${C.dim}(1.5秒内再按一次 Ctrl-C 退出并全关)${C.reset}`);
  postInterrupt();
});

console.log(`${C.dim}claude-chat 跟看中。直接打字回车发消息；Ctrl-C 中断当前生成，连按两次退出并全关。${C.reset}`);
printUrl();   // 一进来先钉一遍网址（不再依赖 SSE 的 hello 事件；历史铺完 history_end 还会再钉）
connect();

// 终端输入：整行读，回车即发（跟手机同一个 /send）。空行忽略。
// 不设 raw mode、不接管 readline 的 SIGINT，Ctrl-C 仍走上面的 process.on("SIGINT") 双击逻辑。
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  // 有待回答的选择题时，输入按"选项编号"解析并走 /answer；否则当普通消息发。
  if (termAsk) {
    const picks = parseAnswer(text, termAsk.questions);
    if (picks.every(p => p.length === 0)) {
      console.log(`${C.dim}   （没识别到有效编号；每题至少选一个，如 1 或 1,3 或 1;2）${C.reset}`);
      return;
    }
    const { id } = termAsk;
    termAsk = null;   // 乐观清掉，服务端确认后也会广播 ask_answered
    postAnswer(id, picks);
    return;
  }
  // 不在本地回显——server 会 broadcast 一个 user 事件，轮询拉回来由 render 统一显示，
  // 避免同一句话打印两次。
  postSend(text);
});
