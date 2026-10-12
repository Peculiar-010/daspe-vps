const { query } = require('../config/database');

const requireAuth = async (req, res, next) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const result = await query(
      `SELECT id, github_username, github_email, github_avatar, status, role,
              ram_limit_mb, cpu_limit, storage_limit_mb, ram_used_mb, storage_used_mb,
              totp_enabled, push_subscription, created_at
       FROM users WHERE id = $1`,
      [req.session.userId]
    );
    if (!result.rows.length) {
      req.session.destroy();
      return res.status(401).json({ error: 'User not found' });
    }
    req.user = result.rows[0];
    next();
  } catch (err) {
    return res.status(500).json({ error: 'Auth check failed' });
  }
};

const requireApproved = async (req, res, next) => {
  await requireAuth(req, res, () => {
    if (req.user.status !== 'active') {
      return res.status(403).json({
        error: 'Account pending approval',
        status: req.user.status
      });
    }
    next();
  });
};

const requireAdmin = async (req, res, next) => {
  await requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  });
};

const requireDeploymentOwner = async (req, res, next) => {
  try {
    const deploymentId = req.params.id || req.params.deploymentId;
    const result = await query(
      `SELECT * FROM deployments WHERE id = $1 AND user_id = $2`,
      [deploymentId, req.user.id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Deployment not found' });
    }
    req.deployment = result.rows[0];
    next();
  } catch (err) {
    return res.status(500).json({ error: 'Deployment check failed' });
  }
};

module.exports = { requireAuth, requireApproved, requireAdmin, requireDeploymentOwner };
