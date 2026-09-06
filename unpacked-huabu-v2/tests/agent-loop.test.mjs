/* GLM 5.3 Flash 无限画布 Agent 循环编排 — 测试
   运行：node --test tests/agent-loop.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
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
  rhRequiredMediaMissing,
} from "../dist/assets/ai2-agent-loop.js";

/* ---------- 测试替身 ---------- */

function makeFakeBridge(options = {}) {
  let seq = 0;
  const state = {
    nodes: (options.nodes || []).map((n) => ({
      id: n.id,
      type: n.type,
      position: { ...(n.position || { x: 0, y: 0 }) },
      selected: !!n.selected,
      data: { ...(n.data || {}) },
    })),
    edges: (options.edges || []).map((e) => ({ ...e })),
  };
  const calls = [];
  const runScripts = new Map();
  const defaultRunScript = options.defaultRunScript || (() => Promise.resolve({ ok: true }));
  const bridge = {
    get() {
      return {
        nodes: state.nodes.map((n) => ({
          id: n.id,
          type: n.type,
          position: { ...n.position },
          selected: !!n.selected,
          data: { ...n.data },
        })),
        edges: state.edges.map((e) => ({ ...e })),
        settings: {},
        createdAt: 0,
      };
    },
    actions: {
      createNode(input) {
        calls.push(["createNode", input.type, input.data && input.data.prompt]);
        const node = {
          id: "node_" + (++seq),
          type: input.type || "generateNode",
          position: { ...(input.position || { x: 0, y: 0 }) },
          selected: false,
          data: { ...(input.data || {}) },
        };
        state.nodes.push(node);
        return node;
      },
      updateNode(id, patch) {
        calls.push(["updateNode", id]);
        const node = state.nodes.find((n) => n.id === id);
        if (!node) return { error: "未找到节点：" + id };
        node.data = { ...node.data, ...patch };
        return { id };
      },
      connect(source, target) {
        calls.push(["connect", source, target]);
        if (state.edges.some((e) => e.source === source && e.target === target)) return;
        state.edges.push({ id: "edge_" + (++seq), source, target, type: "customEdge" });
        /* 模拟 bundle 的 upstreamImages 同步 effect：连线后把源节点当前主图写入目标 */
        const src = state.nodes.find((n) => n.id === source);
        const tgt = state.nodes.find((n) => n.id === target);
        if (src && tgt) {
          const media = src.data.image || (src.data.outputImages || [])[0] || null;
          if (media) tgt.data.upstreamImages = [].concat(tgt.data.upstreamImages || [], [media]);
        }
      },
      runNode(id) {
        calls.push(["runNode", id]);
        const node = state.nodes.find((n) => n.id === id);
        if (!node) return Promise.resolve({ ok: false, id, error: "未找到节点" });
        node.data.running = true;
        node.data.status = "运行中...";
        const script = runScripts.get(id) || defaultRunScript;
        return script().then((result) => {
          node.data.running = false;
          if (result && result.ok) {
            node.data.status = node.type === "runningHubNode" ? "运行成功" : "生成成功";
            node.data.image = node.data.image || "data:image/png;base64,FAKEIMAGE";
            node.data.outputImages = [...(node.data.outputImages || []), node.data.image];
          } else {
            node.data.status = "失败";
            node.data.error = (result && result.error) || "未知错误";
          }
          return result;
        });
      },
      moveNode() {},
    },
    __state: state,
    __calls: calls,
    __setRunScript(id, fn) {
      runScripts.set(id, fn);
    },
  };
  return bridge;
}

function makeScriptedModel(responses) {
  let i = 0;
  const received = [];
  return {
    received,
    call: async (messages) => {
      received.push(messages);
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return typeof r === "function" ? r(i) : r;
    },
  };
}

function makeDeps() {
  return { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now(), resolveNodeId: null };
}

const DOG_CAT_PLAN = {
  goal: "先生成狗，再基于狗图生成狗和猫",
  steps: [
    { stepId: "step_dog", alias: "dog", intent: "创建并生成一只狗", dependsOn: [] },
    { stepId: "step_dog_cat", alias: "dogCat", intent: "基于狗图在狗旁边增加一只猫", dependsOn: ["dog"] },
  ],
  successCriteria: [
    { alias: "dog", terminalStatus: "success", requireOutput: true },
    { alias: "dogCat", terminalStatus: "success", requireOutput: true },
    { edge: { from: "dog", to: "dogCat", inputRole: "image" } },
  ],
};

function decision(obj) {
  return JSON.stringify(obj);
}

/* ---------- registerPlan ---------- */

test("registerPlan accepts a valid dog-cat plan and enters creating phase", () => {
  const task = createEmptyTask("生成狗再加猫");
  const r = registerPlan(task, DOG_CAT_PLAN);
  assert.equal(r.ok, true);
  assert.equal(task.phase, "creating");
  assert.equal(task.plan.steps.length, 2);
  assert.equal(task.successCriteria.length, 3);
});

test("registerPlan rejects empty steps, duplicate alias, unknown deps, cycles and bad criteria", () => {
  const empty = registerPlan(createEmptyTask("t"), { goal: "g", steps: [], successCriteria: [{ alias: "a" }] });
  assert.equal(empty.ok, false);

  const dup = registerPlan(createEmptyTask("t"), {
    goal: "g",
    steps: [
      { stepId: "s1", alias: "dog", intent: "", dependsOn: [] },
      { stepId: "s2", alias: "dog", intent: "", dependsOn: [] },
    ],
    successCriteria: [{ alias: "dog" }],
  });
  assert.equal(dup.ok, false);

  const badDep = registerPlan(createEmptyTask("t"), {
    goal: "g",
    steps: [{ stepId: "s1", alias: "dog", intent: "", dependsOn: ["ghost"] }],
    successCriteria: [{ alias: "dog" }],
  });
  assert.equal(badDep.ok, false);

  const cycle = registerPlan(createEmptyTask("t"), {
    goal: "g",
    steps: [
      { stepId: "s1", alias: "a", intent: "", dependsOn: ["b"] },
      { stepId: "s2", alias: "b", intent: "", dependsOn: ["a"] },
    ],
    successCriteria: [{ alias: "a" }],
  });
  assert.equal(cycle.ok, false);

  const ghostCriteria = registerPlan(createEmptyTask("t"), {
    goal: "g",
    steps: [{ stepId: "s1", alias: "a", intent: "", dependsOn: [] }],
    successCriteria: [{ alias: "ghost" }],
  });
  assert.equal(ghostCriteria.ok, false);
});

