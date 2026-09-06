/* BatchRefiner RunningHub Adapter（官方 /task/openapi/* 契约）
   职责：字段 Schema 解析、工作流注册表规范化与校验、nodeInfoList 构造（含可选图片裁剪）、
   任务提交/查询/取消、状态归一、结果解析、统一错误模型（脱敏）。
   网络通过注入 fetchImpl，纯逻辑可被 node --test 直接测试。
   规范：docs/superpowers/specs/2026-09-06-runninghub-agent-integration-spec.md */

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp)(\?|$)/i;
const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|mkv)(\?|$)/i;
const AUDIO_EXT_RE = /\.(mp3|wav|ogg|m4a|flac|aac)(\?|$)/i;

const RH_CODE_STATUS = {
  0: "success",
  "0": "success",
  804: "running",
  "804": "running",
  813: "queued",
  "813": "queued",
  805: "failed",
  "805": "failed",
};

/* ---------- 错误模型 ---------- */

function makeRhError(input) {
  const err = new Error(input.message || "RunningHub 错误");
  err.stage = input.stage || "validate";
  err.code = input.code;
  err.retryable = !!input.retryable;
  err.taskId = input.taskId;
  err.workflowId = input.workflowId;
  err.fieldKey = input.fieldKey;
  err.rawSummary = input.rawSummary;
  return err;
}

