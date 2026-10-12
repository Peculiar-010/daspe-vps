-- DASPE HOSTING PLATFORM DATABASE SCHEMA

-- Sessions table (for express-session)
CREATE TABLE IF NOT EXISTS session (
  sid VARCHAR NOT NULL COLLATE "default",
  sess JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL,
  CONSTRAINT session_pkey PRIMARY KEY (sid)
);
CREATE INDEX IF NOT EXISTS IDX_session_expire ON session (expire);

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_id VARCHAR(50) UNIQUE NOT NULL,
  github_username VARCHAR(100) UNIQUE NOT NULL,
  github_email VARCHAR(255),
  github_avatar VARCHAR(500),
  github_profile_url VARCHAR(500),
  github_bio TEXT,
  github_followers INTEGER DEFAULT 0,
  github_public_repos INTEGER DEFAULT 0,
  github_account_created_at TIMESTAMP,
  github_name VARCHAR(255),
  github_company VARCHAR(255),
  github_location VARCHAR(255),
  github_access_token TEXT,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended', 'rejected')),
  role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  ram_limit_mb INTEGER DEFAULT 250,
  cpu_limit DECIMAL(3,1) DEFAULT 0.5,
  storage_limit_mb INTEGER DEFAULT 2048,
  ram_used_mb INTEGER DEFAULT 0,
  storage_used_mb INTEGER DEFAULT 0,
  totp_secret VARCHAR(100),
  totp_enabled BOOLEAN DEFAULT FALSE,
  push_subscription TEXT,
  last_login TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Deployments table
CREATE TABLE IF NOT EXISTS deployments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  type VARCHAR(20) DEFAULT 'web' CHECK (type IN ('web', 'bot', 'database')),
  status VARCHAR(20) DEFAULT 'stopped' CHECK (status IN ('building', 'running', 'stopped', 'failed', 'sleeping')),
  subdomain VARCHAR(100) UNIQUE,
  custom_domain VARCHAR(255),
  container_id VARCHAR(100),
  image_name VARCHAR(255),
  runtime VARCHAR(50) DEFAULT 'node',
  github_repo VARCHAR(500),
  github_branch VARCHAR(100) DEFAULT 'main',
  github_webhook_secret VARCHAR(100),
  auto_deploy BOOLEAN DEFAULT FALSE,
  build_command TEXT,
  start_command TEXT,
  port INTEGER DEFAULT 3000,
  ram_limit_mb INTEGER DEFAULT 128,
  cpu_limit DECIMAL(3,1) DEFAULT 0.25,
  storage_limit_mb INTEGER DEFAULT 512,
  health_check_url VARCHAR(500),
  health_check_interval INTEGER DEFAULT 60,
  last_health_check TIMESTAMP,
  health_status VARCHAR(20) DEFAULT 'unknown',
  sleep_after_minutes INTEGER DEFAULT 0,
  last_active TIMESTAMP DEFAULT NOW(),
  deployed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Environment variables table (encrypted)
CREATE TABLE IF NOT EXISTS env_variables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id UUID NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  key VARCHAR(255) NOT NULL,
  value_encrypted TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(deployment_id, key)
);

-- Deployment builds/history table
CREATE TABLE IF NOT EXISTS deployment_builds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id UUID NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  trigger VARCHAR(50) DEFAULT 'manual' CHECK (trigger IN ('manual', 'github_push', 'rollback')),
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'building', 'success', 'failed')),
  commit_sha VARCHAR(100),
  commit_message TEXT,
  logs TEXT,
  started_at TIMESTAMP DEFAULT NOW(),
  finished_at TIMESTAMP,
  image_name VARCHAR(255)
);

-- Deployment logs table (runtime logs snapshots)
CREATE TABLE IF NOT EXISTS deployment_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id UUID NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  log_line TEXT NOT NULL,
  log_type VARCHAR(10) DEFAULT 'stdout' CHECK (log_type IN ('stdout', 'stderr', 'system')),
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_deployment_logs_deployment_id ON deployment_logs(deployment_id);
CREATE INDEX IF NOT EXISTS idx_deployment_logs_created_at ON deployment_logs(created_at);

-- Resource usage history
CREATE TABLE IF NOT EXISTS resource_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id UUID NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  ram_used_mb DECIMAL(8,2),
  cpu_percent DECIMAL(5,2),
  storage_used_mb DECIMAL(8,2),
  bandwidth_in_bytes BIGINT DEFAULT 0,
  bandwidth_out_bytes BIGINT DEFAULT 0,
  recorded_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_resource_usage_deployment_id ON resource_usage(deployment_id);
CREATE INDEX IF NOT EXISTS idx_resource_usage_recorded_at ON resource_usage(recorded_at);

-- Uptime tracking
CREATE TABLE IF NOT EXISTS uptime_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id UUID NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  status VARCHAR(10) CHECK (status IN ('up', 'down')),
  response_time_ms INTEGER,
  checked_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_uptime_deployment_id ON uptime_checks(deployment_id);

-- Push notification subscriptions
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription JSON NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Notifications table
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  body TEXT NOT NULL,
  type VARCHAR(50) DEFAULT 'info' CHECK (type IN ('info', 'success', 'error', 'warning', 'admin')),
  read BOOLEAN DEFAULT FALSE,
  deployment_id UUID REFERENCES deployments(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);

-- Audit log
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(50),
  resource_id VARCHAR(100),
  details JSONB,
  ip_address VARCHAR(50),
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);

-- Caddy dynamic routes (for dynamic subdomain management)
CREATE TABLE IF NOT EXISTS domain_routes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id UUID NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  domain VARCHAR(255) UNIQUE NOT NULL,
  target_port INTEGER NOT NULL,
  ssl_enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Admin broadcast messages
CREATE TABLE IF NOT EXISTS broadcasts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID REFERENCES users(id) ON DELETE SET NULL,
  title VARCHAR(255) NOT NULL,
  body TEXT NOT NULL,
  target VARCHAR(20) DEFAULT 'all' CHECK (target IN ('all', 'active', 'selected')),
  target_user_ids JSONB,
  sent_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Update triggers for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_deployments_updated_at BEFORE UPDATE ON deployments FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_env_variables_updated_at BEFORE UPDATE ON env_variables FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
