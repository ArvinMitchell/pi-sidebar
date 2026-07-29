/* Pi Sidebar 侧边栏逻辑：WebSocket 客户端 + 聊天 UI + 页面内容提取 */

const WS_URL = "ws://127.0.0.1:43118";
const RECONNECT_MS = 3000;

const chatEl = document.getElementById("chat");
const inputEl = document.getElementById("input");
const statusEl = document.getElementById("status");
const btnSend = document.getElementById("btn-send");
const btnSummarize = document.getElementById("btn-summarize");
let isStreaming = false;

const SEND_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>';
const STOP_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="5" y="5" rx="2"/></svg>';

// 流式回复时发送按钮变停止按钮（ChatGPT 同款交互）
function updateSendButton() {
  btnSend.classList.toggle("stop", isStreaming);
  btnSend.innerHTML = isStreaming ? STOP_ICON : SEND_ICON;
  btnSend.title = isStreaming ? "中断当前回复" : "发送";
}
const btnNew = document.getElementById("btn-new");
const modelSelect = document.getElementById("model-select");
const thinkingSelect = document.getElementById("thinking-select");
const btnTheme = document.getElementById("btn-theme");
const btnHistory = document.getElementById("btn-history");
const historyPanel = document.getElementById("history-panel");

// ---------------------------------------------------------------------------
// 主题：跟随系统 / 日间 / 夜间（记忆在 localStorage）
// ---------------------------------------------------------------------------

const THEME_MODES = ["system", "light", "dark"];
const svg = (inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const THEME_META = {
  system: { icon: svg('<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>'), label: "跟随系统" },
  light: { icon: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>'), label: "日间模式" },
  dark: { icon: svg('<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/>'), label: "夜间模式" },
};
let themeMode = localStorage.getItem("pi-sidebar-theme") || "system";

function applyTheme() {
  document.documentElement.dataset.theme = themeMode;
  const meta = THEME_META[themeMode];
  btnTheme.innerHTML = meta.icon;
  btnTheme.title = `主题：${meta.label}（点击切换）`;
}

btnTheme.addEventListener("click", () => {
  const next = (THEME_MODES.indexOf(themeMode) + 1) % THEME_MODES.length;
  themeMode = THEME_MODES[next];
  localStorage.setItem("pi-sidebar-theme", themeMode);
  applyTheme();
});

applyTheme();

let ws = null;
let currentAssistantEl = null; // 正在流式输出的气泡

// ---------------------------------------------------------------------------
// WebSocket 连接（断线自动重连）
// ---------------------------------------------------------------------------

function connect() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => setStatus(true);

  ws.onclose = () => {
    setStatus(false);
    ws = null;
    setTimeout(connect, RECONNECT_MS);
  };

  ws.onerror = () => ws.close();

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    handleBridgeMessage(msg);
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
    return true;
  }
  addMessage("error", "Bridge 未连接。请先在终端运行：cd ~/pi-sidebar/bridge && npm start");
  return false;
}

function setStatus(connected) {
  statusEl.textContent = connected ? "已连接" : "未连接";
  statusEl.className = "status " + (connected ? "connected" : "disconnected");
}

// ---------------------------------------------------------------------------
// Bridge 消息处理
// ---------------------------------------------------------------------------

function handleBridgeMessage(msg) {
  switch (msg.type) {
    case "status":
      isStreaming = !!msg.streaming;
      updateSendButton();
      if (msg.streaming) ensureAssistantBubble();
      else finishToolStatus();
      break;

    case "delta":
      ensureAssistantBubble();
      appendDelta(msg.text);
      break;

    case "end":
      // 注意：工具调用回合中也会收到 end（含 toolCall 的消息结束），
      // 不能在这里结束流式状态；streaming 只由 status 消息驱动
      finalizeAssistantBubble();
      break;

    case "notice":
      addMessage("notice", msg.message);
      break;

    case "tool":
      if (msg.status === "start") showToolStart(msg.tool);
      break;

    case "error":
      addMessage("error", msg.message);
      isStreaming = false;
      updateSendButton();
      break;

    case "config":
      applyConfig(msg);
      break;

    case "history":
      renderHistory(msg.messages || []);
      break;

    case "sessions":
      renderSessionList(msg.sessions || []);
      break;
  }
}

