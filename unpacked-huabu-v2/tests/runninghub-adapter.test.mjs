/* RunningHub Adapter — 字段 Schema、注册表、nodeInfoList、官方接口、错误模型测试
   运行：node --test tests/runninghub-adapter.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseWorkflowFields,
  normalizeRegistryEntry,
  validateRegistryEntry,
  getUsableFields,
  convertFieldValue,
  buildNodeInfoList,
  pruneWorkflowJson,
  submitWorkflow,
  queryTask,
  cancelTask,
  waitForCompletion,
  buildRunningHubState,
  extractFailReason,
  sanitizeText,
  classifyOutputKind,
  isWorkflowLinkValue,
  fieldRole,
} from "../dist/assets/runninghub-adapter.js";

const WORKFLOW_JSON = {
  "6": {
    class_type: "CLIPTextEncode",
    inputs: { text: "1 girl in classroom", clip: ["4", 1] },
    _meta: { title: "正向提示词" },
  },
  "12": {
    class_type: "LoadImage",
    inputs: { image: "example.png" },
    _meta: { title: "输入图片" },
  },
  "28": {
    class_type: "SeedNode",
    inputs: { seed: 447886296, resolution: ["2048", "4096"], enable_fix: true },
    _meta: { title: "参数" },
  },
};

function jsonOk(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

/* ---------- parseWorkflowFields ---------- */

test("parseWorkflowFields skips link inputs, infers types and orders images", () => {
  const fields = parseWorkflowFields(WORKFLOW_JSON);
  const keys = fields.map((f) => f.id);
  assert.ok(keys.includes("6::text"));
  assert.ok(!keys.includes("6::clip"), "链接输入不得进入字段列表");
  assert.ok(isWorkflowLinkValue(["4", 1]));
  assert.ok(!isWorkflowLinkValue(["4", "1"]));

  const text = fields.find((f) => f.id === "6::text");
  assert.equal(text.fieldType, "TEXT");
  assert.equal(fieldRole(text), "prompt");
  assert.match(text.label, /正向提示词/);

  const image = fields.find((f) => f.id === "12::image");
  assert.equal(image.fieldType, "IMAGE");
  assert.equal(fieldRole(image), "image");
  assert.equal(image.sourceFromUpstream, true);
  assert.equal(image.imageOrder, 1);

  const seed = fields.find((f) => f.id === "28::seed");
  assert.equal(seed.fieldType, "NUMBER");
  assert.equal(fieldRole(seed), "number");

  const bool = fields.find((f) => f.id === "28::enable_fix");
  assert.equal(bool.fieldType, "BOOLEAN");
  assert.equal(fieldRole(bool), "boolean");

  assert.equal(fields.every((f) => f.enabled === false), true, "解析字段默认不启用");
});

/* ---------- normalizeRegistryEntry ---------- */

test("normalizeRegistryEntry migrates legacy params into fields", () => {
  const legacy = {
    id: "rhw1",
    name: "高清放大",
    workflowId: "123456",
    note: "放大工作流",
    params: [
      { type: "image", nodeId: "12", fieldName: "image" },
      { type: "text", nodeId: "6", fieldName: "text", value: "默认提示词" },
    ],
  };
  const e = normalizeRegistryEntry(legacy);
  assert.equal(e.title, "高清放大");
  assert.equal(e.optionalImageMode, "prune-workflow");
  assert.equal(e.fields.length, 2);
  const img = e.fields.find((f) => f.id === "12::image");
  assert.equal(img.fieldType, "IMAGE");
  assert.equal(img.required, true);
  assert.equal(img.imageOrder, 1);
  const txt = e.fields.find((f) => f.id === "6::text");
  assert.equal(txt.fieldValue, "默认提示词");
});

test("normalizeRegistryEntry keeps normalized entries and defaults optionalImageMode", () => {
  const e = normalizeRegistryEntry({
    id: "rhw2",
    workflowId: "9",
    title: "t",
    enabled: false,
    optionalImageMode: "reject",
    fields: [{ nodeId: "1", fieldName: "a", fieldType: "TEXT", fieldValue: "x" }],
  });
  assert.equal(e.enabled, false);
  assert.equal(e.optionalImageMode, "reject");
  assert.equal(e.fields[0].id, "1::a");
});

