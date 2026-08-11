// claude-chat 的电脑端跟看（Ink/TUI 版）：连本地轮询接口，把事件渲染成
// 「上方内容区滚动 + 底部固定输入框」的界面——生成中也能打字、退格删整个汉字、
// 上/下箭头翻历史、Option/Alt+←/→ 按单词跳，长段落自动折行由 Ink 负责，不再手搓光标序列。
// 用法（由 claude-chat 调用）：PORT=.. SECRET=.. [FULL_URL=..] [PID_FILE=..] node watch.mjs
import { execSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import React, { useState, useEffect, useRef } from "react";
import { render, Box, Text, Static, useApp, useInput, useStdout, useCursor } from "ink";
import stringWidth from "string-width";
import htm from "htm";

const html = htm.bind(React.createElement);

// ── 自带的单行输入框（替掉 ink-text-input）──────────────────────────────────
// 为什么自己写：ink-text-input 把光标 offset 藏在内部 state 里、不暴露，没法从外部
// 实现「按单词跳」；且它对 meta+箭头/Option+f/b 一概不认。这里全盘接管，光标以
// **码点**为单位（和退格删整个汉字一致），并支持 macOS 的 Option/Alt 词跳。
// 注意：不吞 ↑/↓（留给父组件翻历史）和 Ctrl-C（留给父组件中断/退出）。
const isWordChar = (ch) => !!ch && !/\s/.test(ch);
// 从 cursor 往左找上一个「词首」的码点下标。
function wordLeft(cps, cursor) {
  let i = cursor;
  while (i > 0 && !isWordChar(cps[i - 1])) i--;   // 先跳过左侧空白
  while (i > 0 && isWordChar(cps[i - 1])) i--;     // 再跳过整个词
  return i;
}
// 从 cursor 往右找下一个「词尾之后」的码点下标。
function wordRight(cps, cursor) {
  const n = cps.length;
  let i = cursor;
  while (i < n && !isWordChar(cps[i])) i++;        // 跳过右侧空白
  while (i < n && isWordChar(cps[i])) i++;          // 跳过整个词
  return i;
}

function Input({ value, onChange, onSubmit, focus = true, prompt = "", promptWidth = 0, baseLine = 0 }) {
  const cps = [...value];                          // 按码点切，索引即光标位置
  const [cursor, setCursor] = useState(cps.length);
  const cur = Math.max(0, Math.min(cursor, cps.length));
  const { setCursorPosition } = useCursor();       // 把**真实**终端光标移到输入位，让中文输入法候选框跟手

  const setBoth = (nextCps, nextCursor) => {
    setCursor(nextCursor);
    onChange(nextCps.join(""));
  };

  useInput((input, key) => {
    // 交回父组件处理的键：不动、直接放行。
    if (key.upArrow || key.downArrow || (key.ctrl && input === "c")) return;

    // Shift+Enter = 在光标处插换行（不提交）；普通 Enter = 提交。
    // 依赖 Kitty keyboard protocol（启动时已 push CSI>1u），否则终端把两者都发成 \r，
    // Ink 读到的 key.shift 恒为 false → 退化成「Enter 直接发送」，功能自然降级、不报错。
    if (key.return && key.shift) {
      setBoth([...cps.slice(0, cur), "\n", ...cps.slice(cur)], cur + 1);
      return;
    }
    if (key.return) { onSubmit?.(value); return; }

    // Option/Alt 词跳：macOS 默认 Option+←/→ 发 ESC b / ESC f（input=b/f + meta），
    // iTerm「Esc+」模式发 ESC[1;3D/C（leftArrow/rightArrow + meta）。两种都认。
    const metaWord = key.meta && (key.leftArrow || key.rightArrow || input === "b" || input === "f");
    if (metaWord) {
      if (key.leftArrow || input === "b") setCursor(wordLeft(cps, cur));
      else setCursor(wordRight(cps, cur));
      return;
    }
    // Option+Delete = 删掉左边一个词（macOS 习惯）
    if (key.meta && (key.backspace || key.delete)) {
      const from = wordLeft(cps, cur);
      setBoth([...cps.slice(0, from), ...cps.slice(cur)], from);
      return;
    }
    // 行首 / 行尾：Home、End，以及 Ctrl-A / Ctrl-E（顺手支持，几乎零成本）
    if (key.home || (key.ctrl && input === "a")) { setCursor(0); return; }
    if (key.end || (key.ctrl && input === "e")) { setCursor(cps.length); return; }

    if (key.leftArrow) { setCursor(Math.max(0, cur - 1)); return; }
    if (key.rightArrow) { setCursor(Math.min(cps.length, cur + 1)); return; }

    if (key.backspace || key.delete) {
      if (cur > 0) setBoth([...cps.slice(0, cur - 1), ...cps.slice(cur)], cur - 1);
      return;
    }

    // 其余当作可打印文本插到光标处（含中文/粘贴的多字符）。
    // 过滤掉落单的控制字符（未被上面识别的转义序列残余），别把乱码塞进输入。
    if (input && !key.ctrl && !key.meta) {
      const ins = [...input].filter((c) => c >= " " || c === "\t");
      if (ins.length) setBoth([...cps.slice(0, cur), ...ins, ...cps.slice(cur)], cur + ins.length);
    }
  }, { isActive: focus });

  const before = cps.slice(0, cur).join("");
  const atChar = cur < cps.length ? cps[cur] : " ";
  const after = cur < cps.length ? cps.slice(cur + 1).join("") : "";

  // focus 时**一直**钉真实终端光标到输入位——包括输入为空时。
  // 中文输入法的未上屏拼音串是画在**真实光标**处的：空输入时若把光标交还 Ink
  // （setCursorPosition(undefined)），Ink 不把光标定到 你 ▸ 后，而是留在重画区原点（列 0），
  // 拼音就从列 0 顶格画、和上面的 你 ▸ 分成两行——只有走输入法、且拼音还没上屏（value 空）时才犯。
  // 早先空输入交还 Ink 是为治「流式输出时候选框被往上拽」，那其实是 baseLine 抖动，现已算准，可放心常钉。
  if (focus) {
    // useCursor 的 y 相对**动态重画区**顶部（<Static> 提交的历史行不计入）。
    // baseLine = 输入块上方的动态行数（live/status/askView，由父组件算好传入）。
    // 多行输入（Shift+Enter 插了 \n）：光标前文本按 \n 拆逻辑行——
    //   y 加上「前面完整逻辑行各自的折行数」＋「当前逻辑行内的折行数」；
    //   x 是当前逻辑行内、光标前那截的显示宽 % cols。
    //   提示符宽只算在第一逻辑行（其余逻辑行顶格，无提示符）。
    const cols = Math.max(1, process.stdout.columns || 80);
    const bParts = before.split("\n");
    let y = baseLine;
    for (let i = 0; i < bParts.length - 1; i++) {           // 完整逻辑行（光标不在其内）
      const w = (i === 0 ? promptWidth : 0) + stringWidth(bParts[i]);
      y += Math.max(1, Math.ceil(w / cols));                // 空行也占 1 行
    }
    const lastIdx = bParts.length - 1;
    const lastCells = (lastIdx === 0 ? promptWidth : 0) + stringWidth(bParts[lastIdx]);
    y += Math.floor(lastCells / cols);
    setCursorPosition({ x: lastCells % cols, y });
    // 提示符和输入文本同一个 <Text>——超宽时连续折行，提示符不会被落单在上一行。
    // value 里的 \n 交给 Ink 自然分行渲染。
    return html`<${Text}><${Text} color="green" bold>${prompt}<//>${value}<//>`;
  }

  // 未 focus：不占用真实光标，反显一个占位好看到落点。
  setCursorPosition(undefined);
  return html`<${Text}><${Text} color="green" bold>${prompt}<//>${before}<${Text} inverse>${atChar}<//>${after}<//>`;
}

// 输入提示符 "你 ▸ " 的显示宽度（中文 2 列）——用它算真实光标的起始列。
// 从常量算，改提示符时这里自动跟着变。
const PROMPT = "你 ▸ ";
const PROMPT_WIDTH = stringWidth(PROMPT);

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
  // 2) 兜底清 server + 隧道。
  // 为什么 server 还得兜：pid 文件里记的是 nohup 起的**顶层 npm exec** pid，
  // 其下 npm→tsx→node(server.ts) 三层同属一个进程组，但 npm exec 未必把 SIGTERM
  // 转发给子进程——只杀顶层，真正 listen 的 node(server.ts) 可能变孤儿继续占端口。
  // 又不能按进程组杀：本 watch 进程和 server 同组（脚本 exec 成 watch），会自杀。
  //
  // 关键：server 必须按**本份端口**精确定位，不能按 server.ts 路径 pkill——
  // 多份并存时所有份都是同一个仓库路径，`pkill -f .../server.ts` 会把**每一份**的
  // server 一起杀掉（正是「关一份连别的后台也关了」的真凶）。改用 lsof 抓监听本份
  // PORT 的那个进程：端口是每份唯一的，只命中本份，且直达真正 listen 的 node（绕开
  // npm exec 不转发信号的坑）。
  const kill = (pat) => { try { execSync(`pkill -f ${JSON.stringify(pat)}`, { stdio: "ignore" }); } catch {} };
  try {
    const pids = execSync(`lsof -ti tcp:${PORT} -sTCP:LISTEN`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString().split("\n").map((s) => parseInt(s.trim(), 10)).filter(Boolean);
    for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch {} }
  } catch {}   // lsof 没命中（server 已退）会非零退出，忽略
  // 隧道两种后端都兜（哪种在跑就命中哪种，另一种匹配不到、无副作用）。都按**本份端口**精确匹配。
  // cloudflared：命令行带 --url http://127.0.0.1:<端口>，模式要和启动脚本一致（含 --protocol http2）。
  kill(`cloudflared tunnel --protocol http2 --url http://127.0.0.1:${PORT}`);
  // ngrok：命令行是 `ngrok http <端口> ...`，用 http <端口> 精确到本份（词末空格防 8791 前缀误伤别份）。
  kill(`ngrok http ${PORT} `);
  // 3) 删掉自己的 pid 文件，别在 /tmp 里越堆越多（启动脚本按它占用来选端口号）。
  try { unlinkSync(PID_FILE); } catch {}
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
    { kind: "hint", text: "claude-chat 跟看中。打字回车发消息（生成中也能打）；Shift+Enter 换行；↑/↓ 翻历史；空行回车=打断这轮；Ctrl-C 中断/连按两次退出。" },
    ...urlLines(),
  ]);
  const [live, setLive] = useState("");        // 正在流式的 AI 文本（未定格）
  const [input, setInput] = useState("");
  const [status, setStatus] = useState("");    // 底部一行瞬时状态（思考中…/已打断…）

  // 当前待回答的选择题；历史输入（上下键翻）；last Ctrl-C 时间
  const askRef = useRef(null);
  const [askView, setAskView] = useState(null); // 用于展示题面
  const historyRef = useRef([]);                // 发过的普通消息
  const histIdxRef = useRef(-1);                // -1 = 不在翻历史
  const draftRef = useRef("");                  // 翻历史前暂存的草稿
  const lastSigintRef = useRef(0);
  const liveRef = useRef("");                   // 与 live 同步，供闭包读取
  const inHistoryRef = useRef(false);           // 是否在回放历史（旧 ask 不接受回答）
  const sessionIdRef = useRef("");              // 当前会话 id（退出时打出来供 resume）

  const key = useRef(0);
  const pushLine = (kind, text) => setLines((L) => [...L, { key: key.current++, kind, text }]);

  const commitLive = () => {
    if (liveRef.current) {
      const t = liveRef.current;
      setLines((L) => [...L, { key: key.current++, kind: "ai", text: t }]);
      liveRef.current = ""; setLive("");
    }
  };

  // ── 轮询事件流（带看门狗）──
  // 后端 server 若自己崩了/被杀，cloudflared 隧道还活着 → 手机对着空端口就是 502/Bad gateway。
  // 这里连续多次拉不到本地 server 就判定后端已死，主动把这一份隧道也关掉并提示，
  // 而不是让手机干等 502。（DEAD_AFTER 次 × 500ms ≈ 判定阈值）
  useEffect(() => {
    let since = 0; let alive = true;
    let fails = 0;
    const DEAD_AFTER = 20;   // ~10s 连不上就认定后端挂了
    let bootstrapped = false; // 至少成功连过一次，才允许触发"后端已死"（避免启动竞态误杀）
    (async () => {
      while (alive) {
        try {
          // 带超时：后端若"接受连接但不回应"（卡死/半死），fetch 不加超时会一直挂着，
          // 看门狗永远等不到失败。3s 收不到就当这次失败。
          const res = await fetch(`${BASE}events?since=${since}`, { signal: AbortSignal.timeout(3000) });
          if (res.ok) {
            bootstrapped = true; fails = 0;
            const data = await res.json();
            for (const ev of data.events || []) {
              if (ev.seq > since) since = ev.seq;
              handle(ev);
            }
          } else {
            fails++;
          }
        } catch { fails++; }
        // 曾连上过、之后又连续拉不到 → 后端死了，收拾残局免得留孤儿隧道让手机 502。
        if (bootstrapped && fails >= DEAD_AFTER) {
          alive = false;
          const sid = sessionIdRef.current;
          exit();
          setTimeout(() => {
            process.stdout.write(
              `\n⚠️ 本地后端 server 已不可用（可能崩了或被杀），已关闭隧道以免手机一直 502。\n`
            );
            if (sid) process.stdout.write(`重新连接这段会话:\n  claude-chat ${sid}\n\n`);
            shutdownAll();
            process.exit(1);
          }, 50);
          return;
        }
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
        if (o.sessionId) sessionIdRef.current = o.sessionId;
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
        if (o.sessionId) sessionIdRef.current = o.sessionId;   // 兜底：新会话首轮结束才拿到 id
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
        const sid = sessionIdRef.current;
        exit();                       // 先卸载 Ink，退出 alt-screen、恢复正常终端
        // Ink 卸载后再往真实 stdout 打印 resume 提示——否则会被 alt-screen 清掉看不到。
        setTimeout(() => {
          if (sid) {
            process.stdout.write(
              `\n继续这段会话（接着聊）:\n` +
              `  claude-chat ${sid}\n` +
              `或用官方 CLI 接管:\n` +
              `  claude --resume ${sid}\n\n`
            );
          } else {
            process.stdout.write(`\n（本次没产生可 resume 的会话 id——还没开始对话就退出了。）\n\n`);
          }
          shutdownAll();
          process.exit(0);
        }, 50);
        return;
      }
      lastSigintRef.current = now;
      setStatus("↯ 已请求打断当前生成（1.5秒内再按一次 Ctrl-C 退出并全关）");
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
    // 普通消息：有文字=排队（排进 agent 内部轮次）并记进历史；空行=打断当前这轮
    if (!text) { postSend("", "interrupt"); return; }
    historyRef.current = [...historyRef.current, text];
    postSend(text, "queue");
    // 不本地回显——server 会广播 user 事件，轮询拉回来统一显示，避免重复。
  }

  const color = { user: "green", ai: "cyan", tool: "yellow", err: "red", dim: "gray", sep: "gray", hint: "gray", url: "yellow", urlval: "cyan" };
  const rows = stdout?.rows || 24;

  // 输入块上方的动态行数——喂给 <Input> 定位真实光标（IME 候选框跟手）。
  // <Static> 提交的历史行不参与每帧重画、不计入；只数下面这些动态块的折行。
  const cols = Math.max(1, stdout?.columns || 80);
  // 数一块文本渲染后占几行终端。先按 \n 拆成逻辑行——不拆的话多行内容会被当成一行，
  // baseLine 少算，钉的真光标（连带 IME 候选框）就浮到 live 块顶部去了。
  // 每逻辑行再按列宽折行；prefixW（如 "Claude ◂ "）只加在第一行。
  const wrapLines = (text, prefixW = 0) => {
    const parts = String(text).split("\n");
    let n = 0;
    for (let i = 0; i < parts.length; i++) {
      const w = (i === 0 ? prefixW : 0) + stringWidth(parts[i]);
      n += Math.max(1, Math.ceil(w / cols));         // 空行(w=0)也占 1 行；满行按整除折
    }
    return n;
  };
  let baseLine = 0;
  if (live) baseLine += wrapLines(live, stringWidth("Claude ◂ "));
  if (askView) {
    baseLine += 1;                                   // marginTop=1
    baseLine += 1;                                   // 标题行
    for (const q of askView.questions) {
      baseLine += 1;                                 // Q 行
      baseLine += (q.options || []).length;          // 每个选项一行
    }
    baseLine += 1;                                   // 例子提示行
  }
  if (status) baseLine += 1;

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
      ${live ? html`<${Box}><${Text}><${Text} color="cyan" bold>Claude ◂ <//>${live}<//><//>` : null}
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
        <${Input} value=${input} onChange=${setInput} onSubmit=${onSubmit} prompt=${PROMPT} promptWidth=${PROMPT_WIDTH} baseLine=${baseLine} />
      <//>
    <//>
  `;
}

// ── Kitty keyboard protocol：让终端把 Shift+Enter 和普通 Enter 区分开 ──
// 不开这个，两者都发成 \r、Ink 读到的 key.shift 恒 false，Shift+Enter 就没法换行。
// 开了之后 Shift+Enter 发 CSI 13;2u，Ink 交成 key.return && key.shift（已在 Input 里处理）。
// 支持的终端（iTerm2 3.5+、Kitty、Ghostty、WezTerm）会生效；不支持的会忽略这串，功能自然降级成「Enter 发送」。
// push（CSI>1u = disambiguate escape codes）进栈，退出时**必须**pop（CSI<u），否则协议残留会污染之后的终端会话。
let kittyPopped = false;
function popKitty() {
  if (kittyPopped) return;                 // 幂等：多条退出路径都可能调到
  kittyPopped = true;
  try { process.stdout.write("\x1b[<u"); } catch {}
}
process.on("exit", popKitty);              // 任何退出路径（Ctrl-C 双击、后端已死、异常）兜底 pop

// exitOnCtrlC:false —— 关掉 Ink 默认的「按一次 Ctrl-C 立刻退出」。
// 否则 Ink 自己会在第一次 Ctrl-C 就退出，且 useInput 对 ctrl+c 直接跳过不回调，
// 我们「先中断这轮、1.5s 内再按一次才全退」的逻辑根本收不到键。
render(html`<${App} />`, { exitOnCtrlC: false });

// push 放在 render 之后：等 Ink 接管终端（raw mode + 事件监听就绪）再开启协议，
// 免得启动竞态把这串吃掉。
process.stdout.write("\x1b[>1u");          // push：开启区分模式
