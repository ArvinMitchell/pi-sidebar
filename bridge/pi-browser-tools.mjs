/**
 * pi-browser-tools — 给 pi 注册 browser_* 工具。
 *
 * 工具调用通过 HTTP 发给本机 bridge（bridge.mjs），
 * bridge 再经 WebSocket 转发给 Chrome 插件在真实浏览器里执行。
 *
 * 由 bridge 以 `pi --extension <本文件>` 方式加载。
 */

import { Type } from "typebox";

const BRIDGE_URL = process.env.PI_SIDEBAR_BRIDGE || "http://127.0.0.1:43118";

async function callBrowser(name, args) {
  let resp;
  try {
    resp = await fetch(`${BRIDGE_URL}/tool`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, args }),
    });
  } catch (err) {
    throw new Error(`无法连接浏览器桥接服务 (${BRIDGE_URL}): ${err.message}`);
  }
  const data = await resp.json();
  if (!data.ok) throw new Error(data.error || "浏览器工具执行失败");
  return data.result;
}

const TabIdParam = Type.Optional(
  Type.Number({ description: "目标标签页 id（来自 browser_list_tabs）。省略则操作当前活动标签页" })
);

function textResult(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }], details: {} };
}

export default function (pi) {
  pi.registerTool({
    name: "browser_list_tabs",
    label: "Browser Tabs",
    description: "列出 Chrome 当前打开的所有标签页（id、标题、URL、是否活动）",
    promptSnippet: "List open Chrome tabs",
    promptGuidelines: ["Use browser_list_tabs first when the user refers to an open page without giving a URL."],
    parameters: Type.Object({}),
    async execute() {
      return textResult(await callBrowser("browser_list_tabs", {}));
    },
  });

  pi.registerTool({
    name: "browser_read_page",
    label: "Browser Read",
    description: "读取网页内容（正文文本或 HTML）。可按 CSS 选择器只读某个元素",
    promptSnippet: "Read text or HTML from a Chrome tab",
    promptGuidelines: [
      "Use browser_read_page to read the content of a web page the user is viewing or a URL they mention.",
    ],
    parameters: Type.Object({
      tabId: TabIdParam,
      url: Type.Optional(Type.String({ description: "若给出，则新建标签页打开该 URL 后读取" })),
      format: Type.Optional(Type.String({ description: '"text"（默认）或 "html"' })),
      selector: Type.Optional(Type.String({ description: "只提取匹配 CSS 选择器的元素" })),
      maxChars: Type.Optional(Type.Number({ description: "最多返回字符数，默认 20000" })),
    }),
    async execute(_id, params) {
      return textResult(await callBrowser("browser_read_page", params));
    },
  });

  pi.registerTool({
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description: "截取标签页当前可见区域的截图（返回图片，可直观看页面）",
    promptSnippet: "Capture a screenshot of a Chrome tab",
    promptGuidelines: ["Use browser_screenshot when you need to see the visual state of a page."],
    parameters: Type.Object({
      tabId: TabIdParam,
    }),
    async execute(_id, params) {
      const r = await callBrowser("browser_screenshot", params);
      return {
        content: [
          { type: "text", text: `截图（标签页 ${r.tabId}: ${r.title}）` },
          { type: "image", data: r.data, mimeType: r.mimeType },
        ],
        details: { tabId: r.tabId, title: r.title },
      };
    },
  });

  pi.registerTool({
    name: "browser_click",
    label: "Browser Click",
    description: "点击页面元素：按 CSS 选择器，或按可见文本（如按钮文字）",
    promptSnippet: "Click an element in a Chrome tab",
    parameters: Type.Object({
      tabId: TabIdParam,
      selector: Type.Optional(Type.String({ description: "CSS 选择器" })),
      text: Type.Optional(Type.String({ description: "按可见文本匹配（按钮/链接等），与 selector 二选一" })),
    }),
    async execute(_id, params) {
      return textResult(await callBrowser("browser_click", params));
    },
  });

  pi.registerTool({
    name: "browser_type",
    label: "Browser Type",
    description: "在输入框/文本域/可编辑元素中输入文字，可选回车提交",
    promptSnippet: "Type text into a field in a Chrome tab",
    parameters: Type.Object({
      tabId: TabIdParam,
      selector: Type.String({ description: "输入框的 CSS 选择器" }),
      text: Type.String({ description: "要输入的文字" }),
      pressEnter: Type.Optional(Type.Boolean({ description: "输入后按回车（默认 false）" })),
      clear: Type.Optional(Type.Boolean({ description: "先清空原内容（默认 true）" })),
    }),
    async execute(_id, params) {
      return textResult(await callBrowser("browser_type", params));
    },
  });

  pi.registerTool({
    name: "browser_scroll",
    label: "Browser Scroll",
    description: "滚动页面或某个元素",
    promptSnippet: "Scroll a Chrome tab",
    parameters: Type.Object({
      tabId: TabIdParam,
      direction: Type.String({ description: '"up" | "down" | "top" | "bottom"' }),
      amount: Type.Optional(Type.Number({ description: "滚动像素（up/down 时有效，默认 600）" })),
      selector: Type.Optional(Type.String({ description: "滚动到该元素（优先于 direction）" })),
    }),
    async execute(_id, params) {
      return textResult(await callBrowser("browser_scroll", params));
    },
  });

  pi.registerTool({
    name: "browser_navigate",
    label: "Browser Navigate",
    description: "在浏览器中打开 URL：新标签页或跳转到指定标签页",
    promptSnippet: "Open a URL in Chrome",
    parameters: Type.Object({
      url: Type.String({ description: "要打开的 URL" }),
      tabId: Type.Optional(Type.Number({ description: "在该标签页跳转；省略则新建标签页" })),
    }),
    async execute(_id, params) {
      return textResult(await callBrowser("browser_navigate", params));
    },
  });

  pi.registerTool({
    name: "browser_evaluate",
    label: "Browser Evaluate",
    description: "在页面主环境执行 JavaScript 并返回结果（JSON）。能力最强，谨慎使用",
    promptSnippet: "Run JavaScript in a Chrome tab",
    promptGuidelines: [
      "Use browser_evaluate only when other browser_* tools cannot accomplish the task.",
    ],
    parameters: Type.Object({
      tabId: TabIdParam,
      code: Type.String({ description: "要执行的 JS 表达式或代码（可用 return 返回值）" }),
    }),
    async execute(_id, params) {
      return textResult(await callBrowser("browser_evaluate", params));
    },
  });
}
