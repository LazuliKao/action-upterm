import os from 'os';
import fs from 'fs';
import path from 'path';
import * as core from '@actions/core';
import * as github from '@actions/github';
import * as tc from '@actions/tool-cache';
import {execShellCommand} from './helpers';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Constants
const UPTERM_SOCKET_POLL_INTERVAL = 1000;
const UPTERM_READY_MAX_RETRIES = 10;
const SESSION_STATUS_POLL_INTERVAL = 5000;
const SUPPORTED_UPTERM_ARCHITECTURES = ['amd64', 'arm64'] as const;
const TMUX_DIMENSIONS = {width: 132, height: 43};
// Delay (in milliseconds) to allow upterm sufficient time to initialize before proceeding.
// This 2-second delay helps ensure the upterm server is fully started and ready for connections.
const UPTERM_INIT_DELAY = 2000;

// Platform-specific paths
const PATHS = {
  timeoutFlag: {
    win32: 'C:/msys64/tmp/upterm-timeout-flag',
    unix: '/tmp/upterm-timeout-flag'
  },
  continueFile: {
    win32: 'C:/msys64/continue',
    unix: '/continue'
  },
  logs: {
    uptermCommand: {
      win32: 'C:/msys64/tmp/upterm-command.log',
      unix: '/tmp/upterm-command.log'
    },
    tmuxError: {
      win32: 'C:/msys64/tmp/tmux-error.log',
      unix: '/tmp/tmux-error.log'
    }
  }
} as const;

// Utility Functions
function toShellPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function getUptermTimeoutFlagPath(): string {
  return process.platform === 'win32' ? PATHS.timeoutFlag.win32 : PATHS.timeoutFlag.unix;
}

function getUptermCommandLogPath(): string {
  return process.platform === 'win32' ? PATHS.logs.uptermCommand.win32 : PATHS.logs.uptermCommand.unix;
}

function getTmuxErrorLogPath(): string {
  return process.platform === 'win32' ? PATHS.logs.tmuxError.win32 : PATHS.logs.tmuxError.unix;
}

type UptermArchitecture = (typeof SUPPORTED_UPTERM_ARCHITECTURES)[number];

function getUptermArchitecture(nodeArch: string): UptermArchitecture | null {
  switch (nodeArch) {
    case 'x64':
      return 'amd64';
    case 'arm64':
      return 'arm64';
    default:
      return null;
  }
}

function validateArchitecture(arch: string): UptermArchitecture {
  const uptermArch = getUptermArchitecture(arch);
  if (!uptermArch) {
    throw new Error(`Unsupported architecture for upterm: ${arch}. Only x64 and arm64 are supported.`);
  }
  return uptermArch;
}

function validateInputs(): void {
  const waitTimeout = core.getInput('wait-timeout-minutes');
  if (waitTimeout) {
    const parsedTimeout = parseInt(waitTimeout, 10);
    if (isNaN(parsedTimeout) || parsedTimeout < 0 || parsedTimeout > 1440 || !Number.isInteger(parsedTimeout)) {
      throw new Error('wait-timeout-minutes must be a valid positive integer not exceeding 1440 (24 hours)');
    }
  }

  const uptermServer = core.getInput('upterm-server');
  if (!uptermServer) {
    throw new Error('upterm-server is required');
  }
}

export async function run() {
  try {
    validateInputs();

    await installDependencies();
    await setupSSH();
    await startUptermSession();
    await monitorSession();
  } catch (error: unknown) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed(String(error));
    }
  }
}

