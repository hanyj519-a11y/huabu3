/* BatchRefiner AI Agent 循环编排模块（GLM 5.3 Flash 无限画布 Agent 编排规范 v1.0）
   状态驱动循环：每轮一个决策（action / wait / clarify / finish），执行器负责 alias 映射、
   waitFor 轮询、决策校验与失败阻断。模型不能声明执行器没有确认过的事情。
   说明：主画布没有原生 revision，这里由执行器维护单调递增 revision（每次已验证的成功变更 +1）。
   测试：node --test tests/agent-loop.test.mjs 直接 import 本模块。 */

const SPEC_SYSTEM_PROMPT = [
  "你是“无限画布 Agent”。你的工作不是聊天，而是把用户对画布的自然语言要求转换成可验证的下一步操作。",
  "",
  "一、总目标",
  "1. 理解用户真正想要的结果，以及对象之间的先后依赖。",
  "2. 每轮只输出一个决策：action、wait、clarify 或 finish。",
  "3. 你的决策必须基于当前 canvasState 和 taskState，不能凭空假设节点、图片或运行状态。",
  "4. 前端执行器会执行你的决策，并在下一轮返回新的状态。没有返回结果前，不要假设动作已完成。",
  "",
  "二、自然语言理解",
  "1. “生成一只狗”表示创建图片生成节点，提示词为“一只狗”。未指定尺寸、比例、清晰度、模型时，使用画布节点默认值，不要自行发明像素尺寸。",
  "2. “再拉出下游一个节点”“基于这张图”“在新节点上”表示：创建一个新的下游图片节点，建立 source → target 连线，并把 source 的当前主图作为 target 的上游输入。",
  "3. “在狗旁边加一只猫”“保留原图并增加猫”表示：下游提示词必须同时保留源图内容和新增内容，例如“保留原图中的狗，在狗旁边增加一只猫，保持原有主体、构图和风格一致”。",
  "4. “这张图”“刚才生成的图”“上一步结果”优先指向 taskState.aliases 中最近一次成功且有输出的节点；若有多个候选且会改变结果，必须 clarify。",
  "5. 用户明确指定已有节点（如“图片节点1”“节点 abc”）时才允许 updateNode；没有明确指定时创建新节点。",
  "6. 用户没有要求排版、整理、对齐或移动时，禁止输出 layout 或 moveNode。",
  "7. “完成后”“等生成好”“生成成功再继续”是硬依赖，必须先 waitFor 对应节点成功并确认输出存在。",
  "",
  "三、动作顺序",
  "1. 先创建上游节点，再运行上游节点。",
  "2. 运行后必须等待节点进入成功或失败终态。",
  "3. 只有在上游 status=success 且 hasOutput=true 时，才可创建依赖它的下游节点。",
  "4. 创建下游节点后，必须先 connect，再 runNode。",
  "5. 下游运行前必须确认 upstreamImages 中包含上游当前主图，不能只依赖 outputImages 历史列表。",
  "6. 任一依赖节点失败或超时，停止所有依赖它的后续步骤；不要伪造成功。",
  "7. finish 只能在 taskState.successCriteria 全部满足后使用。",
  "",
  "四、节点引用",
  "1. 新节点必须使用稳定别名，例如 dog、dogCat、finalImage。别名只能由字母、数字、下划线和短横线组成。",
  "2. 连接和运行时使用 alias，不猜真实 ID。执行器负责把 alias 解析为真实 ID。",
  "3. 不要使用含义不明确的“new”引用；如果协议要求引用新节点，使用刚创建动作返回的 alias。",
  "4. 不要重复创建同一目标节点。若 taskState 已有同名 alias，先读取状态，再决定复用还是创建新 alias。",
  "",
  "五、输出格式",
  "1. 只输出一个合法 JSON 对象，不要 Markdown 代码围栏，不要额外解释。",
  "2. JSON 顶层必须有 decisionId、type 和 reason。",
  "3. type 只能是 action、wait、clarify、finish。",
  "4. action 每轮只能包含一个动作；不要一次返回动作数组。",
  "5. 当 taskState.phase=planning 时，首次决策必须同时包含 taskPlan。执行器先校验并登记 taskPlan，再执行本轮 action。",
  "6. reason 是给执行器日志使用的一句话，不能宣称尚未验证的结果。",
  "",
  "六、不可违反的规则",
  "1. 不得在生成任务仍为 running、queued 或 unknown 时创建依赖该结果的下游节点。",
  "2. 不得把“请求已提交”当作“生成成功”。",
  "3. 不得在没有图片输出时说“已生成图片”。",
  "4. 不得吞掉执行器错误，不得继续执行被失败节点阻断的步骤。",
  "5. 不得擅自修改用户没有提到的模型、比例、尺寸、清晰度、提示词或已有节点。",
  "6. 不得调用 layout、moveNode、deleteNode，除非用户明确要求对应操作。",
  "7. 如果缺少 API、模型、参考图或目标节点，使用 clarify，而不是猜测。",
  "",
  "七、终止条件",
  "只有当执行器返回 taskState.successCriteria 全部为 true 时，才输出 finish。finish.message 要清楚说明完成了哪些节点和结果。",
  "",
  "八、RunningHub 节点（画布中存在 RunningHubNode 时适用）",
  "1. 你只能根据 canvasState、runningHubState、workflowCatalog 和 taskState 决策。所有上传、提交、轮询、结果解析由执行器完成；你不接触 API Key、访问密码、上传后的真实资源地址或原始响应中的敏感字段。",
  "2. 工作流选择：用户明确指定名称或 workflowId 时精确选择对应条目；多个工作流都可能满足时先 clarify；只能选择 runningHubState.workflows 中 enabled=true 的条目；不能把 AI 应用、模型和 ComfyUI 工作流混为一类。",
  "3. 参数理解：只修改用户明确提到的参数，未提到的用工作流默认值；提示词只能写入 role=prompt 的字段；SELECT 只能使用 options 中的值；NUMBER/INTEGER 必须保持数字并检查范围；“默认参数”表示使用注册表默认值。用户要求的参数不存在时用 clarify，不要写到相似字段。",
  "4. 上游媒体：先 bindRunningHubInput 把 sourceAlias 的当前主图绑定到 sourceFromUpstream=true 的媒体字段（按 imageOrder 顺序），再 runNode；必填媒体缺失时必须 clarify 或报错，不能提交。不要把 outputImages 历史列表全部发送。",
  "5. 任务顺序：提交返回 queued 只表示任务已接受，必须 waitFor 终态；只有 SUCCESS 且有输出文件才可报告成功或继续下游；失败、取消或超时后停止所有依赖步骤。第一次明确可重试失败最多自动重试一次。",
  "6. 用户提到“放大到 4K”“高清修复”等参数时，先检查 workflowCatalog 中字段 Schema 是否存在对应选项；不存在时如实说明，不要猜测字段。",
  "",
  "当前上下文注入：",
  "{{conversation}}",
  "canvasState = {{canvas_state}}",
  "taskState = {{task_state}}",
  "runningHubState = {{running_hub_state}}",
  "capabilities = {{capabilities}}",
].join("\n");

const ALIAS_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ALLOWED_ACTION_NAMES = [
  "createNode", "updateNode", "connect", "runNode", "inspectNode",
  "listRunningHubWorkflows", "createRunningHubNode", "bindRunningHubInput",
  "cancelRunningHub", "recoverRunningHubTask",
];
const NODE_TYPES = ["generateNode", "videoNode", "textNode", "imageNode", "runningHubNode"];
const RH_ACTION_NAMES = ["listRunningHubWorkflows", "createRunningHubNode", "bindRunningHubInput", "cancelRunningHub", "recoverRunningHubTask"];
const IMAGE_SOURCE_TYPES = ["generateNode", "imageNode", "runningHubNode", "videoNode"];
const MAX_TURNS = 30;
const MAX_RUN_ATTEMPTS = 2;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncStr(value, max) {
  const s = value == null ? "" : String(value);
  return s.length > max ? s.slice(0, max) + "…(长度" + s.length + ")" : s;
}

