// claude-chat 后端：手机聊天网页 → 本地服务 → Claude Agent SDK（resume 会话）→ SSE 推流回网页。
// 启动：SESSION_ID=<id> PORT=8790 MODEL=<model> npx tsx server.ts
// 通常由 claude-chat 启动脚本负责起隧道 + 暗号路径，这里只管本地服务。
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { query } from "@anthropic-ai/claude-agent-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 8790);
// 隐藏路径暗号：所有请求必须走 /<SECRET>/… 前缀，否则 404（防护层，跟 claude-web 拉齐）。
const SECRET = process.env.SECRET || "";
// SESSION_ID 可空：为空则新开一段对话；给了就 resume 那段历史。
let SESSION_ID = process.env.SESSION_ID || undefined;
const MODEL = process.env.MODEL || undefined;
const CWD = process.env.CHAT_CWD || process.cwd();

// 一次只允许一条 prompt 在跑（MVP：单会话、单飞行）。
let running = false;

// ---- 事件缓冲：轮询模型（不用 SSE）----
// 为什么不用 SSE：某些网络（公司 TLS 中间人代理）会缓冲流式响应，把 text/event-stream 这种
// 永不结束的长连接整个憋住，手机端一个字节都收不到（首页短请求却能过）。改成轮询：
// 所有事件追加进内存数组、各带递增 seq；前端每秒拉一次 /events?since=<seq> 取增量。短请求稳穿代理。
type Ev = { seq: number; [k: string]: unknown };
const EVENTS: Ev[] = [];
let SEQ = 0;
const MAX_EVENTS = 5000;   // 防止长时间运行内存无限涨；超了丢最老的（历史会在重连时重铺）

function broadcast(obj: any) {
  EVENTS.push({ ...obj, seq: ++SEQ });
  if (EVENTS.length > MAX_EVENTS) EVENTS.splice(0, EVENTS.length - MAX_EVENTS);
}

// 给工具调用生成一行人类可读摘要，手机上一眼看清"在干什么"。
// 常见工具挑最能说明意图的字段；未知工具退化成截断的 JSON。
function toolSummary(name: string, input: any): string {
  const i = input ?? {};
  const clip = (s: any, n = 80) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + "…" : s; };
  const base = (p: any) => clip(String(p ?? "").split("/").pop());   // 只留文件名
  try {
    switch (name) {
      case "Bash":        return clip(i.command, 120);
      case "Read":        return "读 " + base(i.file_path);
      case "Write":       return "写 " + base(i.file_path);
      case "Edit":        return "改 " + base(i.file_path);
      case "MultiEdit":   return "改 " + base(i.file_path) + `（${(i.edits?.length ?? 0)} 处）`;
      case "Glob":        return "找文件 " + clip(i.pattern, 60);
      case "Grep":        return "搜 " + clip(i.pattern, 60) + (i.path ? " @ " + base(i.path) : "");
      case "LS":          return "列目录 " + base(i.path);
      case "WebFetch":    return "抓网页 " + clip(i.url, 80);
      case "WebSearch":   return "搜网 " + clip(i.query, 60);
      case "Task":        return "子任务 " + clip(i.description || i.subagent_type, 60);
      case "TodoWrite":   return `更新待办（${(i.todos?.length ?? 0)} 项）`;
      case "NotebookEdit":return "改 notebook " + base(i.notebook_path);
      case "AskUserQuestion": {
        const q = i.questions?.[0]?.question || i.question || "";
        return "❓ 提问：" + clip(q, 100);
      }
      case "ExitPlanMode":return "提交计划待确认";
      default: {
        const s = JSON.stringify(i);
        return clip(s, 100);
      }
    }
  } catch { return name; }
}

// 取 seq 之后的所有事件（since=0 或负数=从头，含刚铺的历史）
function eventsSince(since: number): Ev[] {
  if (since <= 0) return EVENTS.slice();
  // EVENTS 按 seq 递增，二分找第一个 > since 的位置
  let lo = 0, hi = EVENTS.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (EVENTS[m].seq <= since) lo = m + 1; else hi = m; }
  return EVENTS.slice(lo);
}

// 首次拉取时把这段会话历史铺进事件流（只铺一次；用标记防重复铺）。
// 手机上只需最近几轮就够，往前翻的历史暂不做懒加载——首拉只铺最近 HISTORY_TAIL 条，
// 首屏轻、也省得 since=0 一次拉一大坨。
const HISTORY_TAIL = 12;
let historyLoaded = false;
function ensureHistoryLoaded() {
  if (historyLoaded) return;
  historyLoaded = true;
  if (!SESSION_ID) return;
  const all = readHistory(SESSION_ID);
  if (!all.length) return;
  const hist = all.slice(-HISTORY_TAIL);
  broadcast({ type: "history_start", count: hist.length, truncated: all.length > hist.length });
  for (const ev of hist) broadcast(ev);
  broadcast({ type: "history_end" });
}

