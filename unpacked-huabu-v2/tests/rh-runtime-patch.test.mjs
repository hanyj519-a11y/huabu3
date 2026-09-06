/* RunningHub 运行时补丁 — 翻译层纯函数测试（Node 环境用假 window 运行）
   运行：node --test tests/rh-runtime-patch.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";

const fakeBridgeNodes = [];
const fakeBridge = {
  get: () => ({ nodes: fakeBridgeNodes, edges: [], settings: { runningHub: { baseUrl: "https://www.runninghub.cn", apiKey: "rh_key", workflows: [] } } }),
  actions: {},
};

globalThis.window = {
  fetch: async () => { throw new Error("no network in unit test"); },
  __AI2_CANVAS_BRIDGE: fakeBridge,
};

const { buildOfficialCreateBody, translateCreateResponse, translateQueryResponse, findRunningNodeForSubmit } =
  await import("../dist/assets/ai2-rh-runtime-patch.js");

function jsonOk(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

/* ---------- translateCreateResponse ---------- */

test("translateCreateResponse maps official create responses to legacy shape", () => {
  const ok = translateCreateResponse({ code: 0, msg: "success", data: { taskId: "1910", clientId: "c1", taskStatus: "QUEUED", promptTips: "{\"result\":true}" } });
  assert.equal(ok.taskId, "1910");
  assert.equal(ok.taskStatus, "QUEUED");
  assert.equal(ok.msg, "success");

  const fail = translateCreateResponse({ code: -2081, msg: "工作流不存在", data: { failedReason: "工作流不存在" } });
  assert.equal(fail.taskId, undefined);
  assert.match(fail.errorMessage, /工作流不存在/);
});

/* ---------- translateQueryResponse ---------- */

test("translateQueryResponse maps outputs responses into legacy poll shape", () => {
  const success = translateQueryResponse({
    code: 0,
    data: { outputs: [{ fileUrl: "https://cdn/a.png", fileType: "png" }, "https://cdn/b.mp4"] },
  });
  assert.equal(success.taskStatus, "SUCCESS");
  assert.deepEqual(success.results.map((r) => r.url), ["https://cdn/a.png", "https://cdn/b.mp4"]);
  assert.equal(success.results[0].outputType, "png");

  assert.equal(translateQueryResponse({ code: 813 }).status, "QUEUED");
  assert.equal(translateQueryResponse({ code: 813 }).taskStatus, "QUEUED");
  assert.equal(translateQueryResponse({ code: 804 }).taskStatus, "RUNNING");

  const failed = translateQueryResponse({ code: 805, data: { failedReason: { msg: "显存不足" } } });
  assert.equal(failed.taskStatus, "FAILED");
  assert.equal(failed.errorMessage, "显存不足");
  assert.deepEqual(failed.failedReason, { msg: "显存不足" });

  assert.equal(translateQueryResponse({ code: 999 }).taskStatus, "RUNNING", "未知状态码按运行中处理，保持旧轮询");
});

/* ---------- findRunningNodeForSubmit ---------- */

test("findRunningNodeForSubmit matches by workflowId and only falls back to unresolvable nodes", () => {
  fakeBridgeNodes.length = 0;
  const settings = { workflows: [{ id: "rhw1", workflowId: "555" }, { id: "rhw2", workflowId: "666" }] };
  const nodeA = { id: "n1", type: "runningHubNode", data: { running: true, rhWorkflowRef: "rhw1" } };
  const nodeB = { id: "n2", type: "runningHubNode", data: { running: false, rhWorkflowRef: "rhw2" } };
  fakeBridgeNodes.push(nodeA, nodeB);

  assert.equal(findRunningNodeForSubmit("555", settings), nodeA);
  assert.equal(findRunningNodeForSubmit("666", settings), null, "配置不一致且可解析时不得乱绑定");

  fakeBridgeNodes.length = 0;
  const ghost = { id: "n3", type: "runningHubNode", data: { running: true, rhWorkflowRef: "rhw-ghost" } };
  fakeBridgeNodes.push(ghost);
  assert.equal(findRunningNodeForSubmit("555", settings), ghost, "唯一无法解析工作流的运行中节点允许兜底");
});

/* ---------- buildOfficialCreateBody ---------- */

const RAW_RH_FIELDS = [
  { nodeId: "12", fieldName: "image", fieldType: "IMAGE", required: true, sourceFromUpstream: true, imageOrder: 1, enabled: true, fieldValue: "" },
  { nodeId: "28", fieldName: "resolution", fieldType: "SELECT", options: ["2048", "4096"], fieldValue: "2048", enabled: true },
  { nodeId: "6", fieldName: "text", fieldType: "TEXT", fieldValue: "默认提示词", enabled: true },
];
const RH_SETTINGS = { apiKey: "rh_key", workflows: [{ id: "rhw1", workflowId: "555" }] };