function outputKind(nodeType) {
  if (nodeType === "videoNode") return "video";
  if (nodeType === "textNode") return "text";
  return "image";
}

function hasNodeOutput(data, nodeType) {
  data = data || {};
  if (nodeType === "videoNode") return !!data.outputVideo;
  if (nodeType === "textNode") return !!(data.text && String(data.text).length);
  return !!(data.image || (Array.isArray(data.outputImages) && data.outputImages.length));
}

/* 节点终态判定：success / failed / running / pending。
   真实画布状态串：启动 running:true + "运行中..."；图片/文本成功 "生成成功"；
   RunningHub 成功 "运行成功"；视频成功 "视频生成成功..."；失败 "失败"。 */
function nodeTerminalState(data, nodeType) {
  data = data || {};
  if (data.running === true) return "running";
  const status = String(data.status || "");
  if (/失败|error/i.test(status)) return "failed";
  if (/成功/.test(status)) return hasNodeOutput(data, nodeType) ? "success" : "pending";
  return "pending";
}

function createEmptyTask(userMessage) {
  return {
    taskId: "task_" + Date.now(),
    phase: "planning",
    plan: null,
    aliases: {},
    successCriteria: [],
    seenDecisionIds: [],
    turns: [],
    runAttempts: {},
    runSeq: 0,
    revision: 1,
    lastExecution: null,
    awaitingClarify: false,
    conversation: [{ role: "user", content: String(userMessage == null ? "" : userMessage) }],
    /* 内部字段（不进入提示词）：_runs / _runResults 由执行器使用 */
  };
}

function appendConversation(task, text) {
  task.conversation.push({ role: "user", content: String(text == null ? "" : text) });
  task.awaitingClarify = false;
}

/* ---------- taskPlan 登记 ---------- */

function normalizeCriteria(entries, aliasSet) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { ok: false, error: "successCriteria 不能为空" };
  }
  const out = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") return { ok: false, error: "successCriteria 含非法条目" };
    if (entry.alias) {
      if (!aliasSet.has(entry.alias)) return { ok: false, error: "successCriteria 引用未登记的 alias：" + entry.alias };
      out.push({
        kind: "node",
        alias: entry.alias,
        terminalStatus: entry.terminalStatus || "success",
        requireOutput: entry.requireOutput !== false,
      });
    } else if (entry.edge) {
      const from = entry.edge.from;
      const to = entry.edge.to;
      if (!aliasSet.has(from) || !aliasSet.has(to)) {
        return { ok: false, error: "successCriteria.edge 引用未登记的 alias：" + from + " → " + to };
      }
      out.push({ kind: "edge", from, to, inputRole: entry.edge.inputRole || "image" });
    } else {
      return { ok: false, error: "successCriteria 含不可验证的条目" };
    }
  }
  return { ok: true, criteria: out };
}

function planHasCycle(steps) {
  const byAlias = new Map(steps.map((s) => [s.alias, s]));
  const visiting = new Set();
  const done = new Set();
  function visit(alias) {
    if (done.has(alias)) return false;
    if (visiting.has(alias)) return true;
    visiting.add(alias);
    const step = byAlias.get(alias);
    for (const dep of (step && step.dependsOn) || []) {
      if (byAlias.has(dep) && visit(dep)) return true;
    }
    visiting.delete(alias);
    done.add(alias);
    return false;
  }
  for (const s of steps) {
    if (visit(s.alias)) return true;
  }
  return false;
}

/* 校验并登记 taskPlan；opts.dryRun=true 时只校验不改状态。 */
function registerPlan(task, plan, opts) {
  if (!plan || typeof plan !== "object") return { ok: false, error: "taskPlan 缺失" };
  if (!plan.goal || !String(plan.goal).trim()) return { ok: false, error: "taskPlan.goal 不能为空" };
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) return { ok: false, error: "taskPlan.steps 不能为空" };
  const seenStepIds = new Set();
  const aliasSet = new Set();
  const steps = [];
  for (const s of plan.steps) {
    if (!s || typeof s !== "object") return { ok: false, error: "taskPlan.steps 含非法步骤" };
    if (!s.stepId || seenStepIds.has(s.stepId)) return { ok: false, error: "stepId 缺失或重复：" + (s.stepId || "?") };
    if (!s.alias || !ALIAS_RE.test(s.alias)) return { ok: false, error: "alias 非法（只允许字母/数字/下划线/短横线）：" + (s.alias || "?") };
    if (aliasSet.has(s.alias)) return { ok: false, error: "alias 重复：" + s.alias };
    const dependsOn = Array.isArray(s.dependsOn) ? s.dependsOn : [];
    for (const dep of dependsOn) {
      if (!aliasSet.has(dep)) return { ok: false, error: "步骤 " + s.alias + " 依赖未定义的 alias：" + dep };
    }
    seenStepIds.add(s.stepId);
    aliasSet.add(s.alias);
    steps.push({ stepId: s.stepId, alias: s.alias, intent: String(s.intent || ""), dependsOn: dependsOn.slice(), status: "pending" });
  }
  if (planHasCycle(steps)) return { ok: false, error: "taskPlan 存在循环依赖" };
  const criteria = normalizeCriteria(plan.successCriteria, aliasSet);
  if (!criteria.ok) return { ok: false, error: criteria.error };

  if (opts && opts.dryRun) return { ok: true };
  task.plan = { goal: String(plan.goal), steps };
  task.successCriteria = criteria.criteria;
  task.phase = "creating";
  return { ok: true };
}

/* ---------- 结构化上下文 ---------- */

/* 把画布快照投影成规范 §8 的最小 CanvasState；长字符串截断，避免提示词爆炸。 */
function buildCanvasState(snap, revision) {
  const nodes = ((snap && snap.nodes) || []).map((n) => {
    const d = n.data || {};
    const base = {
      id: n.id,
      type: n.type,
      title: d.title,
      data: {
        status: d.status,
        running: !!d.running,
        prompt: d.prompt ? truncStr(d.prompt, 200) : undefined,
        image: d.image ? truncStr(d.image, 60) : undefined,
        outputImages: Array.isArray(d.outputImages) ? d.outputImages.slice(0, 6).map((x) => truncStr(x, 60)) : undefined,
        upstreamImages: Array.isArray(d.upstreamImages) ? d.upstreamImages.slice(0, 6).map((x) => truncStr(x, 60)) : undefined,
        outputVideo: d.outputVideo ? truncStr(d.outputVideo, 60) : undefined,
        text: d.text ? truncStr(d.text, 400) : undefined,
        error: d.error ? truncStr(d.error, 200) : undefined,
        runError: d.runError ? truncStr(d.runError, 200) : undefined,
      },
      position: { x: Math.round((n.position && n.position.x) || 0), y: Math.round((n.position && n.position.y) || 0) },
    };
    if (n.type === "runningHubNode") {
      base.data.runningHub = {
        workflowRef: d.rhWorkflowRef || undefined,
        taskId: d.task && d.task.taskId ? String(d.task.taskId) : undefined,
        taskStatus: d.task && d.task.status ? d.task.status : undefined,
        overrideFieldKeys: d.rhParams && typeof d.rhParams === "object" ? Object.keys(d.rhParams) : [],
      };
    }
    return base;
  });
  const edges = ((snap && snap.edges) || []).map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    inputRole: "image",
  }));
  return { revision: revision || 0, nodes, edges };
}