// ---- 读取会话历史（.jsonl），转成一串可直接渲染的气泡事件 ----
// Claude Code 把历史存在 ~/.claude/projects/<slug>/<session-id>.jsonl，
// slug 是把项目目录路径里的 "/" 和 "." 都换成 "-"（例：/Users/yang.wang → -Users-yang-wang）。
function slugForCwd(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}
function historyFile(sessionId: string): string | null {
  const base = join(homedir(), ".claude", "projects");
  // 先按 cwd 的 slug 找；找不到就在所有项目目录里搜同名文件（SDK 也是全局搜的）。
  const direct = join(base, slugForCwd(CWD), `${sessionId}.jsonl`);
  if (existsSync(direct)) return direct;
  try {
    for (const d of readdirSync(base)) {
      const f = join(base, d, `${sessionId}.jsonl`);
      if (existsSync(f)) return f;
    }
  } catch {}
  return null;
}

// 把历史文件解析成 [{type:'user'|'ai'|'tool', text/name}] 事件序列。
function readHistory(sessionId: string): any[] {
  const file = historyFile(sessionId);
  if (!file) return [];
  const out: any[] = [];
  let raw = "";
  try { raw = readFileSync(file, "utf8"); } catch { return []; }
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let o: any;
    try { o = JSON.parse(s); } catch { continue; }
    const t = o.type;
    if (t !== "user" && t !== "assistant") continue;
    const content = o.message?.content;
    if (t === "user") {
      if (typeof content === "string") {
        const txt = content.trim();
        if (txt) out.push({ type: "user", text: txt });
      } else if (Array.isArray(content)) {
        // 只要真正的文字块；tool_result 是工具回传、不是用户说的话，跳过
        for (const b of content) {
          if (b?.type === "text" && b.text?.trim()) out.push({ type: "user", text: b.text.trim() });
        }
      }
    } else { // assistant
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === "text" && b.text?.trim()) out.push({ type: "ai", text: b.text });
          // 历史里的工具调用参数是完整的，直接发 tool_use（带摘要+完整参数），
          // 前端能渲染成可展开卡片，跟实时那条一致（历史没有 tool_start 占位）。
          else if (b?.type === "tool_use") out.push({ type: "tool_use", name: b.name, summary: toolSummary(b.name, b.input), input: b.input ?? {} });
          // thinking 块跳过
        }
      } else if (typeof content === "string" && content.trim()) {
        out.push({ type: "ai", text: content });
      }
    }
  }
  return out;
}

// 当前飞行中的中断器（Ctrl-C / 前端调 /interrupt 时用它掐断 claude 这一轮生成）
let currentAbort: AbortController | null = null;

