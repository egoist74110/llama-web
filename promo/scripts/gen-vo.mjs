import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const POSTPROCESS_VERSION = 'p3';

// Parse arguments
const args = process.argv.slice(2);
const isDry = args.includes('--dry');
const isCheck = args.includes('--check');
const isRedoBelow = args.includes('--redo-below');
let onlyIds = null;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--only' && i + 1 < args.length) {
    onlyIds = new Set(args[i + 1].split(',').map((s) => s.trim()).filter(Boolean));
    i++;
  } else if (arg.startsWith('--only=')) {
    onlyIds = new Set(arg.slice(7).split(',').map((s) => s.trim()).filter(Boolean));
  }
}

// Load .env
try {
  process.loadEnvFile('.env');
} catch {
  // handled by checking variables below
}

const baseUrl = process.env.PROMO_TTS_BASE_URL?.trim();
const apiKey = process.env.PROMO_TTS_API_KEY?.trim();

// Sanitize output so that the API key NEVER appears in any output or error
function sanitize(value) {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : String(value);
  return apiKey ? text.replaceAll(apiKey, '***') : text;
}

// Read narration
const narrationPath = path.resolve('src/narration.json');
if (!fs.existsSync(narrationPath)) {
  console.error('Error: src/narration.json not found');
  process.exit(1);
}

const narration = JSON.parse(fs.readFileSync(narrationPath, 'utf8'));
const voice = narration.voice;
if (!voice) {
  console.error('Error: "voice" field missing in src/narration.json');
  process.exit(1);
}
const defaultTempo = narration.tempo ?? 1;
const asrModel = narration.asrModel || 'MOSS-OpenMOSS-Team/MOSS-Transcribe-Diarize';
const defaultTakes = narration.takes ?? 5;
const defaultMinScore = narration.minScore ?? 0.9;

// Collect items in order
const items = [];
for (const [chId, list] of Object.entries(narration.chapters || {})) {
  for (const item of list) {
    const ttsText = item.say ?? item.text;
    const tempo = item.tempo ?? defaultTempo;
    const takes = item.takes ?? defaultTakes;
    const minScore = item.minScore ?? defaultMinScore;
    const rawHash = crypto
      .createHash('sha256')
      .update(`${voice}\n${ttsText}`)
      .digest('hex')
      .slice(0, 16);
    const hash = crypto
      .createHash('sha256')
      .update(`${rawHash}\n${tempo}\n${POSTPROCESS_VERSION}`)
      .digest('hex')
      .slice(0, 16);
    items.push({
      id: item.id,
      chId,
      text: item.text,
      say: item.say,
      ttsText,
      rawHash,
      hash,
      tempo,
      takes,
      minScore,
    });
  }
}

const manifestPath = path.resolve('src/vo-manifest.json');
let manifest = {};
if (fs.existsSync(manifestPath)) {
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    manifest = {};
  }
}

// Handle --redo-below: filter to items with score < minScore (or missing score)
if (isRedoBelow) {
  const belowIds = new Set();
  for (const item of items) {
    const entry = manifest[item.id];
    if (!entry || entry.score == null || entry.score < item.minScore) {
      belowIds.add(item.id);
    }
  }
  if (belowIds.size === 0) {
    console.log('[redo-below] 所有句子得分均已达到或超过门槛，无需重做。');
    process.exit(0);
  }
  if (onlyIds) {
    onlyIds = new Set([...onlyIds].filter((id) => belowIds.has(id)));
  } else {
    onlyIds = belowIds;
  }
}

const voDir = path.resolve('public/vo');
const rawDir = path.join(voDir, 'raw');

// Scoring functions
function hasJapaneseKana(text) {
  return /[\u3040-\u30ff]/.test(text);
}

function cleanAsrText(text) {
  if (!text) return '';
  return text.replace(/\[.*?\]|［.*?］|【.*?】/g, '').trim();
}

function normalizeForScoring(text) {
  if (!text) return '';
  return text
    .replace(/\[.*?\]|［.*?］|【.*?】/g, '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

function levenshteinDistance(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const charA = a[i - 1];
    for (let j = 1; j <= n; j++) {
      const cost = charA === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost
      );
    }
    const temp = prev;
    prev = curr;
    curr = temp;
  }
  return prev[n];
}