test("registerPlan dryRun does not mutate the task", () => {
  const task = createEmptyTask("t");
  const r = registerPlan(task, DOG_CAT_PLAN, { dryRun: true });
  assert.equal(r.ok, true);
  assert.equal(task.phase, "planning");
  assert.equal(task.plan, null);
});

test("registerPlan accepts dependencies declared before their source step", () => {
  const task = createEmptyTask("先生成狗，再在下游加猫");
  const r = registerPlan(task, {
    goal: "先生成狗，再在下游加猫",
    steps: [
      { stepId: "s_cat", alias: "dogCat", intent: "在狗旁边增加猫", dependsOn: ["dog"] },
      { stepId: "s_dog", alias: "dog", intent: "生成一只狗", dependsOn: [] },
    ],
    successCriteria: [
      { alias: "dog", terminalStatus: "success", requireOutput: true },
      { alias: "dogCat", terminalStatus: "success", requireOutput: true },
      { edge: { from: "dog", to: "dogCat", inputRole: "image" } },
    ],
  });
  assert.equal(r.ok, true, r.error || "逆序依赖不应被判为非法");
  assert.deepEqual(task.plan.steps.map((s) => s.alias), ["dogCat", "dog"]);
});

/* ---------- extractDecision ---------- */

test("extractDecision parses fenced JSON, bare JSON and rejects garbage", () => {
  const fenced = extractDecision("说明\n```json\n{\"decisionId\":\"d1\",\"type\":\"finish\"}\n```\n");
  assert.equal(fenced.ok, true);
  assert.equal(fenced.value.decisionId, "d1");

  const bare = extractDecision('{"decisionId":"d2","type":"wait"}');
  assert.equal(bare.ok, true);

  const embedded = extractDecision('前置说明 {"decisionId":"d3","type":"action","action":{"name":"connect"}} 后缀');
  assert.equal(embedded.ok, true);

  const garbage = extractDecision("这不是 JSON");
  assert.equal(garbage.ok, false);
});

/* ---------- validateDecision ---------- */

function makeCtx(task, nodes = [], edges = [], deps = makeDeps()) {
  return { task, rawSnap: { nodes, edges }, deps };
}

/* ---------- RunningHub fixtures ---------- */

const RH_FIELDS = [
  { id: "12::image", nodeId: "12", fieldName: "image", fieldType: "IMAGE", required: true, sourceFromUpstream: true, imageOrder: 1, enabled: true, fieldValue: "" },
  { id: "28::resolution", nodeId: "28", fieldName: "resolution", fieldType: "SELECT", options: ["2048", "4096"], fieldValue: "2048", enabled: true },
];
const RH_ENTRIES = [{ id: "rhw1", workflowId: "555", title: "seedvr2.5高清放大", fields: RH_FIELDS }];

const RH_PLAN = {
  goal: "用 seedvr2.5 放大上游图片",
  steps: [
    { stepId: "s_source", alias: "source", intent: "准备上游图片", dependsOn: [] },
    { stepId: "s_upscale", alias: "upscale", intent: "RunningHub 放大", dependsOn: ["source"] },
  ],
  successCriteria: [
    { alias: "source", terminalStatus: "success", requireOutput: true },
    { alias: "upscale", terminalStatus: "success", requireOutput: true },
    { edge: { from: "source", to: "upscale", inputRole: "image" } },
  ],
};

function makeRhDeps(overrides = {}) {
  const deps = makeDeps();
  deps.getRhWorkflows = () => RH_ENTRIES;
  deps.rhRuntime = {
    buildRunningHubState: () => ({
      configured: true,
      workflows: [{
        workflowRef: "workflow:rhw1",
        workflowIdMasked: "555",
        title: "seedvr2.5高清放大",
        enabled: true,
        fields: RH_FIELDS.map((f) => ({ fieldKey: f.id, role: f.fieldType === "IMAGE" ? "image" : "select", required: !!f.required, sourceFromUpstream: !!f.sourceFromUpstream, options: f.options })),
      }],
    }),
    cancelTask: overrides.cancelTask || (async (taskId) => ({ ok: true, taskId })),
    recoverNode: overrides.recoverNode || (async () => ({ ok: true, status: "success", outputs: 2 })),
  };
  return deps;
}

test("validateDecision enforces decisionId, type/reason and first-turn taskPlan", () => {
  const task = createEmptyTask("t");
  const ctx = makeCtx(task);

  const missingPlan = validateDecision({ decisionId: "d1", type: "action", reason: "r", action: { name: "inspectNode", target: { alias: "x" } } }, ctx);
  assert.equal(missingPlan.ok, false);
  assert.match(missingPlan.error, /taskPlan/);

  const noReason = validateDecision({ decisionId: "d1", type: "clarify", question: "q" }, ctx);
  assert.equal(noReason.ok, false);

  /* clarify 不触碰画布，允许先于 taskPlan */
  const clarifyFirst = validateDecision({ decisionId: "d1", type: "clarify", reason: "r", question: "q" }, ctx);
  assert.equal(clarifyFirst.ok, true);

  const okFirst = validateDecision({ decisionId: "d0", type: "clarify", reason: "r", question: "q", taskPlan: DOG_CAT_PLAN }, ctx);
  assert.equal(okFirst.ok, true);

  /* decisionId 去重针对已执行过的决策（循环在执行后登记） */
  task.seenDecisionIds.push("d1");
  const dupId = validateDecision({ decisionId: "d1", type: "clarify", reason: "r", question: "q" }, ctx);
  assert.equal(dupId.ok, false);
  assert.match(dupId.error, /decisionId 重复/);
});

