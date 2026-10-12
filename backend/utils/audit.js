const { query } = require('../config/database');

const log = async ({ userId, action, resourceType, resourceId, details, req }) => {
  try {
    const ip = req ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim() : null;
    const userAgent = req ? req.headers['user-agent'] : null;
    await query(
      `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId || null, action, resourceType || null, resourceId || null,
       details ? JSON.stringify(details) : null, ip, userAgent]
    );
  } catch (err) {
    console.error('Audit log error:', err.message);
  }
};

module.exports = { log };