async function installDependencies(): Promise<void> {
  core.debug('Installing dependencies');
  const platformHandlers = {
    linux: async () => {
      const uptermArch = validateArchitecture(process.arch);
      const archive = await tc.downloadTool(`https://github.com/owenthereal/upterm/releases/latest/download/upterm_linux_${uptermArch}.tar.gz`);
      const extractDir = await tc.extractTar(archive);
      const uptermPath = path.join(extractDir, 'upterm');

      if (!fs.existsSync(uptermPath)) {
        throw new Error(`Downloaded upterm archive does not contain binary at expected path: ${uptermPath}`);
      }

      core.addPath(extractDir);
      await execShellCommand('if ! command -v tmux &>/dev/null; then sudo apt-get update && sudo apt-get -y install tmux; fi');
    },
    win32: async () => {
      const uptermArch = validateArchitecture(process.arch);
      const archive = await tc.downloadTool(`https://github.com/owenthereal/upterm/releases/latest/download/upterm_windows_${uptermArch}.tar.gz`);
      const extractDir = await tc.extractTar(archive);
      const uptermExePath = path.join(extractDir, 'upterm.exe');

      if (!fs.existsSync(uptermExePath)) {
        throw new Error(`Downloaded upterm archive does not contain upterm.exe at expected path: ${uptermExePath}`);
      }

      core.addPath(extractDir);
      await execShellCommand('if ! command -v tmux &>/dev/null; then pacman -S --noconfirm tmux; fi');
    },
    darwin: async () => {
      await execShellCommand('brew install owenthereal/upterm/upterm tmux');
    }
  };

  const handler = platformHandlers[process.platform as keyof typeof platformHandlers];
  if (!handler) {
    throw new Error(`Unsupported platform: ${process.platform}`);
  }

  try {
    await handler();
    core.debug('Installed dependencies successfully');
  } catch (error) {
    throw new Error(`Failed to install dependencies on ${process.platform}: ${error}`);
  }
}

async function generateSSHKeys(sshPath: string): Promise<void> {
  const idRsaPath = path.join(sshPath, 'id_rsa');
  const idEd25519Path = path.join(sshPath, 'id_ed25519');

  if (fs.existsSync(idRsaPath)) {
    core.debug('SSH key already exists');
    return;
  }

  core.debug('Generating SSH keys');
  fs.mkdirSync(sshPath, {recursive: true});

  // Use absolute paths instead of ~ to avoid MSYS2 home directory mismatch on Windows
  const rsaKeyPath = toShellPath(idRsaPath);
  const ed25519KeyPath = toShellPath(idEd25519Path);

  try {
    await execShellCommand(`ssh-keygen -q -t rsa -N "" -f "${rsaKeyPath}"; ssh-keygen -q -t ed25519 -N "" -f "${ed25519KeyPath}"`);
    core.debug('Generated SSH keys successfully');
  } catch (error) {
    throw new Error(`Failed to generate SSH keys: ${error}`);
  }
}

function configureSSHClient(sshPath: string): void {
  core.debug('Configuring ssh client');
  const sshConfig = `Host *
  StrictHostKeyChecking no
  CheckHostIP no
  TCPKeepAlive yes
  ServerAliveInterval 30
  ServerAliveCountMax 180
  VerifyHostKeyDNS yes
  UpdateHostKeys yes
  AddressFamily inet
`;
  fs.appendFileSync(path.join(sshPath, 'config'), sshConfig);
}

async function setupSSH(): Promise<void> {
  const sshPath = path.join(os.homedir(), '.ssh');

  await generateSSHKeys(sshPath);
  configureSSHClient(sshPath);
}

function getAllowedUsers(): string[] {
  const allowedUsers = core
    .getInput('limit-access-to-users')
    .split(/[\s\n,]+/)
    .filter(Boolean);

  if (core.getInput('limit-access-to-actor') === 'true') {
    core.info(`Adding actor "${github.context.actor}" to allowed users.`);
    allowedUsers.push(github.context.actor);
  }

  return [...new Set(allowedUsers)];
}

function buildAuthorizedKeysParameter(allowedUsers: string[], authorizedKeysFile?: string): string {
  const parts: string[] = [];
  const userParts = allowedUsers.map(user => `--github-user '${user}'`).filter(Boolean);
  if (userParts.length) parts.push(...userParts);
  if (authorizedKeysFile) parts.push(`--authorized-keys '${toShellPath(authorizedKeysFile)}'`);
  return parts.length ? parts.join(' ') + ' ' : '';
}

function getAuthorizedKeysFilePath(): string {
  return process.platform === 'win32' ? 'C:/msys64/tmp/upterm-authorized-keys' : '/tmp/upterm-authorized-keys';
}