test("validateDecision rejects legacy actions arrays with kind=legacy", () => {
  const ctx = makeCtx(createEmptyTask("t"));
  const r = validateDecision({ decisionId: "d1", actions: [{ action: "createNode" }] }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "legacy");
});

test("validateDecision rejects forbidden and unknown actions", () => {
  const task = createEmptyTask("t");
  registerPlan(task, DOG_CAT_PLAN);
  const ctx = makeCtx(task);
  for (const name of ["layout", "moveNode", "deleteNode", "explode"]) {
    const r = validateDecision(decision({ decisionId: "d" + name, type: "action", reason: "r", action: { name } }), ctx);
    assert.equal(r.ok, false, name);
  }
});

test("validateDecision normalizes a safe single-action alias and explains a missing action name", () => {
  const task = createEmptyTask("生成狗");
  registerPlan(task, {
    goal: "生成狗",
    steps: [{ stepId: "s1", alias: "dog", intent: "生成一只狗", dependsOn: [] }],
    successCriteria: [{ alias: "dog" }],
  });
  const alias = validateDecision(
    { decisionId: "d_alias", type: "action", reason: "创建节点", action: { action: "createNode", alias: "dog", nodeType: "generateNode", data: { prompt: "一只狗" } } },
    makeCtx(task),
  );
  assert.equal(alias.ok, true);

  const planned = createEmptyTask("生成狗");
  registerPlan(planned, {
    goal: "生成狗",
    steps: [{ stepId: "s1", alias: "dog", intent: "生成一只狗", dependsOn: [] }],
    successCriteria: [{ alias: "dog" }],
  });
  const missing = validateDecision(
    { decisionId: "d_missing", type: "action", reason: "创建节点", action: {} },
    makeCtx(planned),
  );
  assert.equal(missing.ok, false);
  assert.match(missing.error, /action\.name 缺失/);
});

test("validateDecision blocks downstream runNode until upstream success and connected", () => {
  const task = createEmptyTask("t");
  registerPlan(task, DOG_CAT_PLAN);
  task.aliases.dog = "n_dog";
  task.aliases.dogCat = "n_cat";

  /* 依赖步骤尚未成功 */
  const runningNodes = [
    { id: "n_dog", type: "generateNode", data: { running: true, status: "运行中..." } },
    { id: "n_cat", type: "generateNode", data: {} },
  ];
  const depPending = validateDecision(
    { decisionId: "d1", type: "action", reason: "r", action: { name: "runNode", target: { alias: "dogCat" } } },
    makeCtx(task, runningNodes),
  );
  assert.equal(depPending.ok, false);
  assert.match(depPending.error, /依赖步骤 dog 尚未成功/);

  /* 依赖成功但还没连线：必须先 connect 再 runNode */
  const successNodes = [
    { id: "n_dog", type: "generateNode", data: { status: "生成成功", image: "data:image/png;base64,x" } },
    { id: "n_cat", type: "generateNode", data: { status: "" } },
  ];
  const noEdge = validateDecision(
    { decisionId: "d2", type: "action", reason: "r", action: { name: "runNode", target: { alias: "dogCat" } } },
    makeCtx(task, successNodes),
  );
  assert.equal(noEdge.ok, false);
  assert.match(noEdge.error, /先 connect 再 runNode/);

  /* 依赖成功且连线存在：放行 */
  const edges = [{ id: "e1", source: "n_dog", target: "n_cat" }];
  const ok = validateDecision(
    { decisionId: "d3", type: "action", reason: "r", action: { name: "runNode", target: { alias: "dogCat" } } },
    makeCtx(task, successNodes, edges),
  );
  assert.equal(ok.ok, true);
});

test("validateDecision blocks runNode when upstream edge source is still running", () => {
  const task = createEmptyTask("t");
  registerPlan(task, DOG_CAT_PLAN);
  task.aliases.dog = "n_dog";
  task.aliases.dogCat = "n_cat";
  const nodes = [
    { id: "n_dog", type: "generateNode", data: { running: true, status: "运行中..." } },
    { id: "n_cat", type: "generateNode", data: {} },
  ];
  const r = validateDecision(
    { decisionId: "d1", type: "action", reason: "r", action: { name: "runNode", target: { alias: "dogCat" } } },
    makeCtx(task, nodes, [{ id: "e1", source: "n_dog", target: "n_cat" }]),
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /上游节点尚未成功/);
});

test("validateDecision rejects finish until all criteria are satisfied", () => {
  const task = createEmptyTask("t");
  registerPlan(task, DOG_CAT_PLAN);
  task.aliases.dog = "n_dog";
  const nodes = [{ id: "n_dog", type: "generateNode", data: { status: "生成成功", image: "data:image/png;base64,x" } }];
  const r = validateDecision({ decisionId: "d1", type: "finish", reason: "r", message: "done" }, makeCtx(task, nodes));
  assert.equal(r.ok, false);
  assert.match(r.error, /成功条件未全部满足/);

  task.aliases.dogCat = "n_cat";
  task.successCriteria = [{ kind: "node", alias: "dog", terminalStatus: "success", requireOutput: true }];
  const ok = validateDecision({ decisionId: "d2", type: "finish", reason: "r", message: "done" }, makeCtx(task, nodes));
  assert.equal(ok.ok, true);
});

test("validateDecision rejects runNode beyond the two-attempt ceiling", () => {
  const task = createEmptyTask("t");
  registerPlan(task, {
    goal: "g",
    steps: [{ stepId: "s1", alias: "dog", intent: "", dependsOn: [] }],
    successCriteria: [{ alias: "dog" }],
  });
  task.aliases.dog = "n_dog";
  task.runAttempts.dog = 2;
  const ctx = makeCtx(task, [{ id: "n_dog", type: "generateNode", data: {} }]);
  const r = validateDecision(
    { decisionId: "d1", type: "action", reason: "r", action: { name: "runNode", target: { alias: "dog" } } },
    ctx,
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /最多 2 次运行上限/);
});

