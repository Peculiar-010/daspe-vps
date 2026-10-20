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


const detectProject = async (srcPath, deployment) => {
  const exists = async (name) => {
    try {
      await fs.access(path.join(srcPath, name));
      return true;
    } catch {
      return false;
    }
  };

  const readJson = async (name) => {
    try {
      return JSON.parse(await fs.readFile(path.join(srcPath, name), 'utf8'));
    } catch {
      return null;
    }
  };

  // Respect an explicitly selected runtime.
  if (deployment.runtime && deployment.runtime !== 'auto') {
    return deployment;
  }

  const pkg = await readJson('package.json');

  if (pkg) {
    const scripts = pkg.scripts || {};
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

    deployment.detectedFramework =
      deps.vite ? 'vite' :
      deps.next ? 'nextjs' :
      deps['@angular/core'] ? 'angular' :
      deps.react ? 'react' :
      deps.vue ? 'vue' : 'node';

    if (await exists('bun.lock') || await exists('bun.lockb')) {
      deployment.runtime = 'bun';
    } else {
      deployment.runtime = 'node';
    }

    if (deployment.detectedFramework === 'vite') {
      deployment.runtime = 'static';
      deployment.port = 8080;
      deployment.build_command = null;
      deployment.start_command = null;
      return deployment;
    }

    deployment.build_command =
      deployment.build_command || (scripts.build ? 'npm run build' : 'npm install');

    deployment.start_command =
      deployment.start_command ||
      (scripts.start ? 'npm start' :
       scripts['start:prod'] ? 'npm run start:prod' : null);

    deployment.port = Number(deployment.port) || 3000;
    return deployment;
  }

  if (await exists('requirements.txt') || await exists('pyproject.toml') ||
      await exists('Pipfile')) {
    deployment.runtime = 'python';
    deployment.build_command = deployment.build_command ||
      (await exists('requirements.txt') ? 'pip install -r requirements.txt' : '');
    deployment.start_command = deployment.start_command ||
      (await exists('main.py') ? 'python main.py' :
       await exists('app.py') ? 'python app.py' : null);
    deployment.port = Number(deployment.port) || 8000;
    return deployment;
  }

  if (await exists('composer.json') || await exists('index.php')) {
    deployment.runtime = 'php';
    deployment.port = Number(deployment.port) || 80;
    return deployment;
  }

  if (await exists('go.mod')) {
    deployment.runtime = 'go';
    deployment.build_command = deployment.build_command || 'go build -o app .';
    deployment.start_command = deployment.start_command || './app';
    deployment.port = Number(deployment.port) || 8080;
    return deployment;
  }

  if (await exists('Cargo.toml')) {
    deployment.runtime = 'rust';
    deployment.build_command = deployment.build_command || 'cargo build --release';
    deployment.start_command = deployment.start_command || './target/release/app';
    deployment.port = Number(deployment.port) || 8080;
    return deployment;
  }

  if (await exists('pom.xml') || await exists('build.gradle') ||
      await exists('build.gradle.kts')) {
    deployment.runtime = 'java';
    deployment.port = Number(deployment.port) || 8080;
    return deployment;
  }

  if (await exists('Gemfile')) {
    deployment.runtime = 'ruby';
    deployment.build_command = deployment.build_command || 'bundle install';
    deployment.start_command = deployment.start_command ||
      (await exists('app.rb') ? 'ruby app.rb' : null);
    deployment.port = Number(deployment.port) || 4567;
    return deployment;
  }

  if (await exists('index.html') || await exists('public/index.html')) {
    deployment.runtime = 'static';
    deployment.port = 8080;
    return deployment;
  }

  throw new Error(
    'Could not automatically detect this project. Select its runtime manually or provide a Dockerfile.'
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

  // Track resources created by this attempt for failure cleanup.
  let startedContainer = false;

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

    // Detect project type after the repository has been fetched.
    await detectProject(srcPath, deployment);

    // Persist the detected configuration before building the image.
    await query(
      `UPDATE deployments
       SET runtime = $1, port = $2, build_command = $3, start_command = $4
       WHERE id = $5`,
      [
        deployment.runtime,
        deployment.port ?? null,
        deployment.build_command ?? null,
        deployment.start_command ?? null,
        deploymentId
      ]
    );

    await appendBuildLog(
      buildId,
      `Detected runtime: ${deployment.runtime}` +
        (deployment.detectedFramework ? `; framework: ${deployment.detectedFramework}` : '')
    );

    // Enforce storage limit check
    const { storageMb } = await getDirSize(srcPath);
    if (storageMb > deployment.storage_limit_mb) {
      throw new Error(`Storage limit exceeded: ${storageMb}MB used of ${deployment.storage_limit_mb}MB`);
    }

    // Get decrypted env vars
    const envVars = await getDecryptedEnvVars(deploymentId);

    // Recreate the build context to prevent stale artifacts from previous builds.
    // The original source directory remains untouched.
    const buildPath = path.join(deployPath, 'build');
    await fs.rm(buildPath, { recursive: true, force: true });
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
    startedContainer = true;

    // Save the running deployment before generating its Caddy route.
    await query(
      `UPDATE deployments
       SET status = 'running', container_id = $1, image_name = $2,
           port = $3, deployed_at = NOW()
       WHERE id = $4`,
      [`daspe-${deploymentId}`, imageName, port, deploymentId]
    );

    // Register the domain and refresh Caddy.
    const domain = deployment.custom_domain || `${deployment.subdomain}.${process.env.BASE_DOMAIN || 'daspe.name.ng'}`;
    await updateCaddyRoute(domain, containerIp, port, deploymentId);

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

    // Stop/remove a container created by this attempt if a later step fails.
    // Do not let cleanup errors hide the original deployment error.
    if (startedContainer) {
      try {
        await dockerService.removeContainer(deploymentId);
        await appendBuildLog(buildId, 'Cleaned up container after deployment failure.');
      } catch (cleanupErr) {
        await appendBuildLog(
          buildId,
          `Warning: container cleanup failed: ${cleanupErr.message}`
        );
      }
    }

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
  // Copy project files without copying Git metadata into Docker build contexts.
  // fs.cp avoids shell interpolation and preserves the source repository.
  await fs.cp(src, dest, {
    recursive: true,
    force: true,
    filter: (source) => {
      const relative = path.relative(src, source);
      if (!relative) return true;

      return !relative.split(path.sep).some((part) =>
        part === '.git' || part === 'node_modules'
      );
    }
  });
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