function evaluateCriteria(task, snap) {
  const rawNodes = (snap && snap.nodes) || [];
  const rawEdges = (snap && snap.edges) || [];
  const entries = (task.successCriteria || []).map((c) => {
    if (c.kind === "node") {
      const nodeId = task.aliases[c.alias];
      const node = nodeId && rawNodes.find((n) => n.id === nodeId);
      if (!node) return Object.assign({}, c, { satisfied: false, detail: "节点未创建" });
      const st = nodeTerminalState(node.data, node.type);
      const ok = st === "success" && (!c.requireOutput || hasNodeOutput(node.data, node.type));
      return Object.assign({}, c, { satisfied: ok, detail: "节点状态 " + st });
    }
    const fromId = task.aliases[c.from];
    const toId = task.aliases[c.to];
    const edge = rawEdges.find((e) => e.source === fromId && e.target === toId);
    return Object.assign({}, c, { satisfied: !!edge, detail: edge ? "连线存在" : "连线不存在" });
  });
  return { all: entries.length > 0 && entries.every((e) => e.satisfied), entries };
}

function buildTaskSnapshot(task, snap) {
  const criteria = evaluateCriteria(task, snap);
  const last = task.turns.length ? task.turns[task.turns.length - 1] : null;
  return {
    taskId: task.taskId,
    phase: task.phase,
    aliases: Object.assign({}, task.aliases),
    steps: task.plan ? task.plan.steps.map((s) => ({ stepId: s.stepId, alias: s.alias, intent: s.intent, dependsOn: s.dependsOn, status: s.status })) : [],
    successCriteria: criteria.entries,
    allCriteriaSatisfied: criteria.all,
    runAttempts: Object.assign({}, task.runAttempts),
    lastExecution: last ? { turn: last.turn, type: last.type, summary: last.summary, ok: last.ok } : null,
  };
}

function buildCapabilities(snap) {
  const types = new Set(NODE_TYPES);
  ((snap && snap.nodes) || []).forEach((n) => n.type && types.add(n.type));
  return {
    nodeTypes: Array.from(types),
    actions: ALLOWED_ACTION_NAMES.concat(["waitFor"]),
  };
}

function buildSystemPrompt(ctx) {
  const canvasState = ctx.canvasState || { revision: 0, nodes: [], edges: [] };
  const taskState = ctx.taskState || {};
  const conversation = ctx.conversation || [];
  const capabilities = ctx.capabilities || { nodeTypes: NODE_TYPES.slice(), actions: ALLOWED_ACTION_NAMES.slice() };
  const content = SPEC_SYSTEM_PROMPT
    .replace("{{conversation}}", JSON.stringify(conversation))
    .replace("{{canvas_state}}", JSON.stringify(canvasState))
    .replace("{{task_state}}", JSON.stringify(taskState))
    .replace("{{running_hub_state}}", JSON.stringify(ctx.runningHubState || null))
    .replace("{{capabilities}}", JSON.stringify(capabilities));
  return [
    { role: "system", content },
    { role: "user", content: "以上为当前状态注入。请基于 canvasState 与 taskState 输出下一轮唯一决策 JSON（只输出一个 JSON 对象）。" },
  ];
}

/* ---------- 决策提取与校验 ---------- */

function extractDecision(text) {
  if (typeof text !== "string") return { ok: false, error: "回复不是文本" };
  const raw = text.trim();
  const candidates = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fence) candidates.push(fence[1].trim());
  candidates.push(raw);
  const m = /\{[\s\S]*\}/.exec(raw);
  if (m) candidates.push(m[0]);
  for (const c of candidates) {
    if (!c) continue;
    try {
      const value = JSON.parse(c);
      if (value && typeof value === "object") return { ok: true, value, raw: c };
    } catch (e) { /* 尝试下一个候选 */ }
  }
  return { ok: false, error: "未找到合法 JSON", raw: raw };
}

function refKey(ref) {
  if (ref == null) return "";
  if (typeof ref === "object") return String(ref.alias || ref.id || ref.target || "");
  return String(ref).trim();
}

/* 解析 RunningHub 工作流引用（"workflow:<localId>" 或裸 id / workflowId）。
   deps.getRhWorkflows 返回已规范化的条目数组（fields 为可用字段）。 */
function resolveRhEntry(deps, workflowRef) {
  const list = deps && typeof deps.getRhWorkflows === "function" ? deps.getRhWorkflows() : [];
  const key = String(workflowRef == null ? "" : workflowRef).trim().replace(/^workflow:/, "");
  if (!key) return null;
  return list.find((e) => e && (e.id === key || String(e.workflowId) === key)) || null;
}

function isMediaFieldType(fieldType) {
  return ["IMAGE", "VIDEO", "AUDIO"].indexOf(String(fieldType || "").toUpperCase()) !== -1;
}

/* RunningHub 节点运行前的必填媒体检查：required 且 sourceFromUpstream 的媒体字段必须有上游图或显式值。 */
function rhRequiredMediaMissing(node, entry) {
  if (!node || !entry || !Array.isArray(entry.fields)) return [];
  const upstream = Array.isArray(node.data && node.data.upstreamImages) ? node.data.upstreamImages.filter(Boolean) : [];
  const params = (node.data && node.data.rhParams) || {};
  const explicit = new Set();
  for (const key of Object.keys(params)) {
    const v = params[key];
    const value = v && typeof v === "object" ? v.value : v;
    if (typeof value === "string" && value.trim()) explicit.add(key);
  }
  const missing = [];
  let upstreamIdx = 0;
  for (const f of entry.fields) {
    if (!isMediaFieldType(f.fieldType) || !f.required) continue;
    if (explicit.has(f.id)) continue;
    if (f.sourceFromUpstream) {
      if (upstream[upstreamIdx]) { upstreamIdx += 1; continue; }
      upstreamIdx += 1;
      missing.push(f.id);
    } else {
      missing.push(f.id);
    }
  }
  return missing;
}

function resolveRef(ctx, ref) {
  const key = refKey(ref);
  if (!key) return null;
  if (ctx.task.aliases[key]) return ctx.task.aliases[key];
  const rawNodes = (ctx.rawSnap && ctx.rawSnap.nodes) || [];
  const node = rawNodes.find((n) => n.id === key || (n.data && n.data.title === key));
  if (node) return node.id;
  if (ctx.deps && typeof ctx.deps.resolveNodeId === "function") {
    const id = ctx.deps.resolveNodeId(key);
    if (id && rawNodes.some((n) => n.id === id)) return id;
  }
  return null;
}

