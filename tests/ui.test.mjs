import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const rootDir = resolve(import.meta.dirname, '..');
const appHtml = await readFile(join(rootDir, 'app', 'index.html'), 'utf8');
const serverSource = await readFile(join(rootDir, 'server', 'server.mjs'), 'utf8');
const pluginManifest = JSON.parse(await readFile(join(rootDir, 'plugin', 'storyboard-review-desk', '.codex-plugin', 'plugin.json'), 'utf8'));

function functionSource(name) {
  const start = appHtml.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const bodyStart = appHtml.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < appHtml.length; index += 1) {
    if (appHtml[index] === '{') depth += 1;
    if (appHtml[index] === '}') depth -= 1;
    if (depth === 0) return appHtml.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

test('后台回填刷新会实际恢复审核意见输入状态', () => {
  const batch = { id: 'batch-current', draft: '' };
  const before = { value: '整体节奏再紧一点', selectionStart: 2, selectionEnd: 6, scrollTop: 18 };
  const after = {
    value: '', selectionStart: 0, selectionEnd: 0, scrollTop: 0,
    focus(options) { this.focusOptions = options; context.document.activeElement = this; },
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
  };
  let currentInput = before;
  let saveCount = 0;
  const context = vm.createContext({
    state: { activeBatchId: batch.id },
    document: { activeElement: before },
    $: (selector) => selector === '#feedbackInput' ? currentInput : null,
    activeBatch: () => batch,
    save: () => { saveCount += 1; },
  });
  vm.runInContext(`${functionSource('captureReviewEditor')}\n${functionSource('restoreReviewEditor')}`, context);
  const snapshot = context.captureReviewEditor();
  currentInput = after;
  context.document.activeElement = null;
  context.restoreReviewEditor(snapshot);

  assert.equal(batch.draft, before.value);
  assert.equal(after.value, before.value);
  assert.deepEqual([after.selectionStart, after.selectionEnd, after.scrollTop], [2, 6, 18]);
  assert.equal(context.document.activeElement, after);
  assert.equal(after.focusOptions.preventScroll, true);
  assert.equal(saveCount, 1);

  const captureAt = appHtml.indexOf('const reviewEditor = captureReviewEditor();');
  const renderAt = appHtml.indexOf('renderAll();', captureAt);
  const restoreAt = appHtml.indexOf('restoreReviewEditor(reviewEditor);', renderAt);
  assert.ok(captureAt >= 0 && renderAt > captureAt && restoreAt > renderAt);
});

test('审核台展示品牌图标与开发者名称', async () => {
  await access(join(rootDir, 'app', 'assets', 'brand-icon.png'));
  assert.match(appHtml, /assets\/brand-icon\.png/);
  assert.match(appHtml, /by YIQI玩AI/);
  assert.match(appHtml, /YIQI玩AI · 出品/);
  assert.match(appHtml, /class="w-24 h-24 object-contain select-none opacity-90"/);
  assert.match(serverSource, /path === '\/assets\/brand-icon\.png'/);
});

test('Codex 插件清单接入品牌图标', async () => {
  const iconPath = join(rootDir, 'plugin', 'storyboard-review-desk', pluginManifest.interface.composerIcon.replace(/^\.\//, ''));
  await access(iconPath);
  assert.equal(pluginManifest.author.name, 'YIQI玩AI');
  assert.equal(pluginManifest.interface.developerName, 'YIQI玩AI');
  assert.equal(pluginManifest.interface.composerIcon, './assets/brand-icon.png');
  assert.equal(pluginManifest.interface.logo, './assets/brand-icon.png');
  assert.equal(pluginManifest.interface.logoDark, './assets/brand-icon.png');
});