function sanitizeText(text) {
  return String(text == null ? "" : text)
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***")
    .replace(/(apiKey|api_key|accessPassword|access_password|Authorization)("?\s*[:=]\s*"?)[^,;&"\s}]+/gi, "$1$2***");
}

function truncStr(value, max) {
  const s = String(value == null ? "" : value);
  return s.length > max ? s.slice(0, max) + "…(长度" + s.length + ")" : s;
}

/* 从官方错误响应中提取用户可读的失败原因（data.failedReason → msg → errorCode）。 */
function extractFailReason(raw) {
  if (!raw || typeof raw !== "object") return truncStr(sanitizeText(raw), 300);
  const d = raw.data || {};
  const candidates = [
    d.failedReason, d.failReason,
    typeof d.failedReason === "object" ? (d.failedReason && (d.failedReason.msg || d.failedReason.message)) : null,
    raw.errorMessage, d.errorMessage, d.message, d.error, raw.message, raw.error,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return truncStr(sanitizeText(c), 300);
  }
  if (raw.msg && raw.msg !== "success") return truncStr(sanitizeText(raw.msg), 300);
  if (raw.errorCode != null) return "errorCode " + raw.errorCode;
  return "未知错误";
}

/* ---------- 字段 Schema ---------- */

/* 工作流 JSON 里的链接输入如 ["4", 1]，是内部连线不是可替换参数。 */
function isWorkflowLinkValue(value) {
  return Array.isArray(value) && value.length === 2 &&
    typeof value[0] === "string" && typeof value[1] === "number";
}

function inferFieldType(fieldName, value) {
  const s = String(fieldName == null ? "" : fieldName) + " " + (typeof value === "string" ? value : "");
  if (/image|img|mask|photo|picture|\.(png|jpe?g|webp|gif|bmp)/i.test(s)) return "IMAGE";
  if (/video|\.(mp4|webm|mov)/i.test(s)) return "VIDEO";
  if (/audio|voice|sound|\.(mp3|wav|flac|m4a)/i.test(s)) return "AUDIO";
  if (value === true || value === false) return "BOOLEAN";
  if (typeof value === "number") return "NUMBER";
  return "TEXT";
}

function fieldRole(field) {
  if (!field) return "text";
  if (field.fieldType === "IMAGE") return "image";
  if (field.fieldType === "VIDEO") return "video";
  if (field.fieldType === "AUDIO") return "audio";
  if (["NUMBER", "FLOAT", "INTEGER", "SLIDER"].indexOf(field.fieldType) !== -1) return "number";
  if (field.fieldType === "BOOLEAN") return "boolean";
  if (field.fieldType === "SELECT" || (Array.isArray(field.options) && field.options.length)) return "select";
  const name = [field.fieldName, field.label, field.group].join(" ");
  if (/prompt|positive|negative|text|caption|description|关键词|提示词|正向|负向/i.test(name)) return "prompt";
  return "text";
}

/* 从 workflowJson 节点 inputs 提取可选 options（数组/枚举/对象列表）。 */
function extractFieldOptions(value) {
  if (Array.isArray(value)) {
    return value.map((v) => (v && typeof v === "object" ? (v.value != null ? v.value : v.label != null ? v.label : v.name) : v))
      .filter((v) => typeof v === "string" || typeof v === "number");
  }
  return null;
}

/* 解析工作流 JSON → 字段 Schema 列表（默认 enabled:false，由用户/导入显式启用）。 */
function parseWorkflowFields(workflowJson, opts) {
  if (!workflowJson || typeof workflowJson !== "object") {
    throw makeRhError({ stage: "workflow", message: "workflowJson 不能为空或格式非法" });
  }
  const fields = [];
  let imageSeq = 0;
  const nodeIds = Object.keys(workflowJson);
  for (const nodeId of nodeIds) {
    const node = workflowJson[nodeId];
    if (!node || typeof node !== "object") continue;
    const inputs = node.inputs || {};
    for (const fieldName of Object.keys(inputs)) {
      const value = inputs[fieldName];
      if (isWorkflowLinkValue(value)) continue;
      const fieldType = inferFieldType(fieldName, value);
      const field = {
        id: nodeId + "::" + fieldName,
        nodeId: String(nodeId),
        fieldName,
        fieldValue: value,
        fieldType,
        label: (node._meta && node._meta.title) ? node._meta.title + "·" + fieldName : fieldName,
        enabled: !!(opts && opts.enableAll),
        required: false,
        sourceFromUpstream: fieldType === "IMAGE" || fieldType === "VIDEO" || fieldType === "AUDIO",
        options: fieldType === "TEXT" || fieldType === "BOOLEAN" || fieldType === "NUMBER" ? null : extractFieldOptions(value),
        imageOrder: 0,
      };
      if (fieldType === "IMAGE") field.imageOrder = ++imageSeq;
      fields.push(field);
    }
  }
  return fields;
}

/* ---------- 注册表规范化与校验 ---------- */

/* 把注册表条目规范化为规范 §4.1 结构；旧条目 {name, workflowId, note, params} 自动迁移。
   幂等：已规范化的条目原样通过。 */
function normalizeRegistryEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const out = {
    id: String(entry.id || ""),
    workflowId: String(entry.workflowId || ""),
    title: String(entry.title || entry.name || ""),
    description: String(entry.description || entry.note || ""),
    enabled: entry.enabled !== false,
    thumbnail: entry.thumbnail || undefined,
    accessPassword: entry.accessPassword || undefined,
    optionalImageMode: ["prune-workflow", "send-empty", "reject"].indexOf(entry.optionalImageMode) !== -1
      ? entry.optionalImageMode
      : "prune-workflow",
    fields: [],
    workflowJson: entry.workflowJson && typeof entry.workflowJson === "object" ? entry.workflowJson : undefined,
    source: ["manual", "workflow-json", "remote"].indexOf(entry.source) !== -1 ? entry.source : "manual",
    updatedAt: entry.updatedAt || 0,
  };
  const legacyImageFields = [];
  if (Array.isArray(entry.fields) && entry.fields.length) {
    out.fields = entry.fields.map((f) => normalizeField(f));
  } else if (Array.isArray(entry.params)) {
    /* 旧协议 params: {type:"text"|"image", nodeId, fieldName, value} */
    let imageOrder = 0;
    for (const p of entry.params) {
      if (!p || !p.nodeId || !p.fieldName) continue;
      const key = p.nodeId + "::" + p.fieldName;
      if (p.type === "image") {
        imageOrder += 1;
        legacyImageFields.push({
          id: key, nodeId: String(p.nodeId), fieldName: p.fieldName, fieldValue: "",
          fieldType: "IMAGE", label: p.fieldName, enabled: true, required: true,
          sourceFromUpstream: true, imageOrder,
        });
      } else {
        out.fields.push({
          id: key, nodeId: String(p.nodeId), fieldName: p.fieldName, fieldValue: p.value,
          fieldType: "TEXT", label: p.fieldName, enabled: true, required: false,
          sourceFromUpstream: false, imageOrder: 0,
        });
      }
    }
    out.fields = legacyImageFields.concat(out.fields);
  }
  return out;
}

function normalizeField(f) {
  return {
    id: String(f.id || (f.nodeId + "::" + f.fieldName)),
    nodeId: String(f.nodeId || ""),
    fieldName: String(f.fieldName || ""),
    fieldValue: f.fieldValue,
    fieldType: String(f.fieldType || "TEXT").toUpperCase(),
    label: f.label || f.fieldName,
    enabled: f.enabled !== false,
    required: !!f.required,
    sourceFromUpstream: !!f.sourceFromUpstream,
    group: f.group || undefined,
    note: f.note || undefined,
    options: Array.isArray(f.options) ? f.options : null,
    imageOrder: Number(f.imageOrder) || 0,
    min: f.min, max: f.max, step: f.step,
  };
}

function isMediaField(field) {
  return ["IMAGE", "VIDEO", "AUDIO"].indexOf(field.fieldType) !== -1;
}

/* 启用字段：有任何 enabled 字段时只用它们；否则用全部字段。媒体按 imageOrder 升序在前。 */
function getUsableFields(entry) {
  const fields = (entry && entry.fields) || [];
  const enabled = fields.filter((f) => f.enabled);
  const pool = enabled.length ? enabled : fields;
  const media = pool.filter((f) => isMediaField(f)).sort((a, b) => (a.imageOrder || 0) - (b.imageOrder || 0));
  const others = pool.filter((f) => !isMediaField(f));
  return media.concat(others);
}

function validateRegistryEntry(entry) {
  const errors = [];
  const warnings = [];
  const e = normalizeRegistryEntry(entry);
  if (!e) return { ok: false, errors: ["条目为空"], warnings, entry: null };
  if (!e.workflowId) errors.push("workflowId 不能为空");
  const seen = new Set();
  const nodeIds = e.workflowJson ? new Set(Object.keys(e.workflowJson)) : null;
  for (const f of e.fields) {
    if (seen.has(f.id)) errors.push("字段键重复：" + f.id);
    seen.add(f.id);
    if (nodeIds && !nodeIds.has(f.nodeId) && e.source !== "remote") {
      errors.push("字段 " + f.id + " 的 nodeId 在 workflowJson 中不存在");
    } else if (nodeIds && e.source !== "remote") {
      const inputs = (e.workflowJson[f.nodeId] && e.workflowJson[f.nodeId].inputs) || {};
      if (!(f.fieldName in inputs) && !isMediaField(f)) {
        errors.push("字段 " + f.id + " 的 fieldName 在节点 inputs 中不存在");
      }
    }
    if (fieldRole(f) === "select" && f.fieldValue != null && Array.isArray(f.options) && f.options.length
      && !f.options.some((o) => String(o) === String(f.fieldValue))) {
      errors.push("字段 " + f.id + " 的默认值不在 options 中");
    }
    if (fieldRole(f) === "number" && f.fieldValue != null && typeof Number(f.fieldValue) !== "number") {
      errors.push("字段 " + f.id + " 的默认值不是数字");
    }
  }
  if (e.workflowJson) {
    for (const node of Object.values(e.workflowJson)) {
      if (!node || typeof node !== "object") { errors.push("workflowJson 含非法节点"); break; }
    }
  }
  if (!e.fields.length) warnings.push("尚未导入字段 Schema，只能按工作流默认参数运行");
  return { ok: errors.length === 0, errors, warnings, entry: e };
}

/* ---------- nodeInfoList 构造 ---------- */

function convertFieldValue(field, value) {
  const role = fieldRole(field);
  if (role === "number") {
    const n = Number(value);
    if (Number.isNaN(n)) throw makeRhError({ stage: "validate", fieldKey: field.id, message: "字段 " + field.id + " 需要数字，收到：" + truncStr(value, 40) });
    if (field.min != null && n < Number(field.min)) throw makeRhError({ stage: "validate", fieldKey: field.id, message: "字段 " + field.id + " 低于最小值 " + field.min });
    if (field.max != null && n > Number(field.max)) throw makeRhError({ stage: "validate", fieldKey: field.id, message: "字段 " + field.id + " 超过最大值 " + field.max });
    if (field.fieldType === "INTEGER" && !Number.isInteger(n)) {
      throw makeRhError({ stage: "validate", fieldKey: field.id, message: "字段 " + field.id + " 需要整数" });
    }
    return n;
  }
  if (role === "boolean") {
    if (value === true || value === "true") return true;
    if (value === false || value === "false") return false;
    throw makeRhError({ stage: "validate", fieldKey: field.id, message: "字段 " + field.id + " 需要 true/false" });
  }
  if (role === "select") {
    if (Array.isArray(field.options) && field.options.length) {
      const match = field.options.find((o) => String(o) === String(value));
      if (match === undefined) {
        throw makeRhError({ stage: "validate", fieldKey: field.id, message: "字段 " + field.id + " 只能使用 " + JSON.stringify(field.options) + " 中的值" });
      }
      return typeof match === "string" ? match : String(value);
    }
    return typeof value === "string" ? value : String(value);
  }
  return typeof value === "string" ? value : String(value);
}

/* 删除字段输入后级联清理：被裁剪字段的链接源若不再被任何人引用则移除，
   并沿其上游继续；输入被删空且无人引用的节点一并移除。 */
function pruneWorkflowJson(workflowJson, removedInputs) {
  const cloned = JSON.parse(JSON.stringify(workflowJson));
  const queue = [];
  for (const { nodeId, fieldName } of removedInputs) {
    const node = cloned[nodeId];
    if (!node || !node.inputs) continue;
    const removed = node.inputs[fieldName];
    delete node.inputs[fieldName];
    if (isWorkflowLinkValue(removed)) queue.push(removed[0]);
    if (!Object.keys(node.inputs).length) queue.push(nodeId);
  }
  const referenced = () => {
    const set = new Set();
    for (const node of Object.values(cloned)) {
      if (!node || !node.inputs) continue;
      for (const v of Object.values(node.inputs)) {
        if (isWorkflowLinkValue(v)) set.add(v[0]);
      }
    }
    return set;
  };
  while (queue.length) {
    const id = queue.pop();
    if (!cloned[id]) continue;
    if (referenced().has(id)) continue;
    const sources = [];
    for (const v of Object.values(cloned[id].inputs || {})) {
      if (isWorkflowLinkValue(v)) sources.push(v[0]);
    }
    delete cloned[id];
    queue.push(...sources);
  }
  return cloned;
}

/* 构造 nodeInfoList。input:
   entry（规范化注册表条目）、overrides（fieldKey → value，来自节点 rhParams / 旧 params）、
   mediaValues（fieldKey → 已上传的 RunningHub 地址；未提供的必填媒体报错）、
   uploadResource（可选，async ({field, blobSource}) → 远端地址）、
   mediaSources（fieldKey → 上游原始 URL/dataURL，供 uploadResource 上传）。 */
async function buildNodeInfoList(input) {
  const entry = input.entry;
  const overrides = input.overrides || {};
  const mediaValues = input.mediaValues || {};
  const mediaSources = input.mediaSources || {};
  const uploadResource = input.uploadResource || null;
  const fields = getUsableFields(entry);
  const nodeInfoList = [];
  const uploaded = [];
  const skippedOptional = [];
  const warnings = [];
  const removedInputs = [];

  for (const field of fields) {
    const override = overrides[field.id];
    if (isMediaField(field)) {
      let value = override != null && typeof override !== "object" ? override : mediaValues[field.id];
      if (override && typeof override === "object" && override.value != null) value = override.value;
      if (!value && mediaSources[field.id] && uploadResource) {
        const up = await uploadResource({ field, source: mediaSources[field.id] });
        value = up.remoteUrl || up.fileName;
        uploaded.push({ fieldKey: field.id, sourceNodeId: field.nodeId, remoteUrl: value });
      }
      if (value) {
        nodeInfoList.push({ nodeId: field.nodeId, fieldName: field.fieldName, fieldValue: value });
        continue;
      }
      if (field.required || field.sourceFromUpstream) {
        if (entry.optionalImageMode === "send-empty" && !field.required) {
          nodeInfoList.push({ nodeId: field.nodeId, fieldName: field.fieldName, fieldValue: "" });
          continue;
        }
        if (entry.optionalImageMode === "prune-workflow" && !field.required && entry.workflowJson) {
          removedInputs.push({ nodeId: field.nodeId, fieldName: field.fieldName });
          skippedOptional.push(field.id);
          continue;
        }
        if (!field.required && entry.optionalImageMode === "prune-workflow") {
          removedInputs.push({ nodeId: field.nodeId, fieldName: field.fieldName });
          skippedOptional.push(field.id);
          continue;
        }
        throw makeRhError({
          stage: "validate",
          fieldKey: field.id,
          workflowId: entry.workflowId,
          message: "必填媒体字段缺失：" + field.id + "（请先绑定上游当前主图）",
          retryable: false,
        });
      }
      skippedOptional.push(field.id);
      continue;
    }
    const raw = override != null
      ? (override && typeof override === "object" && "value" in override ? override.value : override)
      : field.fieldValue;
    if (raw == null || (typeof raw === "string" && !raw.trim())) {
      if (field.required) {
        throw makeRhError({ stage: "validate", fieldKey: field.id, workflowId: entry.workflowId, message: "必填字段缺失：" + field.id, retryable: false });
      }
      skippedOptional.push(field.id);
      continue;
    }
    nodeInfoList.push({ nodeId: field.nodeId, fieldName: field.fieldName, fieldValue: convertFieldValue(field, raw) });
  }

  let prunedWorkflow;
  if (removedInputs.length && entry.workflowJson) {
    prunedWorkflow = pruneWorkflowJson(entry.workflowJson, removedInputs);
    warnings.push("已按 prune-workflow 移除可选媒体字段：" + skippedOptional.join("、"));
  }
  return { nodeInfoList, uploaded, skippedOptional, warnings, prunedWorkflow };
}

/* ---------- 官方接口 ---------- */

function normalizeBase(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "");
}