test("validateDecision blocks downstream createNode until upstream success (plan level)", () => {
  const task = createEmptyTask("t");
  registerPlan(task, DOG_CAT_PLAN);
  task.aliases.dog = "n_dog";
  const nodes = [{ id: "n_dog", type: "generateNode", data: { running: true, status: "运行中..." } }];
  const r = validateDecision(
    { decisionId: "d1", type: "action", reason: "r", action: { name: "createNode", alias: "dogCat", nodeType: "generateNode", data: { prompt: "猫" }, position: { mode: "downstream", relativeTo: "dog" } } },
    makeCtx(task, nodes),
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /禁止创建 dogCat/);
});

test("validateDecision enforces wait/clarify/finish field shapes", () => {
  const task = createEmptyTask("t");
  registerPlan(task, DOG_CAT_PLAN);
  task.aliases.dog = "n_dog";
  const ctx = makeCtx(task, [{ id: "n_dog", type: "generateNode", data: {} }]);

  assert.equal(validateDecision({ decisionId: "d1", type: "wait", reason: "r", waitFor: { alias: "dog" } }, ctx).ok, true);
  assert.equal(validateDecision({ decisionId: "d2", type: "wait", reason: "r", waitFor: { alias: "ghost" } }, ctx).ok, false);
  assert.equal(validateDecision({ decisionId: "d3", type: "clarify", reason: "r" }, ctx).ok, false);
  assert.equal(validateDecision({ decisionId: "d4", type: "finish", reason: "r" }, ctx).ok, false);
});

/* ---------- nodeTerminalState ---------- */

test("nodeTerminalState detects success/running/failed/pending for the three node types", () => {
  assert.equal(nodeTerminalState({ running: true, status: "运行中..." }, "generateNode"), "running");
  assert.equal(nodeTerminalState({ status: "生成成功", image: "x" }, "generateNode"), "success");
  assert.equal(nodeTerminalState({ status: "生成成功" }, "generateNode"), "pending");
  assert.equal(nodeTerminalState({ status: "失败" }, "generateNode"), "failed");
  assert.equal(nodeTerminalState({ status: "生成成功", outputVideo: "http://v" }, "videoNode"), "success");
  assert.equal(nodeTerminalState({ status: "生成成功", outputVideo: "http://v" }, "generateNode"), "pending");
  assert.equal(nodeTerminalState({ status: "生成成功", text: "你好" }, "textNode"), "success");
  assert.equal(nodeTerminalState({ status: "生成成功" }, "textNode"), "pending");
  assert.equal(nodeTerminalState({ status: "运行成功", outputImages: ["a"] }, "runningHubNode"), "success");
  assert.equal(nodeTerminalState({}, "generateNode"), "pending");
});

/* ---------- evaluateCriteria / buildCanvasState ---------- */

test("evaluateCriteria checks node output and edge existence", () => {
  const task = createEmptyTask("t");
  registerPlan(task, DOG_CAT_PLAN);
  task.aliases.dog = "n_dog";
  task.aliases.dogCat = "n_cat";
  const snap = {
    nodes: [
      { id: "n_dog", type: "generateNode", data: { status: "生成成功", image: "x" } },
      { id: "n_cat", type: "generateNode", data: { status: "" } },
    ],
    edges: [],
  };
  const r1 = evaluateCriteria(task, snap);
  assert.equal(r1.all, false);
  assert.equal(r1.entries[0].satisfied, true);
  assert.equal(r1.entries[2].satisfied, false);

  snap.edges.push({ id: "e1", source: "n_dog", target: "n_cat" });
  const r2 = evaluateCriteria(task, snap);
  assert.equal(r2.entries[2].satisfied, true);
  assert.equal(r2.all, false);
});

test("buildCanvasState truncates long image payloads and projects edges", () => {
  const longImage = "data:image/png;base64," + "A".repeat(5000);
  const snap = {
    nodes: [{ id: "n1", type: "generateNode", position: { x: 10.4, y: 20.6 }, data: { title: "图片节点1", prompt: "p", image: longImage, running: true } }],
    edges: [{ id: "e1", source: "n1", target: "n2" }],
  };
  const cs = buildCanvasState(snap, 7);
  assert.equal(cs.revision, 7);
  assert.equal(cs.nodes[0].data.image.length < 100, true);
  assert.match(cs.nodes[0].data.image, /…\(长度\d+\)/);
  assert.equal(cs.nodes[0].position.x, 10);
  assert.equal(cs.edges[0].inputRole, "image");
});

test("buildSystemPrompt injects canvas/task/conversation into the spec template", () => {
  const task = createEmptyTask("生成狗");
  const msgs = buildSystemPrompt({
    canvasState: buildCanvasState({ nodes: [], edges: [] }, 1),
    taskState: buildTaskSnapshotSafe(task),
    conversation: task.conversation,
    capabilities: { nodeTypes: ["generateNode"], actions: ["createNode"] },
  });
  assert.equal(msgs[0].role, "system");
  assert.match(msgs[0].content, /无限画布 Agent/);
  assert.match(msgs[0].content, /生成狗/);
  assert.doesNotMatch(msgs[0].content, /\{\{canvas_state\}\}/);
  assert.doesNotMatch(msgs[0].content, /\{\{task_state\}\}/);
  assert.doesNotMatch(msgs[0].content, /\{\{conversation\}\}/);

  function buildTaskSnapshotSafe(t) {
    return { taskId: t.taskId, phase: t.phase, aliases: {}, steps: [], successCriteria: [] };
  }
});

/* ---------- runAgentTask 集成 ---------- */

