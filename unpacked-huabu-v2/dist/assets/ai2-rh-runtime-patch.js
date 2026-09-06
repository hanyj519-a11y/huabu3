/* BatchRefiner RunningHub 运行时补丁（fetch 翻译层 + 任务持久化/恢复 + 工作流 JSON 导入）
   1) 拦截 bundle 旧运行器发出的 /openapi/v2/run/workflow/* 与 /openapi/v2/query，
      用官方 /task/openapi/create 与 /task/openapi/outputs 完成请求，并把响应回译成旧形状；
      nodeInfoList 由适配器按字段 Schema + 节点覆盖 + 上游当前主图重建。
   2) taskId 持久化到节点 data.task，刷新后可按 taskId 恢复查询。
   3) 提供独立的「RunningHub 工作流 JSON 导入」浮动入口（自有 DOM，不碰 React 管理的节点）。
   任何翻译失败都会回退原始旧协议请求，保证可用性。 */

import { runninghubAdapter as A } from "./runninghub-adapter.js";

const originalFetch = (typeof window !== "undefined" && window.fetch) ? window.fetch.bind(window) : null;

function getBridge() {
  return (typeof window !== "undefined" && window.__AI2_CANVAS_BRIDGE) || null;
}

function getRhSettings() {
  const b = getBridge();
  const settings = (b && b.get && b.get().settings) || {};
  return settings.runningHub || {};
}

function updateNodeData(nodeId, patch) {
  const b = getBridge();
  if (!b || !b.actions || !b.actions.updateNode) return false;
  const r = b.actions.updateNode(nodeId, patch);
  return !(r && r.error);
}

function listRunningHubNodes() {
  const b = getBridge();
  if (!b || !b.get) return [];
  return (b.get().nodes || []).filter((n) => n.type === "runningHubNode");
}

function resolveWorkflowId(node, settings) {
  const workflows = Array.isArray(settings.workflows) ? settings.workflows : [];
  const entry = workflows.find((w) => w && w.id === node.data.rhWorkflowRef);
  return (entry && entry.workflowId) || node.data.workflowId || "";
}

/* 找到本次提交对应的运行中节点：优先 workflowId 精确匹配；无法解析工作流的唯一运行中节点兜底。 */
function findRunningNodeForSubmit(workflowId, settings) {
  const candidates = listRunningHubNodes().filter((n) => n.data && n.data.running === true);
  if (!candidates.length) return null;
  const exact = candidates.filter((n) => resolveWorkflowId(n, settings) === String(workflowId));
  if (exact.length) return exact[0];
  const unresolvable = candidates.filter((n) => !resolveWorkflowId(n, settings));
  return unresolvable.length === 1 ? unresolvable[0] : null;
}

function findNodeByTaskId(taskId) {
  return listRunningHubNodes().find((n) => n.data && n.data.task && String(n.data.task.taskId) === String(taskId)) || null;
}

/* ---------- 提交翻译：旧 body → 官方 create body ---------- */

/* mediaSources：imageOrder 顺序绑定上游当前主图（bundle 已把 upstreamImages 同步进节点数据） */
function collectMediaSources(node, entry) {
  const mediaFields = A.getUsableFields(entry).filter((f) => A.fieldRole(f) === "image" || A.fieldRole(f) === "video" || A.fieldRole(f) === "audio");
  const sources = {};
  const upstream = (node && node.data && node.data.upstreamImages) || [];
  let seq = 0;
  for (const f of mediaFields) {
    if (!f.sourceFromUpstream) continue;
    if (upstream[seq]) sources[f.id] = upstream[seq];
    seq += 1;
  }
  return sources;
}

/* 旧运行器已经把 settings params 的图片上传过一次，直接复用其结果，避免重复上传。 */
function collectUploadedFromLegacyBody(legacyNodeInfoList, entry) {
  const uploaded = {};
  const fieldIds = new Set((entry.fields || []).map((f) => f.id));
  for (const item of legacyNodeInfoList || []) {
    if (!item || item.nodeId == null || !item.fieldName) continue;
    const key = item.nodeId + "::" + item.fieldName;
    if (fieldIds.has(key) && typeof item.fieldValue === "string" && /^https?:\/\//i.test(item.fieldValue)) {
      uploaded[key] = item.fieldValue;
    }
  }
  return uploaded;
}