/* ---------- validateRegistryEntry ---------- */

function makeEntry(overrides = {}) {
  return normalizeRegistryEntry(Object.assign({
    id: "rhw1",
    workflowId: "123",
    title: "测试工作流",
    workflowJson: WORKFLOW_JSON,
    fields: [
      { nodeId: "12", fieldName: "image", fieldType: "IMAGE", required: true, sourceFromUpstream: true, imageOrder: 1, enabled: true },
      { nodeId: "28", fieldName: "resolution", fieldType: "SELECT", options: ["2048", "4096"], fieldValue: "2048", enabled: true },
    ],
  }, overrides));
}

test("validateRegistryEntry accepts a good entry and rejects rule violations", () => {
  const good = validateRegistryEntry(makeEntry());
  assert.equal(good.ok, true, good.errors && good.errors.join(";"));

  const noId = validateRegistryEntry(makeEntry({ workflowId: "" }));
  assert.equal(noId.ok, false);
  assert.match(noId.errors.join(";"), /workflowId/);

  const dup = validateRegistryEntry(makeEntry({
    fields: [
      { nodeId: "12", fieldName: "image", fieldType: "IMAGE", enabled: true },
      { nodeId: "12", fieldName: "image", fieldType: "IMAGE", enabled: true },
    ],
  }));
  assert.equal(dup.ok, false);
  assert.match(dup.errors.join(";"), /字段键重复/);

  const ghostNode = validateRegistryEntry(makeEntry({
    fields: [{ nodeId: "99", fieldName: "x", fieldType: "TEXT", fieldValue: "1", enabled: true }],
  }));
  assert.equal(ghostNode.ok, false);
  assert.match(ghostNode.errors.join(";"), /nodeId 在 workflowJson 中不存在/);

  const ghostField = validateRegistryEntry(makeEntry({
    fields: [{ nodeId: "6", fieldName: "不存在的字段", fieldType: "TEXT", fieldValue: "1", enabled: true }],
  }));
  assert.equal(ghostField.ok, false);
  assert.match(ghostField.errors.join(";"), /fieldName 在节点 inputs 中不存在/);

  const badSelect = validateRegistryEntry(makeEntry({
    fields: [{ nodeId: "28", fieldName: "resolution", fieldType: "SELECT", options: ["2048", "4096"], fieldValue: "8192", enabled: true }],
  }));
  assert.equal(badSelect.ok, false);
  assert.match(badSelect.errors.join(";"), /不在 options 中/);

  const noFields = validateRegistryEntry(makeEntry({ fields: [] }));
  assert.equal(noFields.ok, true);
  assert.ok(noFields.warnings.some((w) => /字段 Schema/.test(w)));
});

/* ---------- getUsableFields / convertFieldValue ---------- */

test("getUsableFields uses enabled subset and sorts media first by imageOrder", () => {
  const entry = normalizeRegistryEntry({
    id: "x", workflowId: "1",
    fields: [
      { nodeId: "2", fieldName: "b", fieldType: "TEXT", fieldValue: "t", enabled: true },
      { nodeId: "3", fieldName: "img2", fieldType: "IMAGE", enabled: true, sourceFromUpstream: true, imageOrder: 2 },
      { nodeId: "3", fieldName: "img1", fieldType: "IMAGE", enabled: true, sourceFromUpstream: true, imageOrder: 1 },
      { nodeId: "4", fieldName: "hidden", fieldType: "TEXT", fieldValue: "off", enabled: false },
    ],
  });
  const usable = getUsableFields(entry);
  assert.deepEqual(usable.map((f) => f.id), ["3::img1", "3::img2", "2::b"]);
});

test("convertFieldValue enforces number/integer/boolean/select types", () => {
  const numberField = { id: "n", nodeId: "1", fieldName: "n", fieldType: "NUMBER", min: 0, max: 10 };
  assert.equal(convertFieldValue(numberField, "5"), 5);
  assert.throws(() => convertFieldValue(numberField, "abc"), /需要数字/);
  assert.throws(() => convertFieldValue(numberField, "11"), /超过最大值/);

  const intField = { id: "i", nodeId: "1", fieldName: "i", fieldType: "INTEGER" };
  assert.equal(convertFieldValue(intField, 3), 3);
  assert.throws(() => convertFieldValue(intField, 3.5), /需要整数/);

  const boolField = { id: "b", nodeId: "1", fieldName: "b", fieldType: "BOOLEAN" };
  assert.equal(convertFieldValue(boolField, "true"), true);
  assert.equal(convertFieldValue(boolField, false), false);
  assert.throws(() => convertFieldValue(boolField, "是的"), /true\/false/);

  const selectField = { id: "s", nodeId: "1", fieldName: "s", fieldType: "SELECT", options: ["a", "b"] };
  assert.equal(convertFieldValue(selectField, "a"), "a");
  assert.throws(() => convertFieldValue(selectField, "c"), /只能使用/);
});