// ---------------------------------------------------------------------------
// 历史会话
// ---------------------------------------------------------------------------

function renderHistory(messages) {
  chatEl.innerHTML = "";
  currentAssistantEl = null;
  for (const m of messages) {
    if (m.role === "user") {
      addMessage("user", m.text);
    } else {
      const el = addMessage("assistant", "");
      el.dataset.raw = m.text;
      renderBubble(el);
    }
  }
  scrollToBottom();
}

function formatTime(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderSessionList(sessions) {
  historyPanel.innerHTML = "";
  if (!sessions.length) {
    historyPanel.innerHTML = '<div class="history-empty">暂无历史会话</div>';
    return;
  }
  for (const s of sessions) {
    const item = document.createElement("div");
    item.className = "history-item";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = s.title;
    const date = document.createElement("div");
    date.className = "date";
    date.textContent = formatTime(s.mtime);
    item.append(title, date);
    item.addEventListener("click", () => {
      closeHistoryPanel();
      send({ type: "switch_session", path: s.path });
    });
    historyPanel.appendChild(item);
  }
}

function closeHistoryPanel() {
  historyPanel.classList.remove("open");
}

btnHistory.addEventListener("click", (e) => {
  e.stopPropagation();
  if (historyPanel.classList.contains("open")) {
    closeHistoryPanel();
  } else {
    historyPanel.classList.add("open");
    historyPanel.innerHTML = '<div class="history-empty">加载中…</div>';
    send({ type: "list_sessions" });
  }
});

document.addEventListener("click", (e) => {
  if (!historyPanel.contains(e.target)) closeHistoryPanel();
});

// ---------------------------------------------------------------------------
// 模型 / 思考水平选择
// ---------------------------------------------------------------------------

// 思考水平标签
const THINKING_LABELS = {
  off: "不思考", minimal: "极简", low: "低", medium: "中",
  high: "高", xhigh: "超高", max: "最高",
};

function applyConfig(cfg) {
  // 模型下拉
  modelSelect.innerHTML = "";
  const currentKey = cfg.currentModel
    ? `${cfg.currentModel.provider}/${cfg.currentModel.id}`
    : null;
  for (const m of cfg.models || []) {
    const key = `${m.provider}/${m.id}`;
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = m.name === m.id ? key : `${m.name} (${m.provider})`;
    if (key === currentKey) opt.selected = true;
    modelSelect.appendChild(opt);
  }
  modelSelect.disabled = !(cfg.models || []).length;

  // 思考水平下拉：如实显示当前模型支持的全部档位
  thinkingSelect.innerHTML = "";
  const shown = cfg.thinkingLevels || [];
  for (const lv of shown) {
    const opt = document.createElement("option");
    opt.value = lv;
    opt.textContent = `思考: ${THINKING_LABELS[lv] || lv}`;
    if (lv === cfg.currentThinking) opt.selected = true;
    thinkingSelect.appendChild(opt);
  }
  thinkingSelect.disabled = !shown.length;
}

modelSelect.addEventListener("change", () => {
  const [provider, ...rest] = modelSelect.value.split("/");
  const modelId = rest.join("/");
  if (provider && modelId) send({ type: "set_model", provider, modelId });
});

thinkingSelect.addEventListener("change", () => {
  send({ type: "set_thinking_level", level: thinkingSelect.value });
});

// ---------------------------------------------------------------------------
// 聊天 UI
// ---------------------------------------------------------------------------

function addMessage(role, text) {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.textContent = text;
  chatEl.appendChild(el);
  scrollToBottom();
  return el;
}

// 工具调用状态行：原地更新，不刷屏；回合结束合并成一行汇总
let toolStatusEl = null;
const toolCounts = new Map();

function showToolStart(name) {
  toolCounts.set(name, (toolCounts.get(name) || 0) + 1);
  if (!toolStatusEl) {
    toolStatusEl = document.createElement("div");
    toolStatusEl.className = "msg tool-status";
    chatEl.appendChild(toolStatusEl);
  }
  toolStatusEl.textContent = `⚙ ${name} …`;
  scrollToBottom();
}

function finishToolStatus() {
  if (!toolStatusEl) return;
  const total = [...toolCounts.values()].reduce((a, b) => a + b, 0);
  const parts = [...toolCounts.entries()]
    .map(([n, c]) => (c > 1 ? `${n} ×${c}` : n))
    .join("、");
  toolStatusEl.textContent = `⚙ 使用了 ${total} 次工具：${parts}`;
  toolStatusEl.classList.add("done");
  toolStatusEl = null;
  toolCounts.clear();
}

function ensureAssistantBubble() {
  if (!currentAssistantEl) {
    currentAssistantEl = addMessage("assistant", "");
  }
}

function appendDelta(text) {
  if (!currentAssistantEl) return;
  currentAssistantEl.dataset.raw = (currentAssistantEl.dataset.raw || "") + text;
  renderBubble(currentAssistantEl);
  scrollToBottom();
}

function finalizeAssistantBubble() {
  if (currentAssistantEl && !currentAssistantEl.dataset.raw) {
    currentAssistantEl.remove();
  }
  currentAssistantEl = null;
}

function scrollToBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

// 轻量 markdown 渲染：先整体转义 HTML，再还原 markdown 结构，保证模型输出里的 HTML 不会注入
function renderBubble(el) {
  el.innerHTML = renderMarkdown(el.dataset.raw || "");
}

function renderMarkdown(raw) {
  // 1. 先抽出代码块，避免里面的字符被后续规则误伤
  const codeBlocks = [];
  const text = raw.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, _lang, code) => {
    codeBlocks.push(code.replace(/\n$/, ""));
    return `\u0000CODE${codeBlocks.length - 1}\u0000`;
  });

  let html = escapeHtml(text);

  // 2. 行内代码同样抽出占位
  const inlineCodes = [];
  html = html.replace(/`([^`\n]+)`/g, (_, c) => {
    inlineCodes.push(c);
    return `\u0000IC${inlineCodes.length - 1}\u0000`;
  });

  // 3. 标题 / 粗体 / 斜体 / 链接
  html = html.replace(/^#{1,6}\s+(.+)$/gm, '<strong class="md-h">$1</strong>');
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
  html = html.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  // 4. 列表：连续的 "- / * / 1." 行包成 ul/ol
  html = html.replace(/((?:^[ \t]*(?:[-*]|\d+\.)[ \t]+.+(?:\n|$))+)/gm, (block) => {
    const ordered = /^\s*\d+\./.test(block);
    const items = block.trimEnd().split("\n").map((line) =>
      `<li>${line.replace(/^[ \t]*(?:[-*]|\d+\.)[ \t]+/, "")}</li>`).join("");
    return ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`;
  });

  // 5. 换行
  html = html.replace(/\n/g, "<br>");

  // 6. 还原代码（此时才转义代码内容）
  html = html.replace(/\u0000IC(\d+)\u0000/g, (_, i) => `<code>${inlineCodes[i]}</code>`);
  html = html.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => `<pre><code>${escapeHtml(codeBlocks[i])}</code></pre>`);

  return html;
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// 页面内容提取（注入到当前标签页执行）
// ---------------------------------------------------------------------------