function validateDecision(decision, ctx) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    return { ok: false, kind: "invalid", error: "回复不是 JSON 对象" };
  }
  if (Array.isArray(decision.actions)) {
    return { ok: false, kind: "legacy", error: "模型返回旧版 actions 协议" };
  }
  if (!decision.decisionId || typeof decision.decisionId !== "string") {
    return { ok: false, kind: "invalid", error: "缺少 decisionId" };
  }
  if (ctx.task.seenDecisionIds.indexOf(decision.decisionId) !== -1) {
    return { ok: false, kind: "invalid", error: "decisionId 重复：" + decision.decisionId };
  }
  const type = decision.type;
  if (["action", "wait", "clarify", "finish"].indexOf(type) === -1) {
    return { ok: false, kind: "invalid", error: "type 非法：" + type };
  }
  if (!decision.reason || !String(decision.reason).trim()) {
    return { ok: false, kind: "invalid", error: "缺少 reason" };
  }
  if (decision.taskPlan) {
    if (ctx.task.phase !== "planning") return { ok: false, kind: "invalid", error: "taskPlan 只能在首轮提供" };
    const pr = registerPlan(ctx.task, decision.taskPlan, { dryRun: true });
    if (!pr.ok) return { ok: false, kind: "invalid", error: "taskPlan 不合法：" + pr.error };
  } else if (ctx.task.phase === "planning" && (type === "action" || type === "wait")) {
    /* clarify 允许先于 taskPlan（歧义澄清不触碰画布）；推进执行的动作必须先登记计划 */
    return { ok: false, kind: "invalid", error: "首轮决策必须包含 taskPlan" };
  }

  if (type === "action") {
    const action = decision.action;
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      return { ok: false, kind: "invalid", error: "type=action 缺少 action 对象" };
    }
    if (ALLOWED_ACTION_NAMES.indexOf(action.name) === -1) {
      return { ok: false, kind: "invalid", error: "不支持或越权的动作：" + action.name };
    }
    if (action.name === "createNode") {
      const alias = action.alias;
      if (!alias || !ALIAS_RE.test(alias)) return { ok: false, kind: "invalid", error: "createNode 缺少合法 alias" };
      if (ctx.task.aliases[alias]) return { ok: false, kind: "invalid", error: "alias 已存在：" + alias };
      const nodeType = action.nodeType || "generateNode";
      if (NODE_TYPES.indexOf(nodeType) === -1) return { ok: false, kind: "invalid", error: "nodeType 非法：" + nodeType };
      /* 计划级依赖门控：依赖步骤尚未成功时禁止创建下游节点 */
      const step = ctx.task.plan && ctx.task.plan.steps.find((s) => s.alias === alias);
      if (step && step.dependsOn.length) {
        const rawNodes = (ctx.rawSnap && ctx.rawSnap.nodes) || [];
        for (const dep of step.dependsOn) {
          const depId = ctx.task.aliases[dep];
          const depNode = depId && rawNodes.find((n) => n.id === depId);
          const st = depNode ? nodeTerminalState(depNode.data, depNode.type) : "missing";
          if (st !== "success") {
            return { ok: false, kind: "invalid", error: "依赖步骤 " + dep + " 尚未成功（" + st + "），禁止创建 " + alias };
          }
        }
      }
    } else if (action.name === "createRunningHubNode") {
      const alias = action.alias;
      if (!alias || !ALIAS_RE.test(alias)) return { ok: false, kind: "invalid", error: "createRunningHubNode 缺少合法 alias" };
      if (ctx.task.aliases[alias]) return { ok: false, kind: "invalid", error: "alias 已存在：" + alias };
      const entry = resolveRhEntry(ctx.deps, action.workflowRef);
      if (!entry) return { ok: false, kind: "invalid", error: "工作流不存在或未启用：" + refKey(action.workflowRef) };
      const fieldIds = new Set((entry.fields || []).map((f) => f.id));
      for (const key of Object.keys(action.overrides || {})) {
        if (!fieldIds.has(key)) return { ok: false, kind: "invalid", error: "覆盖字段不存在：" + key };
      }
    } else if (action.name === "bindRunningHubInput") {
      const targetId = resolveRef(ctx, action.targetAlias);
      const sourceId = resolveRef(ctx, action.sourceAlias);
      if (!targetId || !sourceId) return { ok: false, kind: "invalid", error: "bindRunningHubInput 端点无法解析" };
      if (targetId === sourceId) return { ok: false, kind: "invalid", error: "bindRunningHubInput 不能自绑定" };
      const rawNodes = (ctx.rawSnap && ctx.rawSnap.nodes) || [];
      const targetNode = rawNodes.find((n) => n.id === targetId);
      const entry = targetNode ? resolveRhEntry(ctx.deps, targetNode.data && targetNode.data.rhWorkflowRef) : null;
      if (!entry) return { ok: false, kind: "invalid", error: "目标节点没有可用的工作流字段 Schema" };
      const fieldKey = String(action.fieldKey || "");
      const field = (entry.fields || []).find((f) => f.id === fieldKey);
      if (!field) return { ok: false, kind: "invalid", error: "字段不存在：" + fieldKey };
      if (!isMediaFieldType(field.fieldType)) return { ok: false, kind: "invalid", error: "字段不是媒体字段：" + fieldKey };
    } else if (action.name === "cancelRunningHub" || action.name === "recoverRunningHubTask") {
      if (!resolveRef(ctx, action.targetAlias)) {
        return { ok: false, kind: "invalid", error: action.name + " 目标无法解析" };
      }
    } else if (action.name !== "listRunningHubWorkflows") {
      const ref = action.name === "connect" ? null : action.target;
      if (action.name === "connect") {
        const fromId = resolveRef(ctx, action.from);
        const toId = resolveRef(ctx, action.to);
        if (!fromId || !toId) return { ok: false, kind: "invalid", error: "connect 端点无法解析" };
        if (fromId === toId) return { ok: false, kind: "invalid", error: "connect 不能自连接" };
        if (action.inputRole === "image") {
          const rawNodes = (ctx.rawSnap && ctx.rawSnap.nodes) || [];
          const fromNode = rawNodes.find((n) => n.id === fromId);
          if (fromNode && IMAGE_SOURCE_TYPES.indexOf(fromNode.type) === -1) {
            return { ok: false, kind: "invalid", error: "源节点类型不能输出图片：" + fromNode.type };
          }
        }
      } else if (!resolveRef(ctx, ref)) {
        return { ok: false, kind: "invalid", error: action.name + " 目标无法解析" };
      }
    }
    /* 依赖门控：runNode 的目标必须上游全部成功（边级 + 计划级） */
    if (action.name === "runNode") {
      const targetId = resolveRef(ctx, action.target);
      const rawNodes = (ctx.rawSnap && ctx.rawSnap.nodes) || [];
      const rawEdges = (ctx.rawSnap && ctx.rawSnap.edges) || [];
      const targetNode = rawNodes.find((n) => n.id === targetId);
      const srcIds = rawEdges.filter((e) => e.target === targetId).map((e) => e.source);
      for (const srcId of srcIds) {
        const srcNode = rawNodes.find((n) => n.id === srcId);
        const st = srcNode ? nodeTerminalState(srcNode.data, srcNode.type) : "missing";
        if (st !== "success") {
          return { ok: false, kind: "invalid", error: "上游节点尚未成功（" + st + "），禁止运行下游" };
        }
      }
      const targetAlias = refKey(action.target);
      const step = ctx.task.plan && ctx.task.plan.steps.find((s) => s.alias === targetAlias);
      if (step) {
        for (const dep of step.dependsOn) {
          const depId = ctx.task.aliases[dep];
          const depNode = depId && rawNodes.find((n) => n.id === depId);
          const st = depNode ? nodeTerminalState(depNode.data, depNode.type) : "missing";
          if (st !== "success") {
            return { ok: false, kind: "invalid", error: "依赖步骤 " + dep + " 尚未成功（" + st + "），禁止运行 " + targetAlias };
          }
          const hasEdge = rawEdges.some((e) => e.source === depId && e.target === targetId);
          if (!hasEdge) {
            return { ok: false, kind: "invalid", error: "必须先建立 " + dep + " → " + targetAlias + " 的连线再运行（先 connect 再 runNode）" };
          }
        }
      }
      const attempts = ctx.task.runAttempts[targetAlias] || 0;
      if (attempts >= MAX_RUN_ATTEMPTS) {
        return { ok: false, kind: "invalid", error: "节点 " + targetAlias + " 已达到最多 " + MAX_RUN_ATTEMPTS + " 次运行上限" };
      }
      /* RunningHub 必填媒体预检：缺上游当前主图时禁止提交 */
      if (targetNode && targetNode.type === "runningHubNode") {
        const entry = resolveRhEntry(ctx.deps, targetNode.data && targetNode.data.rhWorkflowRef);
        const missing = rhRequiredMediaMissing(targetNode, entry);
        if (missing.length) {
          return { ok: false, kind: "invalid", error: "必填媒体字段缺失：" + missing.join("、") + "（先 bindRunningHubInput 绑定上游当前主图）" };
        }
      }
    }
  } else if (type === "wait") {
    const w = decision.waitFor;
    if (!w || typeof w !== "object" || !refKey(w.alias)) {
      return { ok: false, kind: "invalid", error: "type=wait 缺少 waitFor.alias" };
    }
    if (!resolveRef(ctx, w.alias)) return { ok: false, kind: "invalid", error: "waitFor.alias 无法解析：" + refKey(w.alias) };
    if (w.timeoutMs != null && !(Number(w.timeoutMs) > 0)) return { ok: false, kind: "invalid", error: "waitFor.timeoutMs 非法" };
  } else if (type === "clarify") {
    if (!decision.question || !String(decision.question).trim()) {
      return { ok: false, kind: "invalid", error: "type=clarify 缺少 question" };
    }
  } else if (type === "finish") {
    if (!decision.message || !String(decision.message).trim()) {
      return { ok: false, kind: "invalid", error: "type=finish 缺少 message" };
    }
    const criteria = evaluateCriteria(ctx.task, ctx.rawSnap);
    if (!criteria.all) {
      const bad = criteria.entries.filter((e) => !e.satisfied).map((e) => (e.kind === "node" ? e.alias : e.from + "→" + e.to)).join("、");
      return { ok: false, kind: "invalid", error: "成功条件未全部满足（" + bad + "），禁止 finish" };
    }
  }
  return { ok: true };
}