test("dog-cat chain: create → run → wait → create → connect → run → wait → finish", async () => {
  const bridge = makeFakeBridge();
  const model = makeScriptedModel([
    decision({ decisionId: "d_001", type: "action", reason: "创建狗节点", taskPlan: DOG_CAT_PLAN, action: { name: "createNode", alias: "dog", nodeType: "generateNode", data: { prompt: "一只狗" }, position: { mode: "auto" } } }),
    decision({ decisionId: "d_002", type: "action", reason: "运行狗节点", action: { name: "runNode", target: { alias: "dog" }, retryPolicy: { maxAttempts: 2 } } }),
    decision({ decisionId: "d_003", type: "wait", reason: "等狗图终态", waitFor: { alias: "dog", terminalStatuses: ["success", "failed"], requireOutput: true, timeoutMs: 5000, pollMs: 300 } }),
    decision({ decisionId: "d_004", type: "action", reason: "创建下游节点", action: { name: "createNode", alias: "dogCat", nodeType: "generateNode", data: { prompt: "保留原图中的狗，在狗旁边增加一只猫" }, position: { mode: "downstream", relativeTo: "dog" } } }),
    decision({ decisionId: "d_005", type: "action", reason: "建立图片连线", action: { name: "connect", from: { alias: "dog" }, to: { alias: "dogCat" }, inputRole: "image" } }),
    decision({ decisionId: "d_006", type: "action", reason: "运行下游节点", action: { name: "runNode", target: { alias: "dogCat" }, retryPolicy: { maxAttempts: 2 } } }),
    decision({ decisionId: "d_007", type: "wait", reason: "等最终结果", waitFor: { alias: "dogCat", terminalStatuses: ["success", "failed"], requireOutput: true, timeoutMs: 5000, pollMs: 300 } }),
    decision({ decisionId: "d_008", type: "finish", reason: "狗节点和下游狗猫节点均已成功并产生图片", message: "已完成：先生成了狗，再基于狗图创建下游节点并生成了狗旁边有猫的图片。" }),
  ]);
  const task = createEmptyTask("给我生成一只狗，生成完成后再拉出下游一个节点，再新节点上狗旁边加上一只猫。");
  const result = await runAgentTask({ bridge, callModel: model.call, task, deps: makeDeps() });

  assert.equal(result.status, "completed");
  assert.equal(task.phase, "completed");
  assert.match(result.message, /狗/);

  const kinds = bridge.__calls.map((c) => c[0]);
  assert.deepEqual(kinds, ["createNode", "runNode", "createNode", "connect", "runNode"]);
  assert.equal(bridge.__calls[0][2], "一只狗");
  assert.match(bridge.__calls[2][2], /保留原图中的狗/);
  assert.equal(bridge.__calls[3][1], task.aliases.dog);
  assert.equal(bridge.__calls[3][2], task.aliases.dogCat);

  const dogNode = bridge.__state.nodes.find((n) => n.id === task.aliases.dog);
  const catNode = bridge.__state.nodes.find((n) => n.id === task.aliases.dogCat);
  assert.equal(catNode.position.x, dogNode.position.x + 380);
  assert.ok(bridge.__state.edges.some((e) => e.source === task.aliases.dog && e.target === task.aliases.dogCat));

  const finishTurn = task.turns[task.turns.length - 1];
  assert.equal(finishTurn.type, "finish");
  assert.equal(task.runAttempts.dog, 1);
  assert.equal(task.runAttempts.dogCat, 1);
});

test("upstream failing twice blocks downstream and never finishes", async () => {
  const bridge = makeFakeBridge({ defaultRunScript: () => Promise.resolve({ ok: false, error: "API 限流" }) });
  const model = makeScriptedModel([
    decision({ decisionId: "f_001", type: "action", reason: "创建狗节点", taskPlan: DOG_CAT_PLAN, action: { name: "createNode", alias: "dog", nodeType: "generateNode", data: { prompt: "一只狗" }, position: { mode: "auto" } } }),
    decision({ decisionId: "f_002", type: "action", reason: "运行狗节点", action: { name: "runNode", target: { alias: "dog" } } }),
    decision({ decisionId: "f_003", type: "wait", reason: "等待狗节点终态", waitFor: { alias: "dog", timeoutMs: 5000, pollMs: 300 } }),
    decision({ decisionId: "f_004", type: "action", reason: "第一次失败可重试，重新运行", action: { name: "runNode", target: { alias: "dog" } } }),
    decision({ decisionId: "f_005", type: "wait", reason: "再次等待狗节点终态", waitFor: { alias: "dog", timeoutMs: 5000, pollMs: 300 } }),
  ]);
  const task = createEmptyTask("生成狗再 downstream 加猫");
  const result = await runAgentTask({ bridge, callModel: model.call, task, deps: makeDeps() });

  assert.equal(result.status, "failed");
  assert.match(result.message, /无法重试|阻断/);
  assert.equal(task.plan.steps.find((s) => s.alias === "dog").status, "failed");
  assert.equal(task.plan.steps.find((s) => s.alias === "dogCat").status, "blocked");
  const createCalls = bridge.__calls.filter((c) => c[0] === "createNode");
  assert.equal(createCalls.length, 1, "下游节点不得被创建");
  assert.equal(bridge.__calls.filter((c) => c[0] === "runNode").length, 2, "最多自动重试 1 次");
  assert.ok(!task.turns.some((t) => t.type === "finish"));
});

test("second run failure exhausts retries and fails the task without downstream progress", async () => {
  const bridge = makeFakeBridge({ defaultRunScript: () => Promise.resolve({ ok: false, error: "持续失败" }) });
  const task = createEmptyTask("t");
  registerPlan(task, {
    goal: "g",
    steps: [{ stepId: "s1", alias: "dog", intent: "", dependsOn: [] }],
    successCriteria: [{ alias: "dog" }],
  });
  const model = makeScriptedModel([
    decision({ decisionId: "r_001", type: "action", reason: "创建", action: { name: "createNode", alias: "dog", nodeType: "generateNode", data: { prompt: "x" }, position: { mode: "auto" } } }),
    decision({ decisionId: "r_002", type: "action", reason: "运行 1", action: { name: "runNode", target: { alias: "dog" } } }),
    decision({ decisionId: "r_003", type: "wait", reason: "等 1", waitFor: { alias: "dog", timeoutMs: 5000, pollMs: 300 } }),
    decision({ decisionId: "r_004", type: "action", reason: "第一次失败可重试，重新运行", action: { name: "runNode", target: { alias: "dog" } } }),
    decision({ decisionId: "r_005", type: "wait", reason: "等 2", waitFor: { alias: "dog", timeoutMs: 5000, pollMs: 300 } }),
  ]);
  const result = await runAgentTask({ bridge, callModel: model.call, task, deps: makeDeps() });
  assert.equal(result.status, "failed");
  assert.equal(bridge.__calls.filter((c) => c[0] === "runNode").length, 2);
  assert.equal(task.runAttempts.dog, 2);
  assert.equal(task.plan.steps[0].status, "failed");
});

