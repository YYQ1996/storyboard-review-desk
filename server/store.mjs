import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { parseShots, shotsToText } from './parser.mjs';

const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const MAX_REFERENCE_ASSETS = 14;
const MAX_CODEX_REFERENCE_INPUTS = 5;
const MAX_CODEX_REFERENCE_BYTES = 4 * 1024 * 1024;
const MAX_CODEX_REFERENCE_EDGE = 2048;
const ISOLATION_PROMPT = '调用 Codex 内置图片生成能力完成本次生图。仅参考本次提供的人物资产图、场景资产图、道具资产图和本次提示词文字。不得参考、复用、临摹或延续本任务中此前生成的任何分镜宫格图；此前宫格图仅代表待修结果，不属于本次参考输入。完成后必须调用分镜审核台的 submit_storyboard_version 工具回填结果。';

function gridLayout(count) {
  const cols = Math.ceil(Math.sqrt(Math.max(count, 1)));
  return { cols, rows: Math.ceil(Math.max(count, 1) / cols) };
}

function assetTypeLabel(type) {
  return type === 'character' ? '人物' : type === 'prop' ? '道具' : '场景';
}

export function groupReferenceAssets(assets) {
  const typedGroups = ['character', 'scene', 'prop']
    .map((type) => ({ type, assets: assets.filter((asset) => (asset.type || 'character') === type), boards: 0 }))
    .filter((group) => group.assets.length);
  if (!typedGroups.length) return [];
  for (const group of typedGroups) group.boards = 1;
  let remainingBoards = MAX_CODEX_REFERENCE_INPUTS - typedGroups.length;
  while (remainingBoards > 0) {
    const target = [...typedGroups].sort((a, b) => (
      (b.assets.length / b.boards) - (a.assets.length / a.boards)
      || b.assets.length - a.assets.length
      || ['character', 'scene', 'prop'].indexOf(a.type) - ['character', 'scene', 'prop'].indexOf(b.type)
    ))[0];
    target.boards += 1;
    remainingBoards -= 1;
  }
  return typedGroups.flatMap((group) => {
    const chunks = [];
    let offset = 0;
    for (let board = 0; board < group.boards; board += 1) {
      const remainingAssets = group.assets.length - offset;
      const remainingForType = group.boards - board;
      const size = Math.ceil(remainingAssets / remainingForType);
      chunks.push(group.assets.slice(offset, offset + size));
      offset += size;
    }
    return chunks;
  });
}

function referenceLines(state, batch, referenceSheets = []) {
  const assetById = new Map(state.assets.map((asset) => [asset.id, asset]));
  const selected = (batch.assetIds || []).map((id) => assetById.get(id)).filter(Boolean);
  const summary = selected.length
    ? `本批参考资产：${selected.map((asset) => `${assetTypeLabel(asset.type)}：${asset.name || '未命名资产'}`).join('；')}。`
    : '本批参考资产：无。';
  if (!referenceSheets.length) return [summary];
  return [
    summary,
    `参考资产索引板：以上 ${selected.length} 项资产已按人物、场景、道具分类合并为 ${referenceSheets.length} 张索引板，每张索引板只包含一种资产类型。索引板每格左上角的资产编号与下列清单一一对应；生成镜头时按分镜脚本中的人物、场景和道具名称匹配对应编号，不得混用。`,
    ...referenceSheets.map((sheet, index) => `索引板${index + 1}（${sheet.typeLabel}）：${sheet.items.map((item) => `${item.label}=${assetTypeLabel(item.type)}：${item.name || '未命名资产'}`).join('；')}。`),
  ];
}

function imageScriptFor(state, batch, shots, referenceSheets = []) {
  const { cols, rows } = gridLayout(shots.length);
  return [
    '分镜脚本',
    `项目：${state.projectName}`,
    `批次：${batch.name}`,
    `宫格布局：${cols}列×${rows}行，按镜号从左到右、从上到下排列，全部镜头合并在一张图中。`,
    `单格画幅：${state.aspectRatio === '9:16' ? '9:16竖版' : '16:9横版'}。`,
    '画格标注：左上角只显示“#镜号”。底部只原样显示本镜实际存在的台词、心声或音效文案；缺失项完全省略，不显示字段标签，不补“无”，不输出“无/无/”或空分隔符；本镜完全无声音时不显示底栏文字。',
    ...referenceLines(state, batch, referenceSheets),
    '',
    shotsToText(shots, false),
  ].join('\n');
}

function canonicalScript(text) {
  const shots = parseShots(text);
  return shots?.length ? shotsToText(shots, false) : '';
}

function numberBatchShots(batch, shots) {
  const ordered = [...(shots || [])].sort((a, b) => a.no - b.no);
  const start = Number(batch.rangeStart || ordered[0]?.no || 1);
  return ordered.map((shot, index) => ({ ...shot, no: start + index }));
}

