const path = require('path');
const fs = require('fs').promises;
const { execSync, spawn } = require('child_process');
const simpleGit = require('simple-git');
const { query } = require('../config/database');
const { decrypt } = require('../utils/encryption');
const dockerService = require('./docker');
const webpush = require('./webpush');
const telegram = require('./telegram');
const { updateCaddyRoute } = require('./caddy');
const { v4: uuidv4 } = require('uuid');

const DEPLOYMENTS_PATH = process.env.DEPLOYMENTS_PATH || '/home/ubuntu/daspe/deployments-data';

const getDecryptedEnvVars = async (deploymentId) => {
  const result = await query(
    `SELECT key, value_encrypted FROM env_variables WHERE deployment_id = $1`,
    [deploymentId]
  );
  const envVars = {};
  for (const row of result.rows) {
    const decrypted = decrypt(row.value_encrypted);
    if (decrypted !== null) envVars[row.key] = decrypted;
  }
  return envVars;
};

const appendBuildLog = async (buildId, line) => {
  await query(
    `UPDATE deployment_builds SET logs = COALESCE(logs, '') || $1 WHERE id = $2`,
    [line + '\n', buildId]
  );
};

const deploy = async (deploymentId, trigger = 'manual', commitSha = null, commitMessage = null) => {
  const depResult = await query(
    `SELECT d.*, u.github_username, u.github_email, u.id as uid,
            u.ram_limit_mb as user_ram_limit, u.storage_limit_mb as user_storage_limit,
            u.github_access_token
     FROM deployments d JOIN users u ON u.id = d.user_id WHERE d.id = $1`,
    [deploymentId]
  );

  if (!depResult.rows.length) throw new Error('Deployment not found');
  const deployment = depResult.rows[0];

  // Check if safe commands
  if (!dockerService.isSafeCommand(deployment.build_command)) {
    throw new Error('Unsafe build command detected');
  }
  if (!dockerService.isSafeCommand(deployment.start_command)) {
    throw new Error('Unsafe start command detected');
  }

  // Create build record
  const buildResult = await query(
    `INSERT INTO deployment_builds (deployment_id, trigger, status, commit_sha, commit_message)
     VALUES ($1, $2, 'building', $3, $4) RETURNING id`,
    [deploymentId, trigger, commitSha, commitMessage]
  );
  const buildId = buildResult.rows[0].id;

  // Update deployment status
  await query(`UPDATE deployments SET status = 'building' WHERE id = $1`, [deploymentId]);

  const deployPath = path.join(DEPLOYMENTS_PATH, deploymentId);
  const srcPath = path.join(deployPath, 'src');

  try {
    await appendBuildLog(buildId, `[${new Date().toISOString()}] Starting build...`);

    // Clone or pull from GitHub
    if (deployment.github_repo) {
      await fs.mkdir(srcPath, { recursive: true });
      const repoUrl = `https://${deployment.github_access_token}@github.com/${deployment.github_repo}.git`;
      const git = simpleGit(srcPath);

      try {
        await git.status();
        await appendBuildLog(buildId, `Pulling latest from ${deployment.github_branch}...`);
        await git.pull('origin', deployment.github_branch);
      } catch {
        await appendBuildLog(buildId, `Cloning ${deployment.github_repo}...`);
        await simpleGit().clone(repoUrl, srcPath, ['--branch', deployment.github_branch, '--depth', '1']);
      }
      await appendBuildLog(buildId, 'Repository ready.');
    }

    // Enforce storage limit check
    const { storageMb } = await getDirSize(srcPath);
    if (storageMb > deployment.storage_limit_mb) {
      throw new Error(`Storage limit exceeded: ${storageMb}MB used of ${deployment.storage_limit_mb}MB`);
    }

    // Get decrypted env vars
    const envVars = await getDecryptedEnvVars(deploymentId);

    // Copy src to build context
    const buildPath = path.join(deployPath, 'build');
    await fs.mkdir(buildPath, { recursive: true });
    await copyDir(srcPath, buildPath);

    await appendBuildLog(buildId, 'Building Docker image...');

    // Generate Dockerfile
    if (deployment.runtime !== 'custom') {
      const dockerfile = dockerService.generateDockerfile(deployment, {});
      await fs.writeFile(path.join(buildPath, 'Dockerfile'), dockerfile);
    }

    const imageName = `daspe-dep-${deploymentId}:latest`;

    // Build image using docker build
    await new Promise((resolve, reject) => {
      const proc = spawn('docker', [
        'build', '-t', imageName,
        '--memory', `${deployment.ram_limit_mb}m`,
        '--network', 'none', // no network during build
        buildPath
      ]);

      proc.stdout.on('data', async (data) => {
        await appendBuildLog(buildId, data.toString());
      });
      proc.stderr.on('data', async (data) => {
        await appendBuildLog(buildId, data.toString());
      });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Build failed with exit code ${code}`));
      });
    });

    await appendBuildLog(buildId, 'Image built successfully. Starting container...');

    // Start container
    const { containerIp, port } = await dockerService.startContainer(deployment, imageName, envVars);

    // Update Caddy routing
    const domain = deployment.custom_domain || `${deployment.subdomain}.${process.env.BASE_DOMAIN}`;
    await updateCaddyRoute(domain, containerIp, port, deploymentId);

    // Update deployment record
    await query(
      `UPDATE deployments SET status = 'running', container_id = $1, image_name = $2, deployed_at = NOW()
       WHERE id = $3`,
      [`daspe-${deploymentId}`, imageName, deploymentId]
    );

    // Update build record
    await query(
      `UPDATE deployment_builds SET status = 'success', finished_at = NOW(), image_name = $1 WHERE id = $2`,
      [imageName, buildId]
    );

    await appendBuildLog(buildId, `\n✅ Deployment successful! Running at https://${domain}`);

    // Notify user
    await webpush.notifyUser(
      deployment.user_id,
      '✅ Deployment Successful',
      `${deployment.name} is now live at https://${domain}`,
      'success',
      deploymentId
    );

    return { success: true, buildId, domain };
  } catch (err) {
    await appendBuildLog(buildId, `\n❌ Build failed: ${err.message}`);
    await query(
      `UPDATE deployments SET status = 'failed' WHERE id = $1`,
      [deploymentId]
    );
    await query(
      `UPDATE deployment_builds SET status = 'failed', finished_at = NOW() WHERE id = $1`,
      [buildId]
    );

    await webpush.notifyUser(
      deployment.user_id,
      '❌ Deployment Failed',
      `${deployment.name} failed to deploy: ${err.message}`,
      'error',
      deploymentId
    );

    throw err;
  }
};

const getDirSize = async (dirPath) => {
  try {
    const { execSync } = require('child_process');
    const output = execSync(`du -sm "${dirPath}" 2>/dev/null || echo "0"`).toString().trim();
    const storageMb = parseInt(output.split('\t')[0]) || 0;
    return { storageMb };
  } catch {
    return { storageMb: 0 };
  }
};

const copyDir = async (src, dest) => {
  const { execSync } = require('child_process');
  execSync(`cp -r "${src}/." "${dest}/"`);
};

const stopDeployment = async (deploymentId) => {
  await dockerService.stopContainer(deploymentId);
  await query(`UPDATE deployments SET status = 'stopped' WHERE id = $1`, [deploymentId]);
};

const deleteDeployment = async (deploymentId) => {
  await dockerService.removeContainer(deploymentId);
  const deployPath = path.join(DEPLOYMENTS_PATH, deploymentId);
  await fs.rm(deployPath, { recursive: true, force: true }).catch(() => {});
  await query(`DELETE FROM deployments WHERE id = $1`, [deploymentId]);
};

const restartDeployment = async (deploymentId) => {
  const container = dockerService.docker.getContainer(`daspe-${deploymentId}`);
  await container.restart({ t: 10 });
  await query(`UPDATE deployments SET status = 'running' WHERE id = $1`, [deploymentId]);
};

module.exports = { deploy, stopDeployment, deleteDeployment, restartDeployment, getDirSize, getDecryptedEnvVars };
