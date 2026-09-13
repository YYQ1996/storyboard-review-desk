import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installHome = process.env.STORYBOARD_INSTALL_HOME
  ? resolve(process.env.STORYBOARD_INSTALL_HOME)
  : homedir();
const dryRun = process.env.STORYBOARD_INSTALL_DRY_RUN === '1';
const pluginName = 'storyboard-review-desk';
const pluginSource = join(rootDir, 'plugin', pluginName);
const personalPlugin = join(installHome, 'plugins', pluginName);
const marketplacePath = join(installHome, '.agents', 'plugins', 'marketplace.json');
const codexHome = process.env.CODEX_HOME
  ? resolve(process.env.CODEX_HOME)
  : join(installHome, '.codex');
const localAppData = process.env.LOCALAPPDATA || join(installHome, 'AppData', 'Local');
const bundledNode = process.platform === 'win32' ? join(rootDir, 'runtime', 'node.exe') : process.execPath;
const installerCodex = join(rootDir, 'runtime', process.platform === 'win32' ? 'codex-cli.exe' : 'codex-cli');
const pluginServer = join(pluginSource, 'server.mjs');
const logPath = join(rootDir, 'install-log.txt');
const codexEnv = {
  ...process.env,
  CODEX_HOME: codexHome,
  ...(process.platform === 'darwin' ? { HOME: installHome } : {}),
};

try {
  writeFileSync(logPath, `分镜审核台安装日志\n开始时间：${new Date().toISOString()}\n`, 'utf8');
} catch {}

function writeLog(level, message) {
  try { appendFileSync(logPath, `[${level}] ${message}\n`, 'utf8'); } catch {}
}

function info(message) {
  console.log(message);
  writeLog('INFO', message);
}

function fail(message) {
  console.error(`\n[失败] ${message}`);
  writeLog('ERROR', message);
  console.error(`安装日志：${logPath}`);
  process.exit(1);
}

function invokeCodex(candidate, args) {
  return spawnSync(candidate, args, {
    cwd: rootDir,
    encoding: 'utf8',
    windowsHide: true,
    env: codexEnv,
  });
}

function discoverCodexAppRoots() {
  if (process.platform !== 'win32') return [];
  if (process.env.STORYBOARD_TEST_CODEX_APP_ROOT) {
    return [resolve(process.env.STORYBOARD_TEST_CODEX_APP_ROOT)];
  }

  const powershell = process.env.SystemRoot
    ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
  const script = [
    "$package = Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue | Select-Object -First 1",
    "if ($package) { [Console]::Out.WriteLine($package.InstallLocation) }",
  ].join('; ');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    cwd: rootDir,
    encoding: 'utf8',
    windowsHide: true,
    env: codexEnv,
  });
  if (result.status !== 0) {
    writeLog('WARN', `无法查询 Codex Windows 应用位置：${result.error?.message || result.stderr || `exit ${result.status}`}`);
    return [];
  }
  return result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

function prepareCodexFromDesktopApp() {
  for (const appRoot of discoverCodexAppRoots()) {
    for (const relativePath of [join('app', 'resources', 'codex.exe'), join('resources', 'codex.exe')]) {
      const source = join(appRoot, relativePath);
      if (!existsSync(source)) continue;
      try {
        copyFileSync(source, installerCodex);
        const result = invokeCodex(installerCodex, ['--version']);
        if (!result.error && result.status === 0) {
          writeLog('INFO', `已从 Codex Windows 应用准备安装组件：${source}`);
          return installerCodex;
        }
        writeLog('WARN', `Codex Windows 应用组件无法运行：${result.error?.message || result.stderr || `exit ${result.status}`}`);
      } catch (error) {
        writeLog('WARN', `无法准备 Codex Windows 应用组件：${error.message}`);
      }
    }
  }
  return null;
}

function firstWorkingCodex(candidates) {
  for (const candidate of candidates) {
    const result = invokeCodex(candidate, ['--version']);
    if (!result.error && result.status === 0) return candidate;
  }
  return null;
}

function installCodexCliOnMac() {
  info('未找到可直接调用的 Codex 组件，正在安装 OpenAI 官方 Codex CLI...');
  const download = spawnSync('curl', ['-fsSL', 'https://chatgpt.com/codex/install.sh'], {
    cwd: rootDir,
    encoding: 'buffer',
    env: codexEnv,
  });
  if (download.error || download.status !== 0) {
    writeLog('WARN', `Codex CLI 下载失败：${download.error?.message || download.stderr?.toString('utf8') || `exit ${download.status}`}`);
    return null;
  }
  const install = spawnSync('/bin/sh', [], {
    cwd: rootDir,
    input: download.stdout,
    encoding: 'utf8',
    env: { ...codexEnv, CODEX_NON_INTERACTIVE: '1' },
  });
  if (install.error || install.status !== 0) {
    writeLog('WARN', `Codex CLI 安装失败：${install.error?.message || install.stderr || install.stdout || `exit ${install.status}`}`);
    return null;
  }
  writeLog('INFO', install.stdout || 'OpenAI 官方 Codex CLI 安装完成');
  return firstWorkingCodex([
    join(installHome, '.local', 'bin', 'codex'),
    process.env.CODEX_INSTALL_DIR && join(process.env.CODEX_INSTALL_DIR, 'codex'),
  ].filter(Boolean));
}