/* ---------- buildNodeInfoList ---------- */

const BASE_ENTRY = makeEntry();

test("buildNodeInfoList builds typed list with overrides and defaults", async () => {
  const r = await buildNodeInfoList({
    entry: BASE_ENTRY,
    overrides: { "28::resolution": 4096 },
    mediaValues: { "12::image": "https://rh.example/uploaded.png" },
  });
  assert.deepEqual(r.nodeInfoList, [
    { nodeId: "12", fieldName: "image", fieldValue: "https://rh.example/uploaded.png" },
    { nodeId: "28", fieldName: "resolution", fieldValue: "4096" },
  ]);
  assert.equal(r.uploaded.length, 0);
});

test("buildNodeInfoList uploads upstream media via injected uploader", async () => {
  const uploads = [];
  const r = await buildNodeInfoList({
    entry: BASE_ENTRY,
    mediaSources: { "12::image": "data:image/png;base64,AAA" },
    uploadResource: async ({ source }) => {
      uploads.push(source);
      return { remoteUrl: "https://rh.example/up.png" };
    },
  });
  assert.equal(uploads.length, 1);
  assert.equal(r.nodeInfoList[0].fieldValue, "https://rh.example/up.png");
  assert.deepEqual(r.uploaded, [{ fieldKey: "12::image", sourceNodeId: "12", remoteUrl: "https://rh.example/up.png" }]);
});

test("buildNodeInfoList fails on missing required media", async () => {
  await assert.rejects(
    () => buildNodeInfoList({ entry: makeEntry({ optionalImageMode: "reject" }) }),
    (e) => e.stage === "validate" && e.fieldKey === "12::image" && /必填媒体字段缺失/.test(e.message),
  );
});

test("buildNodeInfoList prunes optional media per prune-workflow mode", async () => {
  const entry = normalizeRegistryEntry({
    id: "rhw2",
    workflowId: "123",
    optionalImageMode: "prune-workflow",
    workflowJson: {
      "10": { class_type: "LoadImageOptional", inputs: { image: "opt.png" } },
      "12": { class_type: "Consume", inputs: { image: ["10", 0], other: "x" } },
    },
    fields: [
      { nodeId: "12", fieldName: "image", fieldType: "IMAGE", required: false, sourceFromUpstream: true, enabled: true },
      { nodeId: "12", fieldName: "other", fieldType: "TEXT", fieldValue: "keep", enabled: true },
    ],
  });
  const r = await buildNodeInfoList({ entry });
  assert.deepEqual(r.skippedOptional, ["12::image"]);
  assert.ok(r.prunedWorkflow);
  assert.ok(!("image" in r.prunedWorkflow["12"].inputs));
  assert.ok(!r.prunedWorkflow["10"], "孤儿加载节点应被级联移除");
  assert.deepEqual(r.nodeInfoList, [{ nodeId: "12", fieldName: "other", fieldValue: "keep" }]);
});

test("buildNodeInfoList respects send-empty mode for optional media", async () => {
  const entry = makeEntry({ optionalImageMode: "send-empty" });
  entry.fields[0].required = false;
  const r = await buildNodeInfoList({ entry });
  assert.deepEqual(r.nodeInfoList[0], { nodeId: "12", fieldName: "image", fieldValue: "" });
});

test("pruneWorkflowJson cascades orphan removal", () => {
  const wf = {
    "1": { inputs: { a: 1 } },
    "2": { inputs: { img: ["1", 0] } },
    "3": { inputs: { img: ["1", 0], text: "x" } },
  };
  const pruned = pruneWorkflowJson(wf, [{ nodeId: "2", fieldName: "img" }]);
  assert.ok(!pruned["2"], "唯一消费者被裁剪后，孤立节点 1 不再被 2 需要时才移除");
  assert.ok(pruned["1"], "节点 1 仍被 3 引用，必须保留");
});

