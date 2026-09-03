# 图片节点历史与 Agent 控制 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成图片历史选择、下游当前图片传递、Agent 参数控制和节点标题/尺寸显示。

**Architecture:** 继续修改发布版 dist 资源，使用已有图片节点组件和 `__AI2_CANVAS_BRIDGE`。在下游收集入口统一以当前 `image` 为唯一输出，在 Agent 中扩展现有 JSON actions，并保持上传图片链路单图不变。

**Tech Stack:** 发布版 JavaScript、CSS、Node.js 内置测试。

## Global Constraints

- 只修改 `unpacked-huabu-v2` 主目录，不处理旁边旧副本。
- 不新增依赖，不内置 API 地址或密钥。
- 未明确要求时 Agent 不执行 `layout`。
- 单独上传图片向下游仍只传一张图片。

---

### Task 1: 图片历史选择器

**Files:**
- Modify: `dist/assets/index-v1514-gemini-strict-sizefix-v6.js` 图片节点组件
- Modify: `dist/assets/ai2-compact-node-patch.css` 历史按钮和缩略图样式
- Test: `tests/midjourney-api.test.mjs`

- [ ] 添加静态断言：历史按钮位于顶部操作栏，历史缩略图使用节点半宽约束，点击不调用大图预览。
- [ ] 运行测试确认新增断言失败。
- [ ] 将历史按钮移动到放大/下载按钮所在的 `compact-top`，统一水平排列。
- [ ] 将历史弹层中的图片改为缩略图尺寸，并保持点击选择后收起。
- [ ] 运行图片历史相关测试确认通过。

### Task 2: 下游图片去重与当前图优先

**Files:**
- Modify: `dist/assets/index-v1514-gemini-strict-sizefix-v6.js` 上游图片收集函数
- Test: `tests/midjourney-api.test.mjs`

- [ ] 添加断言：存在历史结果时，下游收集使用 `image` 作为唯一图片；上传节点不展开 `outputImages`。
- [ ] 运行测试确认断言失败。
- [ ] 修改统一上游收集逻辑：生成节点有当前 `image` 时只加入该图，否则仅使用单独上传图，最终去重。
- [ ] 运行数据流相关测试确认通过。

### Task 3: Agent 动作与参数识别

**Files:**
- Modify: `dist/assets/ai2-agent-panel.js`
- Modify: `dist/assets/index-v1514-gemini-strict-sizefix-v6.js` 节点桥接和标题显示
- Modify: `dist/assets/ai2-agent-panel.css` Agent 控件样式（如需要）
- Test: `tests/midjourney-api.test.mjs`

- [ ] 添加断言：Agent 支持 `updateNode`、图片参数字段、节点编号定位，且系统提示不要求隐式 `layout`。
- [ ] 运行测试确认断言失败。
- [ ] 扩展 Agent action 执行器：明确指定节点时更新该节点，未指定时创建新节点；图片模型/比例/尺寸/清晰度写入对应 data 字段。
- [ ] 让自然语言提示明确要求模型输出可执行参数；只有用户明确要求排版时才允许 `layout`。
- [ ] 为图片、文本、视频节点生成稳定的类型序号标题，并显示当前尺寸。
- [ ] 运行 Agent 相关测试确认通过。

### Task 4: 全量验证与预览

**Files:**
- Modify: `dist/index.html` 资源缓存版本（如本次 JS/CSS 有更新）

- [ ] 运行 `node --test tests/midjourney-api.test.mjs`，确认全部通过。
- [ ] 运行所有修改后 JavaScript 的 `node --check`。
- [ ] 检查本地 HTTP 返回版本号和资源内容。
- [ ] 刷新 `http://localhost:41730/`，检查无控制台错误并保留预览页。