/* ---------- 执行器 ---------- */

function findRawNode(snap, nodeId) {
  return ((snap && snap.nodes) || []).find((n) => n.id === nodeId) || null;
}

function resolveLive(bridge, task, deps, ref) {
  const key = refKey(ref);
  if (!key) return null;
  if (task.aliases[key]) return task.aliases[key];
  const snap = bridge.get();
  const node = findRawNode(snap, key) || ((snap && snap.nodes) || []).find((n) => n.data && n.data.title === key);
  if (node) return node.id;
  if (deps && typeof deps.resolveNodeId === "function") {
    return deps.resolveNodeId(key) || null;
  }
  return null;
}

function normalizeNodeData(input, nodeType) {
  const data = Object.assign({}, input && typeof input === "object" ? input : {});
  const pairs = [["aspectRatio", "ratio"], ["比例", "ratio"], ["resolution", "quality"], ["清晰度", "quality"], ["modelName", "model"]];
  for (const pair of pairs) {
    if (data[pair[0]] != null && data[pair[1]] == null) data[pair[1]] = data[pair[0]];
    delete data[pair[0]];
  }
  if (data.ratio != null) data.ratio = String(data.ratio).replace(/\s+/g, "");
  if (data.quality != null) data.quality = String(data.quality).toLowerCase().replace(/[高清晰度]/g, "");
  if (nodeType === "generateNode" || nodeType === "imageNode" || nodeType === "runningHubNode") {
    delete data.size;
    delete data.duration;
  }
  if (nodeType === "videoNode") {
    delete data.count;
  }
  if (nodeType === "textNode") {
    delete data.ratio;
    delete data.quality;
    delete data.count;
    delete data.size;
    delete data.duration;
  }
  return data;
}

function computePosition(bridge, task, deps, pos) {
  const snap = bridge.get();
  const nodes = (snap && snap.nodes) || [];
  if (pos && pos.mode === "downstream" && pos.relativeTo) {
    const srcId = resolveLive(bridge, task, deps, pos.relativeTo);
    const srcNode = srcId && findRawNode(snap, srcId);
    if (srcNode && srcNode.position) {
      return { x: srcNode.position.x + 380, y: srcNode.position.y };
    }
  }
  if (!nodes.length) return { x: 120, y: 120 };
  const selected = nodes.filter((n) => n.selected);
  const base = selected.length ? selected[selected.length - 1] : nodes[nodes.length - 1];
  return { x: base.position.x + 380, y: base.position.y };
}

async function verifyCondition(deps, check, timeoutMs, intervalMs) {
  const deadline = deps.now() + (timeoutMs || 1200);
  let result = null;
  while (deps.now() < deadline) {
    result = check();
    if (result) return result;
    await deps.sleep(intervalMs || 100);
  }
  return check();
}

function markStep(task, alias, status) {
  if (!task.plan) return;
  const step = task.plan.steps.find((s) => s.alias === alias);
  if (step) step.status = status;
}

function markBlocked(task, alias) {
  if (!task.plan) return;
  const failed = new Set([alias]);
  for (const step of task.plan.steps) {
    if (step.alias === alias) step.status = "failed";
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of task.plan.steps) {
      if (failed.has(step.alias) || step.status === "blocked") continue;
      if (step.dependsOn.some((d) => failed.has(d))) {
        step.status = "blocked";
        failed.add(step.alias);
        changed = true;
      }
    }
  }
}

async function execCreateNode(bridge, task, deps, action) {
  const alias = action.alias;
  const nodeType = action.nodeType || "generateNode";
  if (task.aliases[alias]) {
    const existing = findRawNode(bridge.get(), task.aliases[alias]);
    if (existing) return { ok: true, created: { alias, nodeId: task.aliases[alias] }, already_existed: true };
    delete task.aliases[alias];
  }
  const data = normalizeNodeData(action.data || {}, nodeType);
  const position = computePosition(bridge, task, deps, action.position);
  const made = bridge.actions.createNode({ type: nodeType, position, data });
  if (made && made.error) return { ok: false, retryable: false, alias, error: made.error };
  const nodeId = made && made.id ? made.id : (typeof made === "string" ? made : null);
  if (!nodeId) return { ok: false, retryable: false, alias, error: "createNode 未返回节点 ID" };
  const verified = await verifyCondition(deps, () => !!findRawNode(bridge.get(), nodeId), 1200, 100);
  if (!verified) return { ok: false, retryable: false, alias, error: "节点创建后未在画布中检测到" };
  task.aliases[alias] = nodeId;
  markStep(task, alias, "created");
  if (task.phase === "planning") task.phase = "creating";
  return { ok: true, created: { alias, nodeId } };
}

async function execUpdateNode(bridge, task, deps, action) {
  const nodeId = resolveLive(bridge, task, deps, action.target);
  if (!nodeId) return { ok: false, retryable: false, error: "未找到目标节点：" + refKey(action.target) };
  const patch = normalizeNodeData(action.patch || {}, null);
  const keys = Object.keys(patch);
  if (!keys.length) return { ok: false, retryable: false, error: "updateNode 缺少 patch" };
  const r = bridge.actions.updateNode(nodeId, patch);
  if (r && r.error) return { ok: false, retryable: false, error: r.error };
  const applied = await verifyCondition(deps, () => {
    const node = findRawNode(bridge.get(), nodeId);
    return !!(node && keys.some((k) => node.data && node.data[k] === patch[k]));
  }, 1200, 100);
  if (!applied) return { ok: false, retryable: false, error: "修改未在画布中生效" };
  return { ok: true, nodeId };
}

