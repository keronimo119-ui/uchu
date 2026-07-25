#!/usr/bin/env node
/**
 * HYG Database と stars.js を照合して、星の固有運動速度データを生成
 *
 * 入手先:
 *   - HYG Database v41: https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv
 *   - stars.js: C:\Users\s-sigpc\Desktop\AI\uchu\stars.js（index.html から読み込み）
 *
 * 使い方:
 *   node gen-starvel.js <stars.js-path> <hygdata-csv-path> <output-starvel.js-path>
 *
 * 照合方法:
 *   1. stars.js の各星について単位方向ベクトルを計算
 *   2. HYG の星と比較：dot product > 0.999995 かつ見かけ等級差 ±0.05
 *   3. 距離が既知の星（r < 1900pc）については、座標差も 0.02pc 以内を確認
 *   4. マッチした星の速度（vx,vy,vz）を単位変換（pc/年 → pc/百万年 = ×1e6）
 *
 * 速度の処理（重要・実在性確保）:
 *   5a. 距離不明の星（r > 1900pc）は [0,0,0] に設定
 *       理由：アプリ側で r>1900pc の星は「方向だけ本物・距離は架空の2000pc」に置いてある。
 *             HYG は距離不明星を 10万pc に置くため、そこから計算した v は
 *             「架空の距離に基づく架空の動き」になり、アプリの大原則に違反。
 *             「動きが分からない星」として正直に 0 で扱うのが正解。
 *   5b. 速度の上限チェック：|v| > 600 km/s の星も [0,0,0]
 *       理由：実在の星の空間速度は最速級（超高速度星）でも 1000 km/s 程度。
 *             HYG の超過値は視差の測定誤差による暴走。視差誤差を持ち込まないため
 *             600 km/s （≈ 0.000614 pc/年）を上限とし、超えたら 0 に。
 *   6. 未マッチの星も [0,0,0]
 *
 * 出力ファイル:
 *   starvel.js - window.UCHU_DATA.vel = [[vx,vy,vz], ...] (pc/百万年・小数4桁)
 *   並び順は stars.js と同じ index 順。
 */

const fs = require('fs');
const path = require('path');

// 速度上限（cm/s 単位で管理）
const SPEED_LIMIT_KM_S = 600; // km/s
const SPEED_LIMIT_PC_PER_YEAR = SPEED_LIMIT_KM_S / 977792;

