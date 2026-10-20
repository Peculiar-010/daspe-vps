const Docker = require('dockerode');
const path = require('path');
const fs = require('fs').promises;
const { query } = require('../config/database');

const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });

const DEPLOYMENTS_PATH = process.env.DEPLOYMENTS_PATH || '/home/ubuntu/daspe/deployments-data';
const BASE_DOMAIN = process.env.BASE_DOMAIN || 'daspe.name.ng';

// Dangerous build command patterns to block
const DANGEROUS_PATTERNS = [
  /curl\s+.*\|\s*(bash|sh|zsh)/i,
  /wget\s+.*\|\s*(bash|sh|zsh)/i,
  /eval\s*\(/i,
  /rm\s+-rf\s+\//i,
  /mkfs/i,
  /dd\s+if=/i,
  /:\(\)\{:\|:&\};:/i, // fork bomb
  /\/etc\/passwd/i,
  /\/etc\/shadow/i,
  /docker\s+run/i,
  /docker\s+exec/i,
  /nsenter/i,
  /chroot/i,
];

const isSafeCommand = (command) => {
  if (!command) return true;
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) return false;
  }
  return true;
};

const RUNTIME_CONFIGS = {
  node: {
    baseImage: 'node:20-alpine',
    defaultBuildCommand: 'npm install',
    defaultStartCommand: 'npm start',
    defaultPort: 3000,
  },
  python: {
    baseImage: 'python:3.12-alpine',
    defaultBuildCommand: 'pip install -r requirements.txt',
    defaultStartCommand: 'python main.py',
    defaultPort: 8000,
  },
  go: {
    baseImage: 'golang:1.21-alpine',
    defaultBuildCommand: 'go build -o app .',
    defaultStartCommand: './app',
    defaultPort: 8080,
  },
  php: {
    baseImage: 'php:8.2-apache',
    defaultBuildCommand: '',
    defaultStartCommand: 'apache2-foreground',
    defaultPort: 80,
  },
  ruby: {
    baseImage: 'ruby:3.2-alpine',
    defaultBuildCommand: 'bundle install',
    defaultStartCommand: 'ruby app.rb',
    defaultPort: 4567,
  },
  bun: {
    baseImage: 'oven/bun:latest',
    defaultBuildCommand: 'bun install',
    defaultStartCommand: 'bun run start',
    defaultPort: 3000,
  },
  deno: {
    baseImage: 'denoland/deno:latest',
    defaultBuildCommand: '',
    defaultStartCommand: 'deno run --allow-net --allow-read --allow-env main.ts',
    defaultPort: 8000,
  },
  java: {
    baseImage: 'eclipse-temurin:21-alpine',
    defaultBuildCommand: 'javac Main.java',
    defaultStartCommand: 'java Main',
    defaultPort: 8080,
  },
  rust: {
    baseImage: 'rust:alpine',
    defaultBuildCommand: 'cargo build --release',
    defaultStartCommand: './target/release/app',
    defaultPort: 8080,
  },
  static: {
    baseImage: 'nginxinc/nginx-unprivileged:alpine',
    defaultBuildCommand: '',
    defaultStartCommand: 'nginx -g daemon off;',
    defaultPort: 8080,
  },
  custom: {
    baseImage: null,
    defaultBuildCommand: '',
    defaultStartCommand: '',
    defaultPort: 3000,
  }
};

const generateDockerfile = (deployment, envVars = {}) => {
  const config = RUNTIME_CONFIGS[deployment.runtime] || RUNTIME_CONFIGS.node;

  if (deployment.runtime === 'custom') {
    return null; // User provides their own Dockerfile
  }

  // Static sites use the stock Nginx server configuration.
  // Runtime environment variables are supplied through Docker's Env settings,
  // not embedded in generated Dockerfile instructions.
  if (deployment.runtime === 'static') {
    if (deployment.detectedFramework === 'vite') {
      return `FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginxinc/nginx-unprivileged:alpine
COPY --from=build /app/dist/ /usr/share/nginx/html/
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
`;
    }

    return `FROM nginxinc/nginx-unprivileged:alpine
COPY . /usr/share/nginx/html/
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
`;
  }


  return `FROM ${config.baseImage}

# Create non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup 2>/dev/null || \
    (groupadd -r appgroup && useradd -r -g appgroup appuser)

WORKDIR /app

# Copy files
COPY . .

# Install dependencies
${deployment.build_command ? `RUN ${deployment.build_command}` : (config.defaultBuildCommand ? `RUN ${config.defaultBuildCommand}` : '# No build step')}

# Set ownership
RUN chown -R appuser:appgroup /app

# Run as non-root
USER appuser

EXPOSE ${deployment.port || config.defaultPort}

CMD ${JSON.stringify((deployment.start_command || config.defaultStartCommand).split(' '))}
`;
};

const buildImage = async (deploymentId, buildContext, deployment, envVars = {}) => {
  const imageName = `daspe-dep-${deploymentId}:latest`;
  const buildPath = path.join(DEPLOYMENTS_PATH, deploymentId, 'build');

  await fs.mkdir(buildPath, { recursive: true });

  // Generate Dockerfile if not custom
  if (deployment.runtime !== 'custom') {
    const dockerfile = generateDockerfile(deployment, envVars);
    await fs.writeFile(path.join(buildPath, 'Dockerfile'), dockerfile);
  }

  const buildStream = await docker.buildImage(
    { context: buildPath, src: await fs.readdir(buildPath) },
    { t: imageName, rm: true, forcerm: true, networkmode: 'none' }
  );

  return { imageName, buildStream };
};

