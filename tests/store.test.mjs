import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectFinalShotsForExport, ConflictError, createStore, validateImageBuffer, ValidationError } from '../server/store.mjs';

const ONE_PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function corruptPngDeflate(source) {
  const buffer = Buffer.from(source);
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') {
      const dataStart = offset + 8;
      buffer[dataStart + 2] = 0x07;
      const crc = crc32(buffer.subarray(offset + 4, dataStart + length));
      buffer.writeUInt32BE(crc, dataStart + length);
      return buffer;
    }
    offset += 12 + length;
  }
  throw new Error('test PNG has no IDAT');
}

function projectState() {
  const shot = { id: 's1', no: 1, camera: '中景', scene: '室内', duration: '2s', desc: '人物抬头', dialogue: '无' };
  return {
    projectName: '测试项目', shots: [shot], assets: [], runs: [], activeBatchId: 'b1',
    batches: [
      { id: 'b1', name: '第1批', status: 'pending', pendingNos: [1], assetIds: [], annotations: [], versions: [], draft: '' },
      { id: 'b2', name: '第2批', status: 'pending', pendingNos: [1], assetIds: [], annotations: [], versions: [], draft: '' },
    ],
  };
}

test('不同批次生成不同令牌且上下文不交叉', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'storyboard-store-'));
  const store = createStore({ rootDir });
  await store.replaceProject(projectState(), 0);
  const first = await store.createRun('b1', 'first');
  const second = await store.createRun('b2', 'first');
  assert.notEqual(first.run.token, second.run.token);
  const context = await store.contextForToken(first.run.token);
  assert.equal(context.batchId, 'b1');
  assert.equal(context.assets.length, 0);
  assert.match(context.isolationRequirement, /不得参考、复用、临摹或延续/);
  assert.match(context.imageScript, /^分镜脚本\n/);
  assert.equal(context.gridCols, 1);
  assert.equal(context.gridRows, 1);
});

test('提交版本可幂等重试，且失败不产生半版本', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'storyboard-submit-'));
  const store = createStore({ rootDir });
  await store.replaceProject(projectState(), 0);
  const { run } = await store.createRun('b1', 'first');
  const imagePath = join(rootDir, 'generated.png');
  await writeFile(imagePath, ONE_PIXEL_PNG);
  const input = {
    token: run.token,
    imagePath,
    gridCols: 1,
    gridRows: 1,
    idempotencyKey: 'same-result',
  };
  const created = await store.submitVersion(input);
  assert.equal(created.duplicate, false);
  const duplicate = await store.submitVersion(input);
  assert.equal(duplicate.duplicate, true);
  const state = await store.readState();
  assert.equal(state.batches[0].versions.length, 1);
  assert.equal(state.batches[0].status, 'reviewing');

  const rootDir2 = await mkdtemp(join(tmpdir(), 'storyboard-fail-'));
  const store2 = createStore({ rootDir: rootDir2 });
  await store2.replaceProject(projectState(), 0);
  const failedRun = await store2.createRun('b1', 'first');
  await assert.rejects(() => store2.submitVersion({ ...input, token: failedRun.run.token, imagePath: join(rootDir2, 'missing.png') }), ValidationError);
  assert.equal((await store2.readState()).batches[0].versions.length, 0);
});

test('不同运行不得把历史宫格作为本次新结果回填', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'storyboard-no-old-grid-'));
  const store = createStore({ rootDir });
  await store.replaceProject(projectState(), 0);
  const first = await store.createRun('b1', 'first');
  const firstImage = join(rootDir, 'first.png');
  await writeFile(firstImage, ONE_PIXEL_PNG);
  await store.submitVersion({ token: first.run.token, imagePath: firstImage, gridCols: 1, gridRows: 1, idempotencyKey: 'first-grid' });

  const second = await store.createRun('b2', 'first');
  const copiedOldImage = join(rootDir, 'copied-old.png');
  await writeFile(copiedOldImage, ONE_PIXEL_PNG);
  await assert.rejects(
    () => store.submitVersion({ token: second.run.token, imagePath: copiedOldImage, gridCols: 1, gridRows: 1, idempotencyKey: 'second-grid' }),
    /历史宫格/,
  );
  assert.equal((await store.readState()).batches[1].versions.length, 0);
});

