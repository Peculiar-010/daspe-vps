const TelegramBot = require('node-telegram-bot-api');

let bot = null;

const getBot = () => {
  if (!bot && process.env.TELEGRAM_BOT_TOKEN) {
    bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
  }
  return bot;
};

const sendMessage = async (message, options = {}) => {
  try {
    const b = getBot();
    if (!b) return;
    await b.sendMessage(process.env.TELEGRAM_ADMIN_CHAT_ID, message, {
      parse_mode: 'HTML',
      ...options
    });
  } catch (err) {
    console.error('Telegram send error:', err.message);
  }
};

const sendPhoto = async (photoUrl, caption) => {
  try {
    const b = getBot();
    if (!b) return;
    await b.sendPhoto(process.env.TELEGRAM_ADMIN_CHAT_ID, photoUrl, {
      caption,
      parse_mode: 'HTML'
    });
  } catch (err) {
    // fallback to text if photo fails
    await sendMessage(caption);
  }
};

const notifyNewSignup = async (user) => {
  const caption = `
🆕 <b>New User Signup — Approval Required</b>

👤 <b>Name:</b> ${user.github_name || user.github_username}
🐙 <b>GitHub:</b> <a href="${user.github_profile_url}">@${user.github_username}</a>
📧 <b>Email:</b> ${user.github_email || 'Not provided'}
📍 <b>Location:</b> ${user.github_location || 'Unknown'}
🏢 <b>Company:</b> ${user.github_company || 'None'}
👥 <b>Followers:</b> ${user.github_followers}
📦 <b>Public Repos:</b> ${user.github_public_repos}
📅 <b>GitHub Since:</b> ${user.github_account_created_at ? new Date(user.github_account_created_at).toDateString() : 'Unknown'}
📝 <b>Bio:</b> ${user.github_bio || 'No bio'}

⏳ <i>Waiting for your approval at the admin panel.</i>
  `.trim();

  if (user.github_avatar) {
    await sendPhoto(user.github_avatar, caption);
  } else {
    await sendMessage(caption);
  }
};

const notifyDeployment = async (user, deployment, status, error = null) => {
  const emoji = status === 'success' ? '✅' : '❌';
  const msg = `
${emoji} <b>Deployment ${status === 'success' ? 'Successful' : 'Failed'}</b>

👤 User: @${user.github_username}
🚀 Project: ${deployment.name}
🌐 URL: https://${deployment.subdomain}.${process.env.BASE_DOMAIN}
${error ? `\n❗ Error: ${error}` : ''}
  `.trim();
  await sendMessage(msg);
};

const notifyServerAlert = async (message) => {
  await sendMessage(`⚠️ <b>Server Alert</b>\n\n${message}`);
};

const notifyUserApproved = async (username) => {
  await sendMessage(`✅ User <b>@${username}</b> has been approved.`);
};

module.exports = {
  sendMessage,
  sendPhoto,
  notifyNewSignup,
  notifyDeployment,
  notifyServerAlert,
  notifyUserApproved
};