async function execConnect(bridge, task, deps, action) {
  const fromId = resolveLive(bridge, task, deps, action.from);
  const toId = resolveLive(bridge, task, deps, action.to);
  if (!fromId || !toId) return { ok: false, retryable: false, error: "连线端点不存在：" + refKey(action.from) + " → " + refKey(action.to) };
  if (fromId === toId) return { ok: false, retryable: false, error: "不能自连接" };
  const snap = bridge.get();
  const existing = ((snap && snap.edges) || []).find((e) => e.source === fromId && e.target === toId);
  if (existing) return { ok: true, edgeId: existing.id, already_existed: true };
  const r = bridge.actions.connect(fromId, toId);
  if (r && r.error) return { ok: false, retryable: false, error: r.error };
  const edge = await verifyCondition(deps, () => {
    const s2 = bridge.get();
    return (((s2 && s2.edges) || []).find((e) => e.source === fromId && e.target === toId)) || null;
  }, 1200, 100);
  if (!edge) return { ok: false, retryable: false, error: "连线未写入画布" };
  return { ok: true, edgeId: edge.id };
}

function execRunNode(bridge, task, deps, action) {
  const alias = refKey(action.target);
  const nodeId = resolveLive(bridge, task, deps, action.target);
  if (!nodeId) return Promise.resolve({ ok: false, retryable: false, alias, error: "未找到节点：" + alias });
  const node = findRawNode(bridge.get(), nodeId);
  if (!node) return Promise.resolve({ ok: false, retryable: false, alias, error: "未找到节点：" + alias });
  if (node.data && node.data.running) {
    return Promise.resolve({ ok: true, already_running: true, alias, runId: "run_" + alias + "_" + (++task.runSeq), status: "queued" });
  }
  task.runAttempts[alias] = (task.runAttempts[alias] || 0) + 1;
  const runId = "run_" + alias + "_" + (++task.runSeq);
  const p = Promise.resolve().then(() => bridge.actions.runNode(nodeId));
  p.then((r) => {
    task._runResults.set(nodeId, r && typeof r === "object" ? r : { ok: false, error: "runNode 返回空" });
  }).catch((e) => {
    task._runResults.set(nodeId, { ok: false, error: (e && e.message) || String(e) });
  });
  if (!task._runs) task._runs = new Map();
  task._runs.set(nodeId, p);
  if (!task.aliases[alias]) task.aliases[alias] = nodeId;
  markStep(task, alias, "running");
  if (task.phase === "creating") task.phase = "running";
  return Promise.resolve({ ok: true, runId, alias, status: "queued" });
}

async function execWaitFor(bridge, task, deps, waitFor) {
  const alias = refKey(waitFor.alias);
  const nodeId = resolveLive(bridge, task, deps, waitFor.alias);
  if (!nodeId) return { ok: false, retryable: false, alias, error: "未找到节点：" + alias };
  const timeoutMs = Number(waitFor.timeoutMs) > 0 ? Number(waitFor.timeoutMs) : 600000;
  const pollMs = Math.max(250, Number(waitFor.pollMs) > 0 ? Number(waitFor.pollMs) : 1000);
  const deadline = deps.now() + timeoutMs;
  let successNoOutput = 0;
  let runEndedGrace = 0;
  for (;;) {
    const snap = bridge.get();
    const node = findRawNode(snap, nodeId);
    if (!node) return { ok: false, retryable: false, alias, error: "节点不存在：" + alias };
    const st = nodeTerminalState(node.data, node.type);
    if (st === "success") {
      markStep(task, alias, "succeeded");
      const current = node.data.image || node.data.outputVideo || (node.data.outputImages || [])[0] || null;
      const sniffedKind = typeof current === "string" && /\.(mp4|webm|mov|m4v|mkv)(\?|$)/i.test(current) ? "video" : null;
      return {
        ok: true,
        alias,
        status: "success",
        hasOutput: true,
        outputRef: { kind: sniffedKind || outputKind(node.type), sourceAlias: alias, selection: "current" },
      };
    }
    if (st === "failed") {
      const attempts = task.runAttempts[alias] || 0;
      return {
        ok: false,
        alias,
        retryable: attempts < MAX_RUN_ATTEMPTS,
        error: node.data && node.data.error ? String(node.data.error) : "节点运行失败：" + (node.data && node.data.status ? node.data.status : "失败"),
      };
    }
    if (/成功/.test(String(node.data && node.data.status))) {
      successNoOutput += 1;
      if (successNoOutput >= 3) {
        return { ok: false, retryable: false, alias, error: "节点报告成功但未检测到输出" };
      }
    } else {
      successNoOutput = 0;
    }
    const rr = task._runResults && task._runResults.get(nodeId);
    if (rr && rr.ok === false && st !== "success") {
      runEndedGrace += 1;
      if (runEndedGrace >= 3) {
        return { ok: false, retryable: (task.runAttempts[alias] || 0) < MAX_RUN_ATTEMPTS, alias, error: rr.error || "运行已结束但未检测到成功状态" };
      }
    } else {
      runEndedGrace = 0;
    }
    if (deps.now() >= deadline) {
      return { ok: false, retryable: (task.runAttempts[alias] || 0) < MAX_RUN_ATTEMPTS, alias, timeout: true, error: "等待超时（" + Math.round(timeoutMs / 1000) + "s）" };
    }
    await deps.sleep(pollMs);
  }
}

function execInspectNode(bridge, task, deps, action) {
  const alias = refKey(action.target);
  const nodeId = resolveLive(bridge, task, deps, action.target);
  if (!nodeId) return { ok: false, retryable: false, alias, error: "未找到节点：" + alias };
  const node = findRawNode(bridge.get(), nodeId);
  if (!node) return { ok: false, retryable: false, alias, error: "未找到节点：" + alias };
  const d = node.data || {};
  return {
    ok: true,
    alias,
    nodeId,
    type: node.type,
    status: d.status,
    running: !!d.running,
    currentOutput: d.image || d.outputVideo || d.text || (d.outputImages || [])[0] || null,
    outputImages: Array.isArray(d.outputImages) ? d.outputImages : [],
    upstreamImages: Array.isArray(d.upstreamImages) ? d.upstreamImages : [],
    error: d.error || null,
  };
}

/* ---------- RunningHub 执行器 ---------- */

function execListRunningHubWorkflows(deps) {
  if (!deps.rhRuntime || typeof deps.rhRuntime.buildRunningHubState !== "function") {
    return { ok: false, retryable: false, error: "RunningHub 运行时不可用" };
  }
  const catalog = deps.rhRuntime.buildRunningHubState();
  return { ok: true, catalog };
}

async function execCreateRunningHubNode(bridge, task, deps, action) {
  const alias = action.alias;
  if (task.aliases[alias]) {
    const existing = findRawNode(bridge.get(), task.aliases[alias]);
    if (existing) return { ok: true, created: { alias, nodeId: task.aliases[alias] }, already_existed: true };
    delete task.aliases[alias];
  }
  const entry = resolveRhEntry(deps, action.workflowRef);
  if (!entry) return { ok: false, retryable: false, alias, error: "工作流不存在或未启用：" + refKey(action.workflowRef) };
  const overrides = {};
  const fieldIds = new Set((entry.fields || []).map((f) => f.id));
  for (const key of Object.keys(action.overrides || {})) {
    if (!fieldIds.has(key)) return { ok: false, retryable: false, alias, error: "覆盖字段不存在：" + key };
    overrides[key] = { value: action.overrides[key] };
  }
  const data = {
    rhWorkflowRef: entry.id,
    rhParams: overrides,
    status: "等待运行",
    upstreamImages: [],
    outputImages: [],
  };
  const position = computePosition(bridge, task, deps, action.position);
  const made = bridge.actions.createNode({ type: "runningHubNode", position, data });
  if (made && made.error) return { ok: false, retryable: false, alias, error: made.error };
  const nodeId = made && made.id ? made.id : (typeof made === "string" ? made : null);
  if (!nodeId) return { ok: false, retryable: false, alias, error: "createNode 未返回节点 ID" };
  const verified = await verifyCondition(deps, () => !!findRawNode(bridge.get(), nodeId), 1200, 100);
  if (!verified) return { ok: false, retryable: false, alias, error: "节点创建后未在画布中检测到" };
  task.aliases[alias] = nodeId;
  markStep(task, alias, "created");
  if (task.phase === "planning") task.phase = "creating";
  return { ok: true, created: { alias, nodeId, workflowRef: "workflow:" + entry.id } };
}

