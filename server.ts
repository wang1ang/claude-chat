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

// ---- SSE 客户端集合：多个浏览器标签都能同时收到推流 ----
type SSEClient = { write: (s: string) => void };
const clients = new Set<SSEClient>();

function broadcast(obj: unknown) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const c of clients) {
    try { c.write(line); } catch { /* 断开的客户端下次清理 */ }
  }
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
          else if (b?.type === "tool_use") out.push({ type: "tool_start", name: b.name });
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
      if (message.type === "system" && message.subtype === "init") {
        SESSION_ID = message.session_id;            // 记住会话，后续接着聊
        broadcast({ type: "session", sessionId: SESSION_ID });

      } else if (message.type === "stream_event") {
        const ev: any = message.event;
        if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
          broadcast({ type: "tool_start", name: ev.content_block.name });
        } else if (ev.type === "content_block_delta") {
          if (ev.delta?.type === "text_delta") {
            broadcast({ type: "text_delta", text: ev.delta.text });
            streamedText = true;
          } else if (ev.delta?.type === "input_json_delta") {
            broadcast({ type: "tool_input_delta", partial: ev.delta.partial_json });
          }
        } else if (ev.type === "content_block_stop") {
          broadcast({ type: "block_stop" });
        }

      } else if (message.type === "assistant") {
        // 兜底：有些回复不走 token 级 stream_event（尤其短回复/某些路径），
        // 只来一条完整的 assistant 消息。若这一轮没实时吐过文字，就从这里把文字/工具补发出去，
        // 否则手机端会从"思考中"直接跳到"完成"、看不到任何回复。
        if (!streamedText) {
          const content: any = (message as any).message?.content;
          if (Array.isArray(content)) {
            for (const b of content) {
              if (b?.type === "text" && b.text) {
                broadcast({ type: "text_delta", text: b.text });
                broadcast({ type: "block_stop" });
              } else if (b?.type === "tool_use") {
                broadcast({ type: "tool_start", name: b.name });
              }
            }
          } else if (typeof content === "string" && content) {
            broadcast({ type: "text_delta", text: content });
            broadcast({ type: "block_stop" });
          }
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

  if (req.method === "GET" && path === "/stream") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
    });
    res.write(": connected\n\n");
    const client: SSEClient = { write: (s) => res.write(s) };
    clients.add(client);
    // 一进来就告诉前端当前会话状态
    res.write(`data: ${JSON.stringify({ type: "hello", sessionId: SESSION_ID ?? null, running })}\n\n`);
    // 再把这段会话的历史铺出来（只发给这个刚连上的客户端，不广播）
    if (SESSION_ID) {
      const hist = readHistory(SESSION_ID);
      if (hist.length) {
        res.write(`data: ${JSON.stringify({ type: "history_start", count: hist.length })}\n\n`);
        for (const ev of hist) res.write(`data: ${JSON.stringify(ev)}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "history_end" })}\n\n`);
      }
    }
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 20000);
    req.on("close", () => { clearInterval(ping); clients.delete(client); });
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
