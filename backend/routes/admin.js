const express = require('express');
const os = require('os');
const { query } = require('../config/database');
const { requireAdminSession, checkAdminSessionExpiry } = require('../middleware/adminAuth');
const { apiLimiter } = require('../middleware/security');
const webpush = require('../services/webpush');
const telegram = require('../services/telegram');
const dockerService = require('../services/docker');
const deploymentService = require('../services/deployment');
const { removeCaddyRoute } = require('../services/caddy');
const audit = require('../utils/audit');

const router = express.Router();

// Every admin API route requires: admin GitHub account + 2FA verified session
router.use(requireAdminSession);
router.use(checkAdminSessionExpiry);
router.use(apiLimiter);

// ── OVERVIEW STATS ──────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [users, deployments, dockerStats] = await Promise.all([
      query(`SELECT COUNT(*) as total,
        COUNT(*) FILTER (WHERE status='pending') as pending,
        COUNT(*) FILTER (WHERE status='active') as active,
        COUNT(*) FILTER (WHERE status='suspended') as suspended
        FROM users WHERE role != 'admin'`),
      query(`SELECT COUNT(*) as total,
        COUNT(*) FILTER (WHERE status='running') as running,
        COUNT(*) FILTER (WHERE status='stopped') as stopped,
        COUNT(*) FILTER (WHERE status='failed') as failed,
        COUNT(*) FILTER (WHERE status='building') as building
        FROM deployments`),
      dockerService.getSystemStats()
    ]);
    const memInfo = {
      total_mb: Math.round(os.totalmem() / 1024 / 1024),
      free_mb: Math.round(os.freemem() / 1024 / 1024),
      used_mb: Math.round((os.totalmem() - os.freemem()) / 1024 / 1024)
    };
    const cpuLoad = os.loadavg();
    res.json({
      users: users.rows[0],
      deployments: deployments.rows[0],
      docker: dockerStats,
      system: {
        memory: memInfo,
        cpu_load: { '1m': cpuLoad[0], '5m': cpuLoad[1], '15m': cpuLoad[2] },
        uptime_hours: Math.round(os.uptime() / 3600)
      }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── USERS ───────────────────────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    const { status, page = 1, limit = 30 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let q = `SELECT id, github_username, github_email, github_avatar, github_profile_url,
              github_name, github_followers, github_public_repos, github_account_created_at,
              github_bio, github_location, github_company, status, role,
              ram_limit_mb, cpu_limit, storage_limit_mb, last_login, created_at,
              (SELECT COUNT(*) FROM deployments WHERE user_id = users.id) as deployment_count,
              (SELECT COUNT(*) FROM deployments WHERE user_id = users.id AND status='running') as running_count
             FROM users WHERE role != 'admin'`;
    const params = [];
    if (status) { params.push(status); q += ` AND status = $${params.length}`; }
    q += ` ORDER BY created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`;
    params.push(parseInt(limit), offset);
    const result = await query(q, params);
    const countRes = await query(`SELECT COUNT(*) FROM users WHERE role != 'admin'${status ? ` AND status='${status}'` : ''}`);
    res.json({ users: result.rows, total: parseInt(countRes.rows[0].count), page: parseInt(page) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/users/:id', async (req, res) => {
  try {
    const result = await query(
      `SELECT u.*, (SELECT COUNT(*) FROM deployments WHERE user_id=u.id) as deployment_count,
       (SELECT json_agg(d ORDER BY d.created_at DESC) FROM (SELECT id,name,type,status,subdomain,runtime,ram_limit_mb,deployed_at,created_at FROM deployments WHERE user_id=u.id) d) as deployments
       FROM users u WHERE u.id = $1`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    const user = result.rows[0];
    delete user.github_access_token;
    delete user.totp_secret;
    res.json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/users/:id/approve', async (req, res) => {
  try {
    const result = await query(
      `UPDATE users SET status='active' WHERE id=$1 AND status='pending' RETURNING *`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'User not found or not pending' });
    const user = result.rows[0];
    await webpush.notifyUser(user.id, 'Account Approved', 'Your Daspe account has been approved. You can now deploy projects.', 'success');
    await telegram.notifyUserApproved(user.github_username);
    await audit.log({ userId: req.adminUser.id, action: 'user_approved', resourceType: 'user', resourceId: req.params.id, req });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/users/:id/reject', async (req, res) => {
  try {
    const { reason } = req.body;
    const result = await query(`UPDATE users SET status='rejected' WHERE id=$1 RETURNING *`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    await webpush.notifyUser(result.rows[0].id, 'Account Not Approved', reason || 'Your application was not approved.', 'error');
    await audit.log({ userId: req.adminUser.id, action: 'user_rejected', resourceType: 'user', resourceId: req.params.id, details: { reason }, req });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/users/:id/suspend', async (req, res) => {
  try {
    await query(`UPDATE users SET status='suspended' WHERE id=$1`, [req.params.id]);
    const deps = await query(`SELECT id FROM deployments WHERE user_id=$1 AND status='running'`, [req.params.id]);
    for (const d of deps.rows) await deploymentService.stopDeployment(d.id).catch(() => {});
    await webpush.notifyUser(req.params.id, 'Account Suspended', 'Your account has been suspended.', 'warning');
    await audit.log({ userId: req.adminUser.id, action: 'user_suspended', resourceType: 'user', resourceId: req.params.id, req });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/users/:id/unsuspend', async (req, res) => {
  try {
    await query(`UPDATE users SET status='active' WHERE id=$1`, [req.params.id]);
    await webpush.notifyUser(req.params.id, 'Account Restored', 'Your account has been restored.', 'success');
    await audit.log({ userId: req.adminUser.id, action: 'user_unsuspended', resourceType: 'user', resourceId: req.params.id, req });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/users/:id', async (req, res) => {
  try {
    const deps = await query(`SELECT id FROM deployments WHERE user_id=$1`, [req.params.id]);
    for (const d of deps.rows) {
      await removeCaddyRoute(d.id).catch(() => {});
      await deploymentService.deleteDeployment(d.id).catch(() => {});
    }
    await query(`DELETE FROM users WHERE id=$1`, [req.params.id]);
    await audit.log({ userId: req.adminUser.id, action: 'user_deleted', resourceType: 'user', resourceId: req.params.id, req });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/users/:id/resources', async (req, res) => {
  try {
    const { ram_limit_mb, cpu_limit, storage_limit_mb } = req.body;
    const updates = [], params = [];
    if (ram_limit_mb !== undefined) { params.push(parseInt(ram_limit_mb)); updates.push(`ram_limit_mb=$${params.length}`); }
    if (cpu_limit !== undefined) { params.push(parseFloat(cpu_limit)); updates.push(`cpu_limit=$${params.length}`); }
    if (storage_limit_mb !== undefined) { params.push(parseInt(storage_limit_mb)); updates.push(`storage_limit_mb=$${params.length}`); }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    params.push(req.params.id);
    const result = await query(
      `UPDATE users SET ${updates.join(',')}, updated_at=NOW() WHERE id=$${params.length} RETURNING id, github_username, ram_limit_mb, cpu_limit, storage_limit_mb`, params);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    await webpush.notifyUser(req.params.id, 'Resource Limits Updated', 'Your resource limits have been updated by the admin.', 'info');
    await audit.log({ userId: req.adminUser.id, action: 'user_resources_updated', resourceType: 'user', resourceId: req.params.id, details: req.body, req });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DEPLOYMENTS ─────────────────────────────────────────────
router.get('/deployments', async (req, res) => {
  try {
    const result = await query(
      `SELECT d.*, u.github_username, u.github_avatar FROM deployments d
       JOIN users u ON u.id=d.user_id ORDER BY d.created_at DESC`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/deployments/:id/stop', async (req, res) => {
  try {
    await deploymentService.stopDeployment(req.params.id);
    await audit.log({ userId: req.adminUser.id, action: 'admin_force_stop', resourceType: 'deployment', resourceId: req.params.id, req });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/deployments/:id/logs', async (req, res) => {
  try {
    const logs = await dockerService.getContainerLogs(req.params.id, 200);
    res.json({ logs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── AUDIT LOG ───────────────────────────────────────────────
router.get('/audit', async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const result = await query(
      `SELECT a.*, u.github_username FROM audit_logs a
       LEFT JOIN users u ON u.id=a.user_id
       ORDER BY a.created_at DESC LIMIT $1 OFFSET $2`, [parseInt(limit), offset]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── BROADCAST ───────────────────────────────────────────────
router.post('/broadcast', async (req, res) => {
  try {
    const { title, body, target, target_user_ids } = req.body;
    if (!title || !body) return res.status(400).json({ error: 'Title and body required' });
    let sentCount = 0;
    if (target === 'all') {
      await webpush.sendToAll({ title, body, type: 'admin' });
      const c = await query(`SELECT COUNT(*) FROM push_subscriptions`);
      sentCount = parseInt(c.rows[0].count);
    } else if (target === 'active') {
      await webpush.sendToAll({ title, body, type: 'admin' }, 'active');
      const c = await query(`SELECT COUNT(*) FROM push_subscriptions ps JOIN users u ON u.id=ps.user_id WHERE u.status='active'`);
      sentCount = parseInt(c.rows[0].count);
    } else if (target === 'selected' && target_user_ids?.length) {
      await webpush.sendToSelected(target_user_ids, { title, body, type: 'admin' });
      sentCount = target_user_ids.length;
    }
    const users = target === 'selected' && target_user_ids?.length
      ? await query(`SELECT id FROM users WHERE id=ANY($1)`, [target_user_ids])
      : await query(`SELECT id FROM users WHERE status='active'`);
    for (const u of users.rows) {
      await query(`INSERT INTO notifications (user_id,title,body,type) VALUES ($1,$2,$3,'admin')`, [u.id, title, body]);
    }
    await query(`INSERT INTO broadcasts (admin_id,title,body,target,target_user_ids,sent_count) VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.adminUser.id, title, body, target||'all', target_user_ids ? JSON.stringify(target_user_ids) : null, sentCount]);
    await audit.log({ userId: req.adminUser.id, action: 'broadcast_sent', details: { title, target, sentCount }, req });
    res.json({ success: true, sent_count: sentCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/pending-count', async (req, res) => {
  try {
    const result = await query(`SELECT COUNT(*) FROM users WHERE status='pending'`);
    res.json({ count: parseInt(result.rows[0].count) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