async function execBindRunningHubInput(bridge, task, deps, action) {
  const targetAlias = refKey(action.targetAlias);
  const sourceAlias = refKey(action.sourceAlias);
  const targetId = resolveLive(bridge, task, deps, action.targetAlias);
  const sourceId = resolveLive(bridge, task, deps, action.sourceAlias);
  if (!targetId || !sourceId) return { ok: false, retryable: false, error: "绑定端点不存在：" + targetAlias + " / " + sourceAlias };
  if (targetId === sourceId) return { ok: false, retryable: false, error: "不能自绑定" };
  let node = findRawNode(bridge.get(), targetId);
  const entry = node ? resolveRhEntry(deps, node.data && node.data.rhWorkflowRef) : null;
  if (!entry) return { ok: false, retryable: false, error: "目标节点没有可用的工作流字段 Schema" };
  const fieldKey = String(action.fieldKey || "");
  const field = (entry.fields || []).find((f) => f.id === fieldKey);
  if (!field) return { ok: false, retryable: false, error: "字段不存在：" + fieldKey };
  if (!isMediaFieldType(field.fieldType)) return { ok: false, retryable: false, error: "字段不是媒体字段：" + fieldKey };

  const snap = bridge.get();
  const existing = ((snap && snap.edges) || []).find((e) => e.source === sourceId && e.target === targetId);
  let edgeId;
  if (existing) {
    edgeId = existing.id;
  } else {
    const r = bridge.actions.connect(sourceId, targetId);
    if (r && r.error) return { ok: false, retryable: false, error: r.error };
    const edge = await verifyCondition(deps, () => {
      const s2 = bridge.get();
      return (((s2 && s2.edges) || []).find((e) => e.source === sourceId && e.target === targetId)) || null;
    }, 1200, 100);
    if (!edge) return { ok: false, retryable: false, error: "连线未写入画布" };
    edgeId = edge.id;
  }
  const patch = { rhParams: Object.assign({}, node.data && node.data.rhParams) };
  patch.rhParams[fieldKey] = { sourceFromUpstream: true };
  const r2 = bridge.actions.updateNode(targetId, patch);
  if (r2 && r2.error) return { ok: false, retryable: false, error: r2.error };
  return { ok: true, edgeId, fieldKey, targetAlias, sourceAlias };
}

async function execCancelRunningHub(bridge, task, deps, action) {
  const alias = refKey(action.targetAlias);
  const nodeId = resolveLive(bridge, task, deps, action.targetAlias);
  const node = nodeId && findRawNode(bridge.get(), nodeId);
  const taskId = node && node.data && node.data.task && node.data.task.taskId;
  if (!taskId) return { ok: false, retryable: false, alias, error: "节点没有运行中的任务 ID" };
  if (!deps.rhRuntime || typeof deps.rhRuntime.cancelTask !== "function") {
    return { ok: false, retryable: false, alias, error: "RunningHub 运行时不可用" };
  }
  try {
    await deps.rhRuntime.cancelTask(taskId);
  } catch (e) {
    return { ok: false, retryable: false, alias, taskId, error: "取消失败：" + ((e && e.message) || e) };
  }
  bridge.actions.updateNode(nodeId, {
    running: false,
    status: "失败",
    runError: "用户取消了 RunningHub 任务",
    task: Object.assign({}, node.data.task, { status: "cancelled", finishedAt: Date.now() }),
  });
  return { ok: true, alias, taskId };
}

async function execRecoverRunningHubTask(bridge, task, deps, action) {
  const alias = refKey(action.targetAlias);
  const nodeId = resolveLive(bridge, task, deps, action.targetAlias);
  if (!nodeId) return { ok: false, retryable: false, alias, error: "未找到节点：" + alias };
  if (!deps.rhRuntime || typeof deps.rhRuntime.recoverNode !== "function") {
    return { ok: false, retryable: false, alias, error: "RunningHub 运行时不可用" };
  }
  const r = await deps.rhRuntime.recoverNode(nodeId);
  if (!r.ok) return { ok: false, retryable: true, alias, error: r.error || "恢复失败" };
  return { ok: true, alias, status: r.status, outputs: r.outputs, failReason: r.failReason };
}

async function execAction(bridge, task, deps, action) {
  switch (action.name) {
    case "createNode": return execCreateNode(bridge, task, deps, action);
    case "updateNode": return execUpdateNode(bridge, task, deps, action);
    case "connect": return execConnect(bridge, task, deps, action);
    case "runNode": return execRunNode(bridge, task, deps, action);
    case "inspectNode": return execInspectNode(bridge, task, deps, action);
    case "listRunningHubWorkflows": return execListRunningHubWorkflows(deps);
    case "createRunningHubNode": return execCreateRunningHubNode(bridge, task, deps, action);
    case "bindRunningHubInput": return execBindRunningHubInput(bridge, task, deps, action);
    case "cancelRunningHub": return execCancelRunningHub(bridge, task, deps, action);
    case "recoverRunningHubTask": return execRecoverRunningHubTask(bridge, task, deps, action);
    default: return { ok: false, retryable: false, error: "不支持的动作：" + action.name };
  }
}

/* ---------- 主循环 ---------- */

function summarizeTurn(decision, execution) {
  if (!decision) return "";
  if (decision.type === "wait") {
    return "等待 " + refKey(decision.waitFor && decision.waitFor.alias) + (execution ? (execution.ok ? " → " + execution.status : " → " + (execution.error || "失败")) : "");
  }
  if (decision.type === "action") {
    const a = decision.action || {};
    if (a.name === "createNode") {
      return execution && execution.ok ? "创建节点 " + a.alias + "（" + execution.created.nodeId + "）" : "创建节点失败：" + (execution && execution.error);
    }
    if (a.name === "connect") {
      return execution && execution.ok ? "已建立连线 " + refKey(a.from) + " → " + refKey(a.to) : "连线失败：" + (execution && execution.error);
    }
    if (a.name === "runNode") {
      return execution && execution.ok ? "提交运行 " + refKey(a.target) + (execution.already_running ? "（已在运行中）" : "") : "运行提交失败：" + (execution && execution.error);
    }
    if (a.name === "updateNode") {
      return execution && execution.ok ? "已修改节点 " + refKey(a.target) : "修改失败：" + (execution && execution.error);
    }
    if (a.name === "inspectNode") {
      return execution && execution.ok ? "检查节点 " + refKey(a.target) + "：" + (execution.status || "无状态") : "检查失败：" + (execution && execution.error);
    }
    if (a.name === "listRunningHubWorkflows") {
      return execution && execution.ok
        ? "读取工作流目录（" + ((execution.catalog && execution.catalog.workflows) || []).length + " 条）"
        : "读取失败：" + (execution && execution.error);
    }
    if (a.name === "createRunningHubNode") {
      return execution && execution.ok
        ? "创建 RunningHub 节点 " + a.alias + "（" + execution.created.nodeId + "，" + execution.created.workflowRef + "）"
        : "创建失败：" + (execution && execution.error);
    }
    if (a.name === "bindRunningHubInput") {
      return execution && execution.ok
        ? "绑定 " + execution.sourceAlias + " → " + execution.targetAlias + " 的 " + execution.fieldKey
        : "绑定失败：" + (execution && execution.error);
    }
    if (a.name === "cancelRunningHub") {
      return execution && execution.ok ? "已取消任务 " + execution.taskId : "取消失败：" + (execution && execution.error);
    }
    if (a.name === "recoverRunningHubTask") {
      return execution && execution.ok
        ? "恢复查询 " + refKey(a.targetAlias) + "：" + (execution.failReason || ("状态 " + execution.status + (execution.outputs != null ? "，" + execution.outputs + " 个输出" : "")))
        : "恢复失败：" + (execution && execution.error);
    }
    return "动作 " + a.name;
  }
  if (decision.type === "clarify") return "向用户澄清";
  if (decision.type === "finish") return "任务完成";
  return decision.type;
}

