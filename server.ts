// claude-chat 后端：手机聊天网页 → 本地服务 → 引擎（Engine）→ 轮询推流回网页。
// 本文件与具体引擎无关：只管 HTTP / 轮询 / 排队 / 暂发（暗号）/ AskUserQuestion 的挂起协调；
// 跟 Claude（或以后的 pi）绑定的部分在 engine-claude.ts 里，通过 engine.ts 的接口接入。
// 启动：SESSION_ID=<id> PORT=8790 MODEL=<model> npx tsx server.ts
// 通常由 claude-chat 启动脚本负责起隧道 + 暗号路径，这里只管本地服务。
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Engine, EngineSession } from "./engine.ts";
import { claudeEngine } from "./engine-claude.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 选引擎：默认 Claude；ENGINE=pi 走 pi（待接）。server 其余部分与引擎无关。
const engine: Engine = claudeEngine;

const PORT = Number(process.env.PORT ?? 8790);
// 隐藏路径暗号：所有请求必须走 /<SECRET>/… 前缀，否则 404（防护层，跟 claude-web 拉齐）。
const SECRET = process.env.SECRET || "";
// SESSION_ID 可空：为空则新开一段对话；给了就 resume 那段历史。
let SESSION_ID = process.env.SESSION_ID || undefined;
const MODEL = process.env.MODEL || undefined;
const CWD = process.env.CHAT_CWD || process.cwd();

// running：agent 当前是否在生成（含内部工具循环）。由引擎的第一条消息置真、done 置假。
// 跟旧版不同：不再「一条 prompt 一飞行」，而是一段持续会话里插消息进内部轮次，
// running 只是给前端看的忙闲指示。
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

// 会话代次：每 startSession 一次 +1。硬中断（abort）时立刻 bump，让被作废那段会话
// 之后还在排空的「迟到事件」（abort 后 SDK 流循环收尾时仍会吐几条）被丢弃，
// 免得它们把 running 又翻回忙、或污染界面。
let sessionGen = 0;

// 引擎事件出口：捕获带 sessionId 的事件更新当前会话；据事件维护 running 忙闲；其余原样 broadcast。
// done = agent 这一轮（含内部工具循环）到边界，置闲；任何生成中事件把它拉回忙。
// gen 是发起这条事件的会话代次；跟当前不符（已被中断作废）就整条丢弃。
function engineEmit(gen: number, ev: any) {
  if (gen !== sessionGen) return;   // 迟到的作废会话事件，丢弃
  if (ev && typeof ev.sessionId === "string" && ev.sessionId) SESSION_ID = ev.sessionId;
  const t = ev?.type;
  if (t === "done") {
    running = false;
    // 一轮结束时若还挂着没答的问题（中断/报错），清掉并让前端撤按钮，免得留个死按钮。
    if (pendingAsk) { broadcast({ type: "ask_clear", id: pendingAsk.id }); pendingAsk = null; }
  } else if (t === "text_delta" || t === "tool_start" || t === "tool_use" || t === "ask") {
    running = true;   // 有生成活动 → 忙
  }
  broadcast(ev);
}

// ---- AskUserQuestion 挂起：让手机能点选项回答 ----
// 引擎需要用户点选时调 ctx.ask(questions)（见 askUser）；这里存住待答的 Promise，
// 广播一个 ask 事件（带 id + 问题 + 选项）给前端渲染成按钮，然后挂起；
// 等 POST /answer 带着 id + 选择进来，resolve 成 picks，引擎据此构造它自己要的 input。
let pendingAsk: {
  id: string;
  resolve: (picks: string[][]) => void;
} | null = null;
let askSeq = 0;

// 供引擎调用：广播可交互 ask 事件并挂起，直到手机作答。
function askUser(questions: any[]): Promise<string[][]> {
  const id = `ask${++askSeq}`;
  broadcast({ type: "ask", id, questions });
  broadcast({ type: "status", text: "等你在手机上选择…" });
  if (process.env.CC_DEBUG) console.error(`[ask] ${id} ${JSON.stringify(questions).slice(0, 200)}`);
  return new Promise<string[][]>((resolve) => {
    pendingAsk = { id, resolve };
  });
}

