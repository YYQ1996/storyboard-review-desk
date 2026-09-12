import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readUnixScript(name) {
  const bytes = readFileSync(join(projectRoot, name));
  assert.equal(bytes.includes(Buffer.from('\r\n')), false, `${name} 必须使用 LF 换行`);
  const source = bytes.toString('utf8');
  assert.match(source, /^#!\/bin\/bash\n/);
  return source;
}

test('macOS 入口使用 LF 并同时覆盖 Apple Silicon 和 Intel', () => {
  for (const name of ['一键安装.command', '一键启动.command']) {
    const source = readUnixScript(name);
    assert.match(source, /arm64\) NODE="\$SCRIPT_DIR\/runtime\/darwin-arm64\/bin\/node"/);
    assert.match(source, /x86_64\) NODE="\$SCRIPT_DIR\/runtime\/darwin-x64\/bin\/node"/);
  }
});

test('macOS 安装器支持 darwin 并使用 OpenAI 官方 CLI 安装器兜底', () => {
  const source = readFileSync(join(projectRoot, 'scripts', 'install.mjs'), 'utf8');
  assert.match(source, /\['win32', 'darwin'\]/);
  assert.match(source, /https:\/\/chatgpt\.com\/codex\/install\.sh/);
  assert.match(source, /\.local', 'bin', 'codex'/);
  assert.match(source, /一键启动\.command/);
});

test('macOS 重复启动时先检查现有服务，不会再次监听端口', () => {
  const source = readUnixScript('一键启动.command');
  const healthCheck = source.indexOf('${URL}api/health');
  const serverStart = source.indexOf('server/server.mjs');
  assert.ok(healthCheck >= 0 && serverStart > healthCheck);
  assert.match(source, /分镜审核台已经在运行/);
});
