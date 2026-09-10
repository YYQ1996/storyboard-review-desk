import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultBatchShotNos, durationSeconds, normalizeAudioText, parseShots, parseStandardFormat, shotsToText } from '../server/parser.mjs';

test('标准格式保留多行字段', () => {
  const shots = parseStandardFormat(`镜头10
机位/景别/运镜：近景
缓慢推近
构图：人物居中
前景有门框遮挡
场景：室内
时长：3s
画面内容：第一行
第二行
台词 / 心声 / 音效：第一句
环境声
情绪目标：压抑
逐渐失控`);
  assert.equal(shots.length, 1);
  assert.equal(shots[0].camera, '近景\n缓慢推近');
  assert.equal(shots[0].composition, '人物居中\n前景有门框遮挡');
  assert.equal(shots[0].desc, '第一行\n第二行');
  assert.equal(shots[0].dialogue, '第一句\n环境声');
  assert.equal(shots[0].emotion, '压抑\n逐渐失控');
  assert.equal(shots[0].scene, '室内');
  assert.equal(shots[0].duration, '3s');
});

test('规范导出保持构图、声音和情绪目标独立', () => {
  const text = shotsToText([{
    no: 2,
    scene: '咖啡馆靠窗区-白天',
    duration: '1.5秒',
    camera: '中景',
    composition: '对角线构图',
    desc: '人物推门',
    dialogue: '门轴声',
    emotion: '紧张升级',
  }], false);
  assert.match(text, /场景：咖啡馆靠窗区-白天/);
  assert.match(text, /时长：1\.5秒/);
  assert.match(text, /构图：对角线构图/);
  assert.match(text, /台词 \/ 心声 \/ 音效：门轴声/);
  assert.match(text, /情绪目标：紧张升级/);
});

test('六列竖线格式保留机位', () => {
  const [shot] = parseShots('3|俯拍远景|天台-夜|2s|人物走向边缘|风声');
  assert.equal(shot.no, 3);
  assert.equal(shot.camera, '俯拍远景');
  assert.equal(shot.scene, '天台-夜');
  assert.equal(shot.duration, '2s');
});

test('JSON 格式保留完整镜头字段', () => {
  const [shot] = parseShots(JSON.stringify([{
    no: 8,
    camera: '低机位近景',
    scene: '走廊-夜',
    duration: '4s',
    desc: '人物停在门前',
    dialogue: '门锁轻响',
  }]));
  assert.deepEqual(
    { no: shot.no, camera: shot.camera, scene: shot.scene, duration: shot.duration, desc: shot.desc, dialogue: shot.dialogue },
    { no: 8, camera: '低机位近景', scene: '走廊-夜', duration: '4s', desc: '人物停在门前', dialogue: '门锁轻响' },
  );
});

test('旧版逐镜头格式导入后规范为场景父级', () => {
  const source = `镜头7
机位/景别/运镜：近景，固定机位
画面内容：第一行
第二行继续描述
台词 / 音效：人物：保持原标点；环境声。`;
  const normalized = shotsToText(parseShots(source));
  assert.match(normalized, /^【场景：未标注场景】/);
  assert.match(normalized, /镜头7/);
  assert.match(normalized, /画面内容：第一行\n第二行继续描述/);
  assert.match(normalized, /台词 \/ 心声 \/ 音效：人物：保持原标点；环境声。/);
});

test('连续镜头共用场景父级且可再次解析', () => {
  const source = `【场景：卧室-深夜】

镜头1
时长：2秒
画面内容：主人入睡
台词 / 心声 / 音效：主人说：“晚安，小宝贝” / 无 / 无

镜头2
时长：1秒
画面内容：猫咪闭眼
台词 / 心声 / 音效：无 / 无 / 猫咪轻微呼噜声`;
  const shots = parseShots(source);
  assert.deepEqual(shots.map(shot => shot.scene), ['卧室-深夜', '卧室-深夜']);
  assert.deepEqual(shots.map(shot => shot.dialogue), ['主人说：“晚安，小宝贝”', '猫咪轻微呼噜声']);
  const exported = shotsToText(shots, false);
  assert.equal((exported.match(/【场景：卧室-深夜】/g) || []).length, 1);
  assert.doesNotMatch(exported, /无\s*[\/／]/);
  const plainHeading = parseShots('场景1：走廊-夜\n\n镜头3\n时长：1秒\n画面内容：人物停步');
  assert.equal(plainHeading[0].scene, '走廊-夜');
});

test('声音字段移除无值占位和空分隔符', () => {
  assert.equal(normalizeAudioText('主人说：“晚安，小宝贝” / 无 / 无'), '主人说：“晚安，小宝贝”');
  assert.equal(normalizeAudioText('无／无／环境音'), '环境音');
  assert.equal(normalizeAudioText('无；纸张摩擦声'), '纸张摩擦声');
  assert.equal(normalizeAudioText('无 / 无 / 无'), '');
});

test('新建批次默认最多选择前 9 镜且累计不超过 15 秒', () => {
  const shots = Array.from({ length: 12 }, (_, index) => ({ no: index + 1, duration: index < 7 ? '2秒' : '1.5s' }));
  assert.deepEqual(defaultBatchShotNos(shots), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(defaultBatchShotNos(Array.from({ length: 12 }, (_, index) => ({ no: index + 1, duration: '1s' }))), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(durationSeconds('00:03.5'), 3.5);
});
