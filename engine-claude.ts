// Claude 引擎：把 @anthropic-ai/claude-agent-sdk 的 query() 封装成 Engine 契约。
// 这里的 runPrompt / readHistory / toolSummary / buildAskUpdatedInput 都是从原 server.ts
// 原样搬过来的——行为不变，只是把「跟 Claude 绑死的部分」收拢到这一个文件。
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Engine, EngineRunContext } from "./engine.ts";

// 把前端提交的答案拼进 AskUserQuestion 期望的 input 结构。
// 关键：SDK 期望 updatedInput 顶层有个 answers 字段，类型是 Record<问题文本, 答案字符串>，
// 多选答案用逗号拼成一个字符串（见 cli.js 里 YN0 schema：answers: record(string,string)，
// 描述 "question text -> answer string; multi-select answers are comma-separated"）。
// 之前错塞成 questions[i].answers=[...]，SDK 读不到 → 拿到空答案。
function buildAskUpdatedInput(input: any, picks: string[][]): Record<string, unknown> {
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  const answers: Record<string, string> = {};
  questions.forEach((q: any, i: number) => {
    const qText = String(q?.question ?? `Q${i + 1}`);
    answers[qText] = (picks[i] ?? []).join(",");
  });
  return { ...input, answers };
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

// ---- 读取会话历史（.jsonl），转成一串可直接渲染的气泡事件 ----
// Claude Code 把历史存在 ~/.claude/projects/<slug>/<session-id>.jsonl，
// slug 是把项目目录路径里的 "/" 和 "." 都换成 "-"（例：/home/alice/proj → -home-alice-proj）。
function slugForCwd(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}
function historyFile(sessionId: string, cwd: string): string | null {
  const base = join(homedir(), ".claude", "projects");
  // 先按 cwd 的 slug 找；找不到就在所有项目目录里搜同名文件（SDK 也是全局搜的）。
  const direct = join(base, slugForCwd(cwd), `${sessionId}.jsonl`);
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
function readHistory(sessionId: string, cwd: string): any[] {
  const file = historyFile(sessionId, cwd);
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

// ---- 驱动一次 claude 调用，把事件翻译成聊天用的简单协议推给前端 ----
async function runPrompt(prompt: string, ctx: EngineRunContext): Promise<void> {
  if (ctx.debug) console.error(`[runPrompt] prompt=${JSON.stringify(prompt)} resume=${ctx.resumeSessionId ?? "(新)"}`);

  // SDK 需要 AbortController；把 server 传来的中性 signal 转接成一个 controller。
  const abort = new AbortController();
  if (ctx.signal.aborted) abort.abort();
  else ctx.signal.addEventListener("abort", () => abort.abort());

  let streamedText = false;   // 这一轮有没有通过 stream_event 实时吐过文字
  const iter = query({
    prompt,
    options: {
      ...(ctx.resumeSessionId ? { resume: ctx.resumeSessionId } : {}),
      // 注意：不能再用 bypassPermissions——那样 SDK 会跳过 canUseTool 回调，
      // 就没机会拦 AskUserQuestion 让手机回答了。改用 canUseTool：默认全放行（MVP 保持
      // 工具自动允许），唯独 AskUserQuestion 挂起等手机点选项。
      canUseTool: async (toolName: string, input: Record<string, unknown>) => {
        if (toolName === "AskUserQuestion") {
          const questions = Array.isArray((input as any).questions) ? (input as any).questions : [];
          const picks = await ctx.ask(questions);
          return { behavior: "allow" as const, updatedInput: buildAskUpdatedInput(input, picks) };
        }
        return { behavior: "allow" as const, updatedInput: input };
      },
      includePartialMessages: true,               // token 级增量
      ...(ctx.model ? { model: ctx.model } : {}),
      cwd: ctx.cwd,
      abortController: abort,
    },
  });

  for await (const message of iter) {
    if (ctx.debug) {
      let d = "";
      if (message.type === "assistant") d = JSON.stringify((message as any).message?.content)?.slice(0, 120);
      else if (message.type === "result") d = (message as any).subtype;
      console.error(`[msg] ${message.type}${(message as any).subtype ? "/" + (message as any).subtype : ""} ${d}`);
    }
    if (message.type === "system" && message.subtype === "init") {
      // 会话 id 由 server 从这条 session 事件里捕获，后续接着聊。
      ctx.emit({ type: "session", sessionId: message.session_id });

    } else if (message.type === "stream_event") {
      const ev: any = message.event;
      // 工具开始的即时提示：stream 里 content_block_start 时 input 还是空的（参数随后才 delta 出来），
      // 所以这里只发一个"工具开始"占位；完整参数由下面的 assistant 消息补齐成 tool_use 详情。
      if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
        // AskUserQuestion 不发工具占位——它由 canUseTool 拦下并广播成可交互的 ask 事件，
        // 免得又冒一条 🔧 占位气泡跟提问按钮打架。
        if (ev.content_block.name !== "AskUserQuestion") ctx.emit({ type: "tool_start", name: ev.content_block.name });
      } else if (ev.type === "content_block_delta") {
        if (ev.delta?.type === "text_delta") {
          ctx.emit({ type: "text_delta", text: ev.delta.text });
          streamedText = true;
        }
        // input_json_delta（工具参数分片）不再逐片发——手机端拼不起来也没意义；
        // 完整参数走 assistant 消息一次性发出。
      } else if (ev.type === "content_block_stop") {
        ctx.emit({ type: "block_stop" });
      }

    } else if (message.type === "assistant") {
      // assistant 消息里 tool_use 块的 input 是**完整**的——无论走没走 token 流，
      // 都从这里把工具的完整参数发出去（带一行人类可读摘要），手机才看得到"在干什么"。
      const content: any = (message as any).message?.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === "tool_use") {
            // AskUserQuestion 跳过——已由 canUseTool 广播成交互式 ask 事件。
            if (b.name !== "AskUserQuestion") ctx.emit({ type: "tool_use", name: b.name, summary: toolSummary(b.name, b.input), input: b.input ?? {} });
          } else if (!streamedText && b?.type === "text" && b.text) {
            // 兜底：这一轮没走 token 流（短回复/某些路径），从完整消息补发文字，
            // 否则手机端会从"思考中"直接跳到"完成"、看不到回复。
            ctx.emit({ type: "text_delta", text: b.text });
            ctx.emit({ type: "block_stop" });
          }
        }
      } else if (!streamedText && typeof content === "string" && content) {
        ctx.emit({ type: "text_delta", text: content });
        ctx.emit({ type: "block_stop" });
      }

    } else if (message.type === "result") {
      ctx.emit({ type: "done", subtype: message.subtype, sessionId: message.session_id });
    }
  }
}

export const claudeEngine: Engine = { runPrompt, readHistory };