const startContainer = async (deployment, imageName, envVars = {}) => {
  const containerName = `daspe-${deployment.id}`;
  const config = RUNTIME_CONFIGS[deployment.runtime] || RUNTIME_CONFIGS.node;
  const port = deployment.port || config.defaultPort;

  // Remove existing container if any
  try {
    const existing = docker.getContainer(containerName);
    await existing.stop({ t: 5 }).catch(() => {});
    await existing.remove({ force: true }).catch(() => {});
  } catch (_) {}

  // Pass the selected internal port to applications that use PORT.
  // Preserve an explicitly configured PORT if the user supplied one.
  const containerEnv = { ...envVars };
  if (!containerEnv.PORT) containerEnv.PORT = String(port);

  const envArray = Object.entries(containerEnv).map(([k, v]) => `${k}=${v}`);

  const container = await docker.createContainer({
    name: containerName,
    Image: imageName,
    Env: envArray,
    ExposedPorts: { [`${port}/tcp`]: {} },
    HostConfig: {
      Memory: deployment.ram_limit_mb * 1024 * 1024,
      MemorySwap: deployment.ram_limit_mb * 1024 * 1024 * 2,
      CpuPeriod: 100000,
      CpuQuota: Math.floor(deployment.cpu_limit * 100000),
      StorageOpt: {},
      NetworkMode: 'daspe-net',
      RestartPolicy: { Name: 'unless-stopped' },
      // Security hardening
      CapDrop: ['ALL'],
      CapAdd: ['NET_BIND_SERVICE'],
      SecurityOpt: ['no-new-privileges:true'],
      ReadonlyRootfs: false,
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=100m' },
      Ulimits: [
        { Name: 'nofile', Soft: 1024, Hard: 2048 },
        { Name: 'nproc', Soft: 128, Hard: 256 }
      ],
    },
    Labels: {
      'daspe.deployment_id': deployment.id,
      'daspe.user_id': deployment.user_id,
      'daspe.subdomain': deployment.subdomain,
      'daspe.port': String(port)
    }
  });

  await container.start();

  // Get container info for IP
  const info = await container.inspect();
  const containerIp = info.NetworkSettings.Networks['daspe-net']?.IPAddress;

  return { container, containerIp, port };
};

const stopContainer = async (deploymentId) => {
  try {
    const container = docker.getContainer(`daspe-${deploymentId}`);
    await container.stop({ t: 10 });
  } catch (err) {
    if (!err.message.includes('No such container') && !err.message.includes('not running')) {
      throw err;
    }
  }
};

const removeContainer = async (deploymentId) => {
  try {
    const container = docker.getContainer(`daspe-${deploymentId}`);
    await container.stop({ t: 5 }).catch(() => {});
    await container.remove({ force: true });
  } catch (err) {
    if (!err.message.includes('No such container')) throw err;
  }
};

const getContainerStats = async (deploymentId) => {
  try {
    const container = docker.getContainer(`daspe-${deploymentId}`);
    const stats = await container.stats({ stream: false });
    const memUsage = stats.memory_stats.usage || 0;
    const memLimit = stats.memory_stats.limit || 1;
    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * 100 : 0;

    return {
      ram_used_mb: Math.round(memUsage / 1024 / 1024 * 100) / 100,
      cpu_percent: Math.round(cpuPercent * 100) / 100,
      status: stats.read ? 'running' : 'stopped'
    };
  } catch {
    return { ram_used_mb: 0, cpu_percent: 0, status: 'stopped' };
  }
};

const getContainerLogs = async (deploymentId, tail = 100) => {
  try {
    const container = docker.getContainer(`daspe-${deploymentId}`);
    const logs = await container.logs({ stdout: true, stderr: true, tail, timestamps: true });
    return logs.toString('utf8');
  } catch {
    return '';
  }
};

const streamContainerLogs = async (deploymentId, callback) => {
  try {
    const container = docker.getContainer(`daspe-${deploymentId}`);
    const stream = await container.logs({
      stdout: true, stderr: true, follow: true, timestamps: true, tail: 50
    });
    stream.on('data', (chunk) => callback(chunk.toString('utf8')));
    stream.on('error', (err) => callback(`[ERROR] ${err.message}`));
    return stream;
  } catch (err) {
    callback(`[ERROR] ${err.message}`);
    return null;
  }
};

const ensureNetwork = async () => {
  try {
    const networks = await docker.listNetworks({ filters: { name: ['daspe-net'] } });
    if (networks.length === 0) {
      await docker.createNetwork({
        Name: 'daspe-net',
        Driver: 'bridge',
        Options: { 'com.docker.network.bridge.enable_icc': 'false' }
      });
      console.log('Created daspe-net Docker network');
    }
  } catch (err) {
    console.error('Network setup error:', err.message);
  }
};

const getSystemStats = async () => {
  try {
    const containers = await docker.listContainers({ all: true });
    const info = await docker.info();
    return {
      total_containers: containers.length,
      running_containers: containers.filter(c => c.State === 'running').length,
      docker_info: {
        memory_total: info.MemTotal,
        containers_running: info.ContainersRunning,
        containers_stopped: info.ContainersStopped
      }
    };
  } catch (err) {
    return { error: err.message };
  }
};

module.exports = {
  docker,
  RUNTIME_CONFIGS,
  isSafeCommand,
  generateDockerfile,
  buildImage,
  startContainer,
  stopContainer,
  removeContainer,
  getContainerStats,
  getContainerLogs,
  streamContainerLogs,
  ensureNetwork,
  getSystemStats
};