function writeAuthorizedKeysFile(keysContent: string): string {
  const filePath = getAuthorizedKeysFilePath();
  fs.writeFileSync(filePath, keysContent.trim() + '\n', {mode: 0o600});
  return filePath;
}

async function createUptermSession(uptermServer: string, authorizedKeysParameter: string, hideClientIp: boolean, forceCommand: string): Promise<void> {
  core.info(`Creating a new session. Connecting to upterm server ${uptermServer}`);
  
  // Build additional flags
  const hideClientIpFlag = hideClientIp ? '--hide-client-ip ' : '';
  // Use custom force-command if provided, otherwise default to tmux attach
  const effectiveForceCommand = forceCommand || 'tmux attach -t upterm';
  const forceCommandFlag = `--force-command '${effectiveForceCommand}' `;
  
  try {
    await execShellCommand(
      `tmux new -d -s upterm-wrapper -x ${TMUX_DIMENSIONS.width} -y ${TMUX_DIMENSIONS.height} "upterm host --skip-host-key-check --accept --server '${uptermServer}' ${authorizedKeysParameter}${hideClientIpFlag}${forceCommandFlag}-- tmux new -s upterm -x ${TMUX_DIMENSIONS.width} -y ${TMUX_DIMENSIONS.height} 2>&1 | tee ${getUptermCommandLogPath()}" 2>${getTmuxErrorLogPath()}`
    );
    await execShellCommand('tmux set -t upterm-wrapper window-size largest; tmux set -t upterm window-size largest');
    core.debug('Created new session successfully');
  } catch (error) {
    try {
      const tmuxError = await execShellCommand(`cat ${getTmuxErrorLogPath()} 2>/dev/null || echo "No tmux error log found"`);
      core.error(`Tmux error log: ${tmuxError.trim()}`);
    } catch (logError) {
      core.debug(`Could not read tmux error log: ${logError}`);
    }
    throw new Error(`Failed to create upterm session: ${error}`);
  }
}

async function setupSessionTimeout(waitTimeoutMinutes: string): Promise<void> {
  const timeout = parseInt(waitTimeoutMinutes, 10);
  const timeoutFlagPath = getUptermTimeoutFlagPath();

  const timeoutScript = `
    (
      sleep $(( ${timeout} * 60 ));
      if ! pgrep -f '^tmux attach ' &>/dev/null; then
        echo "UPTERM_TIMEOUT_REACHED" > ${timeoutFlagPath};
        tmux kill-server;
      fi
    ) & disown
  `;

  try {
    await execShellCommand(timeoutScript);
    core.info(`wait-timeout-minutes set - will wait for ${waitTimeoutMinutes} minutes for someone to connect, otherwise shut down`);
  } catch (error) {
    throw new Error(`Failed to setup timeout: ${error}`);
  }
}