test('DataURL 图片落盘并从项目 JSON 中移除', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'storyboard-image-'));
  const store = createStore({ rootDir });
  const state = projectState();
  state.assets.push({ id: 'a1', name: '人物', type: 'character', img: `data:image/png;base64,${ONE_PIXEL_PNG.toString('base64')}` });
  const saved = await store.replaceProject(state, 0);
  assert.match(saved.assets[0].img, /^\/files\/assets\//);
  const disk = await readFile(store.stateFile, 'utf8');
  assert.doesNotMatch(disk, /data:image/);
});

test('严格图片校验可在上传阶段识别 PNG deflate 损坏', () => {
  assert.equal(validateImageBuffer(ONE_PIXEL_PNG).format, 'PNG');
  assert.throws(() => validateImageBuffer(corruptPngDeflate(ONE_PIXEL_PNG)), /Corrupt deflate stream|InvalidBlockType/);
});

test('创建任务前一次返回本批全部坏图', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'storyboard-all-bad-assets-'));
  const store = createStore({ rootDir });
  await store.readState();
  const broken = corruptPngDeflate(ONE_PIXEL_PNG);
  await writeFile(join(rootDir, 'data', 'assets', 'bad-a.png'), broken);
  await writeFile(join(rootDir, 'data', 'assets', 'bad-b.png'), broken);
  const state = projectState();
  state.assets = [
    { id: 'bad-a', name: '关灯后-全景', type: 'scene', img: '/files/assets/bad-a.png' },
    { id: 'bad-b', name: '关灯后-平视', type: 'scene', img: '/files/assets/bad-b.png' },
  ];
  state.batches[0].assetIds = ['bad-a', 'bad-b'];
  await store.replaceProject(state, 0);
  await assert.rejects(() => store.createRun('b1'), (error) => {
    assert.ok(error instanceof ValidationError);
    assert.equal(error.issues.length, 2);
    assert.deepEqual(error.issues.map((issue) => issue.name), ['关灯后-全景', '关灯后-平视']);
    return true;
  });
});

test('每批超过 5 张参考图时创建任务被前置拦截', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'storyboard-reference-limit-'));
  const store = createStore({ rootDir });
  const state = projectState();
  state.assets = Array.from({ length: 6 }, (_, index) => ({
    id: `asset-${index + 1}`,
    name: `参考图${index + 1}`,
    type: 'scene',
    img: `data:image/png;base64,${ONE_PIXEL_PNG.toString('base64')}`,
  }));
  state.batches[0].assetIds = state.assets.map((asset) => asset.id);
  await store.replaceProject(state, 0);
  await assert.rejects(() => store.createRun('b1'), (error) => {
    assert.ok(error instanceof ValidationError);
    assert.match(error.message, /参考资产校验未通过/);
    assert.match(error.issues[0].reason, /最多接受 5 张/);
    return true;
  });
});

test('超过 4MB 的参考图即使结构可读也不进入 Codex', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'storyboard-reference-compat-'));
  const store = createStore({ rootDir });
  await store.readState();
  const oversized = Buffer.concat([ONE_PIXEL_PNG, Buffer.alloc(4 * 1024 * 1024)]);
  await writeFile(join(rootDir, 'data', 'assets', 'oversized.png'), oversized);
  const state = projectState();
  state.assets = [{ id: 'oversized', name: '超大参考图', type: 'scene', img: '/files/assets/oversized.png' }];
  state.batches[0].assetIds = ['oversized'];
  await store.replaceProject(state, 0);
  const result = await store.validateBatchAssets('b1');
  assert.equal(result.valid, false);
  assert.match(result.issues[0].reason, /超过 Codex 参考图兼容大小 4MB/);
});

test('旧 localStorage 只在空服务中迁移一次', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'storyboard-migrate-'));
  const store = createStore({ rootDir });
  const first = await store.migrateLegacy(projectState());
  assert.equal(first.migrated, true);
  const other = projectState();
  other.projectName = '不应覆盖';
  const second = await store.migrateLegacy(other);
  assert.equal(second.migrated, false);
  assert.equal(second.state.projectName, '测试项目');
});