// ---- 驱动一次 claude 调用，把事件翻译成聊天用的简单协议推给前端 ----
async function runPrompt(prompt: string) {
  if (running) {
    broadcast({ type: "error", message: "上一条还在处理，请稍候。" });
    return;
  }
  running = true;
  if (process.env.CC_DEBUG) console.error(`[runPrompt] prompt=${JSON.stringify(prompt)} resume=${SESSION_ID ?? "(新)"}`);
  broadcast({ type: "user", text: prompt });      // 回显用户气泡
  broadcast({ type: "status", text: "思考中…" });

  const abort = new AbortController();
  currentAbort = abort;
  let streamedText = false;   // 这一轮有没有通过 stream_event 实时吐过文字
  let sentDone = false;       // result 是否已发过 done（避免 finally 重复发）
  try {
    const iter = query({
      prompt,
      options: {
        ...(SESSION_ID ? { resume: SESSION_ID } : {}),
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,      // MVP：工具全自动允许
        includePartialMessages: true,               // token 级增量
        ...(MODEL ? { model: MODEL } : {}),
        cwd: CWD,
        abortController: abort,
      },
    });

    for await (const message of iter) {
      if (process.env.CC_DEBUG) {
        let d = "";
        if (message.type === "assistant") d = JSON.stringify((message as any).message?.content)?.slice(0, 120);
        else if (message.type === "result") d = (message as any).subtype;
        console.error(`[msg] ${message.type}${(message as any).subtype ? "/" + (message as any).subtype : ""} ${d}`);
      }
      if (message.type === "system" && message.subtype === "init") {
        SESSION_ID = message.session_id;            // 记住会话，后续接着聊
        broadcast({ type: "session", sessionId: SESSION_ID });

      } else if (message.type === "stream_event") {
        const ev: any = message.event;
        // 工具开始的即时提示：stream 里 content_block_start 时 input 还是空的（参数随后才 delta 出来），
        // 所以这里只发一个"工具开始"占位；完整参数由下面的 assistant 消息补齐成 tool_use 详情。
        if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
          broadcast({ type: "tool_start", name: ev.content_block.name });
        } else if (ev.type === "content_block_delta") {
          if (ev.delta?.type === "text_delta") {
            broadcast({ type: "text_delta", text: ev.delta.text });
            streamedText = true;
          }
          // input_json_delta（工具参数分片）不再逐片发——手机端拼不起来也没意义；
          // 完整参数走 assistant 消息一次性发出。
        } else if (ev.type === "content_block_stop") {
          broadcast({ type: "block_stop" });
        }

      } else if (message.type === "assistant") {
        // assistant 消息里 tool_use 块的 input 是**完整**的——无论走没走 token 流，
        // 都从这里把工具的完整参数发出去（带一行人类可读摘要），手机才看得到"在干什么"。
        const content: any = (message as any).message?.content;
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b?.type === "tool_use") {
              broadcast({ type: "tool_use", name: b.name, summary: toolSummary(b.name, b.input), input: b.input ?? {} });
            } else if (!streamedText && b?.type === "text" && b.text) {
              // 兜底：这一轮没走 token 流（短回复/某些路径），从完整消息补发文字，
              // 否则手机端会从"思考中"直接跳到"完成"、看不到回复。
              broadcast({ type: "text_delta", text: b.text });
              broadcast({ type: "block_stop" });
            }
          }
        } else if (!streamedText && typeof content === "string" && content) {
          broadcast({ type: "text_delta", text: content });
          broadcast({ type: "block_stop" });
        }

      } else if (message.type === "result") {
        broadcast({ type: "done", subtype: message.subtype, sessionId: message.session_id });
        sentDone = true;
        SESSION_ID = message.session_id;
      }
    }
  } catch (e: any) {
    // 主动中断（abort）不算错误，给个中性提示
    if (abort.signal.aborted) broadcast({ type: "status", text: "已中断这一轮。" });
    else broadcast({ type: "error", message: String(e?.message ?? e) });
  } finally {
    running = false;
    if (currentAbort === abort) currentAbort = null;
    // 只有 result 没发过 done 时（中断/报错/异常提前退出）才补一个，避免重复"✓ 完成"
    if (!sentDone) broadcast({ type: "done", subtype: "idle" });
  }
}

// ---- HTTP：静态首页 + SSE 流 + 发消息 ----
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  // 暗号门槛：请求路径必须以 /<SECRET> 开头；剥掉前缀后再走下面的路由。
  let path = url.pathname;
  if (SECRET) {
    const prefix = "/" + SECRET;
    if (path === prefix) { res.writeHead(302, { location: prefix + "/" }); res.end(); return; }
    if (!path.startsWith(prefix + "/")) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    path = path.slice(prefix.length) || "/";
  }

  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    const html = await readFile(join(__dirname, "public", "index.html"), "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  // 轮询取增量事件：GET /events?since=<seq> → { events:[...], seq:<最新seq>, running }
  // 前端每秒拉一次；短请求能稳穿会憋死 SSE 长连接的代理。since=0 首拉会带上历史。
  if (req.method === "GET" && path === "/events") {
    ensureHistoryLoaded();   // 首次拉取时铺历史（幂等）
    const since = Number(url.searchParams.get("since") ?? "0") || 0;
    const evs = eventsSince(since);
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({
      events: evs,
      seq: SEQ,
      sessionId: SESSION_ID ?? null,
      running,
    }));
    return;
  }

  if (req.method === "POST" && path === "/send") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let text = "";
      try { text = JSON.parse(body).text ?? ""; } catch {}
      text = String(text).trim();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      if (text) runPrompt(text);                    // 异步跑，事件走 SSE
    });
    return;
  }

  // 中断当前这一轮生成（Ctrl-C / 前端按钮触发）。不关服务。
  if (req.method === "POST" && path === "/interrupt") {
    if (currentAbort && running) currentAbort.abort();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, aborted: !!(currentAbort && running) }));
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`claude-chat 后端已启动: http://127.0.0.1:${PORT}`);
  console.log(`会话: ${SESSION_ID ? "resume " + SESSION_ID : "新开"}  模型: ${MODEL ?? "默认"}  目录: ${CWD}`);
});