async function collectDiagnostics(): Promise<string> {
  const socketDirs = getUptermSocketDirs();
  let diagnostics = 'Failed to start upterm - socket not found after maximum retries.\n\nDiagnostics:\n';

  diagnostics += `- Searched socket directories:\n`;
  for (const uptermDir of socketDirs) {
    if (fs.existsSync(uptermDir)) {
      const files = fs.readdirSync(uptermDir);
      diagnostics += `  * ${uptermDir}: exists, contains [${files.join(', ') || 'empty'}]\n`;

      const logPath = path.join(uptermDir, 'upterm.log');
      if (fs.existsSync(logPath)) {
        try {
          const logContent = fs.readFileSync(logPath, 'utf8');
          diagnostics += `    - Upterm log:\n${logContent}\n`;
        } catch (error) {
          diagnostics += `    - Could not read upterm.log: ${error}\n`;
        }
      }
    } else {
      diagnostics += `  * ${uptermDir}: does not exist\n`;
    }
  }

  // Check tmux sessions
  try {
    const tmuxList = await execShellCommand('tmux list-sessions 2>/dev/null || echo "No tmux sessions"');
    diagnostics += `- Tmux sessions: ${tmuxList.trim()}\n`;
  } catch (error) {
    diagnostics += `- Could not check tmux sessions: ${error}\n`;
  }

  // Check tmux error log
  try {
    const tmuxErrorLog = await execShellCommand(`cat ${getTmuxErrorLogPath()} 2>/dev/null || echo "No tmux error log"`);
    if (tmuxErrorLog.trim() !== 'No tmux error log') {
      diagnostics += `- Tmux error log:\n${tmuxErrorLog.trim()}\n`;
    }
  } catch (error) {
    diagnostics += `- Could not read tmux error log: ${error}\n`;
  }

  // Check upterm command output log
  try {
    const cmdLog = await execShellCommand(`cat ${getUptermCommandLogPath()} 2>/dev/null || echo "No command log"`);
    if (cmdLog.trim() !== 'No command log') {
      diagnostics += `- Upterm command output:\n${cmdLog.trim()}\n`;
    }
  } catch (error) {
    diagnostics += `- Could not read command log: ${error}\n`;
  }

  // Check if upterm is in PATH
  try {
    const uptermVersion = await execShellCommand('upterm version 2>&1 || echo "upterm not found in PATH"');
    diagnostics += `- Upterm binary check: ${uptermVersion.trim()}\n`;
  } catch (error) {
    diagnostics += `- Could not check upterm binary: ${error}\n`;
  }

  // Check environment
  diagnostics += `- XDG_RUNTIME_DIR: ${process.env.XDG_RUNTIME_DIR || 'not set'}\n`;
  diagnostics += `- USER: ${process.env.USER || 'not set'}\n`;
  diagnostics += `- UID: ${process.getuid ? process.getuid() : 'unknown'}\n`;

  diagnostics += '\nPlease report this issue with the above diagnostics at: https://github.com/owenthereal/action-upterm/issues';
  return diagnostics;
}

async function checkUptermReady(): Promise<boolean> {
  // First try to find socket file
  if (uptermSocketExists()) {
    return true;
  }

  // Fallback: try running upterm session current without socket path
  // upterm 0.20.0+ may not always create socket in expected locations
  try {
    const output = await execShellCommand('upterm session current 2>&1');
    // If the command succeeds and shows session info, upterm is ready
    if (output.includes('Session:') || output.includes('SSH Command:') || output.includes('Command:')) {
      core.debug('Upterm ready detected via session current command');
      return true;
    }
  } catch {
    // Command failed, upterm not ready yet
  }

  return false;
}

async function waitForUptermReady(): Promise<void> {
  let tries = UPTERM_READY_MAX_RETRIES;
  while (tries-- > 0) {
    core.info(`Waiting for upterm to be ready... (${UPTERM_READY_MAX_RETRIES - tries}/${UPTERM_READY_MAX_RETRIES})`);
    if (await checkUptermReady()) return;
    await sleep(UPTERM_SOCKET_POLL_INTERVAL);
  }

  // Socket not found after retries, collect diagnostics
  const diagnostics = await collectDiagnostics();
  throw new Error(diagnostics);
}

async function startUptermSession(): Promise<void> {
  const allowedUsers = getAllowedUsers();
  const authorizedKeysInput = core.getInput('authorized-keys');
  const authorizedKeysFile = authorizedKeysInput ? writeAuthorizedKeysFile(authorizedKeysInput) : undefined;
  const authorizedKeysParameter = buildAuthorizedKeysParameter(allowedUsers, authorizedKeysFile);
  const uptermServer = core.getInput('upterm-server');
  const waitTimeoutMinutes = core.getInput('wait-timeout-minutes');
  const hideClientIp = core.getInput('hide-client-ip') === 'true';
  const forceCommand = core.getInput('force-command');

  await createUptermSession(uptermServer, authorizedKeysParameter, hideClientIp, forceCommand);
  await sleep(UPTERM_INIT_DELAY);

  if (waitTimeoutMinutes) {
    await setupSessionTimeout(waitTimeoutMinutes);
  }

  await waitForUptermReady();
}