// 回答当前挂起的选框：picks 是 string[][]（每题选中的 label 数组；
// 自由文字回答传 [[text]]，引擎那边 join 后就是原文）。回显+唤醒引擎。
// 供 /answer（点选项）和 /send（选框期直接打字回答）共用。
function answerAsk(id: string, picks: string[][]): boolean {
  if (!pendingAsk) return false;
  if (id && id !== pendingAsk.id) return false;   // 过期回答，忽略
  const ask = pendingAsk;
  pendingAsk = null;
  const flat = picks.flat().filter(Boolean);
  broadcast({ type: "ask_answered", id: ask.id, picks });
  broadcast({ type: "user", text: "（已选）" + (flat.length ? flat.join("、") : "—") });
  broadcast({ type: "status", text: "思考中…" });
  if (process.env.CC_DEBUG) console.error(`[answer] ${ask.id} picks=${JSON.stringify(picks)}`);
  ask.resolve(picks);   // 唤醒挂起的 ctx.ask（引擎据 picks 构造它自己要的 input）
  return true;
}

// 取 seq 之后的所有事件（since=0 或负数=从头，含刚铺的历史）
function eventsSince(since: number): Ev[] {
  if (since <= 0) return EVENTS.slice();
  // EVENTS 按 seq 递增，二分找第一个 > since 的位置
  let lo = 0, hi = EVENTS.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (EVENTS[m].seq <= since) lo = m + 1; else hi = m; }
  return EVENTS.slice(lo);
}

// 首次拉取时把最近 HISTORY_TAIL 条历史铺进事件流（只铺一次，首屏轻）。
// 更早的历史支持懒加载：前端滑到顶时调 GET /history?before=<idx> 往前再取一页。
// 分页游标 = 解析后历史数组（HISTORY_CACHE）的下标：首屏铺的是 [firstShownIdx, len)，
// 再往前就取 [max(0, before-limit), before)。
const HISTORY_TAIL = 12;
const HISTORY_PAGE = 20;   // 每次往前翻加载多少条
let historyLoaded = false;
let HISTORY_CACHE: any[] = [];   // 首拉时缓存整段解析结果，供 /history 分页复用
let firstShownIdx = 0;           // 已经铺给前端的最早那条在 HISTORY_CACHE 里的下标
function ensureHistoryLoaded() {
  if (historyLoaded) return;
  historyLoaded = true;
  if (!SESSION_ID) return;
  HISTORY_CACHE = engine.readHistory(SESSION_ID, CWD);
  const all = HISTORY_CACHE;
  if (!all.length) return;
  firstShownIdx = Math.max(0, all.length - HISTORY_TAIL);
  const hist = all.slice(firstShownIdx);
  broadcast({ type: "history_start", count: hist.length, truncated: firstShownIdx > 0 });
  for (const ev of hist) broadcast(ev);
  broadcast({ type: "history_end" });
}

// 往前取一页更早的历史。before 省略时用 firstShownIdx（"当前最早那条之前"）。
// 返回 { events, hasMore, before }：events 是更早的一批（时间正序），
// before 是这一批里最早那条的下标——前端下次把它当 before 再往前翻。
function olderHistory(beforeArg: number | null) {
  const before = beforeArg == null ? firstShownIdx : Math.max(0, Math.min(beforeArg, HISTORY_CACHE.length));
  const start = Math.max(0, before - HISTORY_PAGE);
  const events = HISTORY_CACHE.slice(start, before);
  return { events, hasMore: start > 0, before: start };
}

// ---- 持续会话驱动器 ----
// 事件翻译、历史解析、AskUserQuestion 的 input 拼装、流式输入 / interrupt 都在引擎里；
// 这里整段会话只 startSession 一次（首条消息时懒起），之后所有消息都往这个句柄里喂。
let session: EngineSession | null = null;

function ensureSession(): EngineSession {
  if (session) return session;
  const gen = sessionGen;   // 绑定这段会话的代次；被中断 bump 后它的迟到事件会被 engineEmit 丢弃
  session = engine.startSession({
    resumeSessionId: SESSION_ID,
    model: MODEL,
    cwd: CWD,
    emit: (ev: any) => engineEmit(gen, ev),
    ask: askUser,
    debug: !!process.env.CC_DEBUG,
  });
  return session;
}