test('旧版 rawBlock 自动拆分构图、声音和情绪目标且保留镜头标识', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'storyboard-shot-upgrade-'));
  const store = createStore({ rootDir });
  const state = projectState();
  state.shots[0] = {
    id: 'legacy-shot-1',
    no: 1,
    camera: '中景',
    desc: '人物推门\n构图：门框形成前景遮挡\n台词/心声/音效：门轴吱呀声\n情绪目标：不安升级',
    scene: '卧室-床区-深夜',
    rawBlock: '镜头1\n机位/景别/运镜：中景\n构图：门框形成前景遮挡\n画面内容：人物推门\n台词/心声/音效：门轴吱呀声\n情绪目标：不安升级',
  };
  const saved = await store.replaceProject(state, 0);
  assert.equal(saved.shots[0].id, 'legacy-shot-1');
  assert.equal(saved.shots[0].desc, '人物推门');
  assert.equal(saved.shots[0].composition, '门框形成前景遮挡');
  assert.equal(saved.shots[0].dialogue, '门轴吱呀声');
  assert.equal(saved.shots[0].emotion, '不安升级');
  assert.equal(saved.shots[0].scene, '卧室-床区-深夜');
});

test('已通过批次只归一本批镜号且不再改写总池或其他批次', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'storyboard-batch-range-repair-'));
  const store = createStore({ rootDir });
  const shot = (no, desc) => ({ id: `pool-${no}`, no, camera: '中景', scene: '室内', duration: '1s', desc, dialogue: '' });
  const state = {
    projectName: '批次重排测试',
    shots: [shot(1, '一'), shot(3, '二'), shot(4, '三'), shot(5, '四')],
    assets: [], runs: [], activeBatchId: 'b2',
    batches: [
      { id: 'b1', name: '第1批', status: 'passed', rangeStart: 1, sourceCount: 1, assetIds: [], annotations: [], versions: [{ id: 'v1', label: 'v1', image: '', shots: [shot(1, '一')] }] },
      { id: 'b2', name: '第2批', status: 'passed', rangeStart: 2, sourceCount: 2, assetIds: [], annotations: [], versions: [{ id: 'v2', label: 'v1', image: '', shots: [shot(3, '二'), shot(4, '三')] }] },
    ],
  };
  const saved = await store.replaceProject(state, 0);
  assert.deepEqual(saved.batches[1].versions[0].shots.map((item) => item.no), [2, 3]);
  assert.deepEqual(saved.shots.map((item) => item.no), [1, 3, 4, 5]);
  assert.deepEqual(saved.batches[0].versions[0].shots.map((item) => item.no), [1]);
});

test('终版导出按批次顺序检查镜号并自动消除缺口和重复', () => {
  const shot = (no, desc) => ({ id: `${desc}-${no}`, no, camera: '中景', scene: '室内', duration: '1s', desc, dialogue: '' });
  const state = {
    shots: [],
    batches: [
      { id: 'b1', rangeStart: 1, versions: [{ shots: [shot(1, '一'), shot(2, '二')] }] },
      { id: 'b2', rangeStart: 2, versions: [{ shots: [shot(2, '三'), shot(3, '四')] }] },
    ],
  };
  const result = collectFinalShotsForExport(state);
  assert.equal(result.renumbered, true);
  assert.deepEqual(result.shots.map((item) => item.no), [1, 2, 3, 4]);
  assert.deepEqual(result.shots.map((item) => item.desc), ['一', '二', '三', '四']);
});

test('仅可删除最新批次并同时移除该批运行记录', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'storyboard-delete-latest-'));
  const store = createStore({ rootDir });
  await store.readState();
  const versionImage = join(rootDir, 'data', 'versions', 'delete-me.png');
  await writeFile(versionImage, ONE_PIXEL_PNG);
  const state = projectState();
  state.batches[1].versions = [{ id: 'v-delete', label: 'v1', image: '/files/versions/delete-me.png', shots: [state.shots[0]] }];
  state.runs = [
    { id: 'r1', batchId: 'b1', token: 't1', status: 'failed' },
    { id: 'r2', batchId: 'b2', token: 't2', status: 'failed' },
  ];
  await store.replaceProject(state, 0);
  await assert.rejects(() => store.deleteLatestBatch('b1'), /只能删除最新批次/);
  const result = await store.deleteLatestBatch('b2');
  assert.equal(result.deleted.name, '第2批');
  assert.deepEqual(result.state.batches.map((batch) => batch.id), ['b1']);
  assert.deepEqual(result.state.runs.map((run) => run.id), ['r1']);
  assert.equal(result.state.activeBatchId, 'b1');
  await assert.rejects(() => readFile(versionImage));
});