test("buildOfficialCreateBody reuses legacy uploads and merges node overrides", async () => {
  const settings = { apiKey: "rh_key", workflows: [{ id: "rhw1", workflowId: "555", fields: RAW_RH_FIELDS }] };
  const node = {
    id: "n1",
    type: "runningHubNode",
    data: {
      rhWorkflowRef: "rhw1",
      upstreamImages: ["data:image/png;base64,AAA"],
      rhParams: { "28::resolution": { value: 4096 } },
    },
  };
  const legacyBody = { addMetadata: true, nodeInfoList: [{ nodeId: "12", fieldName: "image", fieldValue: "https://rh-up/already.png" }] };
  const { body } = await buildOfficialCreateBody({ legacyBody, workflowId: "555", settings, node, fetchImpl: async () => jsonOk({ code: 0, data: {} }) });

  assert.equal(body.workflowId, "555");
  assert.equal(body.apiKey, "rh_key");
  const imageField = body.nodeInfoList.find((i) => i.fieldName === "image");
  assert.equal(imageField.fieldValue, "https://rh-up/already.png", "旧运行器已上传的图片直接复用，不重复上传");
  const resolution = body.nodeInfoList.find((i) => i.fieldName === "resolution");
  assert.equal(resolution.fieldValue, "4096", "节点 rhParams 覆盖生效并按 options 归一为字符串");
  const text = body.nodeInfoList.find((i) => i.fieldName === "text");
  assert.equal(text.fieldValue, "默认提示词");
});

test("buildOfficialCreateBody passes through legacy list when no registry schema exists", async () => {
  const { body } = await buildOfficialCreateBody({
    legacyBody: { nodeInfoList: [{ nodeId: "6", fieldName: "text", fieldValue: "直传" }] },
    workflowId: "777",
    settings: RH_SETTINGS,
    node: null,
    fetchImpl: async () => jsonOk({ code: 0, data: {} }),
  });
  assert.deepEqual(body.nodeInfoList, [{ nodeId: "6", fieldName: "text", fieldValue: "直传" }]);
  assert.equal(body.workflow, undefined);
});

test("buildOfficialCreateBody uploads missing upstream media for bound image fields", async () => {
  const settings = { baseUrl: "https://www.runninghub.cn", apiKey: "rh_key", workflows: [{ id: "rhw1", workflowId: "555", fields: RAW_RH_FIELDS }] };
  const node = { id: "n1", type: "runningHubNode", data: { rhWorkflowRef: "rhw1", upstreamImages: ["data:image/png;base64,AAA"] } };
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    if (String(url).startsWith("data:")) return new Response(new Blob(["img"], { type: "image/png" }));
    return jsonOk({ code: 0, data: { fileName: "rh_up.png" } });
  };
  const { body } = await buildOfficialCreateBody({ legacyBody: { nodeInfoList: [] }, workflowId: "555", settings, node, fetchImpl });
  const imageField = body.nodeInfoList.find((i) => i.fieldName === "image");
  assert.equal(imageField.fieldValue, "rh_up.png", "上传返回的 fileName 作为 fieldValue");
  assert.ok(urls.some((u) => u.endsWith("/task/openapi/upload")));
});

test("buildOfficialCreateBody injects pruned workflow for prune-workflow mode", async () => {
  const settings = { apiKey: "rh_key", workflows: [{
    id: "rhw2",
    workflowId: "888",
    optionalImageMode: "prune-workflow",
    workflowJson: {
      "10": { inputs: { image: "opt.png" } },
      "12": { inputs: { image: ["10", 0], text: "x" } },
    },
    fields: [
      { nodeId: "12", fieldName: "image", fieldType: "IMAGE", required: false, sourceFromUpstream: true, enabled: true },
      { nodeId: "12", fieldName: "text", fieldType: "TEXT", fieldValue: "keep", enabled: true },
    ],
  }] };
  const { body } = await buildOfficialCreateBody({
    legacyBody: { nodeInfoList: [] }, workflowId: "888", settings, node: null, fetchImpl: async () => jsonOk({ code: 0, data: {} }),
  });
  assert.ok(body.workflow, "裁剪后的 workflow JSON 应随请求发送");
  const parsed = JSON.parse(body.workflow);
  assert.ok(!parsed["10"], "孤儿节点已移除");
  assert.ok(!("image" in parsed["12"].inputs));
});

test("buildOfficialCreateBody rejects invalid select overrides", async () => {
  const settings = { apiKey: "rh_key", workflows: [{ id: "rhw1", workflowId: "555", fields: RAW_RH_FIELDS }] };
  const node = { id: "n1", type: "runningHubNode", data: { rhWorkflowRef: "rhw1", rhParams: { "28::resolution": { value: 8192 } } } };
  await assert.rejects(
    () => buildOfficialCreateBody({
      legacyBody: { nodeInfoList: [{ nodeId: "12", fieldName: "image", fieldValue: "https://rh-up/already.png" }] },
      workflowId: "555", settings, node, fetchImpl: async () => jsonOk({ code: 0 }),
    }),
    (e) => /只能使用/.test(e.message),
  );
});
