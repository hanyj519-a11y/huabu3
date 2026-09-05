/* BatchRefiner AI Agent 面板（轻量版）
   记忆策略：只保留当前对话 + 当前画布状态 + 选中节点 + 当前任务记录（sessionStorage 会话级）。
   不含：长期记忆 / 跨会话 / 向量库 / RAG / 用户画像。 */
(function () {
  "use strict";
  if (window.__AI2_AGENT_PANEL__) return;
  window.__AI2_AGENT_PANEL__ = true;

  var SESSION_KEY = "batchrefiner_agent_session_v1";
  var PREF_KEY = "batchrefiner_agent_pref_v1";
  var SKILLS = [
    { id: "auto", name: "自动规划", hint: "" },
    { id: "optimize", name: "提示词优化", hint: "用户想优化/改写提示词。请直接给出优化后的提示词，并简要说明修改点，不要调用工具。" },
    { id: "image", name: "图片生成", hint: "用户想在画布上生成图片。请用 createNode(type=generateNode, prompt=优化后的画面提示词, run=true) 创建并立即运行。" },
    { id: "video", name: "视频生成", hint: "用户想生成视频。请用 createNode(type=videoNode, prompt=画面描述, run=true) 创建并立即运行。" },
    { id: "analyze", name: "画布分析", hint: "用户想了解画布现状。请基于 canvasState 总结节点、连线与运行状态，不要调用工具。" },
    { id: "layout", name: "画布排版", hint: "用户想整理画布布局。请输出 {\"actions\":[{\"action\":\"layout\"}]}。" },
    { id: "connect", name: "节点连接", hint: "用户想连接节点。请用 connect 动作，from/to 使用 canvasState 里的节点 id。" },
  ];
  var messages = [];
  var taskLog = [];
  var busy = false;
  var panelOpen = false;
  var selState = { api: "", model: "", skill: "auto" };
  var ddOpen = null;

  function $(sel) { return document.querySelector(sel); }
  function bridge() { return window.__AI2_CANVAS_BRIDGE; }
  function esc(t) { var d = document.createElement("div"); d.textContent = t == null ? "" : String(t); return d.innerHTML; }

  function saveSession() {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(messages)); } catch (e) {}
  }
  function loadSession() {
    try {
      var raw = sessionStorage.getItem(SESSION_KEY);
      messages = raw ? JSON.parse(raw) : [];
    } catch (e) { messages = []; }
    if (!Array.isArray(messages)) messages = [];
  }
  function savePref() {
    try { sessionStorage.setItem(PREF_KEY, JSON.stringify(selState)); } catch (e) {}
  }
  function loadPref() {
    try { return JSON.parse(sessionStorage.getItem(PREF_KEY) || "{}"); } catch (e) { return {}; }
  }

  /* ---------- Canvas Adapter：画布摘要 ---------- */
  function canvasSummary() {
    var b = bridge();
    if (!b) return "画布尚未就绪";
    var snap = b.get();
    var nodes = (snap.nodes || []).map(function (n) {
      return {
        id: n.id,
        type: n.type,
        title: n.data && n.data.title,
        ratio: n.data && n.data.ratio,
        quality: n.data && n.data.quality,
        size: n.data && n.data.size,
        prompt: n.data && n.data.prompt ? String(n.data.prompt).slice(0, 80) : undefined,
        text: n.data && n.data.text ? String(n.data.text).slice(0, 80) : undefined,
        hasImage: !!(n.data && (n.data.image || (n.data.outputImages || [])[0])),
        status: n.data && n.data.status,
        selected: !!n.selected,
        x: Math.round(n.position.x),
        y: Math.round(n.position.y),
      };
    });
    var edges = (snap.edges || []).map(function (e2) { return e2.source + "->" + e2.target; });
    var sel = (snap.nodes || []).filter(function (n) { return n.selected; }).map(function (n) { return n.id; });
    return JSON.stringify({ nodes: nodes, connections: edges, selectedNodes: sel });
  }

  /* ---------- Conversation Context（长对话自动压缩） ---------- */
  function trimmed() {
    if (messages.length <= 14) return messages;
    return [messages[0], { role: "system", content: "(更早的对话已省略，只保留用户目标与最近上下文)" }].concat(messages.slice(-12));
  }
  function buildMessages(skill) {
    var sys = [
      "你是无限画布应用的 AI Agent，用中文简洁回答，帮助用户在画布上生成图片/视频、组织节点。",
      "可用技能：图片分析、提示词优化、创建图片生成节点、创建视频生成节点、节点连接、运行节点、结果检查。",
      "节点规则：用户明确说图片节点1/文本节点2等名称时，使用 updateNode 修改该节点；没有明确指定节点时创建新节点。除非用户明确要求自动排版，否则绝不输出或执行 layout。",
      "参数规则：图片节点二级菜单使用 model、ratio、quality；兼容 aspectRatio/比例 -> ratio，resolution/清晰度 -> quality。例如 1280x720 转为 ratio 16:9，2K/高清转为 quality 2k。视频节点使用 model、size、duration。保留用户明确说出的 prompt。",
      "多步骤任务必须把用户要求的全部动作一次性输出；动作会按顺序执行，并等待每个生成任务真正完成后再继续，全部动作完成前不要声称任务已完成。",
      "节点运行失败时，允许自动重新提交 1 次；若第 2 次仍失败，必须停止依赖该节点的后续动作并报告失败原因。",
      "当前画布状态 canvasState / 当前选中节点 selectedNodes / 当前任务记录 currentTask：",
      canvasSummary(),
      "currentTask：" + JSON.stringify(taskLog.slice(-6)),
      "需要操作画布时，在回复中输出一个 json 代码块，格式：",
      '```json\n{"actions":[{"action":"createNode","type":"generateNode","prompt":"画面提示词","ratio":"16:9","quality":"2k","model":"模型名","run":true},{"action":"updateNode","node":"图片节点1","data":{"ratio":"16:9","quality":"2k","model":"模型名"}},{"action":"connect","from":"new","to":"节点id"},{"action":"runNode","id":"节点id"}]}\n```',
      '说明：createNode 的 type 可选 generateNode/videoNode/textNode；createNode 和 updateNode 都可接收 prompt、model、ratio、quality、size、duration、count；run:true 表示创建后立即运行；connect 的 from/to 可用 "new" 指代刚创建的节点；只有用户明确要求自动排版时才使用 layout。',
      "除 json 外，用一两句中文说明你做了什么。",
    ].join("\n");
    var list = [{ role: "system", content: sys }];
    if (skill && skill.hint) list.push({ role: "system", content: "【技能指令】" + skill.hint });
    return list.concat(trimmed());
  }

  /* ---------- Agent Controller：解析并执行动作 ---------- */
  function extractActions(text) {
    var out = { text: text, actions: [] };
    var j = null;
    var fence = /```json([\s\S]*?)```/i.exec(text) || /```([\s\S]*?)```/.exec(text);
    if (fence) { try { j = JSON.parse(fence[1].trim()); } catch (e) {} }
    if (!j) {
      var m2 = /\{[\s\S]*"actions"[\s\S]*\}/.exec(text);
      if (m2) { try { j = JSON.parse(m2[0]); } catch (e) {} }
    }
    if (j && Array.isArray(j.actions)) {
      out.actions = j.actions;
      out.text = text.replace(/```json[\s\S]*?```/i, "").replace(/```[\s\S]*?```/, "").trim();
    }
    return out;
  }

  function autoPosition() {
    var b = bridge();
    var snap = b && b.get();
    var nodes = (snap && snap.nodes) || [];
    if (!nodes.length) return { x: 120, y: 120 };
    var sel = nodes.filter(function (n) { return n.selected; });
    var base = sel.length ? sel[sel.length - 1] : nodes[nodes.length - 1];
    return { x: base.position.x + 380, y: base.position.y };
  }

  function resolveNodeId(ref) {
    var b = bridge();
    var nodes = (b && b.get().nodes) || [];
    var value = String(ref == null ? "" : ref).trim();
    var exact = nodes.filter(function (n) {
      return n.id === value || (n.data && n.data.title === value);
    })[0];
    if (exact) return exact.id;
    var number = /^(图片|文本|视频|RunningHub)(?:节点)?\s*(\d+)$/i.exec(value);
    if (number) {
      var label = number[1].toLowerCase();
      var index = Number(number[2]);
      var sameType = nodes.filter(function (n) {
        return ({ 图片: "generateNode", 文本: "textNode", 视频: "videoNode", runninghub: "runningHubNode" })[label] === n.type;
      });
      return sameType[index - 1] && sameType[index - 1].id;
    }
    return value;
  }

  function actionData(action) {
    var data = Object.assign({}, action.data || action.patch || {});
    ["title", "prompt", "model", "ratio", "quality", "size", "duration", "count"].forEach(function (key) {
      if (action[key] != null) data[key] = action[key];
    });
    [["aspectRatio", "ratio"], ["比例", "ratio"], ["resolution", "quality"], ["清晰度", "quality"], ["modelName", "model"]].forEach(function (pair) {
      if (data[pair[0]] != null && data[pair[1]] == null) data[pair[1]] = data[pair[0]];
    });
    if (data.ratio != null) data.ratio = String(data.ratio).replace(/\s+/g, "");
    if (data.quality != null) data.quality = String(data.quality).toLowerCase().replace(/[高清晰度]/g, "");
    return data;
  }

  function layoutNodes() {
    var b = bridge();
    var snap = b.get();
    var order = ["generateNode", "videoNode", "runningHubNode", "textNode", "imageNode"];
    var x = 60;
    order.forEach(function (t) {
      var y = 80;
      (snap.nodes || []).filter(function (n) { return n.type === t; }).forEach(function (n) {
        b.actions.moveNode(n.id, x, y);
        y += 440;
      });
      x += 380;
    });
  }

  async function runNodeWithRetry(id, b, results) {
    var runResult = await b.actions.runNode(id);
    if (runResult && runResult.ok === false) {
      results.push("第 1 次运行失败：" + (runResult.error || "未知错误"));
      results.push("重试第 2 次（最多自动重试 1 次）");
      runResult = await b.actions.runNode(id);
    }
    if (runResult && runResult.ok === false) {
      throw new Error("第 2 次运行仍失败：" + (runResult.error || "未知错误"));
    }
    return runResult;
  }

  async function execActions(actions) {
    var b = bridge();
    var results = [];
    var newId = null;
    for (const a of actions || []) {
      try {
        if (a.action === "createNode") {
          var made = b.actions.createNode({
            type: a.type,
            position: a.position || autoPosition(),
            data: actionData(a),
          });
          newId = made && made.id ? made.id : made;
          if (made && made.error) throw new Error(made.error);
          results.push("已创建 " + (a.type || "generateNode") + " 节点");
          if (a.run && b.actions.runNode) {
            await runNodeWithRetry(newId, b, results);
            results.push("已完成运行");
          }
        } else if (a.action === "updateNode") {
          var targetId = resolveNodeId(a.id || a.node || a.target);
          if (!targetId) throw new Error("未找到要修改的节点");
          if (!b.actions.updateNode) throw new Error("画布不支持修改节点");
          b.actions.updateNode(targetId, actionData(a));
          results.push("已修改 " + targetId);
        } else if (a.action === "connect") {
          var from = a.from === "new" ? newId : a.from;
          var to = a.to === "new" ? newId : a.to;
          if (from && to && from !== to) {
            b.actions.connect(from, to);
            results.push("已连接 " + from + " → " + to);
          }
        } else if (a.action === "runNode") {
          var id = a.id === "new" ? newId : resolveNodeId(a.id || a.node || a.target);
          await runNodeWithRetry(id, b, results);
          results.push("已完成运行 " + id);
        } else if (a.action === "moveNode") {
          b.actions.moveNode(a.id, a.x, a.y);
          results.push("已移动 " + a.id);
        } else if (a.action === "layout") {
          layoutNodes();
          results.push("已自动排版");
        } else if (a.action === "optimizePrompt") {
          results.push("提示词：" + (a.prompt || ""));
        } else {
          results.push("未知动作：" + (a.action || "?"));
        }
      } catch (e) {
        results.push("执行失败：" + ((e && e.message) || e));
      }
    }
    taskLog.push({ time: new Date().toLocaleTimeString(), text: results.join("；") });
    if (taskLog.length > 8) taskLog = taskLog.slice(-8);
    return results;
  }

  /* ---------- UI ---------- */
  var ROBOT_SVG =
    '<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<rect x="7" y="11" width="34" height="30" rx="10" stroke="#fff" stroke-width="4"/>' +
    '<rect x="16" y="21" width="5.5" height="11" rx="2.75" fill="#fff"/>' +
    '<rect x="26.5" y="21" width="5.5" height="11" rx="2.75" fill="#fff"/>' +
    '<rect x="37" y="5" width="8" height="8" rx="2.5" fill="#fff"/>' +
    "</svg>";
  function build() {
    if ($("#ai2-agent-root")) return;
    var root = document.createElement("div");
    root.id = "ai2-agent-root";
    root.innerHTML =
      '<button id="ai2-agent-fab" title="AI Agent">' + ROBOT_SVG + "</button>" +
      '<div id="ai2-agent-panel">' +
      '<div class="ai2-agent-head"><div><b>Agent</b><span>当前对话 + 画布上下文</span></div>' +
      '<div class="ai2-agent-head-btns"><button class="ai2-agent-mini" data-clear>清空</button>' +
      '<button class="ai2-agent-mini" data-close>×</button></div></div>' +
      '<div id="ai2-agent-msgs"></div>' +
      '<div class="ai2-agent-inputwrap">' +
      '<textarea id="ai2-agent-input" rows="2" placeholder="告诉 Agent 你想做什么，例如：把这张图生成三个场景"></textarea>' +
      '<div class="ai2-agent-toolbar"></div>' +
      "</div></div></div>";
    document.body.appendChild(root);
    SKILLS.forEach(function (s2) {
      /* 技能列表由 renderToolbar 渲染 */
    });
    $("#ai2-agent-fab").onclick = toggle;
    $('[data-close]').onclick = toggle;
    $('[data-clear]').onclick = function () {
      messages = [];
      taskLog = [];
      saveSession();
      renderMsgs();
    };
    var toolbar = $(".ai2-agent-toolbar");
    toolbar.addEventListener("click", function (e) {
      var item = e.target.closest(".ai2-dd-item");
      if (item) {
        var ddEl = item.closest("[data-dd]");
        selState[ddEl.getAttribute("data-dd")] = item.getAttribute("data-v");
        ddOpen = null;
        savePref();
        renderToolbar();
        return;
      }
      var pillEl = e.target.closest("[data-dd]");
      if (pillEl) {
        var id = pillEl.getAttribute("data-dd");
        ddOpen = ddOpen === id ? null : id;
        renderToolbar();
        return;
      }
      if (e.target.closest("#ai2-agent-send")) send();
    });
    document.addEventListener("pointerdown", function (e) {
      if (!ddOpen) return;
      var inPill = e.target.closest && e.target.closest(".ai2-agent-pill");
      if (!inPill) {
        ddOpen = null;
        renderToolbar();
      }
    });
    $("#ai2-agent-input").addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
    });
  }

  function toggle() {
    panelOpen = !panelOpen;
    build();
    var p = $("#ai2-agent-panel");
    p.classList.toggle("is-open", panelOpen);
    if (panelOpen) {
      renderToolbar();
      renderMsgs();
      var ta = $("#ai2-agent-input");
      setTimeout(function () { ta && ta.focus(); }, 240);
    }
  }

  function toolbarData() {
    var b = bridge();
    var settings = (b && b.get().settings) || {};
    var plats = settings.platforms || [];
    var pref = loadPref();
    var apiId = selState.api;
    if (!apiId || !plats.some(function (p) { return p.id === apiId; })) {
      apiId = pref.api && plats.some(function (p) { return p.id === pref.api; })
        ? pref.api
        : settings.activePlatformId && plats.some(function (p) { return p.id === settings.activePlatformId; })
          ? settings.activePlatformId
          : (plats.filter(function (p) { return p.apiKey; })[0] || plats[0] || {}).id || "";
      selState.api = apiId;
    }
    var plat = plats.filter(function (p) { return p.id === apiId; })[0];
    var models = plat ? plat.customTextModels || plat.textModels || [] : [];
    if (!selState.model || models.indexOf(selState.model) === -1) {
      selState.model = pref.model && models.indexOf(pref.model) !== -1
        ? pref.model
        : settings.defaultTextModel && models.indexOf(settings.defaultTextModel) !== -1
          ? settings.defaultTextModel
          : models[0] || "";
    }
    if (!SKILLS.some(function (s2) { return s2.id === selState.skill; })) selState.skill = "auto";
    return { settings: settings, plats: plats, models: models };
  }

  function renderToolbar() {
    var wrap = $(".ai2-agent-toolbar");
    if (!wrap) return;
    var d = toolbarData();
    function pill(id, label, val, opts) {
      var list = opts.map(function (o) {
        return '<button type="button" class="ai2-dd-item' + (o.v === val ? " on" : "") + '" data-v="' + esc(o.v) + '">' + esc(o.n) + "</button>";
      }).join("");
      return '<label class="ai2-agent-pill" data-dd="' + id + '">' +
        '<span class="ai2-agent-pill-label">' + label + '</span>' +
        '<span class="ai2-agent-pill-val">' + esc(val || "请选择") + '</span>' +
        '<span class="ai2-agent-pill-arrow">▾</span>' +
        (ddOpen === id ? '<div class="ai2-agent-dd">' + list + "</div>" : "") +
        "</label>";
    }
    var apiPlat = d.plats.filter(function (p) { return p.id === selState.api; })[0];
    var skill = SKILLS.filter(function (s2) { return s2.id === selState.skill; })[0];
    wrap.innerHTML =
      pill("api", "API", apiPlat ? apiPlat.name || apiPlat.id : "", d.plats.map(function (p) { return { v: p.id, n: p.name || p.id }; })) +
      pill("model", "模型", selState.model, d.models.map(function (m2) { return { v: m2, n: m2 }; })) +
      pill("skill", "技能", skill ? skill.name : "", SKILLS.map(function (s2) { return { v: s2.id, n: s2.name }; })) +
      '<button id="ai2-agent-send" title="发送">➤</button>';
  }

  function renderMsgs() {
    var box = $("#ai2-agent-msgs");
    if (!box) return;
    box.innerHTML = messages.length
      ? messages.map(function (m2) {
          var details = Array.isArray(m2.details) && m2.details.length
            ? '<details class="ai2-agent-thinking"><summary>思考过程</summary><div class="ai2-agent-thinking-body">' +
              m2.details.map(function (item) { return '<div>' + esc(item) + '</div>'; }).join("") +
              "</div></details>"
            : "";
          return '<div class="ai2-agent-msg ' + esc(m2.role) + (m2.thinking ? ' thinking' : '') + '"><div class="ai2-agent-bubble">' +
            esc(m2.content).replace(/\n/g, "<br>") + details + "</div></div>";
        }).join("")
      : '<div class="ai2-agent-empty">和 Agent 说说你想做什么。它会读取当前画布，直接创建节点、连线并运行。</div>';
    box.scrollTop = box.scrollHeight;
  }

  function setSending(on) {
    var b2 = $("#ai2-agent-send");
    if (b2) { b2.disabled = on; b2.textContent = on ? "…" : "➤"; }
  }

  function proxyWrap(u) {
    var local = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/i.test(location.hostname);
    return !local && location.protocol.indexOf("http") === 0 && /^https?:/i.test(u)
      ? "/api/proxy?url=" + encodeURIComponent(u)
      : u;
  }

  function pushMsg(role, content, meta) {
    messages.push(Object.assign({ role: role, content: content }, meta || {}));
    saveSession();
    renderMsgs();
  }

  async function send() {
    var ta = $("#ai2-agent-input");
    var text = ta.value.trim();
    if (!text || busy) return;
    var b = bridge();
    if (!b || !b.actions) { pushMsg("assistant", "❌ 画布尚未就绪，请稍后再试。"); return; }
    var settings = (b.get().settings) || {};
    toolbarData();
    var plat = (settings.platforms || []).find(function (p) { return p.id === selState.api; });
    var model = selState.model;
    var skill = SKILLS.find(function (s2) { return s2.id === selState.skill; }) || SKILLS[0];
    if (!plat || !plat.apiKey) { pushMsg("assistant", "❌ 请先在「API 设置」选择平台并填写 API 密钥。"); return; }
    if (!model) { pushMsg("assistant", "❌ 当前平台没有文本模型，请先在「API 设置」里添加。"); return; }

    messages.push({ role: "user", content: text });
    saveSession();
    renderMsgs();
    ta.value = "";
    busy = true;
    setSending(true);
    pushMsg("assistant", "正在思考…", { thinking: true });
    try {
      var res = await fetch(proxyWrap(plat.baseUrl.replace(/\/+$/, "") + "/chat/completions"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + plat.apiKey },
        body: JSON.stringify({ model: model, stream: false, messages: buildMessages(skill) }),
      });
      var raw = await res.text();
      var data;
      try { data = JSON.parse(raw); } catch (e) { throw new Error("返回无法解析：" + raw.slice(0, 200)); }
      if (!res.ok) throw new Error((data && data.error && data.error.message) || "HTTP " + res.status);
      var ch = data.choices && data.choices[0];
      var content = (ch && ((ch.message && ch.message.content) || ch.text)) || "";
      var parsed = extractActions(typeof content === "string" ? content : JSON.stringify(content));
      var allowLayout = /自动排版|整理画布布局|排版/.test(text);
      var executableActions = parsed.actions.filter(function (action) {
        return action.action !== "layout" || allowLayout;
      });
      var results = await execActions(executableActions);
      var reply = (parsed.text || "已完成。") + (results.length ? "\n✅ " + results.join("；") : "");
      messages[messages.length - 1] = {
        role: "assistant",
        content: reply,
        details: [
          "已收到模型回复",
          executableActions.length ? "已按顺序执行画布动作" : "没有需要执行的画布动作",
        ].concat(results),
      };
      saveSession();
      renderMsgs();
    } catch (e) {
      messages[messages.length - 1] = {
        role: "assistant",
        content: "❌ " + ((e && e.message) || e),
        details: ["处理失败：" + ((e && e.message) || e)],
      };
      saveSession();
      renderMsgs();
    } finally {
      busy = false;
      setSending(false);
    }
  }

  function init() {
    build();
    loadSession();
    renderMsgs();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
