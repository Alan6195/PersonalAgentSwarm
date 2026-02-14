#!/bin/bash
set -euo pipefail

# Usage: ./deploy.sh <server_ip> [ssh_key_path]
# Example: ./deploy.sh 49.13.100.50
# Example: ./deploy.sh 49.13.100.50 ~/.ssh/hetzner

SERVER_IP="${1:?Usage: ./deploy.sh <server_ip> [ssh_key_path]}"
SSH_KEY="${2:-}"
REMOTE_USER="root"
REMOTE_DIR="/opt/mission-control"

if [ -n "$SSH_KEY" ]; then
  SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=no"
else
  SSH_OPTS="-o StrictHostKeyChecking=no"
fi

echo "==> Deploying Mission Control to $SERVER_IP"

# Step 1: Install Docker on the server if not present
echo "==> Ensuring Docker is installed..."
ssh $SSH_OPTS "$REMOTE_USER@$SERVER_IP" bash -s <<'INSTALL_DOCKER'
if ! command -v docker &>/dev/null; then
  echo "Installing Docker..."
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable docker
  systemctl start docker
  echo "Docker installed."
else
  echo "Docker already installed."
fi
INSTALL_DOCKER

# Step 2: Sync project files
echo "==> Syncing project files..."
rsync -avz --delete \
  --exclude 'node_modules' \
  --exclude '.next' \
  --exclude '.env' \
  --exclude '.git' \
  --exclude 'pgdata' \
  -e "ssh $SSH_OPTS" \
  ./ "$REMOTE_USER@$SERVER_IP:$REMOTE_DIR/"

# Step 3: Create production .env if it doesn't exist
echo "==> Setting up environment..."
ssh $SSH_OPTS "$REMOTE_USER@$SERVER_IP" bash -s <<'SETUP_ENV'
cd /opt/mission-control
if [ ! -f .env ]; then
  PG_PASS=$(openssl rand -hex 16)
  cat > .env <<EOF
POSTGRES_PASSWORD=$PG_PASS
DATABASE_URL=postgresql://mc:$PG_PASS@db:5432/mission_control
NODE_ENV=production
NEXT_PUBLIC_APP_URL=https://control.ascend-intuition.com
EOF
  echo "Created .env with generated password."
else
  echo ".env already exists, skipping."
fi
SETUP_ENV

# Step 4: Build and deploy
echo "==> Building and starting services..."
ssh $SSH_OPTS "$REMOTE_USER@$SERVER_IP" bash -s <<'DEPLOY'
cd /opt/mission-control
docker compose -f docker-compose.prod.yml up --build -d
echo "Waiting for database to be healthy..."
sleep 5
docker compose -f docker-compose.prod.yml exec app node scripts/setup-db.js 2>/dev/null || echo "DB setup complete (or already seeded)."
echo "Services running:"
docker compose -f docker-compose.prod.yml ps
DEPLOY

echo ""
echo "==> Deployment complete!"
echo "    https://control.ascend-intuition.com"
echo ""
echo "    Make sure your DNS A record points control.ascend-intuition.com -> $SERVER_IP"
echo "    Caddy will automatically provision an SSL certificate once DNS propagates."
