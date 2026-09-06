# 图片节点生成历史与主图切换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为图片节点保留多次生成结果，并在节点内通过三级历史面板切换当前主图。

**Architecture:** 复用图片节点数据中的 `outputImages` 作为有序历史列表，复用 `image` 作为当前主图。生成成功时将新结果与旧历史去重合并；图片节点展开时显示历史入口和面板，选择历史项只更新 `image` 并关闭面板，因此下游仍读取同一个当前主图字段。

**Tech Stack:** 已发布的 React 生产 bundle、CSS patch、Node built-in test runner。

## Global Constraints

- 不创建新的图片存储结构，历史沿用 `outputImages`。
- 当前主图始终存储在 `image`，下游读取逻辑保持不变。
- 生成失败不新增历史项，也不改变当前主图。
- 保留现有提示词、模型、尺寸、比例、张数、上传、放大和下载功能。
- 不改变视频节点、Agent 面板或通用模型请求协议。

---

### Task 1: 生成历史数据流

**Files:**
- Modify: `dist/assets/index-v1514-gemini-strict-sizefix-v6.js:25620-25775`
- Test: `tests/midjourney-api.test.mjs`

**Interfaces:**
- Consumes: `V.data.outputImages`, `ue` from `tM(...)`, and existing `j(nodeId, data)` updater.
- Produces: an ordered, duplicate-free `outputImages` array containing previous and newly generated image URLs; `image` remains the newly generated first result.

- [ ] **Step 1: Write the failing test**

Add a static contract test that requires generation success to merge an existing history list with new results before calling `j`:

```js
test("merges new image results into the image node history", () => {
  const bundle = fs.readFileSync(
    new URL("../dist/assets/index-v1514-gemini-strict-sizefix-v6.js", import.meta.url),
    "utf8",
  );
  assert.match(bundle, /outputImages:\s*Array\.from\(new Set\(/);
  assert.match(bundle, /\.\.\.\(V\.data\.outputImages\s*\|\|\s*\[\]\)/);
  assert.match(bundle, /\.\.\.ue/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests\midjourney-api.test.mjs`

Expected: the new test fails because the bundle currently assigns `outputImages: ue` and discards prior results.

- [ ] **Step 3: Implement the minimal merge**

Before the success update, derive the merged history and use it in the existing update:

```js
const history = Array.from(new Set([...(V.data.outputImages || []), ...ue]));
j(O, Object.assign(
  { running: !1, status: "生成成功", outputImages: history },
  ue.length ? { image: ue[0], fileName: `生成图片-${Date.now()}.png` } : {},
));
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests\midjourney-api.test.mjs`

Expected: all existing tests and the new history merge test pass.

### Task 2: 图片节点历史入口与切换

**Files:**
- Modify: `dist/assets/index-v1514-gemini-strict-sizefix-v6.js:23370-23710`
- Test: `tests/midjourney-api.test.mjs`

**Interfaces:**
- Consumes: `t.outputImages`, `t.image`, `t.updateNode`, and existing `xp` panel state.
- Produces: `historyOpen` local state, a history toggle control, a downward `.compact-history-popover`, and selection callbacks that call `updateNode(nodeId, { image })` then close the popover.

- [ ] **Step 1: Write the failing test**

Add a static UI contract test:

```js
test("renders an image history switcher that updates the current image", () => {
  const bundle = fs.readFileSync(
    new URL("../dist/assets/index-v1514-gemini-strict-sizefix-v6.js", import.meta.url),
    "utf8",
  );
  assert.match(bundle, /compact-history-toggle/);
  assert.match(bundle, /compact-history-popover/);
  assert.match(bundle, /outputImages \|\| \[\]\)\.map/);
  assert.match(bundle, /updateNode\?\.\(e, \{ image: f \}\)/);
  assert.match(bundle, /setHistoryOpen\(!1\)/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests\midjourney-api.test.mjs`

Expected: the new test fails because no history toggle or history popover exists.

- [ ] **Step 3: Implement the image history UI**

Add `const [historyOpen, setHistoryOpen] = z.useState(!1);`, render the toggle only when `(t.outputImages || []).length > 1`, render thumbnails from `t.outputImages || []`, and on thumbnail click call `t.updateNode?.(e, { image: f })` followed by `setHistoryOpen(!1)`. Mark the current item with `current` when `f === t.image`. Keep the existing `compact-panel` condition as `xp` so the prompt and secondary controls remain available after generation.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests\midjourney-api.test.mjs`

Expected: the history UI contract test passes with all prior tests.

### Task 3: 历史面板样式与全量验证

**Files:**
- Modify: `dist/assets/ai2-compact-node-patch.css:1580-end`
- Test: `tests/midjourney-api.test.mjs`

**Interfaces:**
- Consumes: `.compact-history-toggle`, `.compact-history-popover`, `.compact-history-item`, and `.compact-history-item.current` classes from Task 2.
- Produces: a top-right plus entry, a downward panel inside the expanded node, visible thumbnails, current-item styling, and no interference with existing upward third-level menus.

- [ ] **Step 1: Write the failing style assertions**

```js
test("styles image history as a downward thumbnail popover", () => {
  const css = fs.readFileSync(
    new URL("../dist/assets/ai2-compact-node-patch.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /\.compact-history-popover[\s\S]*?position:\s*absolute/);
  assert.match(css, /\.compact-history-popover[\s\S]*?top:\s*calc\(100% \+ 10px\)/);
  assert.match(css, /\.compact-history-item[\s\S]*?border-radius:\s*12px/);
  assert.match(css, /\.compact-history-item\.current[\s\S]*?#fff0e5/);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests\midjourney-api.test.mjs`

Expected: the style test fails because the history classes have no CSS.

- [ ] **Step 3: Add the focused CSS**

Use a positioned wrapper in `.compact-panel` with `top: calc(100% + 10px)`, grid thumbnails, `max-height: min(320px, 45vh)`, and `overflow-y: auto` only for the history list. Use `#fff0e5` for the current item and `#d67642` for its outline, preserving the existing warm-peach palette.

- [ ] **Step 4: Run all verification**

Run: `node --test`

Expected: all tests pass with zero failures.

Run: `node --check dist\assets\index-v1514-gemini-strict-sizefix-v6.js; node --check dist\assets\midjourney-api.js; node --check functions\api\proxy.js; git diff --check`

Expected: all checks exit successfully.

Run: `Invoke-WebRequest -UseBasicParsing http://localhost:41730/`

Expected: HTTP 200 from the local canvas preview.

### Task 4: Commit the implementation

**Files:**
- Modify: `dist/assets/index-v1514-gemini-strict-sizefix-v6.js`
- Modify: `dist/assets/ai2-compact-node-patch.css`
- Modify: `tests/midjourney-api.test.mjs`

- [ ] **Step 1: Review the focused diff**

Run: `git diff -- dist/assets/index-v1514-gemini-strict-sizefix-v6.js dist/assets/ai2-compact-node-patch.css tests/midjourney-api.test.mjs`

Expected: only image-history data flow, UI, CSS, and tests are included.

- [ ] **Step 2: Commit the implementation**

Run: `git add -- 'unpacked-huabu-v2/dist/assets/index-v1514-gemini-strict-sizefix-v6.js' 'unpacked-huabu-v2/dist/assets/ai2-compact-node-patch.css' 'unpacked-huabu-v2/tests/midjourney-api.test.mjs' && git commit -m "feat: add image node generation history"`

Expected: one commit containing only the implementation files listed above.