function reconcilePassedBatchShots(state) {
  for (const batch of state.batches) {
    if (batch.status !== 'passed') continue;
    const latest = batch.versions?.at(-1);
    if (!latest?.shots?.length) continue;
    latest.shots = numberBatchShots(batch, latest.shots);
    latest.rawText = shotsToText(latest.shots, false);
    batch.sourceCount = latest.shots.length;
  }
}

export function collectFinalShotsForExport(state) {
  const allShots = [];
  for (const batch of state.batches || []) {
    const latest = batch.versions?.at(-1);
    const source = latest?.shots?.length
      ? numberBatchShots(batch, latest.shots)
      : (batch.sourceShots?.length
        ? [...batch.sourceShots].sort((a, b) => a.no - b.no)
        : (state.shots || []).filter((shot) => (batch.pendingNos || []).includes(shot.no)).sort((a, b) => a.no - b.no));
    allShots.push(...source);
  }
  const renumbered = allShots.some((shot, index) => Number(shot.no) !== index + 1);
  const shots = renumbered
    ? allShots.map((shot, index) => ({ ...shot, no: index + 1 }))
    : allShots.map((shot) => ({ ...shot }));
  return { shots, renumbered };
}

export class ConflictError extends Error {}
export class ValidationError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.issues = issues;
  }
}
export class NotFoundError extends Error {}

function emptyState() {
  return {
    schemaVersion: 4,
    revision: 0,
    projectName: '未命名短剧项目',
    shots: [],
    batches: [],
    assets: [],
    runs: [],
    activeBatchId: null,
    assetDefaultType: 'character',
    assetsExpanded: false,
    aspectRatio: '16:9',
    split: 50,
  };
}

function inside(parent, child) {
  const diff = relative(resolve(parent), resolve(child));
  return diff === '' || (!diff.startsWith('..') && !isAbsolute(diff));
}

function extensionForMime(mime) {
  return ({
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
  })[mime] || null;
}

function decodeDataUrl(value) {
  const match = String(value || '').match(/^data:(image\/(?:png|jpeg|webp|gif|svg\+xml));(?:charset=[^;,]+;)?(base64)?,(.*)$/s);
  if (!match) return null;
  const [, mime, encoding, payload] = match;
  const buffer = encoding === 'base64'
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8');
  return { mime, buffer };
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function validatePng(buffer) {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('PNG 文件头不完整');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  let sawHeader = false;
  let sawEnd = false;
  const imageData = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcOffset = dataEnd;
    if (dataEnd + 4 > buffer.length) throw new Error(`PNG ${type || '未知'} 数据被截断`);
    const expectedCrc = buffer.readUInt32BE(crcOffset);
    const actualCrc = crc32(buffer.subarray(offset + 4, dataEnd));
    if (actualCrc !== expectedCrc) throw new Error(`PNG ${type} 块校验失败，文件可能损坏`);
    if (type === 'IHDR') {
      if (sawHeader || length !== 13 || offset !== 8) throw new Error('PNG IHDR 结构无效');
      sawHeader = true;
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      bitDepth = buffer[dataStart + 8];
      colorType = buffer[dataStart + 9];
      interlace = buffer[dataStart + 12];
      if (!width || !height) throw new Error('图片宽高无效');
      if (width > 16384 || height > 16384 || width * height > 40_000_000) throw new Error('图片尺寸过大，最长边需不超过 16384px 且总像素不超过 4000 万');
    } else if (type === 'IDAT') {
      imageData.push(buffer.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      if (length !== 0) throw new Error('PNG IEND 结构无效');
      sawEnd = true;
      offset = dataEnd + 4;
      break;
    }
    offset = dataEnd + 4;
  }
  if (!sawHeader || !imageData.length || !sawEnd) throw new Error('PNG 缺少必要的 IHDR、IDAT 或 IEND 数据');
  let raw;
  try { raw = inflateSync(Buffer.concat(imageData)); }
  catch { throw new Error('PNG 压缩数据损坏（Corrupt deflate stream / InvalidBlockType）'); }
  if (!raw.length) throw new Error('PNG 解压后没有有效像素数据');
  if (interlace === 0) {
    const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[colorType];
    if (!channels || ![1, 2, 4, 8, 16].includes(bitDepth)) throw new Error('PNG 色彩或位深格式无效');
    const expectedLength = height * (Math.ceil(width * channels * bitDepth / 8) + 1);
    if (raw.length !== expectedLength) throw new Error('PNG 解压后的像素长度不匹配');
  }
  return { format: 'PNG', width, height };
}

function validateJpeg(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) throw new Error('JPEG 文件头无效');
  let offset = 2;
  let width = 0;
  let height = 0;
  let sawEnd = false;
  while (offset < buffer.length - 1) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset++];
    if (marker === 0xd9) { sawEnd = true; break; }
    if (marker === 0xda) {
      for (let i = offset; i < buffer.length - 1; i += 1) {
        if (buffer[i] === 0xff && buffer[i + 1] === 0xd9) { sawEnd = true; break; }
      }
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) throw new Error('JPEG 数据被截断');
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) throw new Error('JPEG 分段长度无效');
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
      height = buffer.readUInt16BE(offset + 3);
      width = buffer.readUInt16BE(offset + 5);
    }
    offset += length;
  }
  if (!sawEnd || !width || !height) throw new Error('JPEG 缺少有效尺寸或结束标记');
  if (width * height > 40_000_000) throw new Error('图片总像素不能超过 4000 万');
  return { format: 'JPEG', width, height };
}