function findCodex() {
  if (process.platform === 'darwin') {
    const codex = firstWorkingCodex([
      process.env.CODEX_CLI,
      join(codexHome, 'plugins', '.plugin-appserver', 'codex'),
      'codex',
      process.env.CODEX_INSTALL_DIR && join(process.env.CODEX_INSTALL_DIR, 'codex'),
      join(installHome, '.local', 'bin', 'codex'),
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
      '/Applications/ChatGPT.app/Contents/Resources/codex',
      '/Applications/Codex.app/Contents/Resources/codex',
    ].filter(Boolean));
    return codex || installCodexCliOnMac();
  }

  const codex = firstWorkingCodex([
    process.env.CODEX_CLI,
    join(codexHome, 'plugins', '.plugin-appserver', 'codex.exe'),
    'codex',
    process.env.CODEX_INSTALL_DIR && join(process.env.CODEX_INSTALL_DIR, 'codex.exe'),
    join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'),
    join(localAppData, 'OpenAI', 'Codex', 'bin', 'codex.exe'),
    join(localAppData, 'OpenAI', 'Codex', 'manual-cli', 'codex.exe'),
    installerCodex,
  ].filter(Boolean));
  if (codex) return codex;
  return prepareCodexFromDesktopApp();
}

function readMarketplace() {
  if (!existsSync(marketplacePath)) {
    return { name: 'personal', interface: { displayName: 'Personal' }, plugins: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(marketplacePath, 'utf8'));
    if (!Array.isArray(parsed.plugins)) parsed.plugins = [];
    if (!parsed.name) parsed.name = 'personal';
    if (!parsed.interface) parsed.interface = { displayName: 'Personal' };
    return parsed;
  } catch {
    fail(`个人插件清单无法读取：${marketplacePath}\n请先备份或修复这个 JSON 文件。`);
  }
}

if (!['win32', 'darwin'].includes(process.platform)) fail('当前工具包仅支持 Windows 10 / 11 与 macOS。');
if (!existsSync(bundledNode) || !existsSync(pluginServer)) fail('工具包文件不完整，请重新下载并完整解压。');

mkdirSync(codexHome, { recursive: true });
info(`Codex 配置目录：${codexHome}`);

const codex = findCodex();
if (!codex) {
  const platformHelp = process.platform === 'darwin'
    ? '请确认 Mac 已联网，并已安装、登录且至少启动过一次 ChatGPT/Codex App。'
    : '请确认 Windows 版 ChatGPT/Codex App 已安装、已登录并至少启动过一次。';
  fail(`未找到可供安装器调用的 Codex 组件。${platformHelp}如果 App 正在运行，请发送 install-log.txt。`);
}

info(`Codex 命令位置：${codex}`);
info('1/4 正在部署分镜审核台个人插件...');
mkdirSync(personalPlugin, { recursive: true });
cpSync(pluginSource, personalPlugin, { recursive: true, force: true });

const mcpConfig = {
  mcpServers: {
    storyboard_review_desk: {
      command: bundledNode,
      args: [pluginServer],
      enabled: true,
      startup_timeout_sec: 30,
      env: { STORYBOARD_REVIEW_URL: 'http://127.0.0.1:43127' },
    },
  },
};
writeFileSync(join(personalPlugin, '.mcp.json'), `${JSON.stringify(mcpConfig, null, 2)}\n`, 'utf8');

info('2/4 正在登记个人插件...');
const marketplace = readMarketplace();
marketplace.plugins = marketplace.plugins.filter((item) => item?.name !== pluginName);
marketplace.plugins.push({
  name: pluginName,
  source: { source: 'local', path: `./plugins/${pluginName}` },
  policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
  category: 'Productivity',
});
mkdirSync(dirname(marketplacePath), { recursive: true });
if (existsSync(marketplacePath)) copyFileSync(marketplacePath, `${marketplacePath}.bak`);
writeFileSync(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`, 'utf8');

if (dryRun) {
  info('\n[成功] 工具包安装自检通过；未修改当前 Codex 插件缓存。');
  process.exit(0);
}

info('3/4 正在刷新 Codex 插件缓存...');
invokeCodex(codex, ['plugin', 'remove', `${pluginName}@${marketplace.name}`]);
const install = invokeCodex(codex, ['plugin', 'add', `${pluginName}@${marketplace.name}`]);
if (install.status !== 0) {
  fail(`Codex 插件安装失败。\n${install.error?.message || install.stderr || install.stdout || '请确认 Codex 已登录后重试。'}`);
}

info('4/4 正在确认安装结果...');
const list = invokeCodex(codex, ['plugin', 'list', '--json']);
if (list.status !== 0 || !list.stdout.includes(`${pluginName}@${marketplace.name}`)) {
  fail(`插件未出现在 Codex 已安装列表中，请重新运行安装脚本。\n${list.error?.message || list.stderr || ''}`);
}

info('\n[成功] 分镜审核台 v0.1.12 与个人插件均已就绪。');
const launcher = process.platform === 'darwin' ? '一键启动.command' : '一键启动.cmd';
info(`下一步：完整退出并重新打开 ChatGPT/Codex App，然后双击“${launcher}”。`);
