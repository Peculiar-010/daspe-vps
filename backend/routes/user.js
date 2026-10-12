const express = require('express');
const { query } = require('../config/database');
const { requireApproved, requireAuth } = require('../middleware/auth');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');

const router = express.Router();

// Get user notifications
router.get('/notifications', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark notification as read
router.patch('/notifications/:id/read', requireAuth, async (req, res) => {
  try {
    await query(`UPDATE notifications SET read = true WHERE id = $1 AND user_id = $2`, [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark all notifications as read
router.post('/notifications/read-all', requireAuth, async (req, res) => {
  try {
    await query(`UPDATE notifications SET read = true WHERE user_id = $1`, [req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Unread count
router.get('/notifications/unread-count', requireAuth, async (req, res) => {
  try {
    const result = await query(`SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND read = false`, [req.user.id]);
    res.json({ count: parseInt(result.rows[0].count) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get user resource overview
router.get('/resources', requireApproved, async (req, res) => {
  try {
    const ramResult = await query(
      `SELECT COALESCE(SUM(ram_limit_mb), 0) as allocated,
              COALESCE(SUM(CASE WHEN status = 'running' THEN ram_limit_mb ELSE 0 END), 0) as running
       FROM deployments WHERE user_id = $1`,
      [req.user.id]
    );

    // Get live RAM usage from containers
    const runningDeps = await query(
      `SELECT id FROM deployments WHERE user_id = $1 AND status = 'running'`,
      [req.user.id]
    );

    let totalLiveRam = 0;
    const dockerService = require('../services/docker');
    for (const dep of runningDeps.rows) {
      const stats = await dockerService.getContainerStats(dep.id).catch(() => null);
      if (stats) totalLiveRam += stats.ram_used_mb;
    }

    const { getDirSize } = require('../services/deployment');
    const DEPLOYMENTS_PATH = process.env.DEPLOYMENTS_PATH || '/home/ubuntu/daspe/deployments-data';
    const path = require('path');
    const { storageMb } = await getDirSize(path.join(DEPLOYMENTS_PATH));

    res.json({
      ram: {
        limit_mb: req.user.ram_limit_mb,
        allocated_mb: parseInt(ramResult.rows[0].allocated),
        live_used_mb: Math.round(totalLiveRam * 100) / 100,
        available_mb: req.user.ram_limit_mb - parseInt(ramResult.rows[0].allocated)
      },
      storage: {
        limit_mb: req.user.storage_limit_mb,
        used_mb: storageMb,
        available_mb: req.user.storage_limit_mb - storageMb
      },
      cpu: {
        limit: req.user.cpu_limit
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GitHub repos list (for deployment setup)
router.get('/github/repos', requireApproved, async (req, res) => {
  try {
    const axios = require('axios');
    const userResult = await query(`SELECT github_access_token FROM users WHERE id = $1`, [req.user.id]);
    const token = userResult.rows[0]?.github_access_token;
    if (!token) return res.status(400).json({ error: 'GitHub token not available' });

    const response = await axios.get('https://api.github.com/user/repos', {
      headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' },
      params: { sort: 'updated', per_page: 100, type: 'all' }
    });

    const repos = response.data.map(r => ({
      full_name: r.full_name,
      name: r.name,
      private: r.private,
      language: r.language,
      default_branch: r.default_branch,
      updated_at: r.updated_at,
      description: r.description
    }));

    res.json(repos);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get branches for a repo
router.get('/github/repos/:owner/:repo/branches', requireApproved, async (req, res) => {
  try {
    const axios = require('axios');
    const userResult = await query(`SELECT github_access_token FROM users WHERE id = $1`, [req.user.id]);
    const token = userResult.rows[0]?.github_access_token;

    const response = await axios.get(
      `https://api.github.com/repos/${req.params.owner}/${req.params.repo}/branches`,
      { headers: { Authorization: `token ${token}` }, params: { per_page: 50 } }
    );
    res.json(response.data.map(b => b.name));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