async function monitorSession(): Promise<void> {
  core.debug('Entering main loop');
  // Main loop: wait for /continue file or upterm exit
  /*eslint no-constant-condition: ["error", { "checkLoops": false }]*/
  while (true) {
    if (continueFileExists()) {
      core.info("Exiting debugging session because '/continue' file was created");
      break;
    }

    // Check if timeout was reached before checking socket
    if (isTimeoutReached()) {
      logTimeoutMessage();
      break;
    }

    // Check if upterm is still running
    if (!(await checkUptermReady())) {
      core.info("Exiting debugging session: 'upterm' quit");
      break;
    }

    try {
      const socketPath = findUptermSocket();
      if (socketPath) {
        core.info(await execShellCommand(`upterm session current --admin-socket "${socketPath}"`));
      } else {
        // Try without socket path (upterm 0.20.0+ may work without explicit socket)
        core.info(await execShellCommand('upterm session current'));
      }
    } catch (error) {
      // Check if this error is due to timeout before throwing
      if (isTimeoutReached()) {
        logTimeoutMessage();
        break;
      }
      // For other connection issues, provide more context
      const errorMessage = String(error);
      if (errorMessage.includes('connection refused') || errorMessage.includes('No such file or directory')) {
        core.error('Upterm session appears to have ended unexpectedly');
        core.error(`Connection error: ${errorMessage}`);
        core.info('This may indicate the upterm process crashed or was terminated externally');
        break;
      }
      throw new Error(`Failed to get upterm session status: ${error}`);
    }
    await sleep(SESSION_STATUS_POLL_INTERVAL);
  }
}

function getUptermSocketDirs(): string[] {
  // Upterm uses adrg/xdg library for socket storage
  // See: https://github.com/owenthereal/upterm/pull/398
  // XDG RuntimeDir: https://pkg.go.dev/github.com/adrg/xdg#RuntimeDir
  // 
  // The xdg library has fallback behavior when XDG_RUNTIME_DIR is not set:
  // 1. First tries $XDG_RUNTIME_DIR
  // 2. Falls back to /run/user/$UID
  // 3. If that doesn't exist, may fall back to /tmp or other locations
  const dirs: string[] = [];

  if (process.platform === 'linux') {
    // Primary: $XDG_RUNTIME_DIR/upterm
    if (process.env.XDG_RUNTIME_DIR) {
      dirs.push(path.join(process.env.XDG_RUNTIME_DIR, 'upterm'));
    }
    // Fallback: /run/user/$(id -u)/upterm
    const uid = process.getuid ? process.getuid() : 1000;
    dirs.push(`/run/user/${uid}/upterm`);
    // Additional fallback paths for Docker containers where /run/user doesn't exist
    // xdg library may use /tmp as fallback
    dirs.push('/tmp/upterm');
    dirs.push(path.join(os.homedir(), '.local', 'share', 'upterm'));
    dirs.push(path.join(os.homedir(), '.upterm'));
  } else if (process.platform === 'darwin') {
    // macOS: ~/Library/Application Support/upterm
    dirs.push(path.join(os.homedir(), 'Library', 'Application Support', 'upterm'));
  } else {
    // Windows: %LOCALAPPDATA%\upterm
    dirs.push(path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'upterm'));
  }

  return dirs;
}

// Keep for backwards compatibility and diagnostics
function getUptermSocketDir(): string {
  const dirs = getUptermSocketDirs();
  return dirs[0];
}

function findUptermSocket(): string | null {
  // Try all possible socket directories
  for (const uptermDir of getUptermSocketDirs()) {
    if (!fs.existsSync(uptermDir)) continue;

    const socketFile = fs.readdirSync(uptermDir).find(file => file.endsWith('.sock'));
    if (socketFile) {
      return toShellPath(path.join(uptermDir, socketFile));
    }
  }

  return null;
}

function uptermSocketExists(): boolean {
  return findUptermSocket() !== null;
}

function continueFileExists(): boolean {
  const continuePath = process.platform === 'win32' ? PATHS.continueFile.win32 : PATHS.continueFile.unix;
  return fs.existsSync(continuePath) || fs.existsSync(path.join(process.env.GITHUB_WORKSPACE ?? '/', 'continue'));
}

function isTimeoutReached(): boolean {
  return fs.existsSync(getUptermTimeoutFlagPath());
}

function logTimeoutMessage(): void {
  core.info('Upterm session timed out - no client connected within the specified wait-timeout-minutes');
  core.info('The session was automatically shut down to prevent unnecessary resource usage');
}
