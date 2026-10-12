const fs = require('fs').promises;
const path = require('path');
const { execSync } = require('child_process');

const CADDY_CONFIG_DIR = process.env.CADDY_CONFIG_DIR || '/home/ubuntu/daspe/caddy';
const BASE_DOMAIN = process.env.BASE_DOMAIN || 'daspe.name.ng';

const generateCaddyConfig = async () => {
  const { query } = require('../config/database');

  // Get all running deployments
  const result = await query(
    `SELECT d.id, d.subdomain, d.custom_domain, d.port, dr.target_port, dr.domain
     FROM deployments d
     LEFT JOIN domain_routes dr ON dr.deployment_id = d.id
     WHERE d.status = 'running'`
  );

  let routes = '';
  for (const dep of result.rows) {
    const domain = dep.custom_domain || `${dep.subdomain}.${BASE_DOMAIN}`;
    const port = dep.target_port || dep.port || 3000;
    routes += `
${domain} {
  reverse_proxy daspe-${dep.id}:${port} {
    health_uri /
    health_interval 30s
    fail_duration 10s
  }
  encode gzip
  header {
    X-Frame-Options DENY
    X-Content-Type-Options nosniff
    X-XSS-Protection "1; mode=block"
    Referrer-Policy strict-origin-when-cross-origin
    -Server
  }
  # Block sensitive files
  @blocked {
    path /.env /.env.* /.git/* /.htaccess /.DS_Store /config/* *.sql *.log
    path_regexp sensitive \\.(env|git|htaccess|DS_Store|sql|log|bak|backup|conf|config|ini|key|pem|cert|crt)$
  }
  respond @blocked 403
}
`;
  }

  const config = `
# Daspe Platform - Auto-generated Caddy config
# DO NOT EDIT MANUALLY

# Global options
{
  email admin@${BASE_DOMAIN}
  admin off
}

# Main platform site
${BASE_DOMAIN} {
  root * /home/ubuntu/daspe/frontend/public
  file_server
  encode gzip
  header {
    X-Frame-Options DENY
    X-Content-Type-Options nosniff
    X-XSS-Protection "1; mode=block"
    Referrer-Policy strict-origin-when-cross-origin
    Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:;"
    -Server
  }
  # API proxy
  handle /api/* {
    reverse_proxy 127.0.0.1:3000
  }
  handle /auth/* {
    reverse_proxy 127.0.0.1:3000
  }
  handle /webhook/* {
    reverse_proxy 127.0.0.1:3000
  }
  # Block sensitive paths
  @blocked {
    path /.env /.env.* /.git/* /.htaccess /.DS_Store /config/* *.sql *.log
  }
  respond @blocked 403
  # Try files, fallback to index for SPA
  try_files {path} {path}/ /index.html
}

# www redirect
www.${BASE_DOMAIN} {
  redir https://${BASE_DOMAIN}{uri} permanent
}

# User deployment routes
${routes}
`;

  await fs.mkdir(CADDY_CONFIG_DIR, { recursive: true });
  await fs.writeFile(path.join(CADDY_CONFIG_DIR, 'Caddyfile'), config);
};

const updateCaddyRoute = async (domain, containerIp, port, deploymentId) => {
  const { query } = require('../config/database');

  // Save route to DB
  await query(
    `INSERT INTO domain_routes (deployment_id, domain, target_port)
     VALUES ($1, $2, $3)
     ON CONFLICT (domain) DO UPDATE SET target_port = $3`,
    [deploymentId, domain, port]
  );

  // Regenerate full config and reload Caddy
  await regenerateCaddy();
};

const removeCaddyRoute = async (deploymentId) => {
  const { query } = require('../config/database');
  await query(`DELETE FROM domain_routes WHERE deployment_id = $1`, [deploymentId]);
  await regenerateCaddy();
};

const regenerateCaddy = async () => {
  await generateCaddyConfig();
  try {
    execSync('sudo systemctl reload caddy || sudo caddy reload --config /home/ubuntu/daspe/caddy/Caddyfile', {
      timeout: 10000
    });
  } catch (err) {
    console.error('Caddy reload error:', err.message);
  }
};

module.exports = { generateCaddyConfig, updateCaddyRoute, removeCaddyRoute, regenerateCaddy };