test("queued forever times out into the failure path instead of faking success", async () => {
  const bridge = makeFakeBridge({ defaultRunScript: () => new Promise(() => {}) });
  const model = makeScriptedModel([
    decision({ decisionId: "t_001", type: "action", reason: "创建", taskPlan: DOG_CAT_PLAN, action: { name: "createNode", alias: "dog", nodeType: "generateNode", data: { prompt: "一只狗" }, position: { mode: "auto" } } }),
    decision({ decisionId: "t_002", type: "action", reason: "运行", action: { name: "runNode", target: { alias: "dog" } } }),
    decision({ decisionId: "t_003", type: "wait", reason: "等待终态", waitFor: { alias: "dog", timeoutMs: 600, pollMs: 300 } }),
    decision({ decisionId: "t_004", type: "clarify", reason: "超时后请求用户决定", question: "狗节点长时间无结果，是否继续等待？" }),
  ]);
  const task = createEmptyTask("生成狗");
  const result = await runAgentTask({ bridge, callModel: model.call, task, deps: makeDeps() });
  assert.equal(result.status, "clarify");
  const waitTurn = task.turns.find((t) => t.action === "waitFor");
  assert.equal(waitTurn.ok, false);
  assert.match(waitTurn.summary, /超时/);
});

test("clarify pauses the task and the same task resumes with the user's answer", async () => {
  const bridge = makeFakeBridge();
  const firstModel = makeScriptedModel([
    decision({ decisionId: "c_001", type: "clarify", reason: "用户说修改那张图，但画布有两张图", question: "画布上有两张最近图片，你要修改哪一张？" }),
  ]);
  const task = createEmptyTask("修改那张图");
  const r1 = await runAgentTask({ bridge, callModel: firstModel.call, task, deps: makeDeps() });
  assert.equal(r1.status, "clarify");
  assert.equal(task.awaitingClarify, true);

  appendConversation(task, "修改图片节点1 那张");
  const secondModel = makeScriptedModel([
    decision({ decisionId: "c_002", type: "action", reason: "按用户指定节点修改", taskPlan: {
      goal: "修改指定节点",
      steps: [{ stepId: "s1", alias: "edit", intent: "修改图片节点1", dependsOn: [] }],
      successCriteria: [{ alias: "edit" }],
    }, action: { name: "updateNode", target: { alias: "图片节点1" }, patch: { quality: "2k" } } }),
    decision({ decisionId: "c_003", type: "clarify", reason: "修改完成，暂停等待用户", question: "已修改图片节点1，还需要做什么？" }),
  ]);
  bridge.__state.nodes.push({ id: "n1", type: "generateNode", position: { x: 0, y: 0 }, selected: false, data: { title: "图片节点1", quality: "1k" } });
  const r2 = await runAgentTask({ bridge, callModel: secondModel.call, task, deps: makeDeps() });
  assert.equal(r2.status, "clarify");
  const node = bridge.__state.nodes.find((n) => n.id === "n1");
  assert.equal(node.data.quality, "2k");
  assert.equal(task.awaitingClarify, true); /* 任务再次暂停等待用户 */
});

test("model returning legacy actions array triggers the fallback signal", async () => {
  const bridge = makeFakeBridge();
  const model = makeScriptedModel([
    '好的，我来创建节点。\n```json\n{"actions":[{"action":"createNode","type":"generateNode","prompt":"一只狗"}]}\n```',
  ]);
  const task = createEmptyTask("生成一只狗");
  const result = await runAgentTask({ bridge, callModel: model.call, task, deps: makeDeps() });
  assert.equal(result.status, "fallback");
  assert.ok(Array.isArray(result.legacyActions));
  assert.equal(result.legacyActions[0].action, "createNode");
  assert.equal(bridge.__calls.length, 0, "循环执行器在旧协议下不得执行任何画布动作");
});

test("unparseable model output after one repair attempt falls back with raw content", async () => {
  const bridge = makeFakeBridge();
  let callCount = 0;
  const callModel = async () => {
    callCount += 1;
    return callCount === 1 ? "完全无法解析的回复" : "还是无法解析";
  };
  const task = createEmptyTask("生成狗");
  const result = await runAgentTask({ bridge, callModel, task, deps: makeDeps() });
  assert.equal(result.status, "fallback");
  assert.equal(callCount, 2, "最多一次格式修复重问");
  assert.equal(result.rawContent, "还是无法解析");
  assert.equal(bridge.__calls.length, 0, "回退前不得执行任何画布动作");
});

test("inspectNode reports node status without changing the canvas", async () => {
  const bridge = makeFakeBridge();
  bridge.__state.nodes.push({ id: "n1", type: "generateNode", position: { x: 0, y: 0 }, selected: false, data: { title: "图片节点1", status: "生成成功", image: "data:image/png;base64,x" } });
  const model = makeScriptedModel([
    decision({ decisionId: "i_001", type: "action", reason: "确认当前主图", taskPlan: {
      goal: "检查节点",
      steps: [{ stepId: "s1", alias: "check", intent: "检查图片节点1", dependsOn: [] }],
      successCriteria: [{ kind: "node", alias: "check", terminalStatus: "success", requireOutput: false }],
    }, action: { name: "inspectNode", target: { alias: "图片节点1" }, include: ["status", "currentOutput"] } }),
    decision({ decisionId: "i_002", type: "clarify", reason: "检查完毕，暂停", question: "节点已成功，是否继续？" }),
  ]);
  const task = createEmptyTask("看看图片节点1");
  const result = await runAgentTask({ bridge, callModel: model.call, task, deps: makeDeps() });
  assert.equal(result.status, "clarify");
  const inspectTurn = task.turns[0];
  assert.equal(inspectTurn.action, "inspectNode");
  assert.equal(inspectTurn.ok, true);
  assert.match(inspectTurn.summary, /生成成功/);
  assert.equal(bridge.__calls.length, 0);
});

