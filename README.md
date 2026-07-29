# Pi Sidebar

**让你的本地 [Pi Coding Agent](https://pi.dev) 住进 Chrome 侧边栏：聊天、总结网页、语音输入，还能直接控制浏览器。**

*Run your local Pi Coding Agent in a Chrome side panel — chat, summarize pages, voice input, and let the agent control your browser. All through your own Pi setup and model accounts.*

## 功能

- 💬 **侧边栏对话**：与你本地的 Pi agent 聊天，流式输出、Markdown 渲染、历史会话管理
- 📄 **一键总结本页**：抓取当前标签页正文（优先选中文字）发给 Pi 总结
- 🎤 **语音输入**：Chrome 本地语音识别（离线可用），中/英文
- 🌐 **Pi 控制浏览器**：agent 可自主调用 8 个浏览器工具——读页面、截图、点击、输入、滚动、打开 URL、执行 JS
- 🧠 **模型/思考水平切换**：跟随你的 pi 配置，下拉即换
- 🌗 **日夜主题**：跟随系统 / 日间 / 夜间
- 🔒 **安全设计**：agent 只开放浏览器工具（无 bash、无文件读写），提示注入也够不到你的电脑

## 架构

```
Chrome 侧边栏 + 后台 service worker (extension/)
        │  WebSocket  ws://127.0.0.1:43118
        ▼
本地 bridge (bridge/bridge.mjs)   ← HTTP /tool ← pi 扩展注册的 browser_* 工具
        │  stdin/stdout JSONL (RPC 模式)
        ▼
pi --mode rpc --extension pi-browser-tools.mjs --tools browser_*
   （复用你现有的 pi 安装、登录凭证、模型配置，会话存在 pi 标准目录）
```

数据流向：网页内容只发往 ① 你本机的 bridge ② 你自己配置的 LLM 提供商。没有第三方服务器。

用户数据使用可见目录，方便备份和管理：

```text
~/Pi Sidebar/
├── workspace/   工作目录
└── sessions/    历史对话（标准 Pi JSONL）
```

可通过环境变量 `PI_SIDEBAR_DATA_DIR` 修改数据目录。

## 安装

### 前置要求

- [Pi Coding Agent](https://github.com/earendil-works/pi) 已安装并完成登录（`pi` 命令可用）
- Node.js 20+
- Chrome 114+

### 1. 一键安装 bridge（推荐）

```bash
curl -fsSL https://raw.githubusercontent.com/ArvinMitchell/pi-sidebar/main/install.sh | bash
```

自动完成：依赖检查 → 下载最新 bridge → 迁移旧历史 → **配置开机自启**（macOS launchd / Linux systemd）→ 启动并验证。重启电脑后也会自动运行。

**旧用户升级**：重新执行同一条命令即可。脚本会自动迁移一键安装旧目录和常见源码目录，旧文件保留、不会覆盖。若旧 bridge 曾手动解压到其他位置：

```bash
PI_SIDEBAR_LEGACY_WORKSPACE="/旧的/workspace/路径" \
  curl -fsSL https://raw.githubusercontent.com/ArvinMitchell/pi-sidebar/main/install.sh | bash
```

<details>
<summary>手动安装（不配置自启）</summary>

从 [Releases](https://github.com/ArvinMitchell/pi-sidebar/releases/latest) 下载 `pi-sidebar-bridge-x.y.z.zip`，解压后执行 `npm start`。

</details>

bridge 默认监听 `127.0.0.1:43118`（可用 `PI_SIDEBAR_PORT` 修改）。

### 2. 安装 Chrome 插件

从 [Releases](https://github.com/ArvinMitchell/pi-sidebar/releases/latest) 下载 `pi-sidebar-extension-x.y.z.zip` 并**解压**，然后：

1. 打开 `chrome://extensions/`，开启**开发者模式**
2. **加载已解压的扩展程序** → 选择解压出的目录
3. 点工具栏图标打开侧边栏，显示**已连接**即成功

### 3. 验证浏览器工具（可选）

```bash
curl http://127.0.0.1:43118/status
# "toolClient": true 表示 Chrome 工具端已连接
```

在侧边栏问："列出我现在的浏览器标签页"，agent 应直接调用 `browser_list_tabs` 回答。

## 使用

| 操作 | 说明 |
|---|---|
| 输入框 | Enter 发送，Shift+Enter 换行；回复中发送按钮变红色停止按钮 |
| 📄 总结本页 | 抓取当前页正文发给 Pi 总结 |
| 🎤 麦克风 | 语音转文字进输入框（首次需授权，见下） |
| 🕘 历史 | 列出/切换历史会话（与终端 `pi -r` 互通） |
| 下拉框 | 切换模型 / 思考水平（只影响侧边栏会话，不改全局配置） |

**麦克风授权**：侧边栏无法弹出权限框，首次点 🎤 会自动打开授权页，允许一次永久有效。需要电脑有麦克风设备。

**浏览器工具**：`browser_list_tabs` / `browser_read_page` / `browser_screenshot` / `browser_click` / `browser_type` / `browser_scroll` / `browser_navigate` / `browser_evaluate`。例如："打开 bilibili 热搜，告诉我前三是什么"、"把这个页面滚动到底部截图看看"。

## 安全与隐私

- pi 进程以 `--tools` 白名单运行：**只有浏览器工具**，bash/文件读写等内置工具全部禁用。即使网页里有提示注入，agent 也只能在浏览器内活动
- `browser_evaluate` 能力最强（页面内任意 JS），重要账号页面请留意 agent 行为（每步都有 ⚙ 提示）
- 你的 pi 凭证（`~/.pi/agent/auth.json`）只被本地 pi 进程读取，不经由插件传输
- 本插件不收集任何数据，无任何遥测

## 常见问题

- **显示"未连接"**：bridge 没启动。用一键脚本装的通常是 pi 未登录（看 `~/.pi-sidebar/bridge.log`）；手动装的重新 `npm start`
- **bridge 开机自启**：macOS 可配置 launchd（见 issue 或自行添加 plist）
- **chrome:// 等系统页面**：浏览器禁止扩展访问，无法读取/操作
- **换端口**：`PI_SIDEBAR_PORT=xxxx npm start`，同时改 `extension/sidepanel.js` 与 `extension/background.js` 里的 `WS_URL`

## 开发

```
bridge/bridge.mjs            WebSocket/HTTP 桥 + pi RPC 进程管理
bridge/pi-browser-tools.mjs  pi 扩展：注册 browser_* 工具
extension/                   Chrome MV3 插件（侧边栏 + 后台工具执行端）
~/Pi Sidebar/workspace/      可见工作目录（运行时生成）
~/Pi Sidebar/sessions/       可见历史目录（运行时生成）
```

## 支持这个项目

如果 Pi Sidebar 对你有帮助，可以请作者喝杯咖啡 ☕

- **GitHub Sponsors**：https://github.com/sponsors/ArvinMitchell
- **爱发电**：https://afdian.com/a/REPLACE_WITH_YOUR_AFDIAN_ID

也欢迎 Star、提 Issue 和 PR。

## 许可

MIT。图标来自 [Lucide](https://lucide.dev)（ISC）。应用图标取自 pi.dev，本项目与 Pi 官方无隶属关系，详见 [NOTICE](NOTICE)。
