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

test("ships the Pages proxy as a root-level Function", () => {
  const proxy = new URL("../functions/api/proxy.js", import.meta.url);
  assert.equal(fs.existsSync(proxy), true);
});

test("the bundle directly dispatches Midjourney models", () => {
  const bundle = fs.readFileSync(
    new URL("../dist/assets/index-v1514-gemini-strict-sizefix-v6.js", import.meta.url),
    "utf8",
  );
  assert.match(bundle, /__AI2_MJ_API/);
  assert.match(bundle, /buildMidjourneyChatRequest/);
  assert.match(bundle, /buildMidjourneyEndpoint\("variation"\)/);
});

test("documents the root-level Pages proxy deployment requirement", () => {
  const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /functions\/api\/proxy\.js/);
  assert.match(readme, /仓库根目录/);
});

test("uses larger warm-peach outlined controls for every compact node", () => {
  const css = fs.readFileSync(
    new URL("../dist/assets/ai2-compact-node-patch.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /\.compact-pill\s*\{[\s\S]*?height:\s*44px\s*!important/);
  assert.match(css, /\.compact-pill\.active\s*\{[\s\S]*?background:\s*#fff\s*!important/);
  assert.match(css, /\.compact-pill\.active\s*\{[\s\S]*?border-color:\s*#d67642\s*!important/);
  assert.match(css, /\.compact-toolbar \.compact-pill > \.compact-size-popover[\s\S]*?bottom:\s*calc\(100% \+ 26px\)\s*!important/);
  assert.match(css, /\.compact-size-popover \.option-popover button[\s\S]*?border-radius:\s*999px\s*!important/);
  assert.match(css, /\.gen-expand-popovers:not\(:empty\)[\s\S]*?position:\s*absolute\s*!important/);
  assert.match(css, /\.gen-expand-popovers:not\(:empty\)[\s\S]*?bottom:\s*98px\s*!important/);
  assert.match(css, /#fff0e5/i);
});

test("uses the requested peach fill and restores size group labels", () => {
  const css = fs.readFileSync(
    new URL("../dist/assets/ai2-compact-node-patch.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /\.compact-size-popover \.compact-popover-title\s*\{[\s\S]*?display:\s*block\s*!important/);
  assert.match(css, /\.compact-size-popover \.option-popover\s*\{[\s\S]*?margin-bottom:\s*28px\s*!important/);
  assert.match(css, /\.compact-toolbar \.compact-pill > \.compact-size-popover,[\s\S]*?max-height:\s*none\s*!important[\s\S]*?overflow:\s*visible\s*!important/);
  assert.match(css, /\.compact-panel \.compact-textarea,[\s\S]*?border-color:\s*#ebdfd5\s*!important/);
  assert.match(css, /\.compact-panel > \.compact-toolbar\s*\{[\s\S]*?margin-top:\s*10px\s*!important/);
  assert.match(css, /\.gen-expand-panel > \.gen-expand-toolbar\s*\{[\s\S]*?padding-top:\s*10px\s*!important/);
  assert.match(css, /\.generate-node \.node-option-wrap,[\s\S]*?margin-top:\s*10px\s*!important/);
  assert.match(css, /#fff0e5/i);
  assert.doesNotMatch(css, /#6d5df6|#ede9fe|#d9d6ef|rgba\(109,\s*93,\s*246/);
});

test("applies the same readable controls to the Agent panel", () => {
  const css = fs.readFileSync(
    new URL("../dist/assets/ai2-agent-panel.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /\.ai2-agent-pill[\s\S]*?min-height:\s*44px/);
  assert.match(css, /\.ai2-dd-item[\s\S]*?min-height:\s*44px/);
  assert.match(css, /#fff0e5/i);
});

test("keeps the full ratio and count option sets in the published bundle", () => {
  const bundle = fs.readFileSync(
    new URL("../dist/assets/index-v1514-gemini-strict-sizefix-v6.js", import.meta.url),
    "utf8",
  );
  assert.match(bundle, /options: \[\.\.\.pC, "自适应"\]/);
  assert.match(bundle, /options: hC\.map\(\(f\) => `\$\{f\}张`\)/);
  assert.match(bundle, /pC = \["1:1", "2:3", "3:4", "9:16", "16:9", "4:3", "3:2"\]/);
});

test("keeps the image node editor after generation succeeds", () => {
  const bundle = fs.readFileSync(
    new URL("../dist/assets/index-v1514-gemini-strict-sizefix-v6.js", import.meta.url),
    "utf8",
  );
  assert.match(bundle, /xp\s*\?\s*m\.jsxs\("div",\s*\{\s*className:\s*"compact-panel/);
  assert.doesNotMatch(bundle, /xp\s*&&\s*!hasImg\s*\?\s*m\.jsxs\("div",\s*\{\s*className:\s*"compact-panel/);
  assert.doesNotMatch(bundle, /if\s*\(t\.image\s*&&\s*!t\.running\)\s*setXp\(!1\)/);
});

test("merges new image results into the image node history", () => {
  const bundle = fs.readFileSync(
    new URL("../dist/assets/index-v1514-gemini-strict-sizefix-v6.js", import.meta.url),
    "utf8",
  );
  assert.match(bundle, /outputImages:\s*Array\.from\(new Set\(/);
  assert.match(bundle, /\.\.\.\(V\.data\.outputImages\s*\|\|\s*\[\]\)/);
  assert.match(bundle, /\.\.\.ue/);
});

test("renders an image history switcher that updates the current image", () => {
  const bundle = fs.readFileSync(
    new URL("../dist/assets/index-v1514-gemini-strict-sizefix-v6.js", import.meta.url),
    "utf8",
  );
  const topIndex = bundle.indexOf('className: "compact-top nodrag nopan"');
  const historyToggleIndex = bundle.indexOf('className: "compact-history-toggle nodrag nopan"');
  assert.ok(topIndex >= 0 && historyToggleIndex > topIndex);
  assert.doesNotMatch(bundle, /className: "compact-history-menu-toggle/);
  assert.match(bundle, /compact-history-toggle/);
  assert.match(bundle, /compact-history-popover/);
  assert.match(bundle, /outputImages \|\| \[\]\)\.map/);
  assert.match(bundle, /updateNode\?\.\(e, \{ image: f \}\)/);
  assert.match(bundle, /setHistoryOpen\(!1\)/);
});

test("styles image history as a downward thumbnail popover", () => {
  const css = fs.readFileSync(
    new URL("../dist/assets/ai2-compact-node-patch.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /\.compact-history-popover[\s\S]*?position:\s*absolute/);
  assert.match(css, /\.compact-history-popover[\s\S]*?top:\s*calc\(100% \+ 10px\)/);
  assert.match(css, /\.compact-history-item[\s\S]*?border-radius:\s*12px/);
  assert.match(css, /\.compact-history-item\.current[\s\S]*?#fff0e5/);
  assert.match(css, /\.compact-history-popover[\s\S]*?width:\s*min\(260px, 50vw\)/);
});

test("passes only the selected generated image downstream", () => {
  const bundle = fs.readFileSync(
    new URL("../dist/assets/index-v1514-gemini-strict-sizefix-v6.js", import.meta.url),
    "utf8",
  );
  assert.match(bundle, /W\.push\(je\.data\.image \|\| \(je\.data\.outputImages \|\| \[\]\)\[0\]\)/);
});

test("lets Agent update named nodes and blocks implicit layout", () => {
  const agent = fs.readFileSync(
    new URL("../dist/assets/ai2-agent-panel.js", import.meta.url),
    "utf8",
  );
  const bundle = fs.readFileSync(
    new URL("../dist/assets/index-v1514-gemini-strict-sizefix-v6.js", import.meta.url),
    "utf8",
  );
  assert.match(agent, /updateNode/);
  assert.match(agent, /没有明确指定节点时创建新节点/);
  assert.match(agent, /action === "updateNode"/);
  assert.match(bundle, /updateNode: \(O, T\)/);
  assert.match(bundle, /defaultTitle = `\$\{typeLabels\[O\] \|\| "节点"\}\$\{nextIndex\}`/);
});

test("does not ship built-in provider endpoints or credentials", () => {
  const bundle = fs.readFileSync(
    new URL("../dist/assets/index-v1514-gemini-strict-sizefix-v6.js", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(bundle, /https:\/\/api\.wuyinkeji\.com\/api\/async\/video_google_omni/);
  assert.doesNotMatch(bundle, /https:\/\/www\.runninghub\.cn/);
  assert.doesNotMatch(bundle, /apiKey:\s*["'][^"']+["']/);
  assert.match(bundle, /Xt\(i, "\/videos\/generations"\)/);
  assert.match(bundle, /if \(!i\.baseUrl\)/);
});

test("reopens the image editor when generation completes", () => {
  const bundle = fs.readFileSync(
    new URL("../dist/assets/index-v1514-gemini-strict-sizefix-v6.js", import.meta.url),
    "utf8",
  );
  assert.match(bundle, /if \(t\.image && !t\.running && t\.status === "生成成功"\) setXp\(!0\)/);
});

test("does not render a running shimmer stripe above nodes", () => {
  const css = fs.readFileSync(
    new URL("../dist/assets/ai2-motion-patch.css", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(css, /\.node-shell:has\(\.spin\)::after/);
  assert.doesNotMatch(css, /\.node-shell:has\(\.spin\)\s*\{/);
  assert.doesNotMatch(css, /\.run-pill:has\(\.spin\)\s*\{/);
});

test("cache-busts the updated canvas assets", () => {
  const html = fs.readFileSync(
    new URL("../dist/index.html", import.meta.url),
    "utf8",
  );
  assert.match(html, /index-v1514-gemini-strict-sizefix-v6\.js\?v=ui-cleanup-v12-image-agent/);
  assert.match(html, /ai2-compact-node-patch\.css\?v=ui-cleanup-v20-image-agent/);
  assert.match(html, /ai2-motion-patch\.css\?v=runninghub-v5-static-running/);
});