test("formatTurn renders turn number, action and failure marker", () => {
  assert.match(formatTurn({ turn: 3, action: "createNode", summary: "创建节点 dog（n1）", ok: true }), /第3轮 createNode：创建节点 dog（n1）/);
  assert.match(formatTurn({ turn: 4, action: "waitFor", summary: "等待 dog → 等待超时", ok: false }), /❌/);
});

/* ---------- 契约测试 ---------- */

test("index.html loads the loop module with a cache-bust param before the panel", () => {
  const html = fs.readFileSync(new URL("../dist/index.html", import.meta.url), "utf8");
  assert.match(html, /runninghub-adapter\.js\?v=rh-adapter-v1/);
  assert.match(html, /ai2-agent-loop\.js\?v=agent-loop-v5-action-schema/);
  const loopPos = html.indexOf("ai2-agent-loop.js");
  const panelPos = html.indexOf("ai2-agent-panel.js");
  assert.ok(loopPos !== -1 && panelPos !== -1 && loopPos < panelPos);
});

test("panel wires the loop module and retains legacy parsing only for compatibility", () => {
  const agent = fs.readFileSync(new URL("../dist/assets/ai2-agent-panel.js", import.meta.url), "utf8");
  assert.match(agent, /__AI2_AGENT_LOOP/);
  assert.match(agent, /runAgentTask/);
  assert.match(agent, /legacySend/);
  assert.match(agent, /activeTask/);
  assert.match(agent, /awaitingClarify/);
});

