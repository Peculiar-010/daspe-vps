require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const passport = require('passport');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');
const path = require('path');
const { pool, query } = require('./config/database');
const { apiLimiter, sanitizeInput } = require('./middleware/security');
const { initWebPush } = require('./services/webpush');
const { ensureNetwork } = require('./services/docker');
const { startMonitoring } = require('./services/monitor');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https:', 'https://avatars.githubusercontent.com'],
      connectSrc: ["'self'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
    }
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }
}));

app.use(cors({
  origin: process.env.FRONTEND_URL,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(compression());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(sanitizeInput);

app.use(session({
  store: new pgSession({ pool, tableName: 'session', createTableIfMissing: false }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  name: 'dsid',
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'none',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

app.use(passport.initialize());
app.use(passport.session());

// Block sensitive files
app.use(function(req, res, next) {
  const p = req.path.toLowerCase();
  const blocked = ['.env', '.git/', '.htaccess', '.ds_store', 'schema.sql', 'node_modules'];
  if (blocked.some(function(b) { return p.includes(b); }) || p.endsWith('.sql') || p.endsWith('.log') || p.endsWith('.bak')) {
    return res.status(403).end();
  }
  next();
});

// Admin HTML gate — only intercept GET requests for admin HTML pages
app.use('/admin', async function(req, res, next) {
  // Let API calls pass through
  if (req.path.startsWith('/api')) return next();
  // Only intercept HTML page requests
  const isPage = req.method === 'GET' && (req.path === '/' || req.path === '' || req.path.endsWith('.html'));
  if (!isPage) return next();
  // gate.html itself must always be served — no gating the gate
  if (req.path === '/gate.html') return next();

  // No session — hard 404
  if (!req.session || !req.session.userId) {
    return res.status(404).end();
  }

  try {
    const result = await query('SELECT github_username, role FROM users WHERE id = $1', [req.session.userId]);
    if (!result.rows.length) return res.status(404).end();
    const user = result.rows[0];

    // Not the admin account — hard 404
    if (user.github_username !== process.env.ADMIN_GITHUB_USERNAME || user.role !== 'admin') {
      return res.status(404).end();
    }

    // Admin account confirmed — check 2FA
    if (!req.session.adminVerified) {
      // Redirect to gate page instead of serving inline to avoid loops
      return res.redirect('/admin/gate.html');
    }

    // All good
    next();
  } catch (err) {
    console.error('Admin gate error:', err.message);
    return res.status(404).end();
  }
});

// Routes
app.use('/auth', require('./routes/auth'));
app.use('/auth', require('./routes/adminAuth'));
app.use('/api/deployments', require('./routes/deployments'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/user', require('./routes/user'));

// Static files
app.use(express.static(path.join(__dirname, '../frontend/public'), {
  dotfiles: 'deny',
  index: 'index.html',
  etag: true
}));

// SPA fallback
app.get('*', function(req, res) {
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

// Error handler
app.use(function(err, req, res, next) {
  console.error('Error:', err.message);
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large' });
  res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message });
});

const start = async function() {
  try {
    await query('SELECT 1');
    console.log('PostgreSQL connected');
    initWebPush();
    console.log('Web Push initialized');
    await ensureNetwork();
    console.log('Docker network ready');
    startMonitoring();
    console.log('Monitoring started');
    app.listen(PORT, '127.0.0.1', function() {
      console.log('Daspe server running on port ' + PORT);
    });
  } catch (err) {
    console.error('Startup failed:', err.message);
    process.exit(1);
  }
};

start();
