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
    try {
      sessionStorage.setItem(PREF_KEY, JSON.stringify({
        api: $("#ai2-agent-api") ? $("#ai2-agent-api").value : "",
        model: $("#ai2-agent-model") ? $("#ai2-agent-model").value : "",
        skill: $("#ai2-agent-skill") ? $("#ai2-agent-skill").value : "auto",
      }));
    } catch (e) {}
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
      "可用技能：图片分析、提示词优化、创建图片生成节点、创建视频生成节点、节点连接、画布排版、运行节点、结果检查。",
      "当前画布状态 canvasState / 当前选中节点 selectedNodes / 当前任务记录 currentTask：",
      canvasSummary(),
      "currentTask：" + JSON.stringify(taskLog.slice(-6)),
      "需要操作画布时，在回复中输出一个 json 代码块，格式：",
      '```json\n{"actions":[{"action":"createNode","type":"generateNode","prompt":"画面提示词","run":true},{"action":"connect","from":"new","to":"节点id"},{"action":"layout"},{"action":"runNode","id":"节点id"}]}\n```',
      '说明：createNode 的 type 可选 generateNode/videoNode/textNode；run:true 表示创建后立即运行；connect 的 from/to 可用 "new" 指代刚创建的节点；layout 表示自动排版全部节点。',
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

  function execActions(actions) {
    var b = bridge();
    var results = [];
    var newId = null;
    (actions || []).forEach(function (a) {
      try {
        if (a.action === "createNode") {
          var made = b.actions.createNode({
            type: a.type,
            position: a.position || autoPosition(),
            data: a.data || (a.prompt != null ? { prompt: a.prompt } : {}),
          });
          newId = made && made.id ? made.id : made;
          if (made && made.error) throw new Error(made.error);
          results.push("已创建 " + (a.type || "generateNode") + " 节点");
          if (a.run && b.actions.runNode) {
            setTimeout(function () {
              b.actions.runNode(newId);
            }, 200);
            results.push("已开始运行");
          }
        } else if (a.action === "connect") {
          var from = a.from === "new" ? newId : a.from;
          var to = a.to === "new" ? newId : a.to;
          if (from && to && from !== to) {
            b.actions.connect(from, to);
            results.push("已连接 " + from + " → " + to);
          }
        } else if (a.action === "runNode") {
          var id = a.id === "new" ? newId : a.id;
          b.actions.runNode(id);
          results.push("已运行 " + id);
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
    });
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
      '<div class="ai2-agent-toolbar">' +
      '<label class="ai2-agent-pill">API<select id="ai2-agent-api"></select></label>' +
      '<label class="ai2-agent-pill">模型<select id="ai2-agent-model"></select></label>' +
      '<label class="ai2-agent-pill">技能<select id="ai2-agent-skill"></select></label>' +
      '<button id="ai2-agent-send" title="发送">➤</button>' +
      "</div></div></div>";
    document.body.appendChild(root);
    SKILLS.forEach(function (s2) {
      var o = document.createElement("option");
      o.value = s2.id;
      o.textContent = s2.name;
      $("#ai2-agent-skill").appendChild(o);
    });
    $("#ai2-agent-fab").onclick = toggle;
    $('[data-close]').onclick = toggle;
    $('[data-clear]').onclick = function () {
      messages = [];
      taskLog = [];
      saveSession();
      renderMsgs();
    };
    $("#ai2-agent-send").onclick = send;
    $("#ai2-agent-api").onchange = function () { fillModels(); savePref(); };
    $("#ai2-agent-model").onchange = savePref;
    $("#ai2-agent-skill").onchange = savePref;
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
      refreshSelects();
      renderMsgs();
      var ta = $("#ai2-agent-input");
      setTimeout(function () { ta && ta.focus(); }, 240);
    }
  }

  function refreshSelects() {
    var b = bridge();
    var settings = (b && b.get().settings) || {};
    var plats = settings.platforms || [];
    var pref = loadPref();
    var api = $("#ai2-agent-api");
    api.innerHTML = plats.length
      ? plats.map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.name || p.id) + "</option>"; }).join("")
      : '<option value="">未配置平台</option>';
    var chosen = "";
    if (pref.api && plats.some(function (p) { return p.id === pref.api; })) chosen = pref.api;
    else if (settings.activePlatformId && plats.some(function (p) { return p.id === settings.activePlatformId; })) chosen = settings.activePlatformId;
    else {
      var withKey = null;
      plats.forEach(function (p) { if (!withKey && p.apiKey) withKey = p; });
      chosen = withKey ? withKey.id : plats.length ? plats[0].id : "";
    }
    api.value = chosen;
    fillModels();
    if (pref.skill) $("#ai2-agent-skill").value = pref.skill;
  }

  function fillModels() {
    var b = bridge();
    var settings = (b && b.get().settings) || {};
    var plat = (settings.platforms || []).find(function (p) { return p.id === $("#ai2-agent-api").value; });
    var models = plat ? plat.customTextModels || plat.textModels || [] : [];
    var sel = $("#ai2-agent-model");
    sel.innerHTML = models.length
      ? models.map(function (m) { return '<option value="' + esc(m) + '">' + esc(m) + "</option>"; }).join("")
      : '<option value="">无文本模型</option>';
    var pref = loadPref();
    if (pref.model && models.indexOf(pref.model) !== -1) sel.value = pref.model;
    else if (settings.defaultTextModel && models.indexOf(settings.defaultTextModel) !== -1) sel.value = settings.defaultTextModel;
  }

  function renderMsgs() {
    var box = $("#ai2-agent-msgs");
    if (!box) return;
    box.innerHTML = messages.length
      ? messages.map(function (m2) {
          return '<div class="ai2-agent-msg ' + esc(m2.role) + '"><div class="ai2-agent-bubble">' +
            esc(m2.content).replace(/\n/g, "<br>") + "</div></div>";
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

  function pushMsg(role, content) {
    messages.push({ role: role, content: content });
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
    var plat = (settings.platforms || []).find(function (p) { return p.id === $("#ai2-agent-api").value; });
    var model = $("#ai2-agent-model").value;
    var skill = SKILLS.find(function (s2) { return s2.id === $("#ai2-agent-skill").value; }) || SKILLS[0];
    if (!plat || !plat.apiKey) { pushMsg("assistant", "❌ 请先在「API 设置」选择平台并填写 API 密钥。"); return; }
    if (!model) { pushMsg("assistant", "❌ 当前平台没有文本模型，请先在「API 设置」里添加。"); return; }

    messages.push({ role: "user", content: text });
    saveSession();
    renderMsgs();
    ta.value = "";
    busy = true;
    setSending(true);
    pushMsg("assistant", "…思考中");
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
      var results = execActions(parsed.actions);
      var reply = (parsed.text || "已完成。") + (results.length ? "\n✅ " + results.join("；") : "");
      messages[messages.length - 1] = { role: "assistant", content: reply };
      saveSession();
      renderMsgs();
    } catch (e) {
      messages[messages.length - 1] = { role: "assistant", content: "❌ " + ((e && e.message) || e) };
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