// 硬中断：作废当前会话（bump 代次丢弃其迟到事件）、掐断生成、清掉挂起的选框、置闲。
// 下条消息会懒起一个新的 resume 会话，接上历史继续。
function abortSession() {
  if (session) session.abort();
  session = null;
  sessionGen++;   // 作废：之前那段会话之后 emit 的事件全丢
  running = false;
  if (pendingAsk) { broadcast({ type: "ask_clear", id: pendingAsk.id }); pendingAsk = null; }
}

// 外部入口：发一条消息。
// - 空闲时：直接 send，正常开一轮。
// - 忙时（agent 在内部轮次里跑）：interrupt——把消息插进当前内部轮次的间隙（像真实 Claude），
//   保留上下文、接着干，不丢弃在途工作。
function submitPrompt(text: string) {
  const busy = running && !!session;   // 先看当前忙闲（下面会置真）
  broadcast({ type: "user", text });   // 立刻回显用户气泡
  broadcast({ type: "status", text: busy ? "插入到当前轮次…" : "思考中…" });
  const s = ensureSession();
  running = true;
  if (busy) s.interrupt(text);   // 忙 → 插进内部轮次
  else s.send(text);             // 闲 → 正常开一轮
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

  // 懒加载更早的历史：GET /history?before=<idx> → { events, hasMore, before }
  // 前端滑到顶时调用；把 events 逆着 prepend 到列表顶部，用返回的 before 作下次游标。
  if (req.method === "GET" && path === "/history") {
    ensureHistoryLoaded();   // 保证 HISTORY_CACHE 已就绪
    const raw = url.searchParams.get("before");
    const before = raw == null || raw === "" ? null : (Number(raw) || 0);
    const { events, hasMore, before: nextBefore } = olderHistory(before);
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ events, hasMore, before: nextBefore }));
    return;
  }

  if (req.method === "POST" && path === "/send") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let text = "", mode = "queue";
      try { const j = JSON.parse(body); text = j.text ?? ""; mode = j.mode ?? "queue"; } catch {}
      text = String(text).trim();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      // 选框优先：正挂着待答的 AskUserQuestion 时，这条消息一律当成对它的回答，
      // 不走插入/打断——堵住「消息卡在选框弹出前后被吞」的竞态。前端一般已在选框期
      // 改走 /answer，这里是后端权威兜底（消息比选框事件早到、或前端判断没跟上时）。
      if (pendingAsk) {
        if (text) answerAsk(pendingAsk.id, [[text]]);   // 自由文字当回答
        return;                                          // 空消息在选框期直接忽略，别误动选框那轮
      }
      // mode=interrupt：空白发送 = 硬打断——掐断当前生成、丢弃在途工作（Ctrl-C 语义）。
      // mode=queue：有文字——插进当前内部轮次的间隙（忙时）或正常开一轮（闲时），保留上下文。
      if (mode === "interrupt") {
        if (running && session) abortSession();
        return;
      }
      if (!text) return;
      submitPrompt(text);
    });
    return;
  }

  // 回答 AskUserQuestion：body = { id, picks: string[][] }
  // picks[i] 是第 i 个问题选中的 label 数组（单选就 1 个，多选可多个）。
  if (req.method === "POST" && path === "/answer") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let id = "", picks: string[][] = [];
      try { const j = JSON.parse(body); id = j.id ?? ""; picks = Array.isArray(j.picks) ? j.picks : []; } catch {}
      if (!pendingAsk) {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "没有待回答的问题" }));
        return;
      }
      if (id && id !== pendingAsk.id) {
        // 过期的回答（可能是上一个问题的按钮），忽略。
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "问题已过期" }));
        return;
      }
      answerAsk(id, picks);   // 回显 + 唤醒引擎（与 /send 选框兜底共用同一逻辑）
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // 硬中断当前生成（Ctrl-C / 前端按钮触发）：掐断、丢弃在途工作。不关服务。
  // 会话句柄作废（下条消息会懒起一个新的 resume 会话，接上历史继续）。
  if (req.method === "POST" && path === "/interrupt") {
    const aborted = running && !!session;
    if (aborted) abortSession();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, aborted }));
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`claude-chat 后端已启动: http://127.0.0.1:${PORT}`);
  console.log(`会话: ${SESSION_ID ? "resume " + SESSION_ID : "新开"}  模型: ${MODEL ?? "默认"}  目录: ${CWD}`);
});
