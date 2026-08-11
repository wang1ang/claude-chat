// 引擎契约：server.ts 只依赖这个接口，不认识具体是 Claude 还是别的后端。
// 引擎负责「跑一轮对话」和「读会话历史」，其余（HTTP、轮询、排队、隧道、暗号、
// AskUserQuestion 的挂起/唤醒协调）全在 server.ts 里、与引擎无关。

// 一次运行的上下文：引擎通过 emit 把中性事件吐给前端，通过 ask 挂起等手机作答。
export interface EngineRunContext {
  // resume 的会话 id（新开对话时为 undefined）。
  resumeSessionId: string | undefined;
  // 指定模型（可选）。
  model: string | undefined;
  // 会话绑定的工作目录。
  cwd: string;
  // 中断信号：前端 /interrupt 或 Ctrl-C 时触发；引擎据此掐断当前这轮生成。
  signal: AbortSignal;
  // 把一条中性事件推给前端（就是 server 的 broadcast）。
  // 约定：带 sessionId 字段的事件会被 server 捕获用来更新当前会话 id。
  emit: (event: any) => void;
  // 需要用户在手机上点选时调用：广播成可交互的 ask 事件并挂起，
  // 直到 /answer 带着选择进来，resolve 成 picks（picks[i] = 第 i 问选中的 label 数组）。
  ask: (questions: any[]) => Promise<string[][]>;
  // 是否开调试日志（CC_DEBUG）。
  debug: boolean;
}

export interface Engine {
  // 跑一轮对话。事件通过 ctx.emit 实时吐出；返回值可选带最终 sessionId。
  runPrompt(prompt: string, ctx: EngineRunContext): Promise<void>;
  // 把会话历史（.jsonl 等）解析成可直接渲染的气泡事件序列。
  readHistory(sessionId: string, cwd: string): any[];
}
