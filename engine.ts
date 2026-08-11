// 引擎契约：server.ts 只依赖这个接口，不认识具体是 Claude 还是别的后端。
// 引擎负责「维持一段持续会话」和「读会话历史」，其余（HTTP、轮询、排队、隧道、暗号、
// AskUserQuestion 的挂起/唤醒协调）全在 server.ts 里、与引擎无关。
//
// 为什么是「持续会话」而不是「跑一轮」：
//   旧模型每条消息新起一次 query()（string prompt，单轮即关），插入的消息只能等整轮彻底
//   跑完才处理。要做到「像真实 Claude 那样把消息插进 agent 的内部轮次里」，必须整段会话
//   只开一次 query()、喂一个不结束的输入流（streaming input），server 随时往流里 push
//   新消息；需要立刻插进当前内部轮次的间隙时，再调 interrupt()。

// 一段持续会话的上下文：引擎通过 emit 把中性事件吐给前端，通过 ask 挂起等手机作答。
export interface EngineSessionContext {
  // resume 的会话 id（新开对话时为 undefined）。
  resumeSessionId: string | undefined;
  // 指定模型（可选）。
  model: string | undefined;
  // 会话绑定的工作目录。
  cwd: string;
  // 把一条中性事件推给前端（就是 server 的 broadcast）。
  // 约定：带 sessionId 字段的事件会被 server 捕获用来更新当前会话 id。
  emit: (event: any) => void;
  // 需要用户在手机上点选时调用：广播成可交互的 ask 事件并挂起，
  // 直到 /answer 带着选择进来，resolve 成 picks（picks[i] = 第 i 问选中的 label 数组）。
  ask: (questions: any[]) => Promise<string[][]>;
  // 是否开调试日志（CC_DEBUG）。
  debug: boolean;
}

// 引擎返回的会话句柄：server 用它往会话里喂消息 / 插队 / 结束。
export interface EngineSession {
  // 往会话里送一条用户消息。会排到当前内部轮次链的末尾，跑到边界时自然接上。
  send(text: string): void;
  // 立刻把新消息插进当前内部轮次的间隙（像 CLI 那样）：在最近的内部轮次边界暂停、
  // 保留上下文、把 text 作为新输入接上继续。不是把整轮生成掐死丢弃。
  interrupt(text: string): void;
  // 硬中断：掐断当前生成、丢弃在途内容（对应「空消息打断」/ Ctrl-C）。
  abort(): void;
  // 关闭会话（结束输入流，让 query() 收尾）。
  close(): void;
}

export interface Engine {
  // 开一段持续会话。事件通过 ctx.emit 实时吐出。返回可用来喂消息 / 插队的句柄。
  startSession(ctx: EngineSessionContext): EngineSession;
  // 把会话历史（.jsonl 等）解析成可直接渲染的气泡事件序列。
  readHistory(sessionId: string, cwd: string): any[];
}
