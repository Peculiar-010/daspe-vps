#!/usr/bin/env node
// Run this ONCE to set up your admin password and generate VAPID keys
// Usage: node utils/setup.js

require('dotenv').config();
const bcrypt = require('bcrypt');
const webpush = require('web-push');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(r => rl.question(q, r));

async function main() {
  console.log('\n=== DASPE SETUP ===\n');

  // Generate VAPID keys
  const vapid = webpush.generateVAPIDKeys();
  console.log('VAPID Keys generated:');
  console.log('VAPID_PUBLIC_KEY=' + vapid.publicKey);
  console.log('VAPID_PRIVATE_KEY=' + vapid.privateKey);

  // Admin password
  const pw = await ask('\nEnter your admin password (min 12 chars): ');
  if (pw.length < 12) { console.error('Password too short'); process.exit(1); }
  const confirm = await ask('Confirm password: ');
  if (pw !== confirm) { console.error('Passwords do not match'); process.exit(1); }
  const hash = await bcrypt.hash(pw, 14);
  console.log('\nAdmin password hash:');
  console.log('ADMIN_PASSWORD_HASH=' + hash);

  // Encryption key
  const crypto = require('crypto');
  const encKey = crypto.randomBytes(32).toString('hex').slice(0, 32);
  console.log('\nEncryption key (32 chars):');
  console.log('ENCRYPTION_KEY=' + encKey);

  // Session secret
  const sesSecret = crypto.randomBytes(64).toString('hex');
  console.log('\nSession secret:');
  console.log('SESSION_SECRET=' + sesSecret);

  // JWT secret
  const jwtSecret = crypto.randomBytes(64).toString('hex');
  console.log('\nJWT secret:');
  console.log('JWT_SECRET=' + jwtSecret);

  console.log('\n=== Add all of the above to your .env file ===\n');
  rl.close();
}

main().catch(e => { console.error(e); process.exit(1); });
