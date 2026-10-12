const rateLimit = require('express-rate-limit');
const { query } = require('../config/database');
const audit = require('../utils/audit');

// General API rate limit
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

// Auth endpoints - stricter
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many auth attempts.' }
});

// Deploy endpoints
const deployLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  message: { error: 'Too many deploy requests.' }
});

// Build endpoints
const buildLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  message: { error: 'Too many build requests, please wait.' }
});

// Webhook - less restrictive but authenticated
const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  message: { error: 'Too many webhook calls.' }
});

// Validate subdomain
const validateSubdomain = (subdomain) => {
  if (!subdomain) return false;
  const reserved = ['www', 'api', 'admin', 'mail', 'smtp', 'ftp', 'ssh', 'daspe', 'app', 'dashboard'];
  if (reserved.includes(subdomain.toLowerCase())) return false;
  return /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(subdomain);
};

// Check resource quota
const checkQuota = async (req, res, next) => {
  try {
    const user = req.user;
    // Get total RAM used by running deployments
    const result = await query(
      `SELECT COALESCE(SUM(ram_limit_mb), 0) as total_ram
       FROM deployments WHERE user_id = $1 AND status NOT IN ('stopped', 'failed')`,
      [user.id]
    );
    const usedRam = parseInt(result.rows[0].total_ram) || 0;
    if (usedRam >= user.ram_limit_mb) {
      return res.status(400).json({
        error: `RAM quota exceeded. You have ${user.ram_limit_mb}MB total, ${usedRam}MB in use.`
      });
    }
    req.quotaInfo = { usedRam, availableRam: user.ram_limit_mb - usedRam };
    next();
  } catch (err) {
    next(err);
  }
};

// Audit middleware
const auditMiddleware = (action, resourceType) => async (req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = function (data) {
    if (res.statusCode < 400) {
      audit.log({
        userId: req.user?.id,
        action,
        resourceType,
        resourceId: req.params.id || req.params.deploymentId,
        details: { method: req.method, path: req.path },
        req
      }).catch(console.error);
    }
    return originalJson(data);
  };
  next();
};

// Sanitize inputs
const sanitizeInput = (req, res, next) => {
  const sanitize = (obj) => {
    if (typeof obj === 'string') {
      return obj.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
                .replace(/javascript:/gi, '')
                .trim();
    }
    if (typeof obj === 'object' && obj !== null) {
      for (const key of Object.keys(obj)) {
        obj[key] = sanitize(obj[key]);
      }
    }
    return obj;
  };
  if (req.body) req.body = sanitize(req.body);
  if (req.query) req.query = sanitize(req.query);
  next();
};

module.exports = {
  apiLimiter, authLimiter, deployLimiter, buildLimiter, webhookLimiter,
  validateSubdomain, checkQuota, auditMiddleware, sanitizeInput
};
