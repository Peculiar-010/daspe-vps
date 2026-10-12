const cron = require('node-cron');
const axios = require('axios');
const { query } = require('../config/database');
const dockerService = require('./docker');
const webpush = require('./webpush');
const telegram = require('./telegram');

// Record resource usage every 5 minutes
const recordResourceUsage = async () => {
  try {
    const result = await query(`SELECT id FROM deployments WHERE status = 'running'`);
    for (const dep of result.rows) {
      const stats = await dockerService.getContainerStats(dep.id).catch(() => null);
      if (stats) {
        await query(
          `INSERT INTO resource_usage (deployment_id, ram_used_mb, cpu_percent) VALUES ($1, $2, $3)`,
          [dep.id, stats.ram_used_mb, stats.cpu_percent]
        );
      }
    }
    // Cleanup old usage records (keep 7 days)
    await query(`DELETE FROM resource_usage WHERE recorded_at < NOW() - INTERVAL '7 days'`);
  } catch (err) {
    console.error('Resource usage recording error:', err.message);
  }
};

// Health checks every minute
const runHealthChecks = async () => {
  try {
    const result = await query(
      `SELECT id, health_check_url, user_id, name, subdomain FROM deployments
       WHERE status = 'running' AND health_check_url IS NOT NULL AND health_check_url != ''`
    );

    for (const dep of result.rows) {
      try {
        const start = Date.now();
        await axios.get(dep.health_check_url, { timeout: 10000 });
        const responseTime = Date.now() - start;

        await query(
          `INSERT INTO uptime_checks (deployment_id, status, response_time_ms) VALUES ($1, 'up', $2)`,
          [dep.id, responseTime]
        );
        await query(
          `UPDATE deployments SET health_status = 'healthy', last_health_check = NOW() WHERE id = $1`,
          [dep.id]
        );
      } catch (err) {
        await query(
          `INSERT INTO uptime_checks (deployment_id, status) VALUES ($1, 'down')`,
          [dep.id]
        );

        // Check if it was previously healthy
        const prev = await query(
          `SELECT status FROM uptime_checks WHERE deployment_id = $1 ORDER BY checked_at DESC LIMIT 2`,
          [dep.id]
        );

        const wasHealthy = prev.rows[1]?.status === 'up';
        if (wasHealthy) {
          // Notify user
          await webpush.notifyUser(
            dep.user_id,
            '⚠️ Deployment Down',
            `${dep.name} appears to be down! Health check failed.`,
            'error',
            dep.id
          );
          await telegram.notifyServerAlert(`Deployment down: ${dep.name} (${dep.subdomain})\nUser ID: ${dep.user_id}`);
        }

        // Auto-restart attempt
        try {
          await dockerService.docker.getContainer(`daspe-${dep.id}`).restart({ t: 5 });
          await query(`UPDATE deployments SET health_status = 'restarting', last_health_check = NOW() WHERE id = $1`, [dep.id]);
        } catch {}
      }
    }
    // Cleanup old uptime checks (keep 30 days)
    await query(`DELETE FROM uptime_checks WHERE checked_at < NOW() - INTERVAL '30 days'`);
  } catch (err) {
    console.error('Health check error:', err.message);
  }
};

// Sleep/wake management every 5 minutes
const manageSleepingDeployments = async () => {
  try {
    const result = await query(
      `SELECT id, sleep_after_minutes, last_active FROM deployments
       WHERE status = 'running' AND sleep_after_minutes > 0`
    );
    const now = new Date();
    for (const dep of result.rows) {
      const lastActive = new Date(dep.last_active);
      const minutesInactive = (now - lastActive) / 1000 / 60;
      if (minutesInactive >= dep.sleep_after_minutes) {
        await dockerService.stopContainer(dep.id).catch(() => {});
        await query(`UPDATE deployments SET status = 'sleeping' WHERE id = $1`, [dep.id]);
        console.log(`Deployment ${dep.id} put to sleep (inactive ${Math.round(minutesInactive)}m)`);
      }
    }
  } catch (err) {
    console.error('Sleep management error:', err.message);
  }
};

// Update user storage used stats every 10 minutes
const updateStorageStats = async () => {
  try {
    const { getDirSize } = require('./deployment');
    const path = require('path');
    const DEPLOYMENTS_PATH = process.env.DEPLOYMENTS_PATH || '/home/ubuntu/daspe/deployments-data';
    const users = await query(`SELECT id FROM users WHERE status = 'active'`);
    for (const user of users.rows) {
      const deps = await query(`SELECT id FROM deployments WHERE user_id = $1`, [user.id]);
      let totalMb = 0;
      for (const dep of deps.rows) {
        const { storageMb } = await getDirSize(path.join(DEPLOYMENTS_PATH, dep.id, 'src'));
        totalMb += storageMb;
      }
      await query(`UPDATE users SET storage_used_mb = $1 WHERE id = $2`, [totalMb, user.id]);
    }
  } catch (err) {
    console.error('Storage stats update error:', err.message);
  }
};

const startMonitoring = () => {
  // Resource usage every 5 minutes
  cron.schedule('*/5 * * * *', recordResourceUsage);
  // Health checks every minute
  cron.schedule('* * * * *', runHealthChecks);
  // Sleep management every 5 minutes
  cron.schedule('*/5 * * * *', manageSleepingDeployments);
  // Storage stats every 10 minutes
  cron.schedule('*/10 * * * *', updateStorageStats);
  console.log('Monitoring started');
};

module.exports = { startMonitoring };