function scoreTranscript(expectedText, rawTranscript) {
  if (!rawTranscript) return 0;
  if (hasJapaneseKana(rawTranscript)) {
    return 0;
  }
  const s1 = normalizeForScoring(expectedText);
  const s2 = normalizeForScoring(rawTranscript);
  if (s1 === s2) return 1;
  const maxLen = Math.max(s1.length, s2.length);
  if (maxLen === 0) return 1;
  const dist = levenshteinDistance(s1, s2);
  const ratio = Math.max(0, 1 - dist / maxLen);
  return Number(ratio.toFixed(4));
}

// Dry run check
if (isDry) {
  if (isCheck) {
    console.log(`[DRY RUN] Check ASR scores for existing raw clips (${items.length} lines total, asrModel: ${asrModel}):`);
    for (const item of items) {
      const rawFile = path.join(rawDir, `${item.id}-${item.rawHash}.mp3`);
      const hasRaw = fs.existsSync(rawFile);
      const inOnly = onlyIds ? onlyIds.has(item.id) : null;
      if (onlyIds && !inOnly) {
        console.log(`  - [跳过]         ${item.id}: 未在筛选范围内`);
      } else if (hasRaw) {
        console.log(`  - [待识别打分]   ${item.id}: 原始音频就绪 (rawHash: ${item.rawHash}) "${item.ttsText}"`);
      } else {
        console.log(`  - [无缓存跳过]   ${item.id}: 无原始音频缓存`);
      }
    }
    process.exit(0);
  }

  console.log(`[DRY RUN] Plan for voice-over generation (${items.length} lines total, voice: ${voice}, tempo: ${defaultTempo}, asrModel: ${asrModel}, takes: ${defaultTakes}, minScore: ${defaultMinScore}):`);
  for (const item of items) {
    const rawFile = path.join(rawDir, `${item.id}-${item.rawHash}.mp3`);
    const mp3Path = path.join(voDir, `${item.id}.mp3`);
    const canMigrate = fs.existsSync(mp3Path) && !fs.existsSync(rawFile) && manifest[item.id]?.hash === item.rawHash;
    const hasRaw = fs.existsSync(rawFile) || canMigrate;
    const isUpToDate = fs.existsSync(mp3Path) && manifest[item.id]?.hash === item.hash;
    const inOnly = onlyIds ? onlyIds.has(item.id) : null;

    if (onlyIds && !inOnly) {
      console.log(`  - [跳过]         ${item.id}: 未在指定范围内`);
    } else if (isRedoBelow && inOnly) {
      const currentScore = manifest[item.id]?.score != null ? manifest[item.id].score : '无';
      console.log(`  - [重新择优]     ${item.id}: 当前 score=${currentScore} < minScore=${item.minScore} (rawHash: ${item.rawHash}) "${item.ttsText}"`);
    } else if (isUpToDate) {
      const sec = manifest[item.id]?.seconds ?? '?';
      console.log(`  - [已是最新]     ${item.id}: (${sec}s, hash: ${item.hash})`);
    } else if (hasRaw) {
      console.log(`  - [只重做后处理] ${item.id}: 原始音频就绪 (rawHash: ${item.rawHash}, hash: ${item.hash}) "${item.ttsText}"`);
    } else {
      console.log(`  - [请求接口]     ${item.id}: 无原始音频缓存 (rawHash: ${item.rawHash}, hash: ${item.hash}) "${item.ttsText}"`);
    }
  }
  process.exit(0);
}

// Ensure output directories exist
fs.mkdirSync(voDir, { recursive: true });
fs.mkdirSync(rawDir, { recursive: true });

function getDurationInSeconds(filePath) {
  const stdout = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
    { encoding: 'utf8' }
  );
  const parsed = parseFloat(stdout.trim());
  if (Number.isNaN(parsed)) {
    throw new Error(`Failed to parse duration from ffprobe: ${stdout}`);
  }
  return Number(parsed.toFixed(2));
}

function postprocessAudio(inputRawPath, outputMp3Path, tempo) {
  const filter = `atempo=${tempo},silenceremove=start_periods=1:start_silence=0.05:start_threshold=-40dB,areverse,silenceremove=start_periods=1:start_silence=0.08:start_threshold=-40dB,areverse,loudnorm=I=-16:TP=-1.5:LRA=11`;
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-v', 'error',
      '-i', inputRawPath,
      '-af', filter,
      '-ar', '48000',
      '-ac', '1',
      '-b:a', '192k',
      outputMp3Path,
    ],
    { stdio: 'inherit' }
  );
}