test('批次创建后使用源镜头快照，不受总池后续改号影响', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'storyboard-frozen-batch-'));
  const store = createStore({ rootDir });
  const first = await store.replaceProject(projectState(), 0);
  first.shots[0].no = 99;
  await store.replaceProject(first, first.revision);
  const { run } = await store.createRun('b1');
  const context = await store.contextForToken(run.token);
  assert.deepEqual(context.shots.map((shot) => shot.no), [1]);
});

test('批次起点覆盖源镜头旧编号并贯穿生图脚本与回填版本', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'storyboard-authoritative-nos-'));
  const store = createStore({ rootDir });
  const makeShot = (no) => ({ id: `s${no}`, no, camera: '中景', scene: '卧室', duration: '1s', desc: `画面${no}`, dialogue: '' });
  const oldShots = [makeShot(10), makeShot(11)];
  const state = {
    projectName: '镜号一致性', shots: oldShots, assets: [], runs: [], activeBatchId: 'b1',
    batches: [{
      id: 'b1', name: '第2批', status: 'pending', rangeStart: 9, sourceCount: 2,
      pendingNos: [10, 11], sourceShots: oldShots, assetIds: [], annotations: [], versions: [], draft: '',
    }],
  };
  const saved = await store.replaceProject(state, 0);
  assert.deepEqual(saved.batches[0].sourceShots.map((shot) => shot.no), [9, 10]);
  const { run } = await store.createRun('b1');
  const context = await store.contextForToken(run.token);
  assert.deepEqual(context.shots.map((shot) => shot.no), [9, 10]);
  assert.deepEqual([...context.imageScript.matchAll(/镜头(\d+)/g)].map((match) => Number(match[1])), [9, 10]);

  const imagePath = join(rootDir, 'generated.png');
  await writeFile(imagePath, ONE_PIXEL_PNG);
  const result = await store.submitVersion({ token: run.token, imagePath, gridCols: 2, gridRows: 1, idempotencyKey: 'correct-nos' });
  assert.deepEqual(result.version.shots.map((shot) => shot.no), [9, 10]);
  assert.deepEqual([...result.version.rawText.matchAll(/镜头(\d+)/g)].map((match) => Number(match[1])), [9, 10]);
});

test('同批只允许一个进行中的任务', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'storyboard-active-run-'));
  const store = createStore({ rootDir });
  await store.replaceProject(projectState(), 0);
  await store.createRun('b1');
  await assert.rejects(() => store.createRun('b1'), ConflictError);
});

test('返修上下文只含文字意见，不暴露历史宫格路径', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'storyboard-revision-'));
  const store = createStore({ rootDir });
  const state = projectState();
  state.batches[0].status = 'reviewing';
  delete state.batches[0].pendingNos;
  state.batches[0].draft = '镜头1表情更克制';
  state.batches[0].versions.push({
    id: 'v1', label: 'v1', image: '/files/versions/old-grid.png', shots: [state.shots[0]], rawText: '', createdAt: Date.now(), gridCols: 1, gridRows: 1,
  });
  await store.replaceProject(state, 0);
  const { run } = await store.createRun('b1');
  const context = await store.contextForToken(run.token);
  assert.equal(context.mode, 'revision');
  assert.equal(context.feedback, '镜头1表情更克制');
  assert.doesNotMatch(JSON.stringify(context), /old-grid\.png/);
});

test('返修必须先修改并确认分镜脚本，回填使用同一份已确认文本', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'storyboard-revision-script-'));
  const store = createStore({ rootDir });
  const state = projectState();
  state.batches[0].status = 'reviewing';
  state.batches[0].draft = '镜头1改为缓慢抬头';
  state.batches[0].versions.push({
    id: 'v1', label: 'v1', image: '/files/versions/old-grid.png', shots: [state.shots[0]], rawText: '', createdAt: Date.now(), gridCols: 1, gridRows: 1,
  });
  await store.replaceProject(state, 0);
  const { run } = await store.createRun('b1');
  const imagePath = join(rootDir, 'generated.png');
  await writeFile(imagePath, ONE_PIXEL_PNG);
  await assert.rejects(() => store.prepareRevisionScript(run.token, '镜头1\n场景：室内\n时长：2s\n机位/景别/运镜：中景\n构图：\n画面内容：人物抬头\n台词 / 心声 / 音效：无\n情绪目标：'), /没有发生变化/);
  await assert.rejects(() => store.submitVersion({ token: run.token, imagePath, gridCols: 1, gridRows: 1, idempotencyKey: 'before-prepare' }), /尚未准备/);

  const revised = '镜头8\n场景：室内\n时长：2s\n机位/景别/运镜：中景\n构图：\n画面内容：人物缓慢抬头\n台词 / 心声 / 音效：无\n情绪目标：克制';
  const prepared = await store.prepareRevisionScript(run.token, revised);
  assert.match(prepared.imageScript, /人物缓慢抬头/);
  assert.match(prepared.scriptText, /镜头1/);
  assert.doesNotMatch(prepared.scriptText, /镜头8/);
  const result = await store.submitVersion({ token: run.token, imagePath, gridCols: 1, gridRows: 1, idempotencyKey: 'prepared-result' });
  assert.match(result.version.rawText, /人物缓慢抬头/);
  assert.match(result.version.rawText, /情绪目标：克制/);
});

