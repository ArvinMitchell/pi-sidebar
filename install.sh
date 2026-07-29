#!/usr/bin/env bash
# Pi Sidebar 一键安装脚本
#
#   curl -fsSL https://raw.githubusercontent.com/ArvinMitchell/pi-sidebar/main/install.sh | bash
#
# 做的事：检查依赖 → 下载最新 bridge → 配置开机自启 → 启动并验证
set -euo pipefail

INSTALL_DIR="$HOME/.pi-sidebar"
DATA_DIR="${PI_SIDEBAR_DATA_DIR:-$HOME/Pi Sidebar}"
PORT="${PI_SIDEBAR_PORT:-43118}"
REPO="ArvinMitchell/pi-sidebar"

info() { echo "==> $*"; }
fail() { echo "❌ $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. 依赖检查
# ---------------------------------------------------------------------------
info "检查依赖…"
command -v node >/dev/null 2>&1 || fail "需要 Node.js 20+，请先安装: https://nodejs.org"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || fail "Node 版本过低 ($(node -v))，需要 20+"
command -v pi >/dev/null 2>&1 || fail "需要 Pi Coding Agent，请先安装并登录: https://pi.dev"
command -v curl >/dev/null 2>&1 || fail "需要 curl"
command -v unzip >/dev/null 2>&1 || fail "需要 unzip"
NODE_BIN="$(command -v node)"

# ---------------------------------------------------------------------------
# 2. 下载最新 bridge
# ---------------------------------------------------------------------------
info "下载最新 bridge…"
mkdir -p "$INSTALL_DIR"
ASSET_URL=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep '"browser_download_url"' | grep 'bridge' | cut -d '"' -f 4)
[ -n "$ASSET_URL" ] || fail "找不到 bridge 发布包，请检查网络或稍后重试"
TMP_ZIP="$(mktemp /tmp/pi-sidebar-bridge-XXXX.zip)"
curl -fsSL "$ASSET_URL" -o "$TMP_ZIP"
rm -rf "$INSTALL_DIR/bridge" "$INSTALL_DIR/pi-sidebar-bridge"
unzip -qo "$TMP_ZIP" -d "$INSTALL_DIR"
mv "$INSTALL_DIR/pi-sidebar-bridge" "$INSTALL_DIR/bridge"
rm -f "$TMP_ZIP"
mkdir -p "$DATA_DIR/workspace" "$DATA_DIR/sessions"

# 从旧版 workspace 对应的标准 Pi 会话目录迁移历史。
# 只复制不删除、同名不覆盖，因此重复运行安全。
migrate_legacy_workspace() {
  local old_workspace="$1"
  local key old_sessions
  key=$(node -e 'const path=require("node:path"); const p=process.argv[1]; console.log("--" + p.split(path.sep).filter(Boolean).join("-") + "--")' "$old_workspace")
  old_sessions="$HOME/.pi/agent/sessions/$key"
  if find "$old_sessions" -maxdepth 1 -name '*.jsonl' -print -quit 2>/dev/null | grep -q .; then
    info "迁移旧历史: $old_workspace → $DATA_DIR/sessions（旧文件保留）…"
    find "$old_sessions" -maxdepth 1 -name '*.jsonl' -exec cp -n {} "$DATA_DIR/sessions/" \;
  fi
}

# 一键安装旧版的默认位置
migrate_legacy_workspace "$INSTALL_DIR/workspace"
# README 早期源码安装的常见位置
migrate_legacy_workspace "$HOME/pi-sidebar/workspace"
# 手动解压到其他位置时可显式指定
if [ -n "${PI_SIDEBAR_LEGACY_WORKSPACE:-}" ]; then
  migrate_legacy_workspace "$PI_SIDEBAR_LEGACY_WORKSPACE"
fi

# ---------------------------------------------------------------------------
# 3. 注册到 Pi 全局扩展与技能
# ---------------------------------------------------------------------------
info "注册到 Pi 全局扩展与技能…"
PI_EXT_DIR="$HOME/.pi/agent/extensions"
PI_SKILL_DIR="$HOME/.pi/agent/skills/browser-control"

mkdir -p "$PI_EXT_DIR" "$PI_SKILL_DIR"

if [ -f "$INSTALL_DIR/bridge/pi-browser-tools.mjs" ]; then
  ln -sf "$INSTALL_DIR/bridge/pi-browser-tools.mjs" "$PI_EXT_DIR/pi-browser-tools.mjs"
  info "已注册 Pi 全局扩展: $PI_EXT_DIR/pi-browser-tools.mjs"
fi

if [ -f "$INSTALL_DIR/bridge/SKILL.md" ]; then
  cp "$INSTALL_DIR/bridge/SKILL.md" "$PI_SKILL_DIR/SKILL.md"
  info "已注册 Pi 技能: $PI_SKILL_DIR/SKILL.md"
fi

# ---------------------------------------------------------------------------
# 4. 配置开机自启
# ---------------------------------------------------------------------------
if [[ "$OSTYPE" == darwin* ]]; then
  info "配置开机自启 (launchd)…"
  PLIST="$HOME/Library/LaunchAgents/com.pisidebar.bridge.plist"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.pisidebar.bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$INSTALL_DIR/bridge/bridge.mjs</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$INSTALL_DIR/bridge</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$INSTALL_DIR/bridge.log</string>
  <key>StandardErrorPath</key>
  <string>$INSTALL_DIR/bridge.log</string>
</dict>
</plist>
EOF
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"

elif command -v systemctl >/dev/null 2>&1; then
  info "配置开机自启 (systemd user)…"
  SVC_DIR="$HOME/.config/systemd/user"
  mkdir -p "$SVC_DIR"
  cat > "$SVC_DIR/pi-sidebar-bridge.service" <<EOF
[Unit]
Description=Pi Sidebar Bridge
After=network.target

[Service]
ExecStart=$NODE_BIN $INSTALL_DIR/bridge/bridge.mjs
WorkingDirectory=$INSTALL_DIR/bridge
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now pi-sidebar-bridge.service
else
  info "未识别的系统，跳过自启配置。手动启动: node $INSTALL_DIR/bridge/bridge.mjs"
fi

# ---------------------------------------------------------------------------
# 5. 验证
# ---------------------------------------------------------------------------
info "验证…"
sleep 3
if curl -fsS "http://127.0.0.1:$PORT/status" >/dev/null 2>&1; then
  echo ""
  echo "✅ bridge 已运行并配置开机自启！"
  echo ""
  echo "最后一步：安装 Chrome 插件"
  echo "  1. 从 https://github.com/$REPO/releases/latest 下载 extension zip 并解压"
  echo "  2. 打开 chrome://extensions/ → 开发者模式 → 加载已解压的扩展程序"
  echo ""
  echo "历史与工作文件: $DATA_DIR"
  echo "日志: $INSTALL_DIR/bridge.log"
  echo "卸载: $INSTALL_DIR/bridge 删除即可，macOS 再执行 launchctl unload ~/Library/LaunchAgents/com.pisidebar.bridge.plist"
else
  fail "bridge 未能正常启动，请查看日志: $INSTALL_DIR/bridge.log（或检查 pi 是否已登录）"
fi
