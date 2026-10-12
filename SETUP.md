# DASPE SETUP GUIDE

## 1. Clone repo on VPS
```bash
git clone https://<user>:<PAT>@github.com/<user>/<repo>.git /home/ubuntu/daspe
cd /home/ubuntu/daspe
```

## 2. Create deployments directory
```bash
mkdir -p /home/ubuntu/daspe/deployments-data
```

## 3. Install backend dependencies
```bash
cd /home/ubuntu/daspe/backend
npm install
```

## 4. Run database schema
```bash
psql -h localhost -U daspe -d daspe_db -f config/schema.sql
```

## 5. Generate secrets and admin password
```bash
node utils/setup.js
```
Copy all output lines into your .env file.

## 6. Create .env
```bash
cp .env.example .env
nano .env
```
Fill in:
- DB_PASSWORD (your postgres password)
- GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET (from github.com/settings/developers)
- TELEGRAM_BOT_TOKEN and TELEGRAM_ADMIN_CHAT_ID
- ADMIN_GITHUB_USERNAME (your exact GitHub username)
- All generated values from step 5

## 7. Secure the .env file
```bash
chmod 600 /home/ubuntu/daspe/backend/.env
```

## 8. Create Caddy systemd override for sudoless reload
```bash
sudo tee /etc/sudoers.d/caddy-reload << 'SUDO'
ubuntu ALL=(ALL) NOPASSWD: /bin/systemctl reload caddy
ubuntu ALL=(ALL) NOPASSWD: /usr/bin/caddy reload --config /home/ubuntu/daspe/caddy/Caddyfile
SUDO
```

## 9. Initial Caddy config
```bash
sudo tee /etc/caddy/Caddyfile << 'CADDY'
{
  email admin@daspe.name.ng
}
daspe.name.ng {
  reverse_proxy 127.0.0.1:3000
}
CADDY
sudo systemctl reload caddy
```

## 10. Set up UFW firewall
```bash
sudo ufw allow 22
sudo ufw allow 80
sudo ufw allow 443
sudo ufw --force enable
```

## 11. Add ubuntu user to Docker group (if not already)
```bash
sudo usermod -aG docker ubuntu
newgrp docker
```

## 12. Start the backend
```bash
cd /home/ubuntu/daspe/backend
npm start
```

## 13. Set up as systemd service
```bash
sudo tee /etc/systemd/system/daspe.service << 'SVC'
[Unit]
Description=Daspe Hosting Platform
After=network.target postgresql.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/daspe/backend
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SVC

sudo systemctl daemon-reload
sudo systemctl enable daspe
sudo systemctl start daspe
sudo systemctl status daspe
```

## 14. DNS Setup
Point these to your VPS IP at your domain registrar:
- A record: daspe.name.ng → your VPS IP
- A record: *.daspe.name.ng → your VPS IP (wildcard for user deployments)

## 15. First login
- Visit daspe.name.ng
- Sign in with YOUR GitHub account (the one in ADMIN_GITHUB_USERNAME)
- You will be auto-approved and set as admin
- Visit daspe.name.ng/admin/
- You will be shown the gate page — enter your admin password
- On first time: set up TOTP 2FA with your authenticator app
- Done

## Admin 2FA notes
- Your admin page ONLY appears if you are logged in as the admin GitHub account
- Anyone else visiting /admin/ gets a raw browser 404 with no body
- The gate requires: your admin password + TOTP code from your authenticator app
- Admin session expires after 4 hours of inactivity