async function rhPostJson(fetchImpl, url, body, apiKey, timeoutMs, wrapUrl) {
  const target = typeof wrapUrl === "function" ? wrapUrl(url) : url;
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller && timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(target, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      throw makeRhError({ stage: "submit", message: "HTTP " + res.status + "：" + truncStr(sanitizeText(text), 200), retryable: res.status >= 500 || res.status === 429 });
    }
    let data;
    try { data = JSON.parse(text); } catch (e) {
      throw makeRhError({ stage: "submit", message: "RunningHub 返回无法解析：" + truncStr(sanitizeText(text), 200), retryable: false });
    }
    return data;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* 提交高级工作流任务。返回 {ok, taskId, taskStatus, promptTips, failReason}。 */
async function submitWorkflow(input) {
  const fetchImpl = input.fetchImpl;
  const base = normalizeBase(input.baseUrl);
  const apiKey = input.apiKey;
  if (!base) throw makeRhError({ stage: "settings", message: "RunningHub baseUrl 未配置", retryable: false });
  if (!apiKey) throw makeRhError({ stage: "settings", message: "RunningHub API Key 未配置", retryable: false });
  if (!input.workflowId) throw makeRhError({ stage: "workflow", message: "workflowId 不能为空", retryable: false });
  const body = {
    apiKey,
    workflowId: String(input.workflowId),
    addMetadata: input.addMetadata !== false,
  };
  if (Array.isArray(input.nodeInfoList) && input.nodeInfoList.length) body.nodeInfoList = input.nodeInfoList;
  if (input.accessPassword) body.accessPassword = input.accessPassword;
  if (input.instanceType) body.instanceType = input.instanceType;
  if (input.usePersonalQueue != null) body.usePersonalQueue = input.usePersonalQueue === true || input.usePersonalQueue === "true";
  if (input.workflowJson) body.workflow = typeof input.workflowJson === "string" ? input.workflowJson : JSON.stringify(input.workflowJson);
  const raw = await rhPostJson(fetchImpl, base + "/task/openapi/create", body, apiKey, input.timeoutMs || 60000, input.wrapUrl);
  const code = raw && raw.code;
  if (code !== 0 && code !== "0") {
    throw makeRhError({
      stage: "submit",
      code,
      workflowId: input.workflowId,
      message: "任务提交失败：" + extractFailReason(raw),
      retryable: false,
      rawSummary: truncStr(sanitizeText(JSON.stringify(raw).slice(0, 500)), 400),
    });
  }
  const taskId = raw.data && raw.data.taskId;
  if (!taskId) {
    throw makeRhError({ stage: "submit", workflowId: input.workflowId, message: "任务提交成功但未返回 taskId", retryable: false });
  }
  let promptTips;
  try { promptTips = raw.data.promptTips ? truncStr(sanitizeText(raw.data.promptTips), 200) : undefined; } catch (e) { /* 忽略 */ }
  return { ok: true, taskId: String(taskId), taskStatus: (raw.data && raw.data.taskStatus) || "QUEUED", promptTips, raw };
}

function classifyOutputKind(url, outputType) {
  const s = String(url || "");
  if (outputType && /^(png|jpe?g|webp|gif|bmp|image)$/i.test(outputType)) return "image";
  if (outputType && /^(mp4|webm|mov|video)$/i.test(outputType)) return "video";
  if (outputType && /^(mp3|wav|ogg|m4a|flac|aac|audio)$/i.test(outputType)) return "audio";
  if (IMAGE_EXT_RE.test(s)) return "image";
  if (VIDEO_EXT_RE.test(s)) return "video";
  if (AUDIO_EXT_RE.test(s)) return "audio";
  return "file";
}

function extractOutputs(data) {
  const containers = [data, data && data.outputs, data && data.results, data && data.files, data && data.data];
  const out = [];
  const seen = new Set();
  for (const c of containers) {
    if (!Array.isArray(c)) continue;
    for (const item of c) {
      let url = null;
      let outputType = null;
      let nodeId = null;
      if (typeof item === "string") url = item;
      else if (item && typeof item === "object") {
        url = item.fileUrl || item.file_url || item.url || item.downloadUrl || item.download_url;
        outputType = item.outputType || item.fileType || item.type;
        nodeId = item.nodeId != null ? String(item.nodeId) : null;
        if (Array.isArray(url)) { /* 列表值展开 */ for (const u of url) if (typeof u === "string") out.push({ url: u, kind: classifyOutputKind(u, outputType), nodeId }); continue; }
      }
      if (url && typeof url === "string" && /^https?:\/\//i.test(url) && !seen.has(url)) {
        seen.add(url);
        out.push({ url, kind: classifyOutputKind(url, outputType), nodeId });
      }
    }
  }
  return out;
}

/* 查询任务状态与结果（官方 /task/openapi/outputs，单端点同时给出状态与结果）。
   返回 {status: queued|running|success|failed|unknown, outputs, failReason, code}。 */
async function queryTask(input) {
  const fetchImpl = input.fetchImpl;
  const base = normalizeBase(input.baseUrl);
  if (!base) throw makeRhError({ stage: "settings", message: "RunningHub baseUrl 未配置", retryable: false });
  if (!input.taskId) throw makeRhError({ stage: "status", message: "taskId 不能为空", retryable: false });
  const raw = await rhPostJson(fetchImpl, base + "/task/openapi/outputs", { apiKey: input.apiKey, taskId: input.taskId }, input.apiKey, input.timeoutMs || 60000, input.wrapUrl);
  const code = raw && raw.code;
  let status = RH_CODE_STATUS[code] || "unknown";
  let outputs = [];
  let failReason = null;
  if (status === "success") {
    outputs = extractOutputs(raw.data);
    if (!outputs.length) {
      return { status: "failed", outputs, failReason: "任务成功但没有解析到输出文件", code, stage: "result", rawSummary: truncStr(sanitizeText(JSON.stringify(raw).slice(0, 400)), 300) };
    }
  } else if (status === "failed") {
    failReason = extractFailReason(raw);
  } else if (status === "unknown") {
    failReason = "未知状态码 " + code + "：" + extractFailReason(raw);
  }
  return { status, outputs, failReason, code, rawSummary: truncStr(sanitizeText(JSON.stringify(raw).slice(0, 400)), 300) };
}

/* 取消任务（官方 /task/openapi/stop）。 */
async function cancelTask(input) {
  const fetchImpl = input.fetchImpl;
  const base = normalizeBase(input.baseUrl);
  if (!base || !input.apiKey || !input.taskId) {
    throw makeRhError({ stage: "cancel", message: "取消任务缺少 baseUrl/apiKey/taskId", retryable: false });
  }
  const raw = await rhPostJson(fetchImpl, base + "/task/openapi/stop", { apiKey: input.apiKey, taskId: input.taskId }, input.apiKey, input.timeoutMs || 30000, input.wrapUrl);
  const code = raw && raw.code;
  if (code !== 0 && code !== "0") {
    throw makeRhError({ stage: "cancel", code, taskId: input.taskId, message: "取消失败：" + extractFailReason(raw), retryable: false });
  }
  return { ok: true, taskId: input.taskId };
}

/* 条件轮询直到终态。onPoll(status, result) 可选。 */
async function waitForCompletion(input) {
  const deadline = Date.now() + (input.timeoutMs || 1800000);
  const pollMs = Math.max(1000, input.pollMs || 3000);
  let last = null;
  for (;;) {
    last = await input.queryTask(input.taskId);
    if (typeof input.onPoll === "function") input.onPoll(last);
    if (last.status === "success" || last.status === "failed") return last;
    if (Date.now() >= deadline) {
      return { status: "failed", outputs: [], failReason: "等待超时（" + Math.round((input.timeoutMs || 1800000) / 60000) + " 分钟）", stage: "timeout", retryable: true };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/* ---------- 资源上传（dataURL/远程 URL → Blob → 官方上传接口） ---------- */

function inferExtension(mime) {
  const map = {
    "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/bmp": "bmp",
    "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
    "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg", "audio/x-m4a": "m4a", "audio/flac": "flac", "audio/aac": "aac",
  };
  return map[String(mime || "").toLowerCase()] || "png";
}

async function uploadResource(input) {
  const fetchImpl = input.fetchImpl;
  const base = normalizeBase(input.baseUrl);
  if (!base || !input.apiKey) throw makeRhError({ stage: "settings", message: "上传资源缺少 baseUrl/apiKey", retryable: false });
  if (!input.source) throw makeRhError({ stage: "upload", message: "上传资源缺少来源", retryable: false });
  let blob;
  if (input.blob) {
    blob = input.blob;
  } else if (/^data:/i.test(input.source)) {
    const res = await fetchImpl(input.source);
    blob = await res.blob();
  } else if (/^https?:\/\//i.test(input.source)) {
    const res = await fetchImpl(input.source);
    if (!res.ok) throw makeRhError({ stage: "upload", message: "下载上游媒体失败：HTTP " + res.status, retryable: true });
    blob = await res.blob();
  } else {
    throw makeRhError({ stage: "upload", message: "参考媒体格式不支持：" + truncStr(input.source, 60), retryable: false });
  }
  const ext = inferExtension(blob.type);
  const form = new FormData();
  form.append("apiKey", input.apiKey);
  form.append("fileType", input.fileType || "input");
  form.append("file", blob, "upload_" + Date.now() + "." + ext);
  const res = await fetchImpl(base + "/task/openapi/upload", { method: "POST", headers: { Authorization: "Bearer " + input.apiKey }, body: form });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) {
    throw makeRhError({ stage: "upload", message: "上传返回无法解析：" + truncStr(sanitizeText(text), 200), retryable: false });
  }
  if (data.code !== 0 && data.code !== "0") {
    throw makeRhError({ stage: "upload", code: data.code, message: "上传失败：" + extractFailReason(data), retryable: false });
  }
  const d = data.data || {};
  const remote = d.fileName || d.download_url || d.downloadUrl || d.fileUrl || d.url;
  if (!remote) throw makeRhError({ stage: "upload", message: "上传成功但未返回文件地址", retryable: false });
  return { fileName: d.fileName, remoteUrl: d.download_url || d.downloadUrl || d.fileUrl || d.url, fileType: d.fileType };
}

/* ---------- Agent 目录（脱敏） ---------- */

function maskId(id) {
  const s = String(id || "");
  return s.length > 10 ? s.slice(0, 6) + "…" + s.slice(-4) : s;
}

function buildRunningHubState(settings) {
  const rh = (settings && settings.runningHub) || {};
  const workflows = Array.isArray(rh.workflows) ? rh.workflows : [];
  return {
    configured: !!(rh.apiKey && rh.baseUrl),
    workflows: workflows.map((raw) => {
      const entry = normalizeRegistryEntry(raw);
      if (!entry) return { workflowRef: "", title: "非法条目", enabled: false, fields: [] };
      return {
        workflowRef: "workflow:" + entry.id,
        workflowIdMasked: maskId(entry.workflowId),
        title: entry.title,
        enabled: entry.enabled,
        optionalImageMode: entry.optionalImageMode,
        fields: getUsableFields(entry).map((f) => ({
          fieldKey: f.id,
          role: fieldRole(f),
          required: !!f.required,
          sourceFromUpstream: !!f.sourceFromUpstream,
          imageOrder: f.imageOrder || undefined,
          options: Array.isArray(f.options) ? f.options : undefined,
          hasDefault: f.fieldValue != null && f.fieldValue !== "",
        })),
      };
    }),
  };
}

const runninghubAdapter = {
  makeRhError,
  sanitizeText,
  extractFailReason,
  isWorkflowLinkValue,
  inferFieldType,
  fieldRole,
  parseWorkflowFields,
  normalizeRegistryEntry,
  normalizeField,
  getUsableFields,
  validateRegistryEntry,
  buildNodeInfoList,
  pruneWorkflowJson,
  convertFieldValue,
  submitWorkflow,
  queryTask,
  cancelTask,
  waitForCompletion,
  uploadResource,
  buildRunningHubState,
  maskId,
  classifyOutputKind,
};

export { runninghubAdapter };
export {
  makeRhError,
  sanitizeText,
  extractFailReason,
  isWorkflowLinkValue,
  inferFieldType,
  fieldRole,
  parseWorkflowFields,
  normalizeRegistryEntry,
  normalizeField,
  getUsableFields,
  validateRegistryEntry,
  buildNodeInfoList,
  pruneWorkflowJson,
  convertFieldValue,
  submitWorkflow,
  queryTask,
  cancelTask,
  waitForCompletion,
  uploadResource,
  buildRunningHubState,
  maskId,
  classifyOutputKind,
};

if (typeof window !== "undefined") {
  window.__AI2_RH_ADAPTER = runninghubAdapter;
}