test('返修允许批内新增镜头并按批次起点连续编号', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'storyboard-revision-count-'));
  const store = createStore({ rootDir });
  const state = projectState();
  state.batches = [state.batches[0]];
  state.batches[0].status = 'reviewing';
  state.batches[0].rangeStart = 1;
  state.batches[0].sourceCount = 1;
  state.batches[0].draft = '在本批新增一个猫咪特写镜头';
  state.batches[0].versions.push({
    id: 'v1', label: 'v1', image: '/files/versions/old-grid.png', shots: [state.shots[0]], rawText: '', createdAt: Date.now(), gridCols: 1, gridRows: 1,
  });
  await store.replaceProject(state, 0);
  const { run } = await store.createRun('b1');
  const prepared = await store.prepareRevisionScript(run.token, `【场景：室内】

镜头7
时长：1s
画面内容：人物缓慢抬头
台词 / 心声 / 音效：无 / 无 / 无

镜头20
时长：1s
画面内容：猫咪睁眼
台词 / 心声 / 音效：无 / 无 / 猫咪轻微呼噜声`);
  assert.equal(prepared.shotCountDelta, 1);
  assert.match(prepared.scriptText, /镜头1[\s\S]*镜头2/);
  assert.doesNotMatch(prepared.scriptText, /无\s*[\/／]/);
  assert.match(prepared.imageScript, /缺失项完全省略/);
});

test('上下文只返回当前批次勾选的参考资产', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'storyboard-assets-'));
  const store = createStore({ rootDir });
  const state = projectState();
  state.aspectRatio = '9:16';
  state.assets = [
    { id: 'selected', name: '本批道具', type: 'prop', img: `data:image/png;base64,${ONE_PIXEL_PNG.toString('base64')}` },
    { id: 'unused', name: '其他场景', type: 'scene', img: `data:image/png;base64,${ONE_PIXEL_PNG.toString('base64')}` },
  ];
  state.batches[0].assetIds = ['selected'];
  await store.replaceProject(state, 0);
  const { run } = await store.createRun('b1');
  const context = await store.contextForToken(run.token);
  assert.deepEqual(context.assets.map((asset) => asset.id), ['selected']);
  assert.equal(context.assets[0].type, 'prop');
  assert.equal(context.aspectRatio, '9:16');
  assert.match(context.assets[0].path, /assets/);
});

test('不可解析脚本和不足宫格均拒绝且不创建版本', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'storyboard-validate-'));
  const store = createStore({ rootDir });
  const state = projectState();
  state.shots.push({ ...state.shots[0], id: 's2', no: 2 });
  state.batches[0].pendingNos = [1, 2];
  await store.replaceProject(state, 0);
  const imagePath = join(rootDir, 'generated.png');
  await writeFile(imagePath, ONE_PIXEL_PNG);
  const { run } = await store.createRun('b1');

  await assert.rejects(() => store.submitVersion({
    token: run.token, imagePath, scriptText: '不是分镜文本', gridCols: 1, gridRows: 1, idempotencyKey: 'invalid-script',
  }), ValidationError);
  await assert.rejects(() => store.submitVersion({
    token: run.token,
    imagePath,
    scriptText: '镜头1\n机位/景别/运镜：中景\n画面内容：人物抬头\n台词 / 音效：无\n\n镜头2\n机位/景别/运镜：特写\n画面内容：人物停顿\n台词 / 音效：无',
    gridCols: 1,
    gridRows: 1,
    idempotencyKey: 'small-grid',
  }), ValidationError);
  assert.equal((await store.readState()).batches[0].versions.length, 0);
});
