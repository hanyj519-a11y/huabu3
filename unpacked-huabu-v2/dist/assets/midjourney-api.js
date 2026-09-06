const endpointPaths = {
  edit: "/images/edits",
  variation: "/images/variations",
  upscale: "/images/upscales",
};

export function isMidjourneyModel(model) {
  return typeof model === "string" && model.trim().toLowerCase().startsWith("mj_");
}

export function buildMidjourneyChatRequest(model, prompt) {
  return {
    path: "/chat/completions",
    body: {
      model,
      stream: false,
      messages: [{ role: "user", content: prompt }],
    },
  };
}

export function buildMidjourneyEndpoint(kind, taskId) {
  if (kind === "task") {
    return `/tasks/${encodeURIComponent(taskId)}`;
  }

  return endpointPaths[kind];
}

function isImageValue(value) {
  return (
    typeof value === "string" &&
    (/^https?:\/\//i.test(value.trim()) || /^data:image\//i.test(value.trim()))
  );
}

function readResult(value, result, visited = new Set()) {
  if (!value || typeof value !== "object" || visited.has(value)) return;
  visited.add(value);

  if (typeof value.status === "string" && !result.state) result.state = value.status;
  if (typeof value.state === "string" && !result.state) result.state = value.state;
  if (typeof value.task_id === "string" && !result.taskId) result.taskId = value.task_id;
  if (typeof value.taskId === "string" && !result.taskId) result.taskId = value.taskId;
  if (typeof value.error === "string" && !result.error) result.error = value.error;
  if (value.error && typeof value.error.message === "string" && !result.error)
    result.error = value.error.message;
  if (typeof value.message === "string" && !result.error) result.error = value.message;

  for (const key of ["url", "image_url", "imageUrl"]) {
    const candidate = value[key];
    const image = typeof candidate === "object" ? candidate?.url : candidate;
    if (!result.imageUrl && isImageValue(image)) result.imageUrl = image.trim();
  }

  for (const child of Object.values(value)) {
    if (!result.imageUrl || !result.taskId || !result.state) readResult(child, result, visited);
  }
}

export function extractMidjourneyResult(payload) {
  const result = { imageUrl: "", taskId: "", state: "", error: "" };
  readResult(payload, result);
  return result;
}

export async function pollMidjourneyTask({
  baseUrl,
  apiKey,
  taskId,
  fetchImpl = fetch,
  maxAttempts = 60,
  intervalMs = 2000,
}) {
  const taskUrl = `${String(baseUrl || "").replace(/\/+$/, "")}${buildMidjourneyEndpoint("task", taskId)}`;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await fetchImpl(taskUrl, {
      headers: { Authorization: `Bearer ${apiKey || ""}`, Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Midjourney task request failed: HTTP ${response.status}`);
    const result = extractMidjourneyResult(await response.json());
    if (result.imageUrl) return result.imageUrl;
    if (/(failed|error|cancelled|canceled)/i.test(result.state))
      throw new Error(result.error || `Midjourney task ${taskId} failed.`);
    if (attempt + 1 < maxAttempts && intervalMs > 0)
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Midjourney task ${taskId} timed out after ${maxAttempts} checks.`);
}

const midjourneyApi = {
  isMidjourneyModel,
  buildMidjourneyChatRequest,
  buildMidjourneyEndpoint,
  extractMidjourneyResult,
  pollMidjourneyTask,
};

if (typeof window !== "undefined") {
  window.__AI2_MJ_API = midjourneyApi;
}