function extractPageContent() {
  const selection = window.getSelection()?.toString().trim();
  const container =
    document.querySelector("article, main, [role='main']") || document.body;
  let text = (selection || container?.innerText || "").trim();
  text = text.replace(/\n{3,}/g, "\n\n").slice(0, 20000);
  return { title: document.title, url: location.href, text };
}

async function getActiveTabContent() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("找不到当前标签页");

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: extractPageContent,
  });
  if (!result?.result) throw new Error("未能提取页面内容");
  return result.result;
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------

function sendChat() {
  const text = inputEl.value.trim();
  if (!text) return;
  if (!send({ type: "prompt", text })) return;
  addMessage("user", text);
  inputEl.value = "";
  inputEl.focus();
}

btnSend.addEventListener("click", () => {
  if (isStreaming) {
    send({ type: "abort" });
    isStreaming = false;
    updateSendButton();
  } else {
    sendChat();
  }
});

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendChat();
  }
});

btnSummarize.addEventListener("click", async () => {
  try {
    const page = await getActiveTabContent();
    if (!page.text) {
      addMessage("error", "页面没有可提取的文本内容");
      return;
    }
    if (!send({ type: "summarize", page })) return;
    addMessage("user", `📄 总结本页：${page.title}`);
  } catch (err) {
    addMessage("error", `提取页面失败：${err.message}（chrome:// 等系统页面不支持提取）`);
  }
});


