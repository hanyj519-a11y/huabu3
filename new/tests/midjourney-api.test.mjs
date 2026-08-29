import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  buildMidjourneyChatRequest,
  buildMidjourneyEndpoint,
  extractMidjourneyResult,
  isMidjourneyModel,
  pollMidjourneyTask,
} from "../dist/assets/midjourney-api.js";

test("detects Midjourney models by normalized mj_ prefix", () => {
  assert.equal(isMidjourneyModel("mj_fast_imagine"), true);
  assert.equal(isMidjourneyModel("MJ_FAST_IMAGINE"), true);
  assert.equal(isMidjourneyModel("gpt-image-2"), false);
});

test("builds the confirmed Midjourney chat completion request", () => {
  assert.deepEqual(
    buildMidjourneyChatRequest("mj_fast_imagine", "red fox"),
    {
      path: "/chat/completions",
      body: {
        model: "mj_fast_imagine",
        stream: false,
        messages: [{ role: "user", content: "red fox" }],
      },
    },
  );
});

test("builds Midjourney image and task endpoints", () => {
  assert.equal(buildMidjourneyEndpoint("edit"), "/images/edits");
  assert.equal(buildMidjourneyEndpoint("variation"), "/images/variations");
  assert.equal(buildMidjourneyEndpoint("upscale"), "/images/upscales");
  assert.equal(buildMidjourneyEndpoint("task", "job/42"), "/tasks/job%2F42");
});

test("extracts nested image and task metadata", () => {
  assert.equal(
    extractMidjourneyResult({
      data: { output: { image_url: "https://cdn.example/final.png" } },
    }).imageUrl,
    "https://cdn.example/final.png",
  );
  assert.deepEqual(
    extractMidjourneyResult({ data: { task_id: "task-7", status: "processing" } }),
    { imageUrl: "", taskId: "task-7", state: "processing", error: "" },
  );
});

test("polls the assumed task endpoint to an image", async () => {
  const requests = [];
  const image = await pollMidjourneyTask({
    baseUrl: "https://zxai.work/v1",
    apiKey: "test",
    taskId: "task-7",
    intervalMs: 0,
    maxAttempts: 2,
    fetchImpl: async (url) => {
      requests.push(url);
      return {
        ok: true,
        json: async () => ({ data: { url: "https://cdn.example/final.png" } }),
      };
    },
  });
  assert.equal(image, "https://cdn.example/final.png");
  assert.deepEqual(requests, ["https://zxai.work/v1/tasks/task-7"]);
});

test("loads the Midjourney runtime before the main app", () => {
  const html = fs.readFileSync(new URL("../dist/index.html", import.meta.url), "utf8");
  assert.match(html, /midjourney-api\.js/);
});

test("the bundle directly dispatches Midjourney models", () => {
  const bundle = fs.readFileSync(
    new URL("../dist/assets/index-v1514-gemini-strict-sizefix-v6.js", import.meta.url),
    "utf8",
  );
  assert.match(bundle, /__AI2_MJ_API/);
  assert.match(bundle, /buildMidjourneyChatRequest/);
  assert.match(bundle, /buildMidjourneyEndpoint\("variation"\)/);
  assert.match(bundle, /buildMidjourneyEndpoint\("upscale"\)/);
});

test("documents the confirmed model and hardcoded endpoint limitations", () => {
  const readme = fs.readFileSync(
    new URL("../README-COMFLY-v1.5.4.txt", import.meta.url),
    "utf8",
  );
  assert.match(readme, /mj_fast_imagine/);
  assert.match(readme, /硬编码假设/);
});