async function buildOfficialCreateBody(input) {
  const { legacyBody, workflowId, settings, node, fetchImpl } = input;
  const workflows = Array.isArray(settings.workflows) ? settings.workflows : [];
  const rawEntry = workflows.find((w) => w && String(w.workflowId) === String(workflowId)) || null;
  const entry = rawEntry ? A.normalizeRegistryEntry(rawEntry) : null;
  const legacyList = Array.isArray(legacyBody.nodeInfoList) ? legacyBody.nodeInfoList : [];

  let nodeInfoList = legacyList;
  let prunedWorkflow;
  const warnings = [];

  if (entry && A.getUsableFields(entry).length) {
    const mediaValues = collectUploadedFromLegacyBody(legacyList, entry);
    const mediaSources = collectMediaSources(node, entry);
    const uploadResource = async ({ source }) => {
      const up = await A.uploadResource({ baseUrl: settings.baseUrl, apiKey: settings.apiKey, source, fetchImpl });
      return { remoteUrl: up.remoteUrl || up.fileName };
    };
    const overrides = {};
    const nodeParams = (node && node.data && node.data.rhParams) || {};
    for (const key of Object.keys(nodeParams)) overrides[key] = nodeParams[key];
    const built = await A.buildNodeInfoList({
      entry,
      overrides,
      mediaValues,
      mediaSources,
      uploadResource,
    });
    nodeInfoList = built.nodeInfoList;
    prunedWorkflow = built.prunedWorkflow;
    warnings.push(...built.warnings);
  }

  const body = {
    apiKey: settings.apiKey,
    workflowId: String(workflowId),
    addMetadata: legacyBody.addMetadata !== false,
  };
  if (nodeInfoList.length) body.nodeInfoList = nodeInfoList;
  const rawEntryForAccess = workflows.find((w) => w && String(w.workflowId) === String(workflowId));
  if (rawEntryForAccess && rawEntryForAccess.accessPassword) body.accessPassword = rawEntryForAccess.accessPassword;
  if (legacyBody.usePersonalQueue != null) body.usePersonalQueue = legacyBody.usePersonalQueue === true || legacyBody.usePersonalQueue === "true";
  if (prunedWorkflow) body.workflow = JSON.stringify(prunedWorkflow);
  return { body, warnings };
}

/* 官方 create 响应 → 旧运行器期望的顶层 {taskId, msg, errorMessage} 形状 */
function translateCreateResponse(raw) {
  const code = raw && raw.code;
  if (code !== 0 && code !== "0") {
    const failReason = A.extractFailReason(raw);
    return { code: code == null ? -1 : code, msg: failReason, errorMessage: failReason };
  }
  return {
    taskId: raw.data && raw.data.taskId,
    clientId: raw.data && raw.data.clientId,
    taskStatus: raw.data && raw.data.taskStatus,
    promptTips: raw.data && raw.data.promptTips,
    msg: raw.msg || "success",
    code,
  };
}

/* 官方 outputs 响应 → 旧轮询期望的 {status/taskStatus, results:[{url, outputType}], errorMessage} 形状
   注意：bundle 轮询读的是顶层 status（旧 /openapi/v2/query 契约），两个字段都给出以兼容。 */
function translateQueryResponse(raw) {
  const code = raw && raw.code;
  const status = ({ 0: "SUCCESS", "0": "SUCCESS", 804: "RUNNING", "804": "RUNNING", 813: "QUEUED", "813": "QUEUED", 805: "FAILED", "805": "FAILED" })[code] || "RUNNING";
  if (status === "SUCCESS") {
    const outputs = extractOutputsSafe(raw.data);
    const results = outputs.map((o) => ({ url: o.url, outputType: o.outputType || extFromUrl(o.url) }));
    return { status: "SUCCESS", taskStatus: "SUCCESS", results };
  }
  if (status === "FAILED") {
    const failReason = A.extractFailReason(raw);
    return { status: "FAILED", taskStatus: "FAILED", errorMessage: failReason, failedReason: { msg: failReason } };
  }
  return { status, taskStatus: status, results: [] };
}

function extractOutputsSafe(data) {
  /* 复用适配器输出解析，同时保留 outputType 供旧过滤逻辑使用 */
  const containers = [data, data && data.outputs, data && data.results, data && data.files, data && data.data];
  const out = [];
  const seen = new Set();
  for (const c of containers) {
    if (!Array.isArray(c)) continue;
    for (const item of c) {
      let url = null;
      let outputType = null;
      if (typeof item === "string") url = item;
      else if (item && typeof item === "object") {
        url = item.fileUrl || item.file_url || item.url || item.downloadUrl || item.download_url;
        outputType = item.outputType || item.fileType || item.type;
      }
      if (typeof url === "string" && /^https?:\/\//i.test(url) && !seen.has(url)) {
        seen.add(url);
        out.push({ url, outputType });
      }
    }
  }
  return out;
}

