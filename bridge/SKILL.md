---
name: browser-control
description: 当需要在 Chrome 浏览器中提取网页正文、截取画面与视频、或模拟点击交互时使用。
---

# 浏览器控制指南 (Browser Tools)

当用户需要你读取网页、查看视频画面或在 Chrome 浏览器中操作时：

1. **确定目标标签页**：
   - 使用 `browser_list_tabs` 获取当前打开的所有标签页及活跃标签页 ID。

2. **画面与视频查看**：
   - 使用 `browser_screenshot` 获取当前标签页可见区域的截屏。

3. **文本与字幕提取**：
   - 使用 `browser_read_page` 获取网页正文文本（支持传入 CSS `selector` 提取指定 DOM 区域）。
   - 若需获取页面全局 JavaScript 变量或视频字幕/弹幕，使用 `browser_evaluate`。

4. **网页交互控制**：
   - 点击元素：`browser_click` (可通过 `selector` 或文本按钮匹配)。
   - 文本输入：`browser_type` (支持自动清空原文本及按回车提交)。
   - 页面滚动：`browser_scroll` (支持 `up`/`down`/`top`/`bottom` 或指定元素)。
   - 页面跳转：`browser_navigate`。
