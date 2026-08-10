// claude-chat 的电脑端跟看（Ink/TUI 版）：连本地轮询接口，把事件渲染成
// 「上方内容区滚动 + 底部固定输入框」的界面——生成中也能打字、退格删整个汉字、
// 上/下箭头翻历史，长段落自动折行由 Ink 负责，不再手搓光标序列。
// 用法（由 claude-chat 调用）：PORT=.. SECRET=.. [FULL_URL=..] [PID_FILE=..] node watch.mjs
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import React, { useState, useEffect, useRef } from "react";
import { render, Box, Text, Static, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import htm from "htm";

const html = htm.bind(React.createElement);

const PORT = process.env.PORT;
const SECRET = process.env.SECRET;
const FULL_URL = process.env.FULL_URL || "";
const PID_FILE = process.env.PID_FILE;
if (!PORT || !SECRET) { console.error("缺 PORT/SECRET"); process.exit(1); }

const BASE = `http://127.0.0.1:${PORT}/${SECRET}/`;
const stamp = () => new Date().toTimeString().slice(0, 8);

// ── 后端交互（跟手机同一套接口）───────────────────────────────────────────
async function postInterrupt() {
  try { await fetch(`${BASE}interrupt`, { method: "POST" }); } catch {}
}
async function postSend(text, mode = "queue") {
  try {
    await fetch(`${BASE}send`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, mode }),
    });
  } catch {}
}
async function postAnswer(id, picks) {
  try {
    const r = await fetch(`${BASE}answer`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, picks }),
    });
    if (!r.ok) { const j = await r.json().catch(() => ({})); return j.error || ("HTTP " + r.status); }
  } catch (e) { return e.message; }
  return null;
}

// 把终端输入（"1;2"、"1,3"）解析成 picks: string[][]（每题选中的 label 数组）。
function parseAnswer(line, questions) {
  const perQ = line.split(";").map((s) => s.trim());
  return questions.map((q, qi) => {
    const opts = q.options || [];
    const chunk = perQ[qi] ?? perQ[0] ?? "";   // 单题时允许不带分号
    const nums = chunk.split(/[, ]+/).map((s) => parseInt(s, 10)).filter((n) => n >= 1 && n <= opts.length);
    const labels = nums.map((n) => { const op = opts[n - 1]; return typeof op === "string" ? op : (op.label || ""); });
    return [...new Set(labels)];
  });
}

function shutdownAll() {
  // 1) kill pid 文件里记录的父进程
  try {
    for (const line of readFileSync(PID_FILE, "utf8").split("\n")) {
      const pid = parseInt(line.trim(), 10);
      if (pid) { try { process.kill(pid, "SIGTERM"); } catch {} }
    }
  } catch {}
  // 2) 兜底按名清这一份的 server + cloudflared
  const kill = (pat) => { try { execSync(`pkill -f ${JSON.stringify(pat)}`, { stdio: "ignore" }); } catch {} };
  kill(`/claude-chat/server.ts`);
  kill(`cloudflared tunnel --url http://127.0.0.1:${PORT}`);
}

// ── 事件 → 已定格的显示行（committed lines）────────────────────────────────
// 每条 committed line = { key, node }（React 元素），交给 <Static> 只渲染一次、
// 之后滚动到上方。正在流式的 AI 文本单独放 live 状态，实时刷新。
function urlLines() {
  if (!FULL_URL) return [];
  return [
    { kind: "url", text: "📱 手机浏览器打开（末尾暗号不能少）:" },
    { kind: "urlval", text: FULL_URL },
  ];
}

