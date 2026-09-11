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
const bundledNode = join(rootDir, 'runtime', 'node.exe');
const pluginServer = join(pluginSource, 'server.mjs');
const logPath = join(rootDir, 'install-log.txt');
const codexEnv = { ...process.env, CODEX_HOME: codexHome };

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

function findCodex() {
  const candidates = [
    process.env.CODEX_CLI,
    'codex',
    process.env.CODEX_INSTALL_DIR && join(process.env.CODEX_INSTALL_DIR, 'codex.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin', 'codex.exe'),
    join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'manual-cli', 'codex.exe'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = invokeCodex(candidate, ['--version']);
    if (!result.error && result.status === 0) return candidate;
  }
  return null;
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

if (process.platform !== 'win32') fail('当前工具包仅支持 64 位 Windows 10 / 11。');
if (!existsSync(bundledNode) || !existsSync(pluginServer)) fail('工具包文件不完整，请重新下载并完整解压。');

mkdirSync(codexHome, { recursive: true });
info(`Codex 配置目录：${codexHome}`);

const codex = findCodex();
if (!codex) fail('未找到 Codex Windows 客户端。请先安装并登录 Codex，再重新运行一键安装。');

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

info('\n[成功] 分镜审核台 v0.1.9 与个人插件均已就绪。');
info('下一步：完整退出并重新打开 Codex，然后双击“一键启动.cmd”。');