function pushTurn(task, turn, decision, execution, note) {
  const entry = {
    turn,
    type: decision.type,
    action: decision.action ? decision.action.name : decision.type === "wait" ? "waitFor" : decision.type,
    summary: summarizeTurn(decision, execution),
    ok: execution ? execution.ok !== false : true,
  };
  if (note) entry.note = note;
  task.turns.push(entry);
  task.lastExecution = { turn, type: entry.type, summary: entry.summary, ok: entry.ok };
  return entry;
}

function formatTurn(t) {
  let line = "第" + t.turn + "轮 " + (t.action || t.type) + "：" + (t.summary || "");
  if (t.ok === false) line += " ❌";
  if (t.note) line += "（" + t.note + "）";
  return line;
}

function emit(onTurn, task) {
  if (typeof onTurn === "function") onTurn(task);
}

function failTask(task, message) {
  task.phase = "failed";
  return { status: "failed", message, task };
}

/* 循环主入口：每轮一个决策，直到完成 / 澄清 / 失败 / 回退 / 超过 30 轮。 */
async function runAgentTask(opts) {
  const bridge = opts.bridge;
  const callModel = opts.callModel;
  const task = opts.task;
  const onTurn = opts.onTurn;
  const deps = Object.assign({ sleep, now: () => Date.now(), resolveNodeId: null }, opts.deps || {});
  if (!bridge || !bridge.get || !bridge.actions) return failTask(task, "画布桥接不可用");
  if (typeof callModel !== "function") return failTask(task, "模型调用不可用");
  if (!task._runResults) task._runResults = new Map();

  for (let turn = 1; turn <= MAX_TURNS; turn += 1) {
    const rawSnap = bridge.get();
    const canvasState = buildCanvasState(rawSnap, task.revision);
    const taskState = buildTaskSnapshot(task, rawSnap);
    const runningHubState = deps.rhRuntime && typeof deps.rhRuntime.buildRunningHubState === "function"
      ? deps.rhRuntime.buildRunningHubState()
      : null;
    const messages = buildSystemPrompt({
      canvasState,
      taskState,
      conversation: task.conversation,
      capabilities: buildCapabilities(rawSnap),
      runningHubState,
    });

    let content;
    try {
      content = await callModel(messages);
    } catch (e) {
      return failTask(task, "模型请求失败：" + ((e && e.message) || e));
    }

    let parsed = extractDecision(content);
    let validation = validateDecision(parsed.ok ? parsed.value : null, { task, rawSnap, deps });
    if (!validation.ok) {
      /* 一次格式修复重问；仍失败则回退 */
      const repairMessages = messages.concat([
        { role: "assistant", content: typeof content === "string" ? content.slice(0, 4000) : "" },
        { role: "user", content: "上一条回复不符合决策协议，原因：" + validation.error + "。请重新只输出一个合法 JSON 决策对象（顶层含 decisionId、type、reason），不要 Markdown 代码围栏，不要解释。" },
      ]);
      let repairedContent;
      try {
        repairedContent = await callModel(repairMessages);
      } catch (e) {
        return failTask(task, "模型请求失败：" + ((e && e.message) || e));
      }
      content = repairedContent;
      parsed = extractDecision(repairedContent);
      validation = validateDecision(parsed.ok ? parsed.value : null, { task, rawSnap, deps });
      if (!validation.ok) {
        if (validation.kind === "legacy" && parsed.value && Array.isArray(parsed.value.actions)) {
          return { status: "fallback", reason: validation.error, rawContent: content, legacyActions: parsed.value.actions, task };
        }
        return { status: "fallback", reason: validation.error, rawContent: content, task };
      }
    }

    const decision = parsed.value;
    task.seenDecisionIds.push(decision.decisionId);
    if (decision.taskPlan && task.phase === "planning") {
      const pr = registerPlan(task, decision.taskPlan);
      if (!pr.ok) return failTask(task, "taskPlan 登记失败：" + pr.error);
    }

    if (decision.type === "clarify") {
      pushTurn(task, turn, decision, { ok: true }, "等待用户澄清");
      task.awaitingClarify = true;
      emit(onTurn, task);
      return { status: "clarify", question: decision.question, task };
    }

    if (decision.type === "finish") {
      const criteria = evaluateCriteria(task, bridge.get());
      if (!criteria.all) return failTask(task, "finish 被拒绝：成功条件未全部满足");
      task.phase = "completed";
      pushTurn(task, turn, decision, { ok: true });
      emit(onTurn, task);
      return { status: "completed", message: decision.message, criteria, task };
    }

    let execution;
    if (decision.type === "wait") {
      emit(onTurn, task);
      execution = await execWaitFor(bridge, task, deps, decision.waitFor);
    } else {
      execution = await execAction(bridge, task, deps, decision.action);
    }
    if (execution && execution.ok) task.revision += 1;
    pushTurn(task, turn, decision, execution);
    emit(onTurn, task);

    if (execution && execution.ok === false) {
      const alias = execution.alias || (decision.action ? (decision.action.alias || refKey(decision.action.target)) : "");
      const attempts = task.runAttempts[alias] || 0;
      if (execution.retryable === false || attempts >= MAX_RUN_ATTEMPTS) {
        markBlocked(task, alias);
        return failTask(task, "节点 " + (alias || "?") + " 失败且无法重试，依赖它的步骤已阻断：" + (execution.error || "未知错误"));
      }
      /* retryable：模型下一轮自行决定重试或换方案 */
    }
  }

  return failTask(task, "Agent 超过 " + MAX_TURNS + " 轮仍未完成，任务已暂停，禁止继续自动操作");
}

const agentLoop = {
  buildSystemPrompt,
  createEmptyTask,
  appendConversation,
  registerPlan,
  buildCanvasState,
  extractDecision,
  validateDecision,
  nodeTerminalState,
  evaluateCriteria,
  runAgentTask,
  formatTurn,
};

export {
  SPEC_SYSTEM_PROMPT,
  buildSystemPrompt,
  createEmptyTask,
  appendConversation,
  registerPlan,
  buildCanvasState,
  extractDecision,
  validateDecision,
  nodeTerminalState,
  evaluateCriteria,
  runAgentTask,
  formatTurn,
  resolveRhEntry,
  rhRequiredMediaMissing,
};

if (typeof window !== "undefined") {
  window.__AI2_AGENT_LOOP = agentLoop;
}
