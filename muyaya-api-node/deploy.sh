#!/bin/bash
# Deploy Muyaya API Node.js version to VPS
# Run this script on the server (120.48.86.101)

set -e

echo "=== Deploying Muyaya API Node.js ==="

# 1. Create directories
mkdir -p /opt/muyaya-api
mkdir -p /opt/muyaya/photos/thumb
mkdir -p /opt/muyaya/photos/preview
mkdir -p /opt/muyaya/tmp
mkdir -p /opt/muyaya-api/logs

cd /opt/muyaya-api

# 2. Copy files from local (or download from GitHub)
# This script assumes files are already uploaded to /tmp/muyaya-api-node.tar.gz
if [ -f /tmp/muyaya-api-node.tar.gz ]; then
    tar xzf /tmp/muyaya-api-node.tar.gz
    rm -f /tmp/muyaya-api-node.tar.gz
    echo "✓ Files extracted"
else
    echo "✗ Package not found. Upload /tmp/muyaya-api-node.tar.gz first"
    exit 1
fi

# 3. Install dependencies
echo "Installing dependencies..."
npm install --production
echo "✓ Dependencies installed"

# 4. Initialize database
echo "Initializing database..."
node -e "
const Database = require('better-sqlite3');
const fs = require('fs');
const db = new Database('/opt/muyaya/muyaya.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
const schema = fs.readFileSync('schema.sql', 'utf-8');
db.exec(schema);
console.log('Database initialized at /opt/muyaya/muyaya.db');
db.close();
"
echo "✓ Database ready"

# 5. Create .env file
cat > .env << 'ENVEOF'
PORT=3001
PHOTO_DIR=/opt/muyaya/photos
TMP_DIR=/opt/muyaya/tmp
DB_PATH=/opt/muyaya/muyaya.db
AUTH_SECRET=muyaya-secret-key-2026
USERS={"muyaya":"muyaya2024"}
ALLOWED_ORIGINS=https://muyaya.world,https://xiaobubuya.github.io
AGENT_BASE_URL=http://127.0.0.1:3000
AGENT_API_KEY=muyaya-secret-key-2026
ENVEOF
echo "✓ Environment configured"

# 6. Install PM2 and start
npm install -g pm2 2>/dev/null || true
pm2 delete muyaya-api 2>/dev/null || true
pm2 start src/index.js --name muyaya-api
pm2 save
echo "✓ Muyaya API started on port 3001"

# 7. Install Nginx
apt install -y nginx
echo "✓ Nginx installed"

# 8. Configure Nginx
cat > /etc/nginx/sites-available/muyaya << 'NGINXEOF'
upstream muyaya_api {
    server 127.0.0.1:3001;
}

upstream ai_agent_server {
    server 127.0.0.1:3000;
}

server {
    listen 80;
    server_name muyaya.world api.muyaya.world;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl;
    server_name muyaya.world api.muyaya.world;
    
    # Add SSL certificates after certbot
    # ssl_certificate /etc/letsencrypt/live/muyaya.world/fullchain.pem;
    # ssl_certificate_key /etc/letsencrypt/live/muyaya.world/privkey.pem;
    
    location /photos/ {
        alias /opt/muyaya/photos/;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
    
    location /api/ {
        proxy_pass http://muyaya_api;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
    
    location /agent/ {
        proxy_pass http://ai_agent_server/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
    
    location /s/ {
        proxy_pass http://muyaya_api;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
NGINXEOF

ln -sf /etc/nginx/sites-available/muyaya /etc/nginx/sites-enabled/muyaya
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
echo "✓ Nginx configured"

# 9. Setup HTTPS
apt install -y certbot python3-certbot-nginx
certbot --nginx -d muyaya.world -d api.muyaya.world --non-interactive --agree-tos --email admin@muyaya.world --redirect
echo "✓ HTTPS certificate installed"

echo ""
echo "=== Deployment Complete ==="
echo "API: http://localhost:3001/api/health"
echo "Agent: http://localhost:3000/api/health"
echo "Nginx: http://muyaya.world/api/health"
echo ""
echo "Test:"
curl -f http://localhost:3001/api/health
curl -f http://localhost:3000/api/health
