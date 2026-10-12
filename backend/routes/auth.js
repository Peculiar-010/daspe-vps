const express = require('express');
const passport = require('passport');
const GitHubStrategy = require('passport-github2').Strategy;
const { query } = require('../config/database');
const telegram = require('../services/telegram');
const webpush = require('../services/webpush');
const { requireAuth } = require('../middleware/auth');
const { authLimiter } = require('../middleware/security');
const audit = require('../utils/audit');

const router = express.Router();

// Configure GitHub OAuth
passport.use(new GitHubStrategy({
  clientID: process.env.GITHUB_CLIENT_ID,
  clientSecret: process.env.GITHUB_CLIENT_SECRET,
  callbackURL: process.env.GITHUB_CALLBACK_URL,
  scope: ['user:email', 'repo']
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const emails = profile.emails || [];
    const primaryEmail = emails.find(e => e.primary)?.value || emails[0]?.value || null;
    const githubCreatedAt = profile._json.created_at || null;

    // Check for existing user by github_id OR email (duplicate detection)
    const existingByEmail = primaryEmail
      ? await query(`SELECT * FROM users WHERE github_email = $1 AND github_id != $2`, [primaryEmail, String(profile.id)])
      : { rows: [] };

    if (existingByEmail.rows.length > 0) {
      return done(null, false, { message: 'An account with this email already exists.' });
    }

    // Upsert user
    const result = await query(
      `INSERT INTO users (
        github_id, github_username, github_email, github_avatar, github_profile_url,
        github_bio, github_followers, github_public_repos, github_account_created_at,
        github_name, github_company, github_location, github_access_token
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (github_id) DO UPDATE SET
        github_username = EXCLUDED.github_username,
        github_email = EXCLUDED.github_email,
        github_avatar = EXCLUDED.github_avatar,
        github_profile_url = EXCLUDED.github_profile_url,
        github_bio = EXCLUDED.github_bio,
        github_followers = EXCLUDED.github_followers,
        github_public_repos = EXCLUDED.github_public_repos,
        github_name = EXCLUDED.github_name,
        github_company = EXCLUDED.github_company,
        github_location = EXCLUDED.github_location,
        github_access_token = EXCLUDED.github_access_token,
        last_login = NOW(),
        updated_at = NOW()
      RETURNING *, (xmax = 0) AS is_new`,
      [
        String(profile.id),
        profile.username,
        primaryEmail,
        profile.photos?.[0]?.value || null,
        profile.profileUrl || `https://github.com/${profile.username}`,
        profile._json.bio || null,
        profile._json.followers || 0,
        profile._json.public_repos || 0,
        githubCreatedAt,
        profile.displayName || profile.username,
        profile._json.company || null,
        profile._json.location || null,
        accessToken
      ]
    );

    const user = result.rows[0];

    // Check if admin account
    if (profile.username === process.env.ADMIN_GITHUB_USERNAME && user.status !== 'active') {
      await query(`UPDATE users SET status = 'active', role = 'admin' WHERE id = $1`, [user.id]);
      user.status = 'active';
      user.role = 'admin';
    }

    // Notify admin on new signup
    if (user.is_new || user.status === 'pending') {
      if (user.is_new) {
        await telegram.notifyNewSignup(user).catch(console.error);
      }
    }

    return done(null, user);
  } catch (err) {
    return done(err);
  }
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const result = await query(`SELECT * FROM users WHERE id = $1`, [id]);
    done(null, result.rows[0] || false);
  } catch (err) {
    done(err);
  }
});

// GitHub OAuth routes
router.get('/github', authLimiter, passport.authenticate('github', {
  scope: ['user:email', 'repo']
}));

router.get('/github/callback', authLimiter, (req, res, next) => {
  passport.authenticate('github', async (err, user, info) => {
    if (err) {
      console.error('Auth error:', err);
      return res.redirect('/?error=auth_failed');
    }
    if (!user) {
      const msg = info?.message === 'An account with this email already exists.'
        ? 'duplicate_email' : 'auth_failed';
      return res.redirect(`/?error=${msg}`);
    }

    req.session.userId = user.id;
    req.session.save(async (err) => {
      if (err) return res.redirect('/?error=session_failed');

      await audit.log({ userId: user.id, action: 'user_login', req });

      if (user.status === 'pending') {
        return res.redirect('/pending.html');
      }
      if (user.status === 'rejected') {
        return res.redirect('/?error=account_rejected');
      }
      if (user.status === 'suspended') {
        return res.redirect('/?error=account_suspended');
      }
      if (user.role === 'admin') {
        return res.redirect('/admin/index.html');
      }
      return res.redirect('/dashboard/index.html');
    });
  })(req, res, next);
});

// Get current user
router.get('/me', requireAuth, (req, res) => {
  const user = req.user;
  res.json({
    id: user.id,
    username: user.github_username,
    email: user.github_email,
    avatar: user.github_avatar,
    status: user.status,
    role: user.role,
    ramLimit: user.ram_limit_mb,
    cpuLimit: user.cpu_limit,
    storageLimit: user.storage_limit_mb,
    ramUsed: user.ram_used_mb,
    storageUsed: user.storage_used_mb,
    pushEnabled: !!user.push_subscription,
    createdAt: user.created_at
  });
});

// Logout
router.post('/logout', requireAuth, async (req, res) => {
  await audit.log({ userId: req.user.id, action: 'user_logout', req });
  req.session.destroy((err) => {
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

// Save push subscription
router.post('/push-subscribe', requireAuth, async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Invalid subscription' });
    }
    await webpush.saveSubscription(req.user.id, subscription);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

// Get VAPID public key for push
router.get('/push-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

module.exports = router;
