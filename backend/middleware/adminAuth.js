const speakeasy = require('speakeasy');
const bcrypt = require('bcrypt');
const { query } = require('../config/database');
const audit = require('../utils/audit');

// Hard 404 — never reveal admin exists to non-admin users
const hard404 = (res) => {
  res.status(404).end();
};

// Admin route guard — three layers:
// 1. Must be logged in via GitHub OAuth
// 2. Must be THE admin GitHub username
// 3. Must have completed admin 2FA session this session
const requireAdminSession = async (req, res, next) => {
  // Layer 1: GitHub OAuth session must exist
  if (!req.session || !req.session.userId) {
    return hard404(res);
  }

  try {
    const result = await query(
      `SELECT id, github_username, role, totp_secret, totp_enabled, status FROM users WHERE id = $1`,
      [req.session.userId]
    );

    if (!result.rows.length) return hard404(res);
    const user = result.rows[0];

    // Layer 2: Must be THE admin GitHub account
    if (
      user.github_username !== process.env.ADMIN_GITHUB_USERNAME ||
      user.role !== 'admin'
    ) {
      return hard404(res);
    }

    // TOTP must be configured before admin APIs are accessible.
    if (!user.totp_enabled || !user.totp_secret) {
      req.session.adminVerified = false;
      req.session.adminVerifiedAt = null;
      return res.status(403).json({ error: 'ADMIN_TOTP_SETUP_REQUIRED' });
    }

    // Layer 3: Must have completed admin 2FA this session
    if (!req.session.adminVerified) {
      return res.status(403).json({ error: 'ADMIN_2FA_REQUIRED' });
    }

    req.adminUser = user;
    next();
  } catch (err) {
    console.error('Admin auth error:', err.message);
    return hard404(res);
  }
};

// Check if admin identity is correct (for 2FA page pre-check)
const checkAdminIdentity = async (req, res, next) => {
  if (!req.session || !req.session.userId) return hard404(res);
  try {
    const result = await query(
      `SELECT id, github_username, role, totp_secret, totp_enabled FROM users WHERE id = $1`,
      [req.session.userId]
    );
    if (!result.rows.length) return hard404(res);
    const user = result.rows[0];
    if (user.github_username !== process.env.ADMIN_GITHUB_USERNAME || user.role !== 'admin') {
      return hard404(res);
    }
    req.adminUser = user;
    next();
  } catch (err) {
    return hard404(res);
  }
};

// Verify admin password + TOTP
const verifyAdminCredentials = async (req, res) => {
  const { password, totp_code } = req.body;

  if (!req.adminUser) return res.status(404).end();

  try {
    // Check password against ADMIN_PASSWORD hash in env
    const passwordHash = process.env.ADMIN_PASSWORD_HASH;
    if (!passwordHash) {
      return res.status(500).json({ error: 'Admin password not configured' });
    }

    const passwordOk = await bcrypt.compare(password, passwordHash);
    if (!passwordOk) {
      await audit.log({
        userId: req.adminUser.id,
        action: 'admin_login_failed',
        details: { reason: 'wrong_password' },
        req
      });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Require TOTP setup before granting any verified admin session.
    if (!req.adminUser.totp_enabled || !req.adminUser.totp_secret) {
      req.session.adminVerified = false;
      req.session.adminVerifiedAt = null;
      return res.json({ success: false, setup_required: true });
    }

    // Check TOTP if enabled
    if (req.adminUser.totp_enabled && req.adminUser.totp_secret) {
      if (!totp_code) {
        return res.status(401).json({ error: 'TOTP code required', totp_required: true });
      }
      const valid = speakeasy.totp.verify({
        secret: req.adminUser.totp_secret,
        encoding: 'base32',
        token: totp_code.replace(/\s/g, ''),
        window: 1
      });
      if (!valid) {
        await audit.log({
          userId: req.adminUser.id,
          action: 'admin_login_failed',
          details: { reason: 'wrong_totp' },
          req
        });
        return res.status(401).json({ error: 'Invalid 2FA code' });
      }
    }

    // All checks passed — mark admin session verified
    req.session.adminVerified = true;
    req.session.adminVerifiedAt = Date.now();

    await audit.log({
      userId: req.adminUser.id,
      action: 'admin_login_success',
      req
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Admin verify error:', err.message);
    res.status(500).json({ error: 'Verification failed' });
  }
};

// Admin session expires after 4 hours of inactivity
const checkAdminSessionExpiry = (req, res, next) => {
  if (req.session.adminVerified && req.session.adminVerifiedAt) {
    const elapsed = Date.now() - req.session.adminVerifiedAt;
    if (elapsed > 4 * 60 * 60 * 1000) {
      req.session.adminVerified = false;
      req.session.adminVerifiedAt = null;
      return res.status(403).json({ error: 'ADMIN_2FA_REQUIRED' });
    }
    // Refresh timestamp on activity
    req.session.adminVerifiedAt = Date.now();
  }
  next();
};

module.exports = {
  requireAdminSession,
  checkAdminIdentity,
  verifyAdminCredentials,
  checkAdminSessionExpiry
};
