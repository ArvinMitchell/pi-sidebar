/* Pi Sidebar 后台：点击图标打开侧边栏 + 浏览器工具执行端（常驻 WebSocket） */

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("setPanelBehavior failed:", err));

const WS_URL = "ws://127.0.0.1:43118";
const RECONNECT_MS = 3000;

let ws = null;
let lastFocusedWindowId = null;

async function getInstanceId() {
  try {
    const data = await chrome.storage.local.get("pi_instance_id");
    if (data.pi_instance_id) return data.pi_instance_id;
    const id = "inst_" + Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
    await chrome.storage.local.set({ pi_instance_id: id });
    return id;
  } catch {
    // storage 不可用时退化为随机 ID（本次会话内有效）
    if (!getInstanceId._fallback) {
      getInstanceId._fallback = "inst_" + Math.random().toString(36).slice(2, 11);
    }
    return getInstanceId._fallback;
  }
}

chrome.windows.onFocusChanged.addListener((winId) => {
  if (winId !== chrome.windows.WINDOW_ID_NONE) {
    lastFocusedWindowId = winId;
  }
});

async function connect() {
  const instanceId = await getInstanceId();
  try {
    ws = new WebSocket(WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "hello", role: "tools", instanceId }));
  };

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === "tool_call") handleTool(msg);
  };

  ws.onclose = scheduleReconnect;
  ws.onerror = () => ws.close();
}

function scheduleReconnect() {
  setTimeout(connect, RECONNECT_MS);
}

// MV3 service worker 保活：定时 ping + 断线重连
chrome.alarms.create("pi-sidebar-keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {
  if (!ws || ws.readyState !== WebSocket.OPEN) connect();
  else ws.send(JSON.stringify({ type: "ping" }));
});

connect();

// ---------------------------------------------------------------------------
// 工具执行
// ---------------------------------------------------------------------------

async function handleTool(msg) {
  try {
    const result = await executeTool(msg.name, msg.args || {});
    ws.send(JSON.stringify({ type: "tool_result", id: msg.id, ok: true, result }));
  } catch (err) {
    ws.send(JSON.stringify({
      type: "tool_result", id: msg.id, ok: false,
      error: String(err?.message || err),
    }));
  }
}

async function getTargetTab(tabId, targetWindowId) {
  let tab;
  if (tabId != null) {
    tab = await chrome.tabs.get(tabId);
  } else {
    const winId = targetWindowId || lastFocusedWindowId;
    if (winId != null) {
      const tabs = await chrome.tabs.query({ active: true, windowId: winId });
      tab = tabs[0];
    }
    if (!tab) {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    }
  }
  if (!tab?.id) throw new Error("找不到目标标签页");
  if (!/^https?:/.test(tab.url || "")) {
    throw new Error(`无法操作该页面（${tab.url}），仅支持 http/https 页面`);
  }
  return tab;
}

async function createTab(opts) {
  try {
    return await chrome.tabs.create(opts);
  } catch (err) {
    // windowId 可能已失效（侧边栏所在窗口被关闭），降级为默认行为重试
    if (opts.windowId != null) {
      const rest = { ...opts };
      delete rest.windowId;
      return await chrome.tabs.create(rest);
    }
    throw err;
  }
}

async function executeTool(name, args) {
  const targetWinId = args.windowId || args._targetWindowId || lastFocusedWindowId;

  switch (name) {
    case "browser_list_tabs": {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({
        id: t.id, title: t.title, url: t.url,
        active: t.active, windowId: t.windowId,
        isCurrentWindow: targetWinId != null ? t.windowId === targetWinId : undefined,
      }));
    }

    case "browser_navigate": {
      if (args.tabId != null) {
        const tab = await chrome.tabs.update(args.tabId, { url: args.url, active: true });
        return { tabId: tab.id, url: tab.url };
      }
      const createOpts = { url: args.url, active: true };
      if (targetWinId != null) createOpts.windowId = targetWinId;
      const tab = await createTab(createOpts);
      return { tabId: tab.id, url: tab.url || args.url };
    }

    case "browser_read_page": {
      let tab;
      let created = false;
      if (args.url) {
        const createOpts = { url: args.url, active: false };
        if (targetWinId != null) createOpts.windowId = targetWinId;
        tab = await createTab(createOpts);
        created = true;
      } else {
        tab = await getTargetTab(args.tabId, targetWinId);
      }
      if (args.url) await waitForLoad(tab.id);
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: readPageInTab,
        args: [args.format || "text", args.selector || null, args.maxChars || 20000],
      });
      const result = { tabId: tab.id, title: tab.title, url: tab.url, content: r?.result ?? "" };
      if (created && args.autoClose) {
        try { await chrome.tabs.remove(tab.id); } catch {}
        result.closed = true;
      }
      return result;
    }

    case "browser_screenshot": {
      const tab = await getTargetTab(args.tabId, targetWinId);
      // captureVisibleTab 只能截窗口内当前活跃标签页，先激活目标标签
      if (!tab.active) {
        await chrome.tabs.update(tab.id, { active: true });
      }
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: "jpeg", quality: 70,
      });
      const [prefix, data] = dataUrl.split(",");
      return {
        tabId: tab.id, title: tab.title,
        mimeType: prefix.match(/data:(.*?);/)?.[1] || "image/jpeg",
        data,
      };
    }

    case "browser_click": {
      const tab = await getTargetTab(args.tabId, targetWinId);
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: clickInTab,
        args: [args.selector || null, args.text || null],
      });
      return r?.result;
    }

    case "browser_type": {
      const tab = await getTargetTab(args.tabId, targetWinId);
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: typeInTab,
        args: [args.selector, args.text, !!args.pressEnter, args.clear !== false],
      });
      return r?.result;
    }

    case "browser_scroll": {
      const tab = await getTargetTab(args.tabId, targetWinId);
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: scrollInTab,
        args: [args.direction || "down", args.amount || 600, args.selector || null],
      });
      return r?.result;
    }

    case "browser_evaluate": {
      const tab = await getTargetTab(args.tabId, targetWinId);
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: evaluateInTab,
        args: [String(args.code || "")],
      });
      if (r?.result?.error) throw new Error(r.result.error);
      return r?.result?.value ?? "(无返回值)";
    }

    default:
      throw new Error(`未知工具: ${name}`);
  }
}

function waitForLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function done() { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onUpd); resolve(); }
    function onUpd(id, info) { if (id === tabId && info.status === "complete") done(); }
    chrome.tabs.onUpdated.addListener(onUpd);
  });
}

// ---------------------------------------------------------------------------
// 注入到页面里执行的函数（会被序列化，不能引用外部变量）
// ---------------------------------------------------------------------------

function readPageInTab(format, selector, maxChars) {
  let content;
  if (selector) {
    const els = [...document.querySelectorAll(selector)];
    if (!els.length) return `(没有元素匹配选择器: ${selector})`;
    content = els.map((el) => (format === "html" ? el.outerHTML : el.innerText)).join("\n\n");
  } else if (format === "html") {
    content = document.documentElement.outerHTML;
  } else {
    const main = document.querySelector("article, main, [role='main']") || document.body;
    content = main?.innerText || "";
  }
  content = String(content).replace(/\n{3,}/g, "\n\n").trim();
  if (content.length > maxChars) {
    content = content.slice(0, maxChars) + `\n…(已截断，共 ${content.length} 字符)`;
  }
  return content;
}

function clickInTab(selector, text) {
  let el = null;
  if (selector) {
    el = document.querySelector(selector);
    if (!el) return `没有元素匹配选择器: ${selector}`;
  } else if (text) {
    const candidates = document.querySelectorAll(
      "a, button, [role='button'], [role='link'], input[type='submit'], input[type='button'], summary, li, span"
    );
    const needle = text.trim().toLowerCase();
    el = [...candidates].find((c) => (c.innerText || c.value || "").trim().toLowerCase() === needle)
      || [...candidates].find((c) => (c.innerText || c.value || "").trim().toLowerCase().includes(needle));
    if (!el) return `没有找到文本为 "${text}" 的可点击元素`;
  } else {
    return "必须提供 selector 或 text 之一";
  }
  el.scrollIntoView({ block: "center", behavior: "instant" });
  // 模拟真实鼠标事件序列（很多框架监听 pointer/mouse 事件而不是 .click()）
  const opts = { bubbles: true, cancelable: true, view: window };
  for (const t of ["pointerover", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    const EvClass = t.startsWith("pointer") ? PointerEvent : MouseEvent;
    el.dispatchEvent(new EvClass(t, opts));
  }
  const desc = el.innerText?.trim().slice(0, 60) || el.getAttribute("aria-label") || el.tagName;
  return `已点击: ${desc}`;
}

function typeInTab(selector, text, pressEnter, clear) {
  const el = document.querySelector(selector);
  if (!el) return `没有元素匹配选择器: ${selector}`;
  el.scrollIntoView({ block: "center", behavior: "instant" });
  el.focus();

  if (el.isContentEditable) {
    if (clear) {
      el.textContent = "";
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }
    // execCommand 会走浏览器原生输入路径，框架（React/Vue）能正确感知
    if (!document.execCommand("insertText", false, text)) {
      el.textContent += text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    }
  } else if ("value" in el) {
    // 用原生 value setter 绕过 React 等框架的受控组件拦截
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    const next = clear ? text : el.value + text;
    if (setter) setter.call(el, next);
    else el.value = next;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    return `元素不支持输入: ${selector}`;
  }

  if (pressEnter) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
    }
    if (el.form) el.form.requestSubmit?.();
  }
  return `已在 ${selector} 输入 ${text.length} 个字符${pressEnter ? " 并回车" : ""}`;
}

function scrollInTab(direction, amount, selector) {
  if (selector) {
    const el = document.querySelector(selector);
    if (!el) return `没有元素匹配选择器: ${selector}`;
    el.scrollIntoView({ block: "center", behavior: "instant" });
    return `已滚动到元素: ${selector}`;
  }
  switch (direction) {
    case "up": window.scrollBy(0, -amount); break;
    case "down": window.scrollBy(0, amount); break;
    case "top": window.scrollTo(0, 0); break;
    case "bottom": window.scrollTo(0, document.documentElement.scrollHeight); break;
    default: return `未知方向: ${direction}`;
  }
  return `已滚动: ${direction}，当前位置 y=${Math.round(window.scrollY)}`;
}

function evaluateInTab(code) {
  try {
    const value = (0, eval)(code);
    let out;
    try { out = JSON.stringify(value, null, 2); } catch { out = String(value); }
    return { value: (out ?? "undefined").slice(0, 8000) };
  } catch (err) {
    return { error: String(err?.message || err) };
  }
}