// CSV パース（ダブルクォート対応）
function parseCSV(csvText) {
  const lines = csvText.split('\n');
  const result = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const fields = [];
    let current = '';
    let inQuotes = false;

    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      const nextCh = j + 1 < line.length ? line[j + 1] : '';

      if (ch === '"') {
        if (inQuotes && nextCh === '"') {
          current += '"';
          j++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    fields.push(current);
    result.push(fields);
  }

  return result;
}

// 単位方向ベクトル（正規化）
function unitVector(x, y, z) {
  const len = Math.sqrt(x * x + y * y + z * z);
  if (len === 0) return [0, 0, 0];
  return [x / len, y / len, z / len];
}

// ドット積
function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

// 距離
function distance(x1, y1, z1, x2, y2, z2) {
  const dx = x1 - x2;
  const dy = y1 - y2;
  const dz = z1 - z2;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

async function main() {
  const starsPath = process.argv[2];
  const hygPath = process.argv[3];
  const outputPath = process.argv[4];

  if (!starsPath || !hygPath || !outputPath) {
    console.error('Usage: node gen-starvel.js <stars.js> <hyg.csv> <output.js>');
    process.exit(1);
  }

  console.log('Reading stars.js...');
  const starsContent = fs.readFileSync(starsPath, 'utf8');
  const starsMatch = starsContent.match(/window\.UCHU_DATA=(\{.*\})/);
  if (!starsMatch) {
    console.error('stars.js format error');
    process.exit(1);
  }

  const starsData = JSON.parse(starsMatch[1]);
  const stars = starsData.stars;
  console.log(`Loaded ${stars.length} stars from stars.js`);

  console.log('Reading HYG CSV...');
  const hygContent = fs.readFileSync(hygPath, 'utf8');
  const hygLines = parseCSV(hygContent);
  const header = hygLines[0];

  // カラムインデックスを取得
  const idIdx = header.indexOf('id');
  const xIdx = header.indexOf('x');
  const yIdx = header.indexOf('y');
  const zIdx = header.indexOf('z');
  const magIdx = header.indexOf('mag');
  const ciIdx = header.indexOf('ci');
  const vxIdx = header.indexOf('vx');
  const vyIdx = header.indexOf('vy');
  const vzIdx = header.indexOf('vz');
  const distIdx = header.indexOf('dist');
  const properIdx = header.indexOf('proper');

  if ([idIdx, xIdx, yIdx, zIdx, magIdx, ciIdx, vxIdx, vyIdx, vzIdx, distIdx].some(i => i === -1)) {
    console.error('CSV header mismatch');
    process.exit(1);
  }

  // HYG データの前処理（id > 0 のみ、座標・等級・速度が有効）
  const hygStars = [];
  for (let i = 1; i < hygLines.length; i++) {
    const fields = hygLines[i];
    if (fields.length < Math.max(vzIdx, distIdx) + 1) continue;

    const id = parseInt(fields[idIdx]);
    if (id === 0) continue; // 太陽は除外

    const x = parseFloat(fields[xIdx]);
    const y = parseFloat(fields[yIdx]);
    const z = parseFloat(fields[zIdx]);
    const mag = parseFloat(fields[magIdx]);
    const ci = parseFloat(fields[ciIdx]);
    const vx = parseFloat(fields[vxIdx]);
    const vy = parseFloat(fields[vyIdx]);
    const vz = parseFloat(fields[vzIdx]);
    const dist = parseFloat(fields[distIdx]);
    const proper = properIdx >= 0 ? fields[properIdx] : '';

    if (!isFinite(x) || !isFinite(y) || !isFinite(z) || !isFinite(mag)) continue;

    hygStars.push({
      id, x, y, z, mag, ci, vx, vy, vz, dist, proper,
      unitDir: unitVector(x, y, z)
    });
  }
  console.log(`Loaded ${hygStars.length} stars from HYG`);

  // 照合（格子を使った最適化）
  const GRID_SIZE = 20;
  const hygGrid = new Map();

  for (const hygStar of hygStars) {
    const [ux, uy, uz] = hygStar.unitDir;
    const gx = Math.floor(ux * GRID_SIZE) + Math.floor(GRID_SIZE / 2);
    const gy = Math.floor(uy * GRID_SIZE) + Math.floor(GRID_SIZE / 2);
    const gz = Math.floor(uz * GRID_SIZE) + Math.floor(GRID_SIZE / 2);
    const key = `${gx},${gy},${gz}`;

    if (!hygGrid.has(key)) hygGrid.set(key, []);
    hygGrid.get(key).push(hygStar);
  }

  console.log(`Grid created with ${hygGrid.size} cells`);

  // 速度配列を初期化（0,0,0 = 未マッチ/除外）
  const velocities = new Array(stars.length).fill(null).map(() => [0, 0, 0]);
  const stats = {
    matched: 0,
    unmatched: 0,
    distanceUnknown: 0,
    speedExceeded: 0
  };
  const allSpeeds = []; // 速度の集計用（統計・有名星・top 5）

  console.log('Matching stars...');
  for (let i = 0; i < stars.length; i++) {
    const star = stars[i];
    const [x, y, z, mag, bv, conIdx] = star;

    const r = Math.sqrt(x * x + y * y + z * z);
    const starUnitDir = unitVector(x, y, z);
    const [ux, uy, uz] = starUnitDir;

    // 距離不明の星（r > 1900pc）は [0,0,0] にする
    if (r > 1900) {
      stats.distanceUnknown++;
      allSpeeds.push({ index: i, speed: 0, reason: 'distance-unknown' });
      continue;
    }

    // 格子検索（周辺セルも含める）
    let candidates = [];
    const radius = 2;
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dz = -radius; dz <= radius; dz++) {
          const gx = Math.floor(ux * GRID_SIZE) + Math.floor(GRID_SIZE / 2) + dx;
          const gy = Math.floor(uy * GRID_SIZE) + Math.floor(GRID_SIZE / 2) + dy;
          const gz = Math.floor(uz * GRID_SIZE) + Math.floor(GRID_SIZE / 2) + dz;
          const key = `${gx},${gy},${gz}`;
          const cellCandidates = hygGrid.get(key);
          if (cellCandidates) candidates = candidates.concat(cellCandidates);
        }
      }
    }

    // 最良マッチを探す
    let bestMatch = null;
    let bestDot = 0.999995;

    for (const hygStar of candidates) {
      const dotProd = dot(starUnitDir, hygStar.unitDir);

      if (dotProd > bestDot) {
        const magDiff = Math.abs(mag - hygStar.mag);
        if (magDiff <= 0.05) {
          // 距離が既知なら座標差も確認
          if (isFinite(hygStar.dist)) {
            const coordDist = distance(x, y, z, hygStar.x, hygStar.y, hygStar.z);
            if (coordDist > 0.02) continue;
          }

          bestMatch = hygStar;
          bestDot = dotProd;
        }
      }
    }

    if (bestMatch) {
      // 速度を pc/年 で計算してから上限チェック
      const speedPcPerYear = Math.sqrt(bestMatch.vx * bestMatch.vx + bestMatch.vy * bestMatch.vy + bestMatch.vz * bestMatch.vz);

      if (speedPcPerYear > SPEED_LIMIT_PC_PER_YEAR) {
        // 速度が上限を超えた場合は [0,0,0]
        stats.speedExceeded++;
        allSpeeds.push({ index: i, speed: 0, reason: 'speed-exceeded', original: speedPcPerYear * 977792 });
      } else {
        // 速度を pc/百万年 に変換
        const scale = 1e6;
        velocities[i] = [
          parseFloat((bestMatch.vx * scale).toFixed(4)),
          parseFloat((bestMatch.vy * scale).toFixed(4)),
          parseFloat((bestMatch.vz * scale).toFixed(4))
        ];
        stats.matched++;
        allSpeeds.push({
          index: i,
          speed: speedPcPerYear * 977792,
          reason: 'matched',
          proper: bestMatch.proper,
          vx: bestMatch.vx,
          vy: bestMatch.vy,
          vz: bestMatch.vz
        });
      }
    } else {
      // 未マッチ
      stats.unmatched++;
      allSpeeds.push({ index: i, speed: 0, reason: 'unmatched' });
    }

    if ((i + 1) % 1000 === 0) {
      console.log(`  Processed ${i + 1}/${stars.length}`);
    }
  }

  console.log(`\nMatching complete:`);
  console.log(`  Matched: ${stats.matched}`);
  console.log(`  Unmatched: ${stats.unmatched}`);
  console.log(`  Distance unknown (r > 1900pc): ${stats.distanceUnknown}`);
  console.log(`  Speed exceeded (|v| > ${SPEED_LIMIT_KM_S} km/s): ${stats.speedExceeded}`);

  // starvel.js を生成
  const output = `window.UCHU_DATA.vel=${JSON.stringify(velocities)};`;
  fs.writeFileSync(outputPath, output, 'utf8');
  const fileSize = Math.round(fs.statSync(outputPath).size / 1024);
  console.log(`Written to ${outputPath} (${fileSize}KB)`);

  // 検算: 速度の統計
  const speeds = allSpeeds
    .filter(s => s.speed > 0)
    .map(s => s.speed)
    .sort((a, b) => a - b);

  const median = speeds[Math.floor(speeds.length / 2)];
  const maxSpeed = Math.max(...speeds);

  console.log(`\n【検算結果】`);
  console.log(`件数: ${allSpeeds.length} 件`);
  console.log(`  > [0,0,0]: ${allSpeeds.filter(s => s.speed === 0).length}`);
  console.log(`    - 照合できず: ${stats.unmatched}`);
  console.log(`    - 距離不明: ${stats.distanceUnknown}`);
  console.log(`    - 速度超過: ${stats.speedExceeded}`);
  console.log(`速度: 中央値 ${median.toFixed(2)} km/s, 最大値 ${maxSpeed.toFixed(2)} km/s`);

  // 有名星の速度確認（HYG から直接検索）
  const famousSearches = [
    { name: 'Sirius', pattern: /sirius/i },
    { name: 'Arcturus', pattern: /arcturus/i },
    { name: "Barnard's Star", pattern: /barnard/i }
  ];
  console.log('\n【有名星の速度確認（HYG から）】');

  for (const famous of famousSearches) {
    let found = false;
    for (let i = 1; i < hygLines.length; i++) {
      const fields = hygLines[i];
      const proper = properIdx >= 0 ? fields[properIdx] : '';
      if (proper && famous.pattern.test(proper)) {
        const vx = parseFloat(fields[vxIdx]);
        const vy = parseFloat(fields[vyIdx]);
        const vz = parseFloat(fields[vzIdx]);
        const speed = Math.sqrt(vx*vx + vy*vy + vz*vz) * 977792;
        console.log(`  ${famous.name}: ${speed.toFixed(2)} km/s`);
        found = true;
        break;
      }
    }
    if (!found) {
      console.log(`  ${famous.name}: 見つかりません`);
    }
  }

  // 上位5個の高速星を表示
  console.log('\n【上位5個の高速星】');
  const topStars = allSpeeds
    .filter(s => s.proper && s.proper.trim().length > 0)
    .sort((a, b) => b.speed - a.speed)
    .slice(0, 5);

  for (const star of topStars) {
    console.log(`  ${star.proper}: ${star.speed.toFixed(2)} km/s`);
  }

  if (topStars.length === 0) {
    console.log('  （有名星なし）');
  }

  console.log(`\nFile size: ${fileSize}KB`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