test("panel never executes legacy actions after a loop protocol failure", () => {
  const agent = fs.readFileSync(new URL("../dist/assets/ai2-agent-panel.js", import.meta.url), "utf8");
  const loopStart = agent.indexOf("async function loopSend");
  assert.ok(loopStart >= 0, "loopSend must remain present");
  const loopSource = agent.slice(loopStart);
  assert.doesNotMatch(
    loopSource,
    /await\s+legacySend\(/,
    "a failed loop decision must not fall back to the unsafe one-shot executor",
  );
  assert.match(loopSource, /协议|决策|未执行|失败/);
});

/* ---------- RunningHub 扩展 ---------- */

test("rhRequiredMediaMissing reports unbound required media fields", () => {
  const entry = { fields: RH_FIELDS };
  assert.deepEqual(rhRequiredMediaMissing({ data: {} }, entry), ["12::image"]);
  assert.deepEqual(rhRequiredMediaMissing({ data: { upstreamImages: ["data:image/png;base64,x"] } }, entry), []);
  assert.deepEqual(rhRequiredMediaMissing({ data: { rhParams: { "12::image": { value: "https://x/a.png" } } } }, entry), []);
});

test("validateDecision gates RunningHub actions on registry and required media", () => {
  const task = createEmptyTask("t");
  registerPlan(task, { goal: "g", steps: [{ stepId: "s1", alias: "upscale", intent: "", dependsOn: [] }], successCriteria: [{ alias: "upscale" }] });
  task.aliases.upscale = "n_rh";
  const deps = makeRhDeps();
  const rhNode = { id: "n_rh", type: "runningHubNode", data: { rhWorkflowRef: "rhw1" } };
  const ctx = makeCtx(task, [rhNode], [], deps);

  const badRef = validateDecision({ decisionId: "h1", type: "action", reason: "r", action: { name: "createRunningHubNode", alias: "u2", workflowRef: "workflow:ghost" } }, ctx);
  assert.equal(badRef.ok, false);
  assert.match(badRef.error, /工作流不存在或未启用/);

  const badField = validateDecision({ decisionId: "h2", type: "action", reason: "r", action: { name: "bindRunningHubInput", targetAlias: { alias: "upscale" }, fieldKey: "6::text", sourceAlias: { alias: "upscale" } } },
    makeCtx(task, [rhNode, { id: "n_src", type: "generateNode", data: {} }], [], deps));
  assert.equal(badField.ok, false);

  const noMedia = validateDecision({ decisionId: "h3", type: "action", reason: "r", action: { name: "runNode", target: { alias: "upscale" } } }, ctx);
  assert.equal(noMedia.ok, false);
  assert.match(noMedia.error, /必填媒体字段缺失/);

  rhNode.data.upstreamImages = ["data:image/png;base64,x"];
  const okRun = validateDecision({ decisionId: "h4", type: "action", reason: "r", action: { name: "runNode", target: { alias: "upscale" } } }, ctx);
  assert.equal(okRun.ok, true);
});

test("RunningHub chain: list → create → bind → run → wait → finish", async () => {
  const bridge = makeFakeBridge();
  const model = makeScriptedModel([
    decision({ decisionId: "h_001", type: "action", reason: "读取工作流目录", taskPlan: RH_PLAN, action: { name: "listRunningHubWorkflows" } }),
    decision({ decisionId: "h_002", type: "action", reason: "创建上游图片节点", action: { name: "createNode", alias: "source", nodeType: "generateNode", data: { prompt: "一张测试图" }, position: { mode: "auto" } } }),
    decision({ decisionId: "h_003", type: "action", reason: "运行上游", action: { name: "runNode", target: { alias: "source" } } }),
    decision({ decisionId: "h_004", type: "wait", reason: "等上游图", waitFor: { alias: "source", timeoutMs: 5000, pollMs: 300 } }),
    decision({ decisionId: "h_005", type: "action", reason: "创建放大节点并覆盖 4K 参数", action: { name: "createRunningHubNode", alias: "upscale", workflowRef: "workflow:rhw1", overrides: { "28::resolution": 4096 }, position: { mode: "downstream", relativeTo: "source" } } }),
    decision({ decisionId: "h_006", type: "action", reason: "绑定上游当前主图到 IMAGE 字段", action: { name: "bindRunningHubInput", targetAlias: { alias: "upscale" }, fieldKey: "12::image", sourceAlias: { alias: "source" }, sourceSelection: "current" } }),
    decision({ decisionId: "h_007", type: "action", reason: "提交放大任务", action: { name: "runNode", target: { alias: "upscale" } } }),
    decision({ decisionId: "h_008", type: "wait", reason: "等待任务终态", waitFor: { alias: "upscale", timeoutMs: 5000, pollMs: 300 } }),
    decision({ decisionId: "h_009", type: "finish", reason: "放大任务成功且有输出", message: "已完成 seedvr2.5 高清放大。" }),
  ]);
  const task = createEmptyTask("把这张图用 seedvr2.5 放大到 4K");
  const result = await runAgentTask({ bridge, callModel: model.call, task, deps: makeRhDeps() });

  assert.equal(result.status, "completed", result.message || "");
  const upscale = bridge.__state.nodes.find((n) => n.id === task.aliases.upscale);
  assert.equal(upscale.type, "runningHubNode");
  assert.equal(upscale.data.rhWorkflowRef, "rhw1");
  assert.equal(upscale.data.rhParams["28::resolution"].value, 4096, "只有字段 Schema 中存在的字段才被覆盖");
  assert.equal(upscale.data.rhParams["12::image"].sourceFromUpstream, true);
  assert.equal(upscale.data.upstreamImages.length >= 1, true, "绑定后上游当前主图进入节点");
  assert.ok(bridge.__state.edges.some((e) => e.source === task.aliases.source && e.target === task.aliases.upscale));

  const listTurn = task.turns.find((t) => t.action === "listRunningHubWorkflows");
  assert.equal(listTurn.ok, true);
  assert.match(listTurn.summary, /1 条/);
  const bindTurn = task.turns.find((t) => t.action === "bindRunningHubInput");
  assert.match(bindTurn.summary, /12::image/);
});

test("cancelRunningHub stops the remote task and marks the node failed", async () => {
  const bridge = makeFakeBridge();
  bridge.__state.nodes.push({
    id: "n_rh",
    type: "runningHubNode",
    position: { x: 0, y: 0 },
    selected: false,
    data: { rhWorkflowRef: "rhw1", status: "运行中...", running: true, task: { taskId: "task-1", status: "running" } },
  });
  const cancelled = [];
  const deps = makeRhDeps({ cancelTask: async (taskId) => { cancelled.push(taskId); return { ok: true }; } });
  const model = makeScriptedModel([
    decision({ decisionId: "h2_001", type: "action", reason: "用户要求取消", taskPlan: { goal: "取消任务", steps: [{ stepId: "s1", alias: "upscale", intent: "", dependsOn: [] }], successCriteria: [{ alias: "upscale" }] }, action: { name: "cancelRunningHub", targetAlias: "n_rh" } }),
    decision({ decisionId: "h2_002", type: "clarify", reason: "已取消，暂停等待用户", question: "任务已取消，是否重新提交？" }),
  ]);
  const task = createEmptyTask("取消放大任务");
  const result = await runAgentTask({ bridge, callModel: model.call, task, deps });
  assert.equal(result.status, "clarify");
  assert.deepEqual(cancelled, ["task-1"]);
  const node = bridge.__state.nodes.find((n) => n.id === "n_rh");
  assert.equal(node.data.task.status, "cancelled");
  assert.equal(node.data.status, "失败");
  assert.match(node.data.runError, /取消/);
});

test("recoverRunningHubTask re-queries a stale taskId", async () => {
  const bridge = makeFakeBridge();
  bridge.__state.nodes.push({
    id: "n_rh2",
    type: "runningHubNode",
    position: { x: 0, y: 0 },
    selected: false,
    data: { rhWorkflowRef: "rhw1", status: "运行中...", task: { taskId: "task-9", status: "running" } },
  });
  const deps = makeRhDeps({ recoverNode: async (nodeId) => ({ ok: true, status: "success", outputs: 2, nodeId }) });
  const model = makeScriptedModel([
    decision({ decisionId: "h3_001", type: "action", reason: "刷新后恢复查询", taskPlan: { goal: "恢复任务", steps: [{ stepId: "s1", alias: "upscale", intent: "", dependsOn: [] }], successCriteria: [{ alias: "upscale" }] }, action: { name: "recoverRunningHubTask", targetAlias: "n_rh2" } }),
    decision({ decisionId: "h3_002", type: "clarify", reason: "恢复完成，暂停", question: "已恢复查询，输出已写回。" }),
  ]);
  const task = createEmptyTask("刷新后恢复任务");
  const result = await runAgentTask({ bridge, callModel: model.call, task, deps });
  assert.equal(result.status, "clarify");
  const recoverTurn = task.turns.find((t) => t.action === "recoverRunningHubTask");
  assert.equal(recoverTurn.ok, true);
  assert.match(recoverTurn.summary, /success/);
});

test("canvasState projects RunningHub task metadata without leaking outputs", () => {
  const snap = {
    nodes: [{ id: "n1", type: "runningHubNode", position: { x: 1, y: 2 }, data: { title: "RunningHub节点", rhWorkflowRef: "rhw1", rhParams: { "28::resolution": { value: 4096 } }, task: { taskId: "19102", status: "running" }, upstreamImages: ["https://x/a.png"], outputImages: ["https://x/out.png"] } }],
    edges: [],
  };
  const cs = buildCanvasState(snap, 3);
  assert.deepEqual(cs.nodes[0].data.runningHub, {
    workflowRef: "rhw1",
    taskId: "19102",
    taskStatus: "running",
    overrideFieldKeys: ["28::resolution"],
  });
  assert.equal(cs.revision, 3);
});