function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [lines, setLines] = useState(() => [
    { kind: "hint", text: "claude-chat 跟看中。打字回车发消息（生成中也能打）；↑/↓ 翻历史；空行回车=打断这轮；Ctrl-C 中断/连按两次退出。" },
    ...urlLines(),
  ]);
  const [live, setLive] = useState("");        // 正在流式的 AI 文本（未定格）
  const [input, setInput] = useState("");
  const [status, setStatus] = useState("");    // 底部一行瞬时状态（思考中…/已中断…）

  // 当前待回答的选择题；历史输入（上下键翻）；last Ctrl-C 时间
  const askRef = useRef(null);
  const [askView, setAskView] = useState(null); // 用于展示题面
  const historyRef = useRef([]);                // 发过的普通消息
  const histIdxRef = useRef(-1);                // -1 = 不在翻历史
  const draftRef = useRef("");                  // 翻历史前暂存的草稿
  const lastSigintRef = useRef(0);
  const liveRef = useRef("");                   // 与 live 同步，供闭包读取
  const inHistoryRef = useRef(false);           // 是否在回放历史（旧 ask 不接受回答）

  const key = useRef(0);
  const pushLine = (kind, text) => setLines((L) => [...L, { key: key.current++, kind, text }]);

  const commitLive = () => {
    if (liveRef.current) {
      const t = liveRef.current;
      setLines((L) => [...L, { key: key.current++, kind: "ai", text: t }]);
      liveRef.current = ""; setLive("");
    }
  };

  // ── 轮询事件流 ──
  useEffect(() => {
    let since = 0; let alive = true;
    (async () => {
      while (alive) {
        try {
          const res = await fetch(`${BASE}events?since=${since}`);
          if (res.ok) {
            const data = await res.json();
            for (const ev of data.events || []) {
              if (ev.seq > since) since = ev.seq;
              handle(ev);
            }
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 500));
      }
    })();
    return () => { alive = false; };
  }, []);

  function handle(o) {
    switch (o.type) {
      case "history_start":
        inHistoryRef.current = true;
        pushLine("sep", `┄┄ 历史（${o.count} 条）┄┄`);
        break;
      case "history_end":
        inHistoryRef.current = false;
        pushLine("sep", "┄┄ 以上为历史，下面是实时 ┄┄");
        for (const l of urlLines()) pushLine(l.kind, l.text);
        break;
      case "session":
        pushLine("sep", `── 会话 ${String(o.sessionId || "").slice(0, 8)} ──`);
        break;
      case "user":
        commitLive();
        pushLine("user", o.text);
        break;
      case "ai":
        commitLive();
        pushLine("ai", o.text);
        break;
      case "status":
        if (!inHistoryRef.current) setStatus(o.text || "");
        break;
      case "tool_start":
        break; // 占位，详情由 tool_use 打
      case "tool_use":
        commitLive();
        pushLine("tool", `🔧 ${o.name}${o.summary ? " " + o.summary : ""}`);
        break;
      case "ask": {
        commitLive();
        if (inHistoryRef.current) break;
        const questions = Array.isArray(o.questions) ? o.questions : [];
        askRef.current = { id: o.id, questions };
        setAskView({ id: o.id, questions });
        break;
      }
      case "ask_answered":
        if (askRef.current && askRef.current.id === o.id) { askRef.current = null; setAskView(null); }
        break;
      case "ask_clear":
        if (askRef.current && askRef.current.id === o.id) {
          askRef.current = null; setAskView(null); pushLine("dim", "（问题已取消）");
        }
        break;
      case "text_delta":
        setStatus("");
        liveRef.current += o.text;
        setLive(liveRef.current);
        break;
      case "block_stop":
        commitLive();
        break;
      case "done":
        commitLive();
        setStatus("");
        pushLine("dim", "✓ 完成");
        break;
      case "error":
        commitLive();
        pushLine("err", "⚠️ " + o.message);
        break;
    }
  }

  // ── 键盘：Ctrl-C（中断/双击退出）、↑/↓ 翻历史 ──
  useInput((inputCh, k) => {
    if (k.ctrl && inputCh === "c") {
      const now = Date.now();
      if (now - lastSigintRef.current < 1500) {
        shutdownAll();
        exit();
        setTimeout(() => process.exit(0), 50);
        return;
      }
      lastSigintRef.current = now;
      setStatus("↯ 已请求中断当前生成（1.5秒内再按一次 Ctrl-C 退出并全关）");
      postInterrupt();
      return;
    }
    // 上/下翻历史（只翻发过的普通消息）
    if (k.upArrow) {
      const H = historyRef.current;
      if (!H.length) return;
      if (histIdxRef.current === -1) { draftRef.current = input; histIdxRef.current = H.length; }
      histIdxRef.current = Math.max(0, histIdxRef.current - 1);
      setInput(H[histIdxRef.current]);
      return;
    }
    if (k.downArrow) {
      const H = historyRef.current;
      if (histIdxRef.current === -1) return;
      histIdxRef.current += 1;
      if (histIdxRef.current >= H.length) { histIdxRef.current = -1; setInput(draftRef.current); }
      else setInput(H[histIdxRef.current]);
      return;
    }
  });

  function onSubmit(value) {
    const text = value.trim();
    setInput("");
    histIdxRef.current = -1; draftRef.current = "";
    // 待回答选择题：按编号解析走 /answer
    const ask = askRef.current;
    if (ask) {
      if (!text) return;
      const picks = parseAnswer(text, ask.questions);
      if (picks.every((p) => p.length === 0)) {
        setStatus("没识别到有效编号；每题至少选一个，如 1 或 1,3 或 1;2");
        return;
      }
      const id = ask.id;
      askRef.current = null; setAskView(null);
      postAnswer(id, picks).then((err) => { if (err) pushLine("err", "⚠️ 回答失败：" + err); });
      return;
    }
    // 普通消息：有文字=排队插入并记进历史；空行=打断当前这轮
    if (!text) { postSend("", "interrupt"); return; }
    historyRef.current = [...historyRef.current, text];
    postSend(text, "queue");
    // 不本地回显——server 会广播 user 事件，轮询拉回来统一显示，避免重复。
  }

  const color = { user: "green", ai: "cyan", tool: "yellow", err: "red", dim: "gray", sep: "gray", hint: "gray", url: "yellow", urlval: "cyan" };
  const rows = stdout?.rows || 24;

  return html`
    <${Box} flexDirection="column">
      <${Static} items=${lines}>
        ${(l) => html`
          <${Box} key=${l.key ?? l.kind}>
            <${Text} color=${color[l.kind] || undefined} bold=${l.kind === "user" || l.kind === "url" || l.kind === "urlval"}>
              ${l.kind === "user" ? "你 ▸ " : l.kind === "ai" ? "Claude ◂ " : l.kind === "tool" ? "" : ""}${l.text}
            <//>
          <//>
        `}
      <//>
      ${live ? html`<${Box}><${Text} color="cyan" bold>Claude ◂ <//><${Text}>${live}<//><//>` : null}
      ${askView ? html`
        <${Box} flexDirection="column" marginTop=${1}>
          <${Text} color="yellow" bold>❓ Claude 在提问（回复选项编号，多题用 ; 分隔，多选用逗号）：<//>
          ${askView.questions.map((q, qi) => html`
            <${Box} key=${qi} flexDirection="column">
              <${Text} bold>  Q${qi + 1}. ${q.question || ""}${q.multiSelect ? "（可多选）" : ""}<//>
              ${(q.options || []).map((op, oi) => {
                const label = typeof op === "string" ? op : (op.label || "");
                const desc = typeof op === "string" ? "" : (op.description || "");
                return html`<${Text} key=${oi}>     <${Text} color="cyan">${oi + 1})<//> ${label}${desc ? " — " + desc : ""}<//>`;
              })}
            <//>
          `)}
          <${Text} color="gray">     例：单题单选输 1；单题多选输 1,3；两题输 1;2<//>
        <//>
      ` : null}
      ${status ? html`<${Box}><${Text} color="gray">… ${status}<//><//>` : null}
      <${Box}>
        <${Text} color="green" bold>你 ▸ <//>
        <${TextInput} value=${input} onChange=${setInput} onSubmit=${onSubmit} placeholder="" />
      <//>
    <//>
  `;
}

// exitOnCtrlC:false —— 关掉 Ink 默认的「按一次 Ctrl-C 立刻退出」。
// 否则 Ink 自己会在第一次 Ctrl-C 就退出，且 useInput 对 ctrl+c 直接跳过不回调，
// 我们「先中断这轮、1.5s 内再按一次才全退」的逻辑根本收不到键。
render(html`<${App} />`, { exitOnCtrlC: false });
