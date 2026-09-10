export function normalizeShot(source, index = 0) {
  const no = Number(source.no ?? source['镜号'] ?? index + 1);
  return {
    id: String(source.id || `shot_${no}_${index}`),
    no: Number.isFinite(no) ? no : index + 1,
    camera: String(source.camera ?? source['机位'] ?? source['机位/景别/运镜'] ?? ''),
    composition: String(source.composition ?? source['构图'] ?? ''),
    scene: String(source.scene ?? source['场景'] ?? ''),
    duration: String(source.duration ?? source['时长'] ?? ''),
    desc: String(source.desc ?? source['画面内容'] ?? source['画面'] ?? source['描述'] ?? ''),
    dialogue: normalizeAudioText(source.dialogue ?? source.audio ?? source['台词'] ?? source['台词 / 音效'] ?? source['台词/心声/音效'] ?? source['台词 / 心声 / 音效'] ?? ''),
    emotion: String(source.emotion ?? source['情绪目标'] ?? ''),
    ...(source.rawBlock ? { rawBlock: String(source.rawBlock) } : {}),
  };
}

export function normalizeAudioText(value) {
  const emptyValues = /^(?:无|暂无|没有|空|无台词|无对白|无心声|无音效|无对白及音效|-+)$/;
  return String(value ?? '')
    .split(/\s*[\/／;；]\s*/)
    .map((part) => part.trim().replace(/^(?:台词|对白|心声|内心|音效)\s*[:：]\s*/, '').trim())
    .filter((part) => part && !emptyValues.test(part))
    .join('；');
}

const FIELD_LINE = /^(机位\s*[\/／]\s*景别\s*[\/／]\s*运镜|构图|场景|时长|画面内容|情绪目标|台词\s*[\/／]\s*(?:心声\s*[\/／]\s*)?音效)\s*[:：]\s*(.*)$/;

export function parseStandardFormat(text) {
  if (!/^镜头\s*\d+\s*$/m.test(text)) return null;
  const blocks = [];
  let activeScene = '';
  let activeBlock = null;
  const sourceLines = text.split(/\r?\n/);
  for (const [lineIndex, line] of sourceLines.entries()) {
    const bracketHeading = line.trim().match(/^【场景(?:\s*\d+)?\s*[:：]\s*(.*?)】$/);
    const plainHeading = line.trim().match(/^场景(?:\s*\d+)?\s*[:：]\s*(.*?)$/);
    const nextContent = sourceLines.slice(lineIndex + 1).find((item) => item.trim())?.trim() || '';
    const sceneHeading = bracketHeading || (plainHeading && (!activeBlock || /^镜头\s*\d+\s*$/.test(nextContent)) ? plainHeading : null);
    if (sceneHeading) {
      if (activeBlock) blocks.push(activeBlock);
      activeBlock = null;
      activeScene = sceneHeading[1].trim();
      continue;
    }
    if (/^镜头\s*\d+\s*$/.test(line.trim())) {
      if (activeBlock) blocks.push(activeBlock);
      activeBlock = { lines: [line.trim()], parentScene: activeScene };
    } else if (activeBlock) {
      activeBlock.lines.push(line);
    }
  }
  if (activeBlock) blocks.push(activeBlock);

  const shots = [];
  for (const [index, entry] of blocks.entries()) {
    const block = entry.lines.join('\n').trim();
    const lines = block.split(/\r?\n/);
    const noMatch = lines.shift()?.match(/^镜头\s*(\d+)\s*$/);
    if (!noMatch) continue;

    const fields = { camera: '', composition: '', scene: '', duration: '', desc: '', dialogue: '', emotion: '' };
    const labelToKey = (label) => {
      if (/^机位/.test(label)) return 'camera';
      if (label === '构图') return 'composition';
      if (label === '场景') return 'scene';
      if (label === '时长') return 'duration';
      if (label === '画面内容') return 'desc';
      if (label === '情绪目标') return 'emotion';
      return 'dialogue';
    };
    let activeKey = null;
    for (const line of lines) {
      const match = line.match(FIELD_LINE);
      if (match) {
        activeKey = labelToKey(match[1]);
        fields[activeKey] = match[2].trim();
      } else if (activeKey) {
        fields[activeKey] += `${fields[activeKey] ? '\n' : ''}${line}`;
      }
    }
    shots.push(normalizeShot({ no: noMatch[1], ...fields, scene: fields.scene || entry.parentScene, rawBlock: block }, index));
  }
  return shots.length ? shots.sort((a, b) => a.no - b.no) : null;
}

export function parseShots(text) {
  const value = String(text || '').trim();
  if (!value) return null;

  const standard = parseStandardFormat(value);
  if (standard) return standard;

  try {
    const json = JSON.parse(value);
    const items = Array.isArray(json) ? json : json.shots;
    if (Array.isArray(items) && items.length) {
      return items.map(normalizeShot).sort((a, b) => a.no - b.no);
    }
  } catch {}

  const shots = [];
  for (const [index, line] of value.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const parts = line.split(/\s*[|｜]\s*/);
    if (parts.length < 2 || !/^\d+$/.test(parts[0])) continue;
    if (parts.length >= 6) {
      shots.push(normalizeShot({
        no: parts[0], camera: parts[1], scene: parts[2], duration: parts[3], desc: parts[4], dialogue: parts.slice(5).join('|'),
      }, index));
    } else {
      shots.push(normalizeShot({
        no: parts[0], scene: parts[1], duration: parts[2] || '', desc: parts[3] || '', dialogue: parts[4] || '',
      }, index));
    }
  }
  return shots.length ? shots.sort((a, b) => a.no - b.no) : null;
}

export function shotsToText(shots, preserveRaw = true) {
  let previousScene = null;
  const blocks = [];
  for (const shot of shots) {
    const scene = String(shot.scene || '未标注场景').trim();
    if (scene !== previousScene) {
      blocks.push(`【场景：${scene}】`);
      previousScene = scene;
    }
    blocks.push([
      `镜头${shot.no}`,
      `时长：${shot.duration || ''}`,
      `机位/景别/运镜：${shot.camera || ''}`,
      `构图：${shot.composition || ''}`,
      `画面内容：${shot.desc || ''}`,
      `台词 / 心声 / 音效：${normalizeAudioText(shot.dialogue)}`,
      `情绪目标：${shot.emotion || ''}`,
    ].join('\n'));
  }
  return blocks.join('\n\n');
}

export function durationSeconds(value) {
  const text = String(value || '').trim();
  const clock = text.match(/^(\d+):([0-5]?\d(?:\.\d+)?)$/);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  const number = text.match(/\d+(?:\.\d+)?/);
  return number ? Number(number[0]) : 0;
}

export function defaultBatchShotNos(shots, maxShots = 9, maxDuration = 15) {
  const selected = [];
  let total = 0;
  for (const shot of shots.slice(0, maxShots)) {
    const seconds = durationSeconds(shot.duration);
    if (total + seconds > maxDuration) break;
    selected.push(shot.no);
    total += seconds;
  }
  return selected;
}
