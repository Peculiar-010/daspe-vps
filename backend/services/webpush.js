const webpush = require('web-push');
const { query } = require('../config/database');

const initWebPush = () => {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
      process.env.VAPID_EMAIL,
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
  }
};

const saveSubscription = async (userId, subscription) => {
  await query(
    `INSERT INTO push_subscriptions (user_id, subscription)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [userId, JSON.stringify(subscription)]
  );
  await query(`UPDATE users SET push_subscription = $1 WHERE id = $2`, [
    JSON.stringify(subscription), userId
  ]);
};

const sendToUser = async (userId, payload) => {
  try {
    const result = await query(
      `SELECT subscription FROM push_subscriptions WHERE user_id = $1`,
      [userId]
    );
    for (const row of result.rows) {
      try {
        const subscription = JSON.parse(row.subscription);
        await webpush.sendNotification(subscription, JSON.stringify(payload));
      } catch (err) {
        if (err.statusCode === 410) {
          // Subscription expired, remove it
          await query(
            `DELETE FROM push_subscriptions WHERE user_id = $1 AND subscription = $2`,
            [userId, row.subscription]
          );
        }
      }
    }
  } catch (err) {
    console.error('Web push error:', err.message);
  }
};

const sendToAll = async (payload, statusFilter = null) => {
  try {
    let q = `SELECT ps.user_id, ps.subscription FROM push_subscriptions ps
             JOIN users u ON u.id = ps.user_id`;
    const params = [];
    if (statusFilter) {
      q += ` WHERE u.status = $1`;
      params.push(statusFilter);
    }
    const result = await query(q, params);
    for (const row of result.rows) {
      try {
        const subscription = JSON.parse(row.subscription);
        await webpush.sendNotification(subscription, JSON.stringify(payload));
      } catch (err) {
        if (err.statusCode === 410) {
          await query(`DELETE FROM push_subscriptions WHERE user_id = $1`, [row.user_id]);
        }
      }
    }
  } catch (err) {
    console.error('Broadcast push error:', err.message);
  }
};

const sendToSelected = async (userIds, payload) => {
  for (const userId of userIds) {
    await sendToUser(userId, payload);
  }
};

const saveNotificationToDB = async (userId, title, body, type = 'info', deploymentId = null) => {
  await query(
    `INSERT INTO notifications (user_id, title, body, type, deployment_id) VALUES ($1,$2,$3,$4,$5)`,
    [userId, title, body, type, deploymentId || null]
  );
};

const notifyUser = async (userId, title, body, type = 'info', deploymentId = null) => {
  await saveNotificationToDB(userId, title, body, type, deploymentId);
  await sendToUser(userId, { title, body, type, deploymentId, timestamp: Date.now() });
};

module.exports = {
  initWebPush,
  saveSubscription,
  sendToUser,
  sendToAll,
  sendToSelected,
  notifyUser,
  saveNotificationToDB
};