function extFromUrl(url) {
  const m = /\.([a-z0-9]{2,5})(?:\?|$)/i.exec(String(url || ""));
  return m ? m[1].toLowerCase() : "image";
}

function jsonResponse(obj) {
  return new Response(JSON.stringify(obj), { status: 200, headers: { "Content-Type": "application/json" } });
}

/* ---------- fetch 翻译层 ---------- */

/* bundle 的请求包装器会把外部 API 包成 /api/proxy?url=<encoded>；
   匹配与改写都在解码后的 URL 上进行，官方请求沿用同样的代理包装。 */
function decodeUrl(u) {
  try { return decodeURIComponent(String(u)); } catch (e) { return String(u); }
}

function isProxied(decodedUrl) {
  return /\/api\/proxy\?url=/i.test(decodedUrl);
}

function isLegacySubmit(decodedUrl) {
  return /\/openapi\/v2\/run\/workflow\/([^/?#]+)/i.test(decodedUrl);
}

function isLegacyQuery(decodedUrl) {
  return /\/openapi\/v2\/query(?:[?#]|$)/i.test(decodedUrl);
}

function officialUrlFor(decodedUrl, path) {
  let origin;
  if (isProxied(decodedUrl)) {
    const m = /[?&]url=([\s\S]*)$/i.exec(decodedUrl);
    const inner = m ? m[1] : "";
    try { origin = new URL(inner).origin; } catch (e) { origin = new URL(decodedUrl, location.href).origin; }
  } else {
    try { origin = new URL(decodedUrl, location.href).origin; } catch (e) { origin = location.origin; }
  }
  const target = origin + path;
  return isProxied(decodedUrl) ? "/api/proxy?url=" + encodeURIComponent(target) : target;
}

async function handleLegacySubmit(decodedUrl, init) {
  const workflowId = decodeURIComponent((/\/openapi\/v2\/run\/workflow\/([^/?#]+)/i.exec(decodedUrl) || [])[1] || "");
  if (!workflowId) throw new Error("无法从旧提交 URL 解析 workflowId");
  const settings = getRhSettings();
  if (!settings.apiKey) throw new Error("RunningHub API Key 未配置，跳过翻译");
  const legacyBody = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
  const node = findRunningNodeForSubmit(workflowId, settings);
  const { body, warnings } = await buildOfficialCreateBody({ legacyBody, workflowId, settings, node, fetchImpl: originalFetch });
  if (warnings.length) console.info("[RH patch]", warnings.join("；"));

  const res = await originalFetch(officialUrlFor(decodedUrl, "/task/openapi/create"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + settings.apiKey },
    body: JSON.stringify(body),
  });
  const official = await res.json();
  const legacy = translateCreateResponse(official);

  if (legacy.taskId && node) {
    updateNodeData(node.id, {
      task: {
        taskId: String(legacy.taskId),
        clientId: legacy.clientId,
        status: "queued",
        submittedAt: Date.now(),
        attempts: ((node.data.task && node.data.task.attempts) || 0) + 1,
        promptTips: legacy.promptTips ? String(legacy.promptTips).slice(0, 200) : undefined,
      },
    });
  }
  console.info("[RH patch] 已用官方 /task/openapi/create 提交任务", legacy.taskId || "");
  return jsonResponse(legacy);
}

async function handleLegacyQuery(decodedUrl, init) {
  const settings = getRhSettings();
  if (!settings.apiKey) throw new Error("RunningHub API Key 未配置，跳过翻译");
  const legacyBody = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
  const taskId = legacyBody.taskId;
  if (!taskId) throw new Error("旧查询请求缺少 taskId");
  const res = await originalFetch(officialUrlFor(decodedUrl, "/task/openapi/outputs"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + settings.apiKey },
    body: JSON.stringify({ apiKey: settings.apiKey, taskId: String(taskId) }),
  });
  const official = await res.json();
  const legacy = translateQueryResponse(official);

  const node = findNodeByTaskId(taskId);
  if (node && node.data && node.data.task) {
    const patch = { task: Object.assign({}, node.data.task, { status: legacy.taskStatus.toLowerCase() }) };
    if (legacy.taskStatus === "SUCCESS") patch.task.finishedAt = Date.now();
    if (legacy.taskStatus === "FAILED") patch.task.error = { stage: "status", message: legacy.errorMessage, retryable: false };
    updateNodeData(node.id, patch);
  }
  return jsonResponse(legacy);
}

async function patchedFetch(url, init) {
  try {
    const decoded = decodeUrl(url);
    if (init && init.method === "POST" && typeof init.body === "string") {
      if (isLegacySubmit(decoded)) return await handleLegacySubmit(decoded, init);
      if (isLegacyQuery(decoded)) return await handleLegacyQuery(decoded, init);
    }
  } catch (e) {
    console.warn("[RH patch] 翻译失败，回退旧协议：", (e && e.message) || e);
  }
  return originalFetch(url, init);
}

/* ---------- 刷新恢复 ---------- */

/* 直连官方接口的请求（恢复/取消）与页面同源不同源时走 /api/proxy，避免 CORS。 */
function wrapForPage(url) {
  try {
    const target = new URL(url, location.href);
    if (target.origin === location.origin) return target.href;
    return "/api/proxy?url=" + encodeURIComponent(target.href);
  } catch (e) {
    return "/api/proxy?url=" + encodeURIComponent(url);
  }
}

async function queryOfficialTask(taskId) {
  const settings = getRhSettings();
  if (!settings.apiKey || !settings.baseUrl) throw new Error("RunningHub 未配置");
  return A.queryTask({ baseUrl: settings.baseUrl, apiKey: settings.apiKey, taskId, fetchImpl: originalFetch, wrapUrl: wrapForPage });
}

function mergeOutputImages(existing, urls) {
  return Array.from(new Set([].concat(existing || [], urls)));
}

async function recoverNode(nodeId) {
  const node = listRunningHubNodes().find((n) => n.id === nodeId);
  if (!node || !node.data || !node.data.task || !node.data.task.taskId) return { ok: false, error: "节点没有可恢复的任务" };
  if (node.data.running === true) return { ok: false, error: "节点正在运行，无需恢复" };
  const task = node.data.task;
  if (["success", "failed", "cancelled"].indexOf(task.status) !== -1 && task.status !== "failed") {
    return { ok: false, error: "任务已是终态：" + task.status };
  }
  try {
    const result = await queryOfficialTask(task.taskId);
    if (result.status === "success") {
      updateNodeData(nodeId, {
        outputImages: mergeOutputImages(node.data.outputImages, result.outputs.map((o) => o.url)),
        status: "运行成功",
        task: Object.assign({}, task, { status: "success", finishedAt: Date.now() }),
      });
      return { ok: true, status: "success", outputs: result.outputs.length };
    }
    if (result.status === "failed") {
      updateNodeData(nodeId, {
        status: "失败",
        runError: result.failReason,
        task: Object.assign({}, task, { status: "failed", error: { stage: result.stage || "status", message: result.failReason, retryable: false } }),
      });
      return { ok: true, status: "failed", failReason: result.failReason };
    }
    updateNodeData(nodeId, { task: Object.assign({}, task, { status: result.status }) });
    return { ok: true, status: result.status };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

async function recoverStaleTasks() {
  const nodes = listRunningHubNodes().filter((n) =>
    n.data && n.data.task && n.data.task.taskId &&
    ["queued", "running"].indexOf(n.data.task.status) !== -1 &&
    n.data.running !== true);
  const results = [];
  for (const n of nodes) {
    results.push({ nodeId: n.id, title: n.data.title, outcome: await recoverNode(n.id) });
  }
  return results;
}

/* ---------- 工作流 JSON 导入（自有 DOM，浮动入口） ---------- */

const SETTINGS_KEY = "batchrefiner_openai_endpoint_settings_v2";

function readStoredSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"); } catch (e) { return {}; }
}

function writeWorkflowImport(workflowLocalId, workflowJsonText) {
  const parsed = JSON.parse(workflowJsonText); /* 可能抛出，由调用方捕获 */
  if (!parsed || typeof parsed !== "object") throw new Error("工作流 JSON 必须是对象");
  const settings = readStoredSettings();
  settings.runningHub = settings.runningHub || { baseUrl: "", apiKey: "", workflows: [] };
  settings.runningHub.workflows = Array.isArray(settings.runningHub.workflows) ? settings.runningHub.workflows : [];
  const entry = settings.runningHub.workflows.find((w) => w && w.id === workflowLocalId);
  if (!entry) throw new Error("未找到选中的工作流条目，请先在 API 设置里创建");
  const fields = A.parseWorkflowFields(parsed, { enableAll: false });
  entry.workflowJson = parsed;
  entry.fields = fields;
  entry.source = "workflow-json";
  entry.updatedAt = Date.now();
  const validation = A.validateRegistryEntry(entry);
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  return { fields: fields.length, validation };
}

function buildImportDialog() {
  if (document.getElementById("ai2-rh-import")) return;
  const root = document.createElement("div");
  root.id = "ai2-rh-import";
  root.innerHTML =
    '<button id="ai2-rh-import-fab" title="RunningHub 工作流 JSON 导入">RH</button>' +
    '<div id="ai2-rh-import-panel">' +
    '<div class="ai2-rh-import-head"><b>RunningHub 工作流导入</b><button data-close>×</button></div>' +
    '<label class="ai2-rh-import-row">目标工作流 <select id="ai2-rh-import-wf"></select></label>' +
    '<textarea id="ai2-rh-import-json" rows="10" placeholder="粘贴 ComfyUI 工作流 JSON（API 格式）"></textarea>' +
    '<div class="ai2-rh-import-actions"><button id="ai2-rh-import-parse">解析并保存到本地设置</button></div>' +
    '<div id="ai2-rh-import-result"></div>' +
    '<div class="ai2-rh-import-note">保存后需刷新页面生效。字段默认不启用，可在解析结果中确认；链接输入（[nodeId, 序号]）会自动排除。</div>' +
    "</div>";
  document.body.appendChild(root);
  const fab = root.querySelector("#ai2-rh-import-fab");
  const panel = root.querySelector("#ai2-rh-import-panel");
  fab.addEventListener("click", () => {
    const sel = root.querySelector("#ai2-rh-import-wf");
    const stored = readStoredSettings();
    const workflows = (stored.runningHub && stored.runningHub.workflows) || [];
    sel.innerHTML = workflows.map((w) =>
      '<option value="' + String(w.id || "").replace(/"/g, "") + '">' +
      String((w.title || w.name || "未命名") + "（" + String(w.workflowId || "无 workflowId") + "）").replace(/</g, "&lt;") +
      "</option>").join("");
    panel.classList.toggle("is-open");
  });
  root.querySelector("[data-close]").addEventListener("click", () => panel.classList.remove("is-open"));
  root.querySelector("#ai2-rh-import-parse").addEventListener("click", () => {
    const result = root.querySelector("#ai2-rh-import-result");
    try {
      const wfId = root.querySelector("#ai2-rh-import-wf").value;
      if (!wfId) throw new Error("请先选择目标工作流");
      const out = writeWorkflowImport(wfId, root.querySelector("#ai2-rh-import-json").value);
      const errs = out.validation.errors || [];
      result.innerHTML =
        '<div class="ok">已解析 ' + out.fields + " 个字段并保存。刷新页面后生效。</div>" +
        (errs.length ? '<div class="err">校验警告：' + errs.map((s) => String(s).replace(/</g, "&lt;")).join("；") + "</div>" : "");
    } catch (e) {
      result.innerHTML = '<div class="err">导入失败：' + String((e && e.message) || e).replace(/</g, "&lt;") + "</div>";
    }
  });
}

/* ---------- 启动 ---------- */

function init() {
  if (!originalFetch) return;
  window.fetch = patchedFetch;
  window.__AI2_RH_RUNTIME = {
    recoverNode,
    recoverStaleTasks,
    queryTaskStatus: async (taskId) => queryOfficialTask(taskId),
    cancelTask: async (taskId) => {
      const settings = getRhSettings();
      return A.cancelTask({ baseUrl: settings.baseUrl, apiKey: settings.apiKey, taskId, fetchImpl: originalFetch, wrapUrl: wrapForPage });
    },
    buildRunningHubState: () => A.buildRunningHubState(getBridge() && getBridge().get ? getBridge().get().settings : {}),
    /* 测试导出 */
    buildOfficialCreateBody,
    translateCreateResponse,
    translateQueryResponse,
    findRunningNodeForSubmit,
  };
  if (typeof document !== "undefined") buildImportDialog();
  /* 等 bridge 就绪后做一次刷新恢复（仅浏览器环境） */
  if (typeof document === "undefined") return;
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if (getBridge()) {
      clearInterval(timer);
      setTimeout(() => { recoverStaleTasks().then((r) => { if (r.length) console.info("[RH patch] 恢复结果：", r); }).catch(() => {}); }, 5000);
    } else if (tries > 60) {
      clearInterval(timer);
    }
  }, 500);
}

if (typeof window !== "undefined") {
  if (typeof document !== "undefined" && document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
}

export { buildOfficialCreateBody, translateCreateResponse, translateQueryResponse, findRunningNodeForSubmit };