btnNew.addEventListener("click", () => {
  if (!send({ type: "new_session" })) return;
  chatEl.innerHTML = "";
  currentAssistantEl = null;
  addMessage("notice", "已开始新会话");
});

// ---------------------------------------------------------------------------
// 语音输入（Chrome 内置语音识别）
// ---------------------------------------------------------------------------

const btnMic = document.getElementById("btn-mic");
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let recording = false;
let voiceBaseText = ""; // 开始录音时输入框已有的文本

if (!SpeechRecognition) {
  btnMic.disabled = true;
  btnMic.title = "当前浏览器不支持语音识别";
}

function setRecordingState(on) {
  recording = on;
  btnMic.classList.toggle("recording", on);
  btnMic.title = on ? "点击停止录音" : "语音输入";
}

function openMicPermissionPage() {
  chrome.tabs.create({ url: chrome.runtime.getURL("mic-permission.html") });
  addMessage("notice", "已打开麦克风授权页，授权成功后回来再点一次 🎤");
}

async function createRecognition() {
  // 优先使用 Chrome 139+ 的本地语音识别（不依赖网络服务，扩展页面里更可靠）
  if (typeof SpeechRecognition.available === "function") {
    try {
      const opts = { langs: ["zh-CN"], processLocally: true };
      const status = await SpeechRecognition.available(opts);
      if (status === "downloadable" || status === "downloading") {
        addMessage("notice", "首次使用需下载本地语音识别模型，请稍候…");
        await SpeechRecognition.install(opts);
      }
      if (status !== "unavailable") {
        addMessage("notice", "使用 Chrome 本地语音识别（离线）");
        return new SpeechRecognition(opts);
      }
    } catch {
      // 本地识别不可用则回落到传统在线识别
    }
  }
  const r = new SpeechRecognition();
  r.lang = "zh-CN";
  addMessage("notice", "使用在线语音识别（需要联网）");
  return r;
}

async function startRecording() {
  // 预检麦克风权限；侧边栏弹不出授权框时，打开专门的授权页
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch {
    openMicPermissionPage();
    return;
  }

  try {
    recognition = await createRecognition();
  } catch (err) {
    addMessage("error", `无法初始化语音识别: ${err.message}`);
    return;
  }
  recognition.lang = "zh-CN";
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onstart = () => setRecordingState(true);

  voiceBaseText = inputEl.value;
  if (voiceBaseText && !voiceBaseText.endsWith(" ") && !voiceBaseText.endsWith("\n")) {
    voiceBaseText += " ";
  }

  recognition.onresult = (e) => {
    let transcript = "";
    for (let i = 0; i < e.results.length; i++) {
      transcript += e.results[i][0].transcript;
    }
    inputEl.value = voiceBaseText + transcript;
    inputEl.focus();
  };

  recognition.onerror = (e) => {
    setRecordingState(false);
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      openMicPermissionPage();
    } else if (e.error === "no-speech") {
      addMessage("notice", "没有检测到语音，请再试一次");
    } else if (e.error !== "aborted") {
      addMessage("error", `语音识别失败: ${e.error}`);
    }
  };

  recognition.onend = () => setRecordingState(false);

  try {
    await recognition.start();
    setRecordingState(true);
  } catch (err) {
    addMessage("error", `无法启动语音识别: ${err.message}`);
  }
}

function stopRecording() {
  try { recognition?.stop(); } catch {}
  setRecordingState(false);
  inputEl.focus();
}

btnMic.addEventListener("click", () => {
  if (recording) stopRecording();
  else startRecording();
});

connect();
inputEl.focus();