export function validateImageBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('图片文件为空');
  if (buffer.length > 50 * 1024 * 1024) throw new Error('单张图片不能超过 50MB');
  if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return validatePng(buffer);
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return validateJpeg(buffer);
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    if (buffer.length < 20 || buffer.readUInt32LE(4) + 8 > buffer.length) throw new Error('WEBP 数据被截断');
    return { format: 'WEBP' };
  }
  if (['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) {
    if (buffer.length < 14 || buffer[buffer.length - 1] !== 0x3b) throw new Error('GIF 数据不完整');
    return { format: 'GIF', width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  throw new Error('无法识别图片编码；请上传 PNG、JPG、WEBP 或 GIF');
}

function composeFeedback(batch) {
  const located = (batch.annotations || []).map((annotation) =>
    `【镜头${annotation.shotNo}】原文「${annotation.quote || ''}」存在问题：${annotation.note || ''}`,
  );
  const draft = String(batch.draft || '').trim();
  return [...located, ...(draft ? [draft] : [])].join('\n');
}

function upgradeShot(source, index = 0) {
  if (source?.rawBlock) {
    const parsed = parseShots(source.rawBlock)?.[0];
    if (parsed) return { ...source, ...parsed, scene: parsed.scene || source.scene || '', id: source.id || parsed.id };
  }
  return source;
}

export function createStore(options = {}) {
  const rootDir = resolve(options.rootDir || MODULE_ROOT);
  const dataDir = resolve(options.dataDir || join(rootDir, 'data'));
  const stateFile = join(dataDir, 'project.json');
  const assetDir = join(dataDir, 'assets');
  const referenceDir = join(dataDir, 'reference-sheets');
  const versionDir = join(dataDir, 'versions');
  let writeQueue = Promise.resolve();

  async function ensureDirectories() {
    await Promise.all([
      mkdir(dataDir, { recursive: true }),
      mkdir(assetDir, { recursive: true }),
      mkdir(referenceDir, { recursive: true }),
      mkdir(versionDir, { recursive: true }),
    ]);
  }

  async function readState() {
    await ensureDirectories();
    try {
      const parsed = JSON.parse(await readFile(stateFile, 'utf8'));
      return { ...emptyState(), ...parsed, runs: Array.isArray(parsed.runs) ? parsed.runs : [] };
    } catch (error) {
      if (error.code === 'ENOENT') return emptyState();
      throw error;
    }
  }

  async function persistImage(dataUrl, kind) {
    const decoded = decodeDataUrl(dataUrl);
    if (!decoded) return dataUrl;
    const extension = extensionForMime(decoded.mime);
    if (!extension) throw new ValidationError('不支持的图片格式');
    try { validateImageBuffer(decoded.buffer); }
    catch (error) { throw new ValidationError(error.message); }
    const hash = createHash('sha256').update(decoded.buffer).digest('hex').slice(0, 24);
    const folder = kind === 'assets' ? assetDir : kind === 'reference-sheets' ? referenceDir : versionDir;
    const fileName = `${hash}${extension}`;
    const target = join(folder, fileName);
    try { await access(target); } catch { await writeFile(target, decoded.buffer); }
    return `/files/${kind}/${fileName}`;
  }

  async function prepareReferenceSheets(assets, incomingSheets) {
    if (assets.length <= MAX_CODEX_REFERENCE_INPUTS) return [];
    const expectedGroups = groupReferenceAssets(assets);
    if (!Array.isArray(incomingSheets) || incomingSheets.length !== expectedGroups.length) {
      throw new ValidationError(`本批 ${assets.length} 项参考资产需要生成 ${expectedGroups.length} 张资产索引板，请重试创建任务`);
    }
    let labelIndex = 1;
    const prepared = [];
    for (const [sheetIndex, expected] of expectedGroups.entries()) {
      const incoming = incomingSheets[sheetIndex] || {};
      const expectedIds = expected.map((asset) => asset.id);
      if (JSON.stringify(incoming.assetIds || []) !== JSON.stringify(expectedIds)) {
        throw new ValidationError('资产索引板与本批参考资产不一致，请重新创建任务');
      }
      const decoded = decodeDataUrl(incoming.dataUrl);
      if (!decoded) throw new ValidationError(`第 ${sheetIndex + 1} 张资产索引板数据无效`);
      const info = validateImageBuffer(decoded.buffer);
      if (decoded.buffer.length > MAX_CODEX_REFERENCE_BYTES) throw new ValidationError(`第 ${sheetIndex + 1} 张资产索引板超过 4MB`);
      if (info.width > MAX_CODEX_REFERENCE_EDGE || info.height > MAX_CODEX_REFERENCE_EDGE) {
        throw new ValidationError(`第 ${sheetIndex + 1} 张资产索引板最长边超过 2048px`);
      }
      const types = [...new Set(expected.map((asset) => assetTypeLabel(asset.type)))];
      const items = expected.map((asset) => ({
        id: asset.id,
        label: `A${String(labelIndex++).padStart(2, '0')}`,
        name: asset.name || '未命名资产',
        type: asset.type || 'character',
      }));
      prepared.push({
        id: `reference-sheet-${sheetIndex + 1}`,
        name: `资产索引板${sheetIndex + 1}`,
        type: 'reference-sheet',
        typeLabel: types.join('+'),
        sourceAssetIds: expectedIds,
        items,
        img: await persistImage(incoming.dataUrl, 'reference-sheets'),
      });
    }
    return prepared;
  }

  async function normalizeState(input) {
    const next = { ...emptyState(), ...structuredClone(input) };
    next.shots = Array.isArray(next.shots) ? next.shots.map(upgradeShot) : [];
    next.assets = Array.isArray(next.assets) ? next.assets : [];
    next.batches = Array.isArray(next.batches) ? next.batches : [];
    next.runs = Array.isArray(next.runs) ? next.runs : [];
    next.aspectRatio = next.aspectRatio === '9:16' ? '9:16' : '16:9';
    const incomingIssues = [];
    for (const asset of next.assets) {
      asset.type = ['character', 'scene', 'prop'].includes(asset.type) ? asset.type : 'character';
      if (String(asset.img || '').startsWith('data:image/')) {
        const decoded = decodeDataUrl(asset.img);
        try {
          if (!decoded) throw new Error('图片数据格式无效');
          validateImageBuffer(decoded.buffer);
        } catch (error) {
          incomingIssues.push({ id: asset.id, name: asset.name || '未命名资产', reason: error.message });
        }
      }
    }
    if (incomingIssues.length) throw new ValidationError(`发现 ${incomingIssues.length} 张无效参考图，请一次处理完后重试`, incomingIssues);
    for (const asset of next.assets) {
      if (String(asset.img || '').startsWith('data:image/')) asset.img = await persistImage(asset.img, 'assets');
    }
    for (const batch of next.batches) {
      batch.assetIds = Array.isArray(batch.assetIds) ? batch.assetIds : [];
      batch.annotations = Array.isArray(batch.annotations) ? batch.annotations : [];
      batch.versions = Array.isArray(batch.versions) ? batch.versions : [];
      const originalShots = batch.pendingNos?.length ? batch.pendingNos : batch.versions[0]?.shots?.map((shot) => shot.no) || [];
      batch.rangeStart = Number.isFinite(Number(batch.rangeStart)) ? Number(batch.rangeStart) : (Math.min(...originalShots) || 1);
      batch.sourceCount = Number.isFinite(Number(batch.sourceCount)) && Number(batch.sourceCount) > 0
        ? Number(batch.sourceCount)
        : Math.max(originalShots.length, 1);
      for (const version of batch.versions) {
        version.shots = Array.isArray(version.shots) ? version.shots.map(upgradeShot) : [];
        version.shots = numberBatchShots(batch, version.shots);
        if (version.shots.length) version.rawText = shotsToText(version.shots, false);
        if (String(version.image || '').startsWith('data:image/')) version.image = await persistImage(version.image, 'versions');
      }
      const storedSourceShots = Array.isArray(batch.sourceShots) ? batch.sourceShots.map(upgradeShot) : [];
      const poolByNo = new Map(next.shots.map((shot) => [shot.no, shot]));
      batch.sourceShots = storedSourceShots.length
        ? storedSourceShots
        : originalShots.map((no) => poolByNo.get(Number(no))).filter(Boolean).map((shot) => ({ ...shot }));
      if (!batch.sourceShots.length && batch.versions[0]?.shots?.length) {
        batch.sourceShots = batch.versions[0].shots.map((shot) => ({ ...shot }));
      }
      if (batch.sourceShots.length) batch.sourceShots = numberBatchShots(batch, batch.sourceShots);
    }
    reconcilePassedBatchShots(next);
    next.schemaVersion = 4;
    return next;
  }

  async function atomicWrite(state) {
    await ensureDirectories();
    const temp = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temp, stateFile);
  }

  function enqueue(operation) {
    const pending = writeQueue.then(operation, operation);
    writeQueue = pending.catch(() => {});
    return pending;
  }

  async function replaceProject(input, expectedRevision) {
    return enqueue(async () => {
      const current = await readState();
      if (expectedRevision !== undefined && Number(expectedRevision) !== Number(current.revision)) {
        throw new ConflictError('项目已经被其他操作更新，请刷新后重试');
      }
      const next = await normalizeState(input);
      next.revision = Number(current.revision || 0) + 1;
      next.updatedAt = Date.now();
      await atomicWrite(next);
      return next;
    });
  }

  async function migrateLegacy(input) {
    return enqueue(async () => {
      const current = await readState();
      const isEmpty = !current.shots.length && !current.batches.length && !current.assets.length;
      if (!isEmpty) return { migrated: false, state: current };
      const next = await normalizeState(input);
      next.revision = Number(current.revision || 0) + 1;
      next.migratedFromLocalStorageAt = Date.now();
      next.updatedAt = Date.now();
      await atomicWrite(next);
      return { migrated: true, state: next };
    });
  }

  function shotsForBatch(state, batch) {
    const latest = batch.versions?.at(-1);
    if (latest?.shots?.length) return numberBatchShots(batch, latest.shots.map(upgradeShot));
    if (batch.sourceShots?.length) return numberBatchShots(batch, batch.sourceShots.map(upgradeShot));
    const numbers = batch.pendingNos || [];
    return state.shots.filter((shot) => numbers.includes(shot.no)).map(upgradeShot).sort((a, b) => a.no - b.no);
  }

  async function deleteLatestBatch(batchId) {
    return enqueue(async () => {
      const state = await readState();
      const index = state.batches.findIndex((batch) => batch.id === batchId);
      if (index < 0) throw new NotFoundError('找不到批次');
      if (index !== state.batches.length - 1) throw new ValidationError('只能删除最新批次');
      const [deleted] = state.batches.splice(index, 1);
      const deletedRuns = state.runs.filter((run) => run.batchId === batchId);
      state.runs = state.runs.filter((run) => run.batchId !== batchId);
      state.activeBatchId = state.batches.at(-1)?.id || null;
      state.revision += 1;
      state.updatedAt = Date.now();
      await atomicWrite(state);

      const retainedImages = new Set(state.batches.flatMap((batch) => (batch.versions || []).map((version) => version.image).filter(Boolean)));
      const deletedImages = [...new Set((deleted.versions || []).map((version) => version.image).filter((image) => image && !retainedImages.has(image)))];
      await Promise.all(deletedImages.map(async (image) => {
        const filePath = resolvePublicFile(image);
        if (filePath) await unlink(filePath).catch(() => {});
      }));
      return {
        state,
        deleted: {
          id: deleted.id,
          name: deleted.name,
          versionCount: deleted.versions?.length || 0,
          runCount: deletedRuns.length,
        },
      };
    });
  }

  async function exportFinalScript() {
    const state = await readState();
    const result = collectFinalShotsForExport(state);
    return { ...result, text: shotsToText(result.shots, false) };
  }

  async function validateAssetsForBatch(state, batch) {
    const selected = new Set(batch.assetIds || []);
    const assets = state.assets.filter((asset) => selected.has(asset.id));
    const issues = [];
    if (assets.length > MAX_REFERENCE_ASSETS) {
      issues.push({
        id: 'reference-limit',
        name: '参考资产数量',
        reason: `本批已选 ${assets.length} 张，审核台最多支持 ${MAX_REFERENCE_ASSETS} 张参考资产；请先取消 ${assets.length - MAX_REFERENCE_ASSETS} 张`,
      });
    }
    const fileIssues = (await Promise.all(assets.map(async (asset) => {
      const filePath = resolvePublicFile(asset.img);
      if (!filePath) return { id: asset.id, name: asset.name || '未命名资产', reason: '图片路径无效' };
      const buffer = await readFile(filePath).catch(() => null);
      if (!buffer) return { id: asset.id, name: asset.name || '未命名资产', reason: '找不到图片文件' };
      try {
        const info = validateImageBuffer(buffer);
        if (buffer.length > MAX_CODEX_REFERENCE_BYTES) {
          throw new Error('图片超过 Codex 参考图兼容大小 4MB，请删除后重新上传以自动压缩');
        }
        if ((info.width && info.width > MAX_CODEX_REFERENCE_EDGE) || (info.height && info.height > MAX_CODEX_REFERENCE_EDGE)) {
          throw new Error('图片最长边超过 Codex 参考图兼容尺寸 2048px，请删除后重新上传以自动缩放');
        }
        return null;
      } catch (error) {
        return { id: asset.id, name: asset.name || '未命名资产', reason: error.message };
      }
    }))).filter(Boolean);
    issues.push(...fileIssues);
    return { valid: issues.length === 0, checked: assets.length, issues };
  }

  async function validateBatchAssets(batchId) {
    const state = await readState();
    const batch = state.batches.find((item) => item.id === batchId);
    if (!batch) throw new NotFoundError('找不到批次');
    return validateAssetsForBatch(state, batch);
  }

  async function createRun(batchId, mode = 'first', incomingReferenceSheets = []) {
    return enqueue(async () => {
      const state = await readState();
      const batch = state.batches.find((item) => item.id === batchId);
      if (!batch) throw new NotFoundError('找不到批次');
      if (batch.status === 'passed') throw new ValidationError('已通过批次不能创建新的生图任务');
      const activeRun = state.runs.find((item) => item.batchId === batchId && ['ready', 'preparing', 'generating', 'submitting'].includes(item.status));
      if (activeRun) throw new ConflictError('本批已经有进行中的 Codex 任务');
      const shots = shotsForBatch(state, batch);
      if (!shots.length) throw new ValidationError('当前批次没有可用镜头');
      const assetValidation = await validateAssetsForBatch(state, batch);
      if (!assetValidation.valid) throw new ValidationError(`参考资产校验未通过，共 ${assetValidation.issues.length} 项问题，请一次处理完后重试`, assetValidation.issues);
      mode = batch.versions?.length ? 'revision' : 'first';
      const feedback = mode === 'revision' ? composeFeedback(batch) : '';
      if (mode === 'revision' && !feedback) throw new ValidationError('请先填写本轮返修意见');
      const token = randomBytes(24).toString('hex');
      const sourceScriptText = shotsToText(shots, false);
      const selectedAssetIds = new Set(batch.assetIds || []);
      const selectedAssets = state.assets.filter((asset) => selectedAssetIds.has(asset.id));
      const referenceSheets = await prepareReferenceSheets(selectedAssets, incomingReferenceSheets);
      const run = {
        id: `run_${randomUUID()}`,
        token,
        batchId,
        mode,
        status: 'ready',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        baseVersionId: batch.versions?.at(-1)?.id || null,
        feedback,
        sourceScriptText,
        sourceScriptSha256: createHash('sha256').update(sourceScriptText).digest('hex'),
        sourceShotNos: shots.map((shot) => shot.no),
        rangeStart: Number(batch.rangeStart || shots[0]?.no || 1),
        assetIds: [...(batch.assetIds || [])],
        referenceMode: referenceSheets.length ? 'index-sheet' : 'direct',
        referenceSheets,
        aspectRatio: state.aspectRatio === '9:16' ? '9:16' : '16:9',
        events: [{ at: Date.now(), type: 'created', status: 'ready' }],
      };
      if (mode === 'first') run.imageScript = imageScriptFor(state, { ...batch, assetIds: run.assetIds }, shots, referenceSheets);
      state.runs.push(run);
      state.revision += 1;
      state.updatedAt = Date.now();
      await atomicWrite(state);
      return {
        run,
        instruction: [
          '请使用「分镜审核台」插件完成本批分镜宫格生成。',
          `运行令牌：${token}`,
          '先调用 get_batch_context。返修任务必须先用 prepare_revision_script 将审核意见落实到分镜脚本；随后把工具返回的 imageScript 原样交给 Codex 内置图片生成能力，完成后立即调用 submit_storyboard_version 回填。',
          '为缩短等待，推荐使用 GPT-5.6 Luna，推理强度设为低。',
          ISOLATION_PROMPT,
          '如果任一步失败，请调用 report_generation_status 标记 failed，并说明可以直接重试的原因。',
        ].join('\n\n'),
      };
    });
  }

  async function contextForToken(token) {
    const state = await readState();
    const run = state.runs.find((item) => item.token === token);
    if (!run) throw new NotFoundError('运行令牌无效');
    const batch = state.batches.find((item) => item.id === run.batchId);
    if (!batch) throw new NotFoundError('批次已经不存在');
    const runBatch = { ...batch, rangeStart: Number(run.rangeStart || batch.rangeStart || 1) };
    const shots = numberBatchShots(runBatch, parseShots(run.preparedScriptText || run.sourceScriptText) || []);
    const assetValidation = await validateAssetsForBatch(state, { ...batch, assetIds: run.assetIds || batch.assetIds });
    if (!assetValidation.valid) throw new ValidationError(`参考资产校验未通过，共 ${assetValidation.issues.length} 项问题，请一次处理完后重试`, assetValidation.issues);
    const selected = new Set(run.assetIds || batch.assetIds || []);
    const sourceAssets = state.assets
      .filter((asset) => selected.has(asset.id))
      .map((asset) => ({
        id: asset.id,
        name: asset.name,
        type: asset.type,
        path: resolvePublicFile(asset.img),
      }));
    const assets = run.referenceSheets?.length
      ? run.referenceSheets.map((sheet) => ({
        id: sheet.id,
        name: `${sheet.name}（${sheet.typeLabel}）`,
        type: sheet.type,
        path: resolvePublicFile(sheet.img),
        sourceAssetIds: sheet.sourceAssetIds,
      }))
      : sourceAssets;
    const layout = gridLayout(shots.length);
    return {
      runId: run.id,
      runStatus: run.status,
      runMessage: run.message || '',
      resultVersionId: run.resultVersionId || null,
      batchId: batch.id,
      batchName: batch.name,
      mode: run.mode,
      projectName: state.projectName,
      aspectRatio: run.aspectRatio || (state.aspectRatio === '9:16' ? '9:16' : '16:9'),
      scriptText: shotsToText(shots, false),
      imageScript: run.mode === 'first'
        ? imageScriptFor({ ...state, aspectRatio: run.aspectRatio || state.aspectRatio }, { ...runBatch, assetIds: run.assetIds || batch.assetIds }, shots, run.referenceSheets || [])
        : (run.preparedScriptText ? imageScriptFor({ ...state, aspectRatio: run.aspectRatio || state.aspectRatio }, { ...runBatch, assetIds: run.assetIds || batch.assetIds }, shots, run.referenceSheets || []) : null),
      gridCols: layout.cols,
      gridRows: layout.rows,
      shots,
      feedback: run.feedback,
      assets: assets.filter((asset) => asset.path),
      referenceMode: run.referenceSheets?.length ? 'index-sheet' : 'direct',
      referenceAssetCount: sourceAssets.length,
      referenceInputCount: assets.filter((asset) => asset.path).length,
      sourceAssets: sourceAssets.map(({ id, name, type }) => ({ id, name, type })),
      isolationRequirement: ISOLATION_PROMPT,
      submissionRequirement: '生成完成后立即调用 submit_storyboard_version，传入相同运行令牌、生成图片绝对路径、宫格行列和幂等键。脚本由审核台使用本次已确认文本落库。',
    };
  }

  async function prepareRevisionScript(token, scriptText) {
    return enqueue(async () => {
      const state = await readState();
      const run = state.runs.find((item) => item.token === token);
      if (!run) throw new NotFoundError('运行令牌无效');
      if (run.mode !== 'revision') throw new ValidationError('首版任务不需要准备返修脚本');
      if (run.status === 'completed') throw new ConflictError('该运行已经提交过结果');
      const batch = state.batches.find((item) => item.id === run.batchId);
      if (!batch) throw new NotFoundError('批次已经不存在');
      const baseShots = shotsForBatch(state, batch);
      const parsedRevision = parseShots(scriptText);
      if (!parsedRevision?.length) throw new ValidationError('返修后的分镜脚本无法解析');
      if (parsedRevision.length > 20) throw new ValidationError('单批返修最多保留 20 个镜头，请拆分批次');
      const rangeStart = Number(batch.rangeStart || baseShots[0]?.no || 1);
      const revisedShots = parsedRevision.map((shot, index) => {
        const normalized = { ...shot, no: rangeStart + index, id: shot.id || `shot_${rangeStart + index}_${index}` };
        delete normalized.rawBlock;
        return normalized;
      });
      const sourceScript = canonicalScript(run.sourceScriptText || shotsToText(baseShots, false));
      const revisedScript = shotsToText(revisedShots, false);
      if (sourceScript === revisedScript) {
        throw new ValidationError('返修后的分镜脚本没有发生变化；请先把审核意见落实到对应字段');
      }
      run.preparedScriptText = revisedScript;
      run.preparedImageScript = imageScriptFor(state, { ...batch, assetIds: run.assetIds || batch.assetIds }, revisedShots, run.referenceSheets || []);
      run.preparedAt = Date.now();
      run.updatedAt = Date.now();
      run.events = [...(run.events || []), { at: Date.now(), type: 'revision_prepared', status: run.status }];
      state.revision += 1;
      state.updatedAt = Date.now();
      await atomicWrite(state);
      return {
        scriptText: revisedScript,
        imageScript: run.preparedImageScript,
        gridCols: gridLayout(revisedShots.length).cols,
        gridRows: gridLayout(revisedShots.length).rows,
        shotCountDelta: revisedShots.length - baseShots.length,
      };
    });
  }

  async function updateRunStatus(token, status, message = '') {
    const allowed = new Set(['ready', 'preparing', 'generating', 'submitting', 'failed']);
    if (!allowed.has(status)) throw new ValidationError('无效的运行状态');
    return enqueue(async () => {
      const state = await readState();
      const run = state.runs.find((item) => item.token === token);
      if (!run) throw new NotFoundError('运行令牌无效');
      if (run.status === 'completed') return run;
      run.status = status;
      run.message = String(message || '');
      run.updatedAt = Date.now();
      run.events = [...(run.events || []), { at: Date.now(), type: 'status', status, message: run.message }];
      state.revision += 1;
      state.updatedAt = Date.now();
      await atomicWrite(state);
      return run;
    });
  }

  async function submitVersion(input) {
    return enqueue(async () => {
      const state = await readState();
      const run = state.runs.find((item) => item.token === input.token);
      if (!run) throw new NotFoundError('运行令牌无效');
      if (run.status === 'completed') {
        if (run.idempotencyKey === input.idempotencyKey) {
          return { duplicate: true, versionId: run.resultVersionId };
        }
        throw new ConflictError('该运行已经提交过结果');
      }
      const batch = state.batches.find((item) => item.id === run.batchId);
      if (!batch) throw new NotFoundError('批次已经不存在');
      if (batch.status === 'passed') throw new ValidationError('已通过批次不能自动回填');

      const imagePath = resolve(String(input.imagePath || ''));
      const allowedRoots = [rootDir, resolve(process.env.CODEX_HOME || join(homedir(), '.codex'), 'generated_images')];
      if (!allowedRoots.some((root) => inside(root, imagePath))) {
        throw new ValidationError('图片必须位于当前项目或 Codex generated_images 目录');
      }
      const extension = extname(imagePath).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(extension)) throw new ValidationError('只接受 PNG、JPG、WEBP 或 GIF 图片');
      const imageStat = await stat(imagePath).catch(() => null);
      if (!imageStat?.isFile()) throw new ValidationError('找不到待回填图片');
      if (imageStat.size > 50 * 1024 * 1024) throw new ValidationError('单张图片不能超过 50MB');
      const imageBuffer = await readFile(imagePath);
      try { validateImageBuffer(imageBuffer); }
      catch (error) { throw new ValidationError(`待回填图片无效：${error.message}`); }
      const imageSha256 = createHash('sha256').update(imageBuffer).digest('hex');
      for (const otherBatch of state.batches) {
        for (const version of otherBatch.versions || []) {
          let existingHash = version.imageSha256;
          if (!existingHash) {
            const existingPath = resolvePublicFile(version.image);
            const existingBuffer = existingPath ? await readFile(existingPath).catch(() => null) : null;
            if (existingBuffer) existingHash = createHash('sha256').update(existingBuffer).digest('hex');
          }
          if (existingHash === imageSha256) {
            throw new ValidationError(`本次图片与${otherBatch.name}${version.label}完全相同，疑似复用了历史宫格；请重新调用内置生图后再回填`);
          }
        }
      }

      const sourceScript = run.mode === 'revision'
        ? run.preparedScriptText
        : (run.sourceScriptText || shotsToText(shotsForBatch(state, batch), false));
      if (!sourceScript) throw new ValidationError('返修脚本尚未准备，请先调用 prepare_revision_script');
      const runBatch = { ...batch, rangeStart: Number(run.rangeStart || batch.rangeStart || 1) };
      const shots = numberBatchShots(runBatch, parseShots(sourceScript));
      if (!shots?.length) throw new ValidationError('分镜文本无法解析，未创建版本');
      const authoritativeScript = shotsToText(shots, false);
      if (input.scriptText && shotsToText(numberBatchShots(runBatch, parseShots(input.scriptText) || []), false) !== authoritativeScript) {
        throw new ValidationError('提交脚本与本次已确认的分镜脚本不一致');
      }
      const gridCols = Number(input.gridCols);
      const gridRows = Number(input.gridRows);
      if (!Number.isInteger(gridCols) || gridCols < 1 || gridCols > 5 ||
          !Number.isInteger(gridRows) || gridRows < 1 || gridRows > 4) {
        throw new ValidationError('宫格布局必须为 1–5 列、1–4 行');
      }
      if (gridCols * gridRows < shots.length) throw new ValidationError('宫格容量小于镜头数量');

      const versionId = `version_${randomUUID()}`;
      const fileName = `${versionId}${extension === '.jpeg' ? '.jpg' : extension}`;
      await copyFile(imagePath, join(versionDir, fileName));
      const version = {
        id: versionId,
        label: `v${batch.versions.length + 1}`,
        image: `/files/versions/${fileName}`,
        shots,
        rawText: authoritativeScript,
        appliedFeedback: run.feedback || '',
        sourceRunId: run.id,
        imageSha256,
        scriptSha256: createHash('sha256').update(authoritativeScript).digest('hex'),
        createdAt: Date.now(),
        gridCols,
        gridRows,
      };
      batch.versions.push(version);
      batch.activeV = batch.versions.length - 1;
      batch.status = 'reviewing';
      batch.draft = '';
      batch.annotations = [];
      delete batch.pendingFeedback;
      delete batch.pendingNos;
      run.status = 'completed';
      run.updatedAt = Date.now();
      run.idempotencyKey = String(input.idempotencyKey || run.id);
      run.resultVersionId = version.id;
      run.events = [...(run.events || []), { at: Date.now(), type: 'submitted', status: 'completed', versionId: version.id, imageSha256 }];
      state.revision += 1;
      state.updatedAt = Date.now();
      await atomicWrite(state);
      return { duplicate: false, version, run };
    });
  }

  async function runById(id) {
    const state = await readState();
    const run = state.runs.find((item) => item.id === id);
    if (!run) throw new NotFoundError('找不到运行记录');
    return run;
  }

  function resolvePublicFile(publicPath) {
    const match = String(publicPath || '').match(/^\/files\/(assets|reference-sheets|versions)\/([^/]+)$/);
    if (!match) return null;
    const folder = match[1] === 'assets' ? assetDir : match[1] === 'reference-sheets' ? referenceDir : versionDir;
    const target = resolve(folder, match[2]);
    return inside(folder, target) ? target : null;
  }

  return {
    rootDir,
    dataDir,
    stateFile,
    readState,
    replaceProject,
    migrateLegacy,
    deleteLatestBatch,
    exportFinalScript,
    createRun,
    validateBatchAssets,
    contextForToken,
    prepareRevisionScript,
    updateRunStatus,
    submitVersion,
    runById,
    resolvePublicFile,
  };
}

export { ISOLATION_PROMPT };
