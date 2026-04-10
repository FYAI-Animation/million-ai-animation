#!/usr/bin/env bash
#
# 百万AI动画大师速成班 · 一键部署脚本
# 适用：Ubuntu 20.04+ / Debian 11+
# 用法：
#   1) cp server/.env.example server/.env
#   2) 编辑 server/.env，填写 SMTP_PASS、DOMAIN 等
#   3) sudo bash deploy/deploy.sh
#
# 此脚本会：
#   - 安装 Node.js 20 LTS、Caddy、rsync 等依赖
#   - 把静态站点同步到 /var/www/million-ai
#   - 把后端安装到 /opt/million-ai-api 并注册 systemd 服务
#   - 配置 Caddy 自动 HTTPS 反代 /api/* 到 127.0.0.1:3001
#   - 启动并健康检查
#
set -euo pipefail

# ---------- 常量 ----------
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WEB_ROOT="${WEB_ROOT:-/var/www/million-ai}"
API_DIR="${API_DIR:-/opt/million-ai-api}"
SERVICE_NAME="million-ai-api"
NODE_MAJOR=20

# ---------- 输出辅助 ----------
green() { printf '\033[1;32m%s\033[0m\n' "$*"; }
red()   { printf '\033[1;31m%s\033[0m\n' "$*" 1>&2; }
info()  { printf '\033[1;36m▸\033[0m %s\n' "$*"; }

# ---------- 前置检查 ----------
if [[ $EUID -ne 0 ]]; then
  red "请使用 root 或 sudo 运行：sudo bash deploy/deploy.sh"
  exit 1
fi

if [[ ! -f "$REPO_DIR/server/.env" ]]; then
  red "未找到 $REPO_DIR/server/.env"
  red "请先执行：cp server/.env.example server/.env  并填写"
  exit 1
fi

# 加载 .env（同时被后端运行时使用）
set -a
# shellcheck disable=SC1090
source "$REPO_DIR/server/.env"
set +a

DOMAIN="${DOMAIN:-}"
if [[ -z "$DOMAIN" || "$DOMAIN" == "请填写你的域名.com" ]]; then
  red "请在 server/.env 中填写真实的 DOMAIN（已解析到本机的域名）"
  exit 1
fi

for k in SMTP_USER SMTP_PASS TO_EMAIL; do
  if [[ -z "${!k:-}" || "${!k}" == *"请填写"* ]]; then
    red "server/.env 中 $k 未填写"
    exit 1
  fi
done

info "部署目标: https://$DOMAIN"
info "静态根:   $WEB_ROOT"
info "后端目录: $API_DIR"
echo

# ---------- 1. 系统依赖 ----------
info "更新 apt 索引并安装基础依赖"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  curl gnupg ca-certificates rsync \
  debian-keyring debian-archive-keyring apt-transport-https >/dev/null

# ---------- 2. Node.js ----------
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  CURRENT_NODE=$(node -v | sed 's/v\([0-9]*\).*/\1/')
  if [[ "$CURRENT_NODE" -ge 18 ]]; then
    NEED_NODE=0
  fi
fi

if [[ $NEED_NODE -eq 1 ]]; then
  info "安装 Node.js ${NODE_MAJOR} LTS"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
green "  Node.js: $(node -v)"
green "  npm:     $(npm -v)"

# ---------- 3. Caddy ----------
if ! command -v caddy >/dev/null 2>&1; then
  info "安装 Caddy"
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi
green "  Caddy:   $(caddy version | head -1)"
echo

# ---------- 4. 同步静态文件 ----------
info "同步静态文件 → $WEB_ROOT"
mkdir -p "$WEB_ROOT"
rsync -a --delete \
  --exclude='.git' \
  --exclude='.gitignore' \
  --exclude='server' \
  --exclude='deploy' \
  --exclude='.env*' \
  --exclude='.DS_Store' \
  --exclude='node_modules' \
  --exclude='*.md' \
  "$REPO_DIR/" "$WEB_ROOT/"

# ---------- 5. 安装后端 ----------
info "安装后端 → $API_DIR"
mkdir -p "$API_DIR"
rsync -a --delete \
  --exclude='node_modules' \
  --exclude='.env' \
  "$REPO_DIR/server/" "$API_DIR/"
cp "$REPO_DIR/server/.env" "$API_DIR/.env"
chmod 600 "$API_DIR/.env"

cd "$API_DIR"
info "npm install"
npm install --omit=dev --silent --no-audit --no-fund

# 用户权限
id -u www-data >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin www-data
chown -R www-data:www-data "$API_DIR" "$WEB_ROOT"

# ---------- 6. systemd ----------
info "写入 systemd 服务: ${SERVICE_NAME}.service"
cat > /etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=Million AI animation form API
After=network.target

[Service]
Type=simple
WorkingDirectory=${API_DIR}
EnvironmentFile=${API_DIR}/.env
ExecStart=$(command -v node) ${API_DIR}/server.js
Restart=always
RestartSec=3
User=www-data
Group=www-data
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ${SERVICE_NAME} >/dev/null
systemctl restart ${SERVICE_NAME}

# ---------- 7. Caddy 配置 ----------
info "写入 Caddyfile"
mkdir -p /var/log/caddy
cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
    encode gzip zstd

    handle /api/* {
        reverse_proxy 127.0.0.1:${PORT:-3001}
    }

    handle {
        root * ${WEB_ROOT}
        try_files {path} /index.html
        file_server
    }

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options nosniff
        Referrer-Policy strict-origin-when-cross-origin
    }

    log {
        output file /var/log/caddy/${DOMAIN}.log
        format console
    }
}
EOF

chown -R caddy:caddy /var/log/caddy 2>/dev/null || true

# 校验 Caddy 配置
if ! caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
  red "Caddyfile 校验失败"
  caddy validate --config /etc/caddy/Caddyfile || true
  exit 1
fi

systemctl reload caddy 2>/dev/null || systemctl restart caddy

# ---------- 8. 健康检查 ----------
sleep 2
if curl -fsS "http://127.0.0.1:${PORT:-3001}/api/health" >/dev/null; then
  green "✅ 后端 API 健康检查通过"
else
  red "⚠️  后端健康检查失败，查看日志: journalctl -u ${SERVICE_NAME} -n 80 --no-pager"
fi

if systemctl is-active --quiet caddy; then
  green "✅ Caddy 运行中"
else
  red "⚠️  Caddy 未运行，查看日志: journalctl -u caddy -n 80 --no-pager"
fi

echo
green "═══════════════════════════════════════════════════"
green "🎉 部署完成"
green "═══════════════════════════════════════════════════"
cat <<EOF

  访问站点:    https://${DOMAIN}
  API 健康:    https://${DOMAIN}/api/health
  静态根:      ${WEB_ROOT}
  后端目录:    ${API_DIR}
  服务管理:    systemctl status ${SERVICE_NAME}
  实时日志:    journalctl -u ${SERVICE_NAME} -f
  Caddy 日志:  tail -f /var/log/caddy/${DOMAIN}.log

DNS 提示:
  请确认 ${DOMAIN} 的 A/AAAA 记录已指向本机 IP，
  Caddy 首次访问 https 域名时会自动申请 Let's Encrypt 证书。
  若证书申请失败，请检查 80/443 端口是否开放（云厂商安全组）。

EOF