/* ---------- submitWorkflow ---------- */

test("submitWorkflow posts the official contract and parses taskId", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return jsonOk({ code: 0, msg: "success", data: { taskId: "1910246", taskStatus: "QUEUED", promptTips: "{\"result\":true}" } });
  };
  const r = await submitWorkflow({
    baseUrl: "https://www.runninghub.cn/", apiKey: "rh_key_1", workflowId: "1904136",
    nodeInfoList: [{ nodeId: "6", fieldName: "text", fieldValue: "1 girl" }],
    fetchImpl,
  });
  assert.equal(r.ok, true);
  assert.equal(r.taskId, "1910246");
  assert.equal(r.taskStatus, "QUEUED");
  assert.equal(calls[0].url, "https://www.runninghub.cn/task/openapi/create");
  assert.equal(calls[0].body.workflowId, "1904136");
  assert.equal(calls[0].body.apiKey, "rh_key_1");
  assert.equal(calls[0].body.addMetadata, true);
});

test("submitWorkflow rejects non-zero code and missing taskId", async () => {
  await assert.rejects(
    () => submitWorkflow({
      baseUrl: "https://x", apiKey: "k", workflowId: "w", fetchImpl: async () => jsonOk({ code: -2081, msg: "work流程不存在" }),
    }),
    (e) => e.stage === "submit" && /任务提交失败/.test(e.message),
  );
  await assert.rejects(
    () => submitWorkflow({
      baseUrl: "https://x", apiKey: "k", workflowId: "w", fetchImpl: async () => jsonOk({ code: 0, data: {} }),
    }),
    (e) => e.stage === "submit" && /未返回 taskId/.test(e.message),
  );
  await assert.rejects(
    () => submitWorkflow({ baseUrl: "", apiKey: "k", workflowId: "w", fetchImpl: async () => jsonOk({}) }),
    (e) => e.stage === "settings",
  );
});

/* ---------- queryTask ---------- */

test("queryTask maps official codes and parses outputs", async () => {
  const mk = (body) => async (url, init) => {
    assert.equal(url, "https://rh/task/openapi/outputs");
    assert.deepEqual(JSON.parse(init.body), { apiKey: "k", taskId: "t1" });
    return jsonOk(body);
  };
  const success = await queryTask({
    baseUrl: "https://rh", apiKey: "k", taskId: "t1", fetchImpl: mk({
      code: 0, data: { outputs: [
        { fileUrl: "https://cdn/a.png", fileType: "png" },
        "https://cdn/b.mp4",
        { url: "https://cdn/c.mp3" },
      ] },
    }),
  });
  assert.equal(success.status, "success");
  assert.deepEqual(success.outputs.map((o) => o.kind), ["image", "video", "audio"]);

  const running = await queryTask({ baseUrl: "https://rh", apiKey: "k", taskId: "t1", fetchImpl: mk({ code: 804, msg: "running" }) });
  assert.equal(running.status, "running");

  const queued = await queryTask({ baseUrl: "https://rh", apiKey: "k", taskId: "t1", fetchImpl: mk({ code: 813 }) });
  assert.equal(queued.status, "queued");

  const failed = await queryTask({ baseUrl: "https://rh", apiKey: "k", taskId: "t1", fetchImpl: mk({ code: 805, data: { failedReason: { msg: "显存不足" } } }) });
  assert.equal(failed.status, "failed");
  assert.equal(failed.failReason, "显存不足");

  const empty = await queryTask({ baseUrl: "https://rh", apiKey: "k", taskId: "t1", fetchImpl: mk({ code: 0, data: {} }) });
  assert.equal(empty.status, "failed", "SUCCESS 但无结果必须视为失败");
  assert.match(empty.failReason, /没有解析到输出文件/);

  const unknown = await queryTask({ baseUrl: "https://rh", apiKey: "k", taskId: "t1", fetchImpl: mk({ code: 999, msg: "奇怪" }) });
  assert.equal(unknown.status, "unknown");
});

