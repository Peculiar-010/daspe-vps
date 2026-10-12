const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const AdmZip = require('adm-zip');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { query } = require('../config/database');
const { requireApproved, requireDeploymentOwner } = require('../middleware/auth');
const { deployLimiter, buildLimiter, validateSubdomain, checkQuota, auditMiddleware } = require('../middleware/security');
const { encrypt, decrypt } = require('../utils/encryption');
const deploymentService = require('../services/deployment');
const dockerService = require('../services/docker');
const { removeCaddyRoute } = require('../services/caddy');
const audit = require('../utils/audit');

const router = express.Router();
const DEPLOYMENTS_PATH = process.env.DEPLOYMENTS_PATH || '/home/ubuntu/daspe/deployments-data';

// File upload config — no size limit, quota enforced separately
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadPath = path.join(DEPLOYMENTS_PATH, req.params.id, 'uploads');
    await fs.mkdir(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, safeName);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    // Block files that could be used to attack the host system directly
    const blocked = ['.sh', '.bash', '.zsh', '.fish', '.csh', '.exe', '.bat', '.cmd', '.ps1', '.vbs'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (blocked.includes(ext)) {
      return cb(new Error(`File type ${ext} is not allowed`));
    }
    cb(null, true);
  }
});

// List user deployments
router.get('/', requireApproved, async (req, res) => {
  try {
    const result = await query(
      `SELECT d.*, 
              (SELECT COUNT(*) FROM deployment_builds WHERE deployment_id = d.id) as build_count,
              (SELECT status FROM deployment_builds WHERE deployment_id = d.id ORDER BY started_at DESC LIMIT 1) as last_build_status
       FROM deployments d WHERE d.user_id = $1 ORDER BY d.created_at DESC`,
      [req.user.id]
    );
    // Get live stats for running containers
    const deps = result.rows;
    for (const dep of deps) {
      if (dep.status === 'running') {
        const stats = await dockerService.getContainerStats(dep.id).catch(() => null);
        if (stats) {
          dep.live_ram_mb = stats.ram_used_mb;
          dep.live_cpu_percent = stats.cpu_percent;
        }
      }
    }
    res.json(deps);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single deployment
router.get('/:id', requireApproved, requireDeploymentOwner, async (req, res) => {
  try {
    const dep = req.deployment;
    if (dep.status === 'running') {
      const stats = await dockerService.getContainerStats(dep.id).catch(() => null);
      if (stats) {
        dep.live_ram_mb = stats.ram_used_mb;
        dep.live_cpu_percent = stats.cpu_percent;
      }
    }
    res.json(dep);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create deployment
router.post('/', requireApproved, deployLimiter, async (req, res) => {
  try {
    const {
      name, type, runtime, subdomain, github_repo, github_branch,
      build_command, start_command, port, ram_limit_mb, auto_deploy,
      health_check_url, sleep_after_minutes
    } = req.body;

    if (!name || !subdomain) {
      return res.status(400).json({ error: 'Name and subdomain are required' });
    }

    if (!validateSubdomain(subdomain)) {
      return res.status(400).json({ error: 'Invalid subdomain. Use lowercase letters, numbers and hyphens only.' });
    }

    // Check subdomain availability
    const existing = await query(`SELECT id FROM deployments WHERE subdomain = $1`, [subdomain]);
    if (existing.rows.length) {
      return res.status(400).json({ error: 'Subdomain already taken' });
    }

    // Check command safety
    if (!dockerService.isSafeCommand(build_command) || !dockerService.isSafeCommand(start_command)) {
      return res.status(400).json({ error: 'Unsafe command detected' });
    }

    // Validate RAM doesn't exceed user limit
    const requestedRam = parseInt(ram_limit_mb) || 128;
    const usedResult = await query(
      `SELECT COALESCE(SUM(ram_limit_mb), 0) as used FROM deployments WHERE user_id = $1 AND status NOT IN ('stopped','failed')`,
      [req.user.id]
    );
    const usedRam = parseInt(usedResult.rows[0].used);
    if (usedRam + requestedRam > req.user.ram_limit_mb) {
      return res.status(400).json({
        error: `Not enough RAM. You have ${req.user.ram_limit_mb - usedRam}MB available.`
      });
    }

    const webhookSecret = crypto.randomBytes(32).toString('hex');

    const result = await query(
      `INSERT INTO deployments (
        user_id, name, type, runtime, subdomain, github_repo, github_branch,
        build_command, start_command, port, ram_limit_mb, auto_deploy,
        health_check_url, sleep_after_minutes, github_webhook_secret
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING *`,
      [
        req.user.id, name, type || 'web', runtime || 'node', subdomain,
        github_repo || null, github_branch || 'main',
        build_command || null, start_command || null,
        parseInt(port) || 3000, requestedRam, auto_deploy || false,
        health_check_url || null, sleep_after_minutes || 0, webhookSecret
      ]
    );

    const dep = result.rows[0];
    await fs.mkdir(path.join(DEPLOYMENTS_PATH, dep.id, 'src'), { recursive: true });

    await audit.log({ userId: req.user.id, action: 'deployment_created', resourceType: 'deployment', resourceId: dep.id, req });
    res.status(201).json(dep);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update deployment settings
router.patch('/:id', requireApproved, requireDeploymentOwner, async (req, res) => {
  try {
    const { name, github_repo, github_branch, build_command, start_command, port, auto_deploy, health_check_url, sleep_after_minutes, ram_limit_mb } = req.body;

    if (build_command && !dockerService.isSafeCommand(build_command)) {
      return res.status(400).json({ error: 'Unsafe build command' });
    }

    await query(
      `UPDATE deployments SET
        name = COALESCE($1, name),
        github_repo = COALESCE($2, github_repo),
        github_branch = COALESCE($3, github_branch),
        build_command = COALESCE($4, build_command),
        start_command = COALESCE($5, start_command),
        port = COALESCE($6, port),
        auto_deploy = COALESCE($7, auto_deploy),
        health_check_url = COALESCE($8, health_check_url),
        sleep_after_minutes = COALESCE($9, sleep_after_minutes)
       WHERE id = $10`,
      [name, github_repo, github_branch, build_command, start_command,
       port ? parseInt(port) : null, auto_deploy, health_check_url, sleep_after_minutes, req.params.id]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete deployment
router.delete('/:id', requireApproved, requireDeploymentOwner, async (req, res) => {
  try {
    await removeCaddyRoute(req.params.id);
    await deploymentService.deleteDeployment(req.params.id);
    await audit.log({ userId: req.user.id, action: 'deployment_deleted', resourceType: 'deployment', resourceId: req.params.id, req });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Deploy (build + start)
router.post('/:id/deploy', requireApproved, requireDeploymentOwner, buildLimiter, async (req, res) => {
  try {
    res.json({ success: true, message: 'Build started' });
    deploymentService.deploy(req.params.id, 'manual').catch(console.error);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stop
router.post('/:id/stop', requireApproved, requireDeploymentOwner, async (req, res) => {
  try {
    await deploymentService.stopDeployment(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start
router.post('/:id/start', requireApproved, requireDeploymentOwner, async (req, res) => {
  try {
    const dep = req.deployment;
    if (!dep.image_name) return res.status(400).json({ error: 'No image built yet. Deploy first.' });
    const envVars = await deploymentService.getDecryptedEnvVars(dep.id);
    await dockerService.startContainer(dep, dep.image_name, envVars);
    await query(`UPDATE deployments SET status = 'running' WHERE id = $1`, [dep.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Restart
router.post('/:id/restart', requireApproved, requireDeploymentOwner, async (req, res) => {
  try {
    await deploymentService.restartDeployment(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get build history
router.get('/:id/builds', requireApproved, requireDeploymentOwner, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, trigger, status, commit_sha, commit_message, started_at, finished_at, image_name
       FROM deployment_builds WHERE deployment_id = $1 ORDER BY started_at DESC LIMIT 20`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get build logs
router.get('/:id/builds/:buildId/logs', requireApproved, requireDeploymentOwner, async (req, res) => {
  try {
    const result = await query(
      `SELECT logs FROM deployment_builds WHERE id = $1 AND deployment_id = $2`,
      [req.params.buildId, req.params.id]
    );
    res.json({ logs: result.rows[0]?.logs || '' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get runtime logs (SSE)
router.get('/:id/logs', requireApproved, requireDeploymentOwner, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify({ log: data })}\n\n`);
  };

  sendEvent('[System] Connecting to container logs...\n');

  const stream = await dockerService.streamContainerLogs(req.params.id, sendEvent);

  req.on('close', () => {
    if (stream) stream.destroy();
  });
});

// Get stats
router.get('/:id/stats', requireApproved, requireDeploymentOwner, async (req, res) => {
  try {
    const stats = await dockerService.getContainerStats(req.params.id);
    const history = await query(
      `SELECT ram_used_mb, cpu_percent, recorded_at FROM resource_usage
       WHERE deployment_id = $1 ORDER BY recorded_at DESC LIMIT 60`,
      [req.params.id]
    );
    res.json({ current: stats, history: history.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Uptime history
router.get('/:id/uptime', requireApproved, requireDeploymentOwner, async (req, res) => {
  try {
    const result = await query(
      `SELECT status, response_time_ms, checked_at FROM uptime_checks
       WHERE deployment_id = $1 ORDER BY checked_at DESC LIMIT 100`,
      [req.params.id]
    );
    const upChecks = result.rows.filter(r => r.status === 'up').length;
    const uptime = result.rows.length > 0 ? Math.round((upChecks / result.rows.length) * 100 * 10) / 10 : 0;
    res.json({ uptime_percent: uptime, checks: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Env variables - list keys only (not values)
router.get('/:id/env', requireApproved, requireDeploymentOwner, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, key, created_at, updated_at FROM env_variables WHERE deployment_id = $1 ORDER BY key`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add/update env variable
router.put('/:id/env', requireApproved, requireDeploymentOwner, async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key || value === undefined) return res.status(400).json({ error: 'Key and value required' });
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) return res.status(400).json({ error: 'Invalid env key format' });

    const encrypted = encrypt(value);
    await query(
      `INSERT INTO env_variables (deployment_id, key, value_encrypted)
       VALUES ($1, $2, $3)
       ON CONFLICT (deployment_id, key) DO UPDATE SET value_encrypted = $3, updated_at = NOW()`,
      [req.params.id, key, encrypted]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete env variable
router.delete('/:id/env/:key', requireApproved, requireDeploymentOwner, async (req, res) => {
  try {
    await query(
      `DELETE FROM env_variables WHERE deployment_id = $1 AND key = $2`,
      [req.params.id, req.params.key]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload files
router.post('/:id/files', requireApproved, requireDeploymentOwner, upload.array('files'), async (req, res) => {
  try {
    const uploadPath = path.join(DEPLOYMENTS_PATH, req.params.id, 'uploads');
    const srcPath = path.join(DEPLOYMENTS_PATH, req.params.id, 'src');

    // Check storage quota after upload
    const { storageMb } = await deploymentService.getDirSize(srcPath);
    if (storageMb > req.user.storage_limit_mb) {
      // Remove uploaded files
      for (const file of req.files) {
        await fs.unlink(file.path).catch(() => {});
      }
      return res.status(400).json({ error: `Storage quota exceeded. You have ${req.user.storage_limit_mb}MB total.` });
    }

    // Handle ZIPs
    for (const file of req.files) {
      if (file.originalname.endsWith('.zip')) {
        const zip = new AdmZip(file.path);
        const entries = zip.getEntries();

        // ZIP slip protection
        for (const entry of entries) {
          const entryPath = path.resolve(srcPath, entry.entryName);
          if (!entryPath.startsWith(path.resolve(srcPath))) {
            await fs.unlink(file.path).catch(() => {});
            return res.status(400).json({ error: 'Malicious ZIP file detected (path traversal)' });
          }
        }

        zip.extractAllTo(srcPath, true);
        await fs.unlink(file.path);
      } else {
        // Move to src
        await fs.mkdir(srcPath, { recursive: true });
        await fs.copyFile(file.path, path.join(srcPath, file.filename));
        await fs.unlink(file.path).catch(() => {});
      }
    }

    res.json({ success: true, uploaded: req.files.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List files in deployment
router.get('/:id/files', requireApproved, requireDeploymentOwner, async (req, res) => {
  try {
    const srcPath = path.join(DEPLOYMENTS_PATH, req.params.id, 'src');
    const listFiles = async (dir, base = '') => {
      const items = [];
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.git')) continue;
          const relPath = base ? `${base}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            items.push({ name: entry.name, path: relPath, type: 'directory' });
            items.push(...await listFiles(path.join(dir, entry.name), relPath));
          } else {
            const stat = await fs.stat(path.join(dir, entry.name));
            items.push({ name: entry.name, path: relPath, type: 'file', size: stat.size });
          }
        }
      } catch {}
      return items;
    };
    const files = await listFiles(srcPath);
    const { storageMb } = await deploymentService.getDirSize(srcPath);
    res.json({ files, storage_used_mb: storageMb });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete file
router.delete('/:id/files/*', requireApproved, requireDeploymentOwner, async (req, res) => {
  try {
    const srcPath = path.join(DEPLOYMENTS_PATH, req.params.id, 'src');
    const filePath = path.resolve(srcPath, req.params[0]);
    // Path traversal protection
    if (!filePath.startsWith(path.resolve(srcPath))) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    await fs.rm(filePath, { recursive: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rollback to previous build
router.post('/:id/rollback/:buildId', requireApproved, requireDeploymentOwner, async (req, res) => {
  try {
    const buildResult = await query(
      `SELECT * FROM deployment_builds WHERE id = $1 AND deployment_id = $2 AND status = 'success'`,
      [req.params.buildId, req.params.id]
    );
    if (!buildResult.rows.length) return res.status(404).json({ error: 'Build not found or unsuccessful' });

    const build = buildResult.rows[0];
    if (!build.image_name) return res.status(400).json({ error: 'No image for this build' });

    const dep = req.deployment;
    const envVars = await deploymentService.getDecryptedEnvVars(dep.id);
    await dockerService.startContainer({ ...dep, image_name: build.image_name }, build.image_name, envVars);
    await query(`UPDATE deployments SET status = 'running', image_name = $1 WHERE id = $2`, [build.image_name, dep.id]);
    await audit.log({ userId: req.user.id, action: 'deployment_rollback', resourceType: 'deployment', resourceId: dep.id, details: { buildId: req.params.buildId }, req });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GitHub webhook endpoint
router.post('/:id/webhook', async (req, res) => {
  try {
    const result = await query(`SELECT * FROM deployments WHERE id = $1`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });

    const dep = result.rows[0];
    if (!dep.auto_deploy) return res.status(200).json({ message: 'Auto-deploy disabled' });

    // Verify GitHub webhook signature
    const sig = req.headers['x-hub-signature-256'];
    if (!sig || !dep.github_webhook_secret) return res.status(401).json({ error: 'No signature' });

    const expected = `sha256=${crypto.createHmac('sha256', dep.github_webhook_secret).update(JSON.stringify(req.body)).digest('hex')}`;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const event = req.headers['x-github-event'];
    if (event === 'push') {
      const branch = req.body.ref?.replace('refs/heads/', '');
      if (branch !== dep.github_branch) return res.status(200).json({ message: 'Branch mismatch' });

      res.json({ success: true, message: 'Deploy triggered' });
      const commitSha = req.body.after;
      const commitMessage = req.body.head_commit?.message;
      deploymentService.deploy(dep.id, 'github_push', commitSha, commitMessage).catch(console.error);
    } else {
      res.json({ message: 'Event ignored' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