async function requestTtsWithRetry(item) {
  if (!baseUrl || !apiKey) {
    throw new Error('Error: PROMO_TTS_BASE_URL and PROMO_TTS_API_KEY must be set in .env');
  }
  const base = baseUrl.replace(/\/+$/, '');
  const url = `${base}/audio/speech`;
  const body = JSON.stringify({
    model: voice,
    input: item.ttsText,
    voice: 'default',
    response_format: 'mp3',
  });

  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body,
        signal: AbortSignal.timeout(180_000),
      });

      if (!res.ok) {
        const text = await res.text();
        const snippet = sanitize(text).slice(0, 200);
        console.error(sanitize(`[${item.id}] TTS attempt ${attempt + 1}/${maxRetries + 1} HTTP ${res.status}: ${snippet}`));
        if (attempt === maxRetries) {
          throw new Error(`[${item.id}] TTS failed after ${maxRetries} retries (status ${res.status})`);
        }
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      return buffer;
    } catch (err) {
      if (attempt === maxRetries) {
        throw new Error(sanitize(`[${item.id}] TTS failed after ${maxRetries} retries: ${err.message}`));
      }
      console.error(sanitize(`[${item.id}] TTS attempt ${attempt + 1}/${maxRetries + 1} error: ${err.message}`));
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function requestAsrWithRetry(audioBuffer, id) {
  if (!baseUrl || !apiKey) {
    throw new Error('Error: PROMO_TTS_BASE_URL and PROMO_TTS_API_KEY must be set in .env');
  }
  const base = baseUrl.replace(/\/+$/, '');
  const url = `${base}/audio/transcriptions`;

  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const formData = new FormData();
      formData.append('model', asrModel);
      formData.append('file', new Blob([audioBuffer], { type: 'audio/mpeg' }), `${id}.mp3`);

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: formData,
        signal: AbortSignal.timeout(60_000),
      });

      if (!res.ok) {
        const text = await res.text();
        const snippet = sanitize(text).slice(0, 200);
        console.error(sanitize(`[${id}] ASR attempt ${attempt + 1}/${maxRetries + 1} HTTP ${res.status}: ${snippet}`));
        if (attempt === maxRetries) {
          return { error: `HTTP ${res.status}: ${snippet}`, asrText: '', rawText: '' };
        }
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      const json = await res.json();
      const rawText = json.text || '';
      const asrText = cleanAsrText(rawText);
      return { asrText, rawText, error: null };
    } catch (err) {
      const msg = sanitize(err.message);
      console.error(sanitize(`[${id}] ASR attempt ${attempt + 1}/${maxRetries + 1} error: ${msg}`));
      if (attempt === maxRetries) {
        return { error: msg, asrText: '', rawText: '' };
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// Write the manifest in narration order (atomic).
function writeManifest(m) {
  const ordered = {};
  for (const item of items) if (m[item.id]) ordered[item.id] = m[item.id];
  const tmp = `${manifestPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ordered, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, manifestPath);
}

function cleanOldRawForId(id, currentRawHash) {
  if (!fs.existsSync(rawDir)) return;
  for (const filename of fs.readdirSync(rawDir)) {
    if (filename.startsWith(`${id}-`) && filename.endsWith('.mp3')) {
      if (filename !== `${id}-${currentRawHash}.mp3`) {
        console.log(`[cleanup] deleting outdated raw: ${filename}`);
        try {
          fs.unlinkSync(path.join(rawDir, filename));
        } catch {}
      }
    }
  }
}

function cleanupAll(itemsList) {
  const validIds = new Set(itemsList.map((it) => it.id));
  const validRawFiles = new Set(itemsList.map((it) => `${it.id}-${it.rawHash}.mp3`));

  // 1. Delete mp3s for IDs no longer in narration
  if (fs.existsSync(voDir)) {
    for (const filename of fs.readdirSync(voDir)) {
      const fullPath = path.join(voDir, filename);
      if (fs.statSync(fullPath).isFile() && filename.endsWith('.mp3')) {
        const id = filename.slice(0, -4);
        if (!validIds.has(id)) {
          console.log(`[cleanup] deleting obsolete mp3: ${filename}`);
          fs.unlinkSync(fullPath);
        }
      }
    }
  }

  // 2. Delete raw cache files for IDs no longer in narration, and outdated rawHash files for existing IDs
  if (fs.existsSync(rawDir)) {
    for (const filename of fs.readdirSync(rawDir)) {
      const fullPath = path.join(rawDir, filename);
      if (fs.statSync(fullPath).isFile() && filename.endsWith('.mp3')) {
        if (!validRawFiles.has(filename)) {
          console.log(`[cleanup] deleting obsolete raw: ${filename}`);
          fs.unlinkSync(fullPath);
        }
      }
    }
  }
}

const updatedManifest = { ...manifest };
const failedAsrItems = [];

// Branch: --check mode
if (isCheck) {
  console.log(`[check] Checking ASR scores for existing raw audio (${items.length} items)...`);
  for (const item of items) {
    if (onlyIds && !onlyIds.has(item.id)) continue;

    const rawFile = path.join(rawDir, `${item.id}-${item.rawHash}.mp3`);
    const mp3Path = path.join(voDir, `${item.id}.mp3`);
    const canMigrate = fs.existsSync(mp3Path) && !fs.existsSync(rawFile) && manifest[item.id]?.hash === item.rawHash;
    if (canMigrate) {
      console.log(`[migrate] moving ${item.id}.mp3 -> raw/${path.basename(rawFile)}`);
      fs.renameSync(mp3Path, rawFile);
    }
    if (!fs.existsSync(rawFile)) {
      console.log(`[check] ${item.id}: 无 raw 缓存文件 (${path.basename(rawFile)})，跳过`);
      continue;
    }

    const audioBuffer = fs.readFileSync(rawFile);
    const asrRes = await requestAsrWithRetry(audioBuffer, item.id);

    let score = null;
    let asrText = '';
    if (asrRes.error) {
      failedAsrItems.push({ id: item.id, error: asrRes.error });
    } else {
      asrText = asrRes.asrText;
      score = scoreTranscript(item.ttsText, asrRes.rawText || asrRes.asrText);
    }

    const scoreStr = score != null ? score.toFixed(2) : 'null';
    console.log(sanitize(`${item.id} score=${scoreStr} 识别：${asrText}`));

    if (!updatedManifest[item.id]) {
      updatedManifest[item.id] = {
        hash: item.hash,
        seconds: 0,
      };
    }
    updatedManifest[item.id].asr = asrText;
    updatedManifest[item.id].score = score;
    writeManifest(updatedManifest);
  }

  // Summary
  if (failedAsrItems.length > 0) {
    console.warn('\n以下句子语音识别请求失败（已保留音频，score 记为 null）:');
    for (const f of failedAsrItems) {
      console.warn(`  - ${f.id}: ${f.error}`);
    }
  }

  const belowMinList = [];
  for (const item of items) {
    if (onlyIds && !onlyIds.has(item.id)) continue;
    const entry = updatedManifest[item.id];
    if (!entry || entry.score == null || entry.score < item.minScore) {
      belowMinList.push({
        id: item.id,
        score: entry?.score ?? null,
        minScore: item.minScore,
        asr: entry?.asr ?? '',
        expected: item.ttsText,
      });
    }
  }

  if (belowMinList.length > 0) {
    console.log('\n[check] 以下句子得分低于门槛 (score < minScore):');
    for (const b of belowMinList) {
      const scoreStr = b.score != null ? b.score.toFixed(2) : 'null';
      console.log(`  - ${b.id}: score=${scoreStr} < minScore=${b.minScore.toFixed(2)} 期望："${b.expected}" 识别："${b.asr}"`);
    }
  } else {
    console.log('\n[check] 所有检查句子得分均已达到或超过门槛！');
  }

  writeManifest(updatedManifest);
  process.exit(0);
}

// Main generation loop
for (const item of items) {
  const rawFile = path.join(rawDir, `${item.id}-${item.rawHash}.mp3`);
  const mp3Path = path.join(voDir, `${item.id}.mp3`);
  const isUpToDate = fs.existsSync(mp3Path) && manifest[item.id]?.hash === item.hash;

  if (onlyIds && !onlyIds.has(item.id)) {
    continue;
  }

  if (isUpToDate && !onlyIds) {
    console.log(`[skip] ${item.id} is up to date`);
    if (updatedManifest[item.id]?.seconds == null) {
      updatedManifest[item.id] = {
        ...manifest[item.id],
        hash: item.hash,
        seconds: getDurationInSeconds(mp3Path),
      };
    }
    continue;
  }

  // 1. Ensure raw audio exists
  const canMigrate = fs.existsSync(mp3Path) && !fs.existsSync(rawFile) && manifest[item.id]?.hash === item.rawHash;
  if (canMigrate) {
    console.log(`[migrate] moving ${item.id}.mp3 -> raw/${path.basename(rawFile)}`);
    fs.renameSync(mp3Path, rawFile);
  }

  const needsRequest = !fs.existsSync(rawFile) || (onlyIds && onlyIds.has(item.id));
  let selectedCandidate = null;
  let takesCount = 0;

  if (needsRequest) {
    let bestCandidate = null;

    // Existing version participates in selection if present
    if (fs.existsSync(rawFile)) {
      const existingBuffer = fs.readFileSync(rawFile);
      let existingScore = manifest[item.id]?.score ?? null;
      let existingAsr = manifest[item.id]?.asr ?? '';

      if (existingScore == null) {
        console.log(`[evaluating existing] ${item.id} ASR score...`);
        const asrRes = await requestAsrWithRetry(existingBuffer, item.id);
        if (asrRes.error) {
          failedAsrItems.push({ id: item.id, error: asrRes.error });
        } else {
          existingAsr = asrRes.asrText;
          existingScore = scoreTranscript(item.ttsText, asrRes.rawText || asrRes.asrText);
        }
      }

      bestCandidate = {
        buffer: existingBuffer,
        score: existingScore,
        asr: existingAsr,
        fromExisting: true,
      };

      if (existingScore != null) {
        console.log(sanitize(`${item.id} [已有版本] score=${existingScore.toFixed(2)} 识别：${existingAsr}`));
      }
    }

    const maxTakes = item.takes;
    for (let take = 1; take <= maxTakes; take++) {
      takesCount = take;
      console.log(`[generating raw] ${item.id} (take ${take}/${maxTakes}): "${item.ttsText}"`);
      const audioBuffer = await requestTtsWithRetry(item);

      const asrRes = await requestAsrWithRetry(audioBuffer, item.id);
      let score = null;
      let asrText = '';
      if (asrRes.error) {
        failedAsrItems.push({ id: item.id, error: asrRes.error });
      } else {
        asrText = asrRes.asrText;
        score = scoreTranscript(item.ttsText, asrRes.rawText || asrRes.asrText);
      }

      const scoreStr = score != null ? score.toFixed(2) : 'null';
      console.log(sanitize(`${item.id} 第 ${take} 次 score=${scoreStr} 识别：${asrText}`));

      if (bestCandidate == null) {
        bestCandidate = {
          buffer: audioBuffer,
          score,
          asr: asrText,
          fromExisting: false,
        };
      } else if (score != null) {
        if (bestCandidate.score == null || score > bestCandidate.score) {
          bestCandidate = {
            buffer: audioBuffer,
            score,
            asr: asrText,
            fromExisting: false,
          };
        }
      }

      // Stop once score >= minScore
      if (score != null && score >= item.minScore) {
        break;
      }
    }

    selectedCandidate = bestCandidate;
    if (selectedCandidate && !selectedCandidate.fromExisting) {
      fs.writeFileSync(rawFile, selectedCandidate.buffer);
    }
  } else {
    // rawFile already ready, only postprocessing needed
    selectedCandidate = {
      score: manifest[item.id]?.score ?? null,
      asr: manifest[item.id]?.asr ?? '',
    };
    takesCount = manifest[item.id]?.takes ?? 1;
  }

  // Clean old raw files for this ID if any
  cleanOldRawForId(item.id, item.rawHash);

  // 2. Postprocess audio: tempo + trim silence
  console.log(`[postprocessing] ${item.id}: (atempo=${item.tempo})`);
  postprocessAudio(rawFile, mp3Path, item.tempo);

  const seconds = getDurationInSeconds(mp3Path);
  updatedManifest[item.id] = {
    hash: item.hash,
    seconds,
    asr: selectedCandidate?.asr ?? (manifest[item.id]?.asr ?? ''),
    score: selectedCandidate?.score ?? (manifest[item.id]?.score ?? null),
    takes: takesCount,
  };
  writeManifest(updatedManifest);
  const scoreStr = updatedManifest[item.id].score != null ? updatedManifest[item.id].score.toFixed(2) : 'null';
  console.log(`[done] ${item.id} -> ${seconds}s (score=${scoreStr})`);
}

cleanupAll(items);
writeManifest(updatedManifest);

if (failedAsrItems.length > 0) {
  console.warn('\n以下句子语音识别请求失败（已保留音频，score 记为 null）:');
  for (const f of failedAsrItems) {
    console.warn(`  - ${f.id}: ${f.error}`);
  }
}

console.log(`Manifest written to ${manifestPath}`);