test("cancelTask posts the stop endpoint", async () => {
  const calls = [];
  const r = await cancelTask({
    baseUrl: "https://rh", apiKey: "k", taskId: "t9", fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return jsonOk({ code: 0, msg: "success" });
    },
  });
  assert.equal(r.ok, true);
  assert.equal(calls[0].url, "https://rh/task/openapi/stop");
  assert.equal(calls[0].body.taskId, "t9");
  await assert.rejects(
    () => cancelTask({ baseUrl: "https://rh", apiKey: "k", taskId: "t9", fetchImpl: async () => jsonOk({ code: 1, msg: "任务已完成无法取消" }) }),
    (e) => e.stage === "cancel",
  );
});

test("waitForCompletion polls until terminal or timeout", async () => {
  let polls = 0;
  const done = await waitForCompletion({
    taskId: "t1",
    timeoutMs: 5000,
    pollMs: 10,
    queryTask: async () => {
      polls += 1;
      return polls < 3 ? { status: "running", outputs: [] } : { status: "success", outputs: [{ url: "https://x/a.png", kind: "image" }] };
    },
  });
  assert.equal(done.status, "success");
  assert.equal(polls, 3);

  const timedOut = await waitForCompletion({
    taskId: "t1",
    timeoutMs: 30,
    pollMs: 10,
    queryTask: async () => ({ status: "running", outputs: [] }),
  });
  assert.equal(timedOut.status, "failed");
  assert.match(timedOut.failReason, /等待超时/);
});

/* ---------- 错误模型与脱敏 ---------- */

test("extractFailReason and sanitizeText keep secrets out of messages", () => {
  assert.equal(extractFailReason({ code: 805, data: { failedReason: { msg: "节点执行失败" } } }), "节点执行失败");
  assert.equal(extractFailReason({ code: 805, msg: "任务失败：显存不足" }), "任务失败：显存不足");
  assert.equal(extractFailReason({ code: 805 }), "未知错误");

  const dirty = "Authorization: Bearer abc123 and apiKey=xyz789 and {\"apiKey\":\"zzz\"}";
  const clean = sanitizeText(dirty);
  assert.ok(!clean.includes("abc123"));
  assert.ok(!clean.includes("xyz789"));
  assert.ok(clean.includes("***"));
});

test("classifyOutputKind prefers extension and falls back to file", () => {
  assert.equal(classifyOutputKind("https://x/a.png"), "image");
  assert.equal(classifyOutputKind("https://x/a.MP4?token=1"), "video");
  assert.equal(classifyOutputKind("https://x/a.wav"), "audio");
  assert.equal(classifyOutputKind("https://x/a.xyz"), "file");
  assert.equal(classifyOutputKind("https://x/whatever", "image"), "image");
});

/* ---------- buildRunningHubState（Agent 脱敏目录） ---------- */

test("buildRunningHubState masks workflowId and never exposes secrets", () => {
  const state = buildRunningHubState({
    runningHub: {
      baseUrl: "https://www.runninghub.cn",
      apiKey: "secret_key",
      workflows: [{
        id: "rhw1",
        workflowId: "202213456789007986",
        title: "seedvr2.5高清放大",
        accessPassword: "topsecret",
        fields: [
          { nodeId: "12", fieldName: "image", fieldType: "IMAGE", required: true, sourceFromUpstream: true, imageOrder: 1, enabled: true },
          { nodeId: "28", fieldName: "resolution", fieldType: "SELECT", options: ["2048", "4096"], fieldValue: "2048", enabled: true },
        ],
      }],
    },
  });
  assert.equal(state.configured, true);
  const wf = state.workflows[0];
  assert.equal(wf.workflowRef, "workflow:rhw1");
  assert.match(wf.workflowIdMasked, /…/);
  assert.ok(!JSON.stringify(state).includes("202213456789007986"), "完整 workflowId 不得进入模型上下文");
  assert.ok(!JSON.stringify(state).includes("topsecret"), "accessPassword 不得进入模型上下文");
  assert.ok(!JSON.stringify(state).includes("secret_key"));
  const imgField = wf.fields.find((f) => f.fieldKey === "12::image");
  assert.equal(imgField.role, "image");
  assert.equal(imgField.required, true);
  const selField = wf.fields.find((f) => f.fieldKey === "28::resolution");
  assert.deepEqual(selField.options, ["2048", "4096"]);
});
