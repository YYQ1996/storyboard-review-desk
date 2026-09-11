import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function assertCrLfOnly(path) {
  const bytes = readFileSync(path);
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0a) {
      assert.equal(bytes[index - 1], 0x0d, `${path} 包含未配对的 LF 换行`);
    }
  }
}

test('Windows 一键安装入口使用 CRLF，避免 cmd.exe 闪退', { skip: process.platform !== 'win32' }, () => {
  assertCrLfOnly(join(projectRoot, '一键安装.cmd'));
  assertCrLfOnly(join(projectRoot, '一键启动.cmd'));
});

test('发布包入口可在隔离用户目录完成插件安装并显式传递 CODEX_HOME', {
  skip: process.platform !== 'win32' || process.env.STORYBOARD_INSTALL_E2E !== '1',
}, () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'storyboard-review-installer-'));
  try {
    const packageRoot = process.env.STORYBOARD_INSTALL_PACKAGE_ROOT
      ? resolve(process.env.STORYBOARD_INSTALL_PACKAGE_ROOT)
      : join(sandbox, '分镜审核台-v0.1.10-Windows');
    const installHome = join(sandbox, 'student-home');
    const fakeCodexLog = join(sandbox, 'fake-codex.jsonl');
    const fakeCodex = join(sandbox, 'fake-codex.exe');
    if (!process.env.STORYBOARD_INSTALL_PACKAGE_ROOT) {
      mkdirSync(join(packageRoot, 'runtime'), { recursive: true });
      mkdirSync(join(packageRoot, 'scripts'), { recursive: true });
      copyFileSync(process.execPath, join(packageRoot, 'runtime', 'node.exe'));
      copyFileSync(join(projectRoot, 'scripts', 'install.mjs'), join(packageRoot, 'scripts', 'install.mjs'));
      copyFileSync(join(projectRoot, '一键安装.cmd'), join(packageRoot, '一键安装.cmd'));
      cpSync(join(projectRoot, 'plugin'), join(packageRoot, 'plugin'), { recursive: true });
    }
    copyFileSync(process.execPath, fakeCodex);

    const fakeCodexHook = join(packageRoot, 'fake-codex-hook.cjs');
    writeFileSync(fakeCodexHook, [
      "const fs = require('node:fs');",
      "if (process.argv[1] && /[\\\\/]plugin$/.test(process.argv[1])) {",
      "  const args = process.argv.slice(2);",
      "  fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args, codexHome: process.env.CODEX_HOME }) + '\\n');",
      "  if (args[0] === 'list') process.stdout.write(JSON.stringify({ plugins: ['storyboard-review-desk@personal'] }));",
      "  process.exit(0);",
      "}",
    ].join('\n'), 'utf8');

    const env = {
      ...process.env,
      FAKE_CODEX_LOG: fakeCodexLog,
      NODE_OPTIONS: `--require=${fakeCodexHook}`,
      STORYBOARD_INSTALL_HOME: installHome,
      STORYBOARD_INSTALL_NONINTERACTIVE: '1',
      LOCALAPPDATA: join(sandbox, 'local-app-data'),
      PATH: join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
    };
    delete env.CODEX_HOME;
    mkdirSync(join(installHome, '.codex', 'plugins', '.plugin-appserver'), { recursive: true });
    copyFileSync(fakeCodex, join(installHome, '.codex', 'plugins', '.plugin-appserver', 'codex.exe'));

    const installerPath = join(packageRoot, '一键安装.cmd');
    const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'call', installerPath], {
      cwd: packageRoot,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });

    assert.equal(result.status, 0, JSON.stringify({
      status: result.status,
      signal: result.signal,
      error: result.error?.message,
      stdout: result.stdout,
      stderr: result.stderr,
    }));
    assert.match(`${result.stdout}\n${result.stderr}`, /分镜审核台 v0\.1\.10 与个人插件均已就绪/);
    assert.ok(existsSync(join(installHome, '.codex')), '安装器应创建默认 CODEX_HOME');
    assert.ok(existsSync(join(installHome, '.agents', 'plugins', 'marketplace.json')));
    assert.ok(existsSync(join(installHome, 'plugins', 'storyboard-review-desk', '.mcp.json')));
    assert.ok(existsSync(join(packageRoot, 'install-log.txt')));

    const calls = readFileSync(fakeCodexLog, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.deepEqual(calls.map((call) => call.args[0]), ['remove', 'add', 'list']);
    assert.ok(calls.every((call) => call.codexHome === join(installHome, '.codex')));
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('没有 PATH 和 plugin-appserver 时可从已安装的 ChatGPT Windows App 准备 Codex 组件', {
  skip: process.platform !== 'win32' || process.env.STORYBOARD_INSTALL_E2E !== '1',
}, () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'storyboard-review-app-bundle-'));
  try {
    const packageRoot = join(sandbox, '分镜审核台-v0.1.10-Windows');
    const installHome = join(sandbox, 'student-home');
    const appRoot = join(sandbox, 'windows-app-package');
    const fakeCodexLog = join(sandbox, 'fake-codex.jsonl');
    mkdirSync(join(packageRoot, 'runtime'), { recursive: true });
    mkdirSync(join(packageRoot, 'scripts'), { recursive: true });
    mkdirSync(join(appRoot, 'app', 'resources'), { recursive: true });
    copyFileSync(process.execPath, join(packageRoot, 'runtime', 'node.exe'));
    copyFileSync(join(projectRoot, 'scripts', 'install.mjs'), join(packageRoot, 'scripts', 'install.mjs'));
    copyFileSync(join(projectRoot, '一键安装.cmd'), join(packageRoot, '一键安装.cmd'));
    cpSync(join(projectRoot, 'plugin'), join(packageRoot, 'plugin'), { recursive: true });
    copyFileSync(process.execPath, join(appRoot, 'app', 'resources', 'codex.exe'));

    const fakeCodexHook = join(packageRoot, 'fake-codex-hook.cjs');
    writeFileSync(fakeCodexHook, [
      "const fs = require('node:fs');",
      "if (process.argv[1] && /[\\\\/]plugin$/.test(process.argv[1])) {",
      "  const args = process.argv.slice(2);",
      "  fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args, codexHome: process.env.CODEX_HOME }) + '\\n');",
      "  if (args[0] === 'list') process.stdout.write(JSON.stringify({ plugins: ['storyboard-review-desk@personal'] }));",
      "  process.exit(0);",
      "}",
    ].join('\n'), 'utf8');

    const env = {
      ...process.env,
      FAKE_CODEX_LOG: fakeCodexLog,
      NODE_OPTIONS: `--require=${fakeCodexHook}`,
      STORYBOARD_INSTALL_HOME: installHome,
      STORYBOARD_INSTALL_NONINTERACTIVE: '1',
      STORYBOARD_TEST_CODEX_APP_ROOT: appRoot,
      LOCALAPPDATA: join(sandbox, 'local-app-data'),
      PATH: join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
    };
    delete env.CODEX_HOME;
    delete env.CODEX_CLI;

    const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'call', join(packageRoot, '一键安装.cmd')], {
      cwd: packageRoot,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /runtime\\codex-cli\.exe/);
    assert.ok(existsSync(join(packageRoot, 'runtime', 'codex-cli.exe')));
    const calls = readFileSync(fakeCodexLog, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.deepEqual(calls.map((call) => call.args[0]), ['remove', 'add', 'list']);
    assert.ok(calls.every((call) => call.codexHome === join(installHome, '.codex')));
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('一键安装失败时窗口停留并等待用户确认', {
  skip: process.platform !== 'win32' || process.env.STORYBOARD_INSTALL_E2E !== '1',
}, async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'storyboard-review-installer-failure-'));
  try {
    const installerPath = join(sandbox, '一键安装.cmd');
    const installerSource = process.env.STORYBOARD_INSTALL_PACKAGE_ROOT
      ? join(resolve(process.env.STORYBOARD_INSTALL_PACKAGE_ROOT), '一键安装.cmd')
      : join(projectRoot, '一键安装.cmd');
    copyFileSync(installerSource, installerPath);
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'call', installerPath], {
      cwd: sandbox,
      env: { ...process.env, STORYBOARD_INSTALL_NONINTERACTIVE: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });

    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    assert.equal(child.exitCode, null, '失败窗口应停留在 pause，而不是立即退出');
    child.stdin.write('\r\n');
    child.stdin.end();
    const exitCode = await new Promise((resolveExit, rejectExit) => {
      child.once('error', rejectExit);
      child.once('close', resolveExit);
    });
    assert.equal(exitCode, 1);
    assert.match(output, /installer will stay open/i);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
