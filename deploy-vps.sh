#!/usr/bin/env bash
# Presto Pressing — installation automatique sur un VPS Ubuntu/Debian
set -euo pipefail

# ----------------------------- À PERSONNALISER ------------------------------
DOMAIN="pressing.racekof.com"
REPO_URL="https://github.com/KOFURB/presto-pressing.git"
LETSENCRYPT_EMAIL="etrancitranassena@gmail.com"
DB_NAME="presto"
DB_USER="presto"
DB_PASS="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
# ----------------------------------------------------------------------------

APP_DIR="/var/www/presto-pressing"
JWT_SECRET="$(openssl rand -hex 32)"
NODE_MAJOR=20

log(){ echo -e "\n\033[1;36m==> $*\033[0m"; }

if [ "$(id -u)" -ne 0 ]; then echo "Lancez ce script en root"; exit 1; fi

log "Mise a jour du systeme"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ca-certificates gnupg ufw openssl

log "Installation de Node.js ${NODE_MAJOR}.x"
if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q "^v${NODE_MAJOR}\."; then
  curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash -
  apt-get install -y nodejs
fi
node -v && npm -v

log "Installation de MariaDB"
apt-get install -y mariadb-server
systemctl enable --now mariadb

log "Creation de la base de donnees"
mysql <<SQL
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
ALTER USER '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL

log "Recuperation du code depuis GitHub"
if [ -d "$APP_DIR/.git" ]; then git -C "$APP_DIR" pull; else rm -rf "$APP_DIR"; git clone "$REPO_URL" "$APP_DIR"; fi
cd "$APP_DIR"

log "Fichier .env"
cat > .env <<ENV
DB_HOST=localhost
DB_PORT=3306
DB_USER=${DB_USER}
DB_PASSWORD=${DB_PASS}
DB_NAME=${DB_NAME}
JWT_SECRET=${JWT_SECRET}
PORT=3000
ENV
chmod 600 .env

log "Dependances Node"
npm install --omit=dev

log "Initialisation de la base (tables + comptes + demo)"
npm run seed

log "Demarrage avec PM2"
npm install -g pm2
pm2 delete presto >/dev/null 2>&1 || true
pm2 start server/server.js --name presto
pm2 save
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true

log "Configuration de Nginx"
apt-get install -y nginx
cat > /etc/nginx/sites-available/presto <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/presto /etc/nginx/sites-enabled/presto
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

log "Pare-feu"
ufw allow OpenSSH >/dev/null 2>&1 || true
ufw allow 'Nginx Full' >/dev/null 2>&1 || true
yes | ufw enable >/dev/null 2>&1 || true

log "Certificat SSL"
apt-get install -y certbot python3-certbot-nginx
if certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos -m "${LETSENCRYPT_EMAIL}" --redirect; then
  echo "SSL active."
else
  echo "!! SSL non configure. Relancez plus tard : certbot --nginx -d ${DOMAIN}"
fi

log "TERMINE"
echo "-------------------------------------------------------------"
echo " Application     : https://${DOMAIN}"
echo " Mot de passe DB : ${DB_PASS}  (aussi dans ${APP_DIR}/.env)"
echo ""
echo " Comptes par defaut (A CHANGER) :"
echo "   admin / admin123"
echo "   caisse / caisse123"
echo "   reception / reception123"
echo "   production / production123"
echo "-------------------------------------------------------------"
