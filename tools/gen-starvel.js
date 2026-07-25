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
 *   5. 未マッチの星と距離不明の星（r > 1900pc）は [0,0,0] に設定
 *
 * 出力ファイル:
 *   starvel.js - window.UCHU_DATA.vel = [[vx,vy,vz], ...] (pc/百万年・小数4桁)
 *   並び順は stars.js と同じ index 順。
 */

const fs = require('fs');
const path = require('path');

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

    if (!isFinite(x) || !isFinite(y) || !isFinite(z) || !isFinite(mag)) continue;

    hygStars.push({
      id, x, y, z, mag, ci, vx, vy, vz, dist,
      unitDir: unitVector(x, y, z)
    });
  }
  console.log(`Loaded ${hygStars.length} stars from HYG`);

  // 照合（格子を使った最適化）
  const GRID_SIZE = 20; // 格子セルのサイズ（単位ベクトル空間）
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

  // 速度配列を初期化（0,0,0 = 未マッチ）
  const velocities = new Array(stars.length).fill(null).map(() => [0, 0, 0]);
  let matched = 0;
  let unmatched = 0;
  let zeroVel = 0;

  console.log('Matching stars...');
  for (let i = 0; i < stars.length; i++) {
    const star = stars[i];
    const [x, y, z, mag, bv, conIdx] = star;

    const r = Math.sqrt(x * x + y * y + z * z);
    const starUnitDir = unitVector(x, y, z);
    const [ux, uy, uz] = starUnitDir;

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
          if (r < 1900 && isFinite(hygStar.dist)) {
            const coordDist = distance(x, y, z, hygStar.x, hygStar.y, hygStar.z);
            if (coordDist > 0.02) continue;
          }

          bestMatch = hygStar;
          bestDot = dotProd;
        }
      }
    }

    if (bestMatch) {
      // 速度変換：pc/年 → pc/百万年
      const scale = 1e6;
      velocities[i] = [
        parseFloat((bestMatch.vx * scale).toFixed(4)),
        parseFloat((bestMatch.vy * scale).toFixed(4)),
        parseFloat((bestMatch.vz * scale).toFixed(4))
      ];
      matched++;
    } else {
      // 未マッチ
      if (r > 1900) {
        zeroVel++; // 距離不明の星
      } else {
        unmatched++;
      }
      velocities[i] = [0, 0, 0];
    }

    if ((i + 1) % 1000 === 0) {
      console.log(`  Processed ${i + 1}/${stars.length}`);
    }
  }

  console.log(`Matching complete: ${matched} matched, ${unmatched} unmatched, ${zeroVel} distance-unknown`);

  // starvel.js を生成
  const output = `window.UCHU_DATA.vel=${JSON.stringify(velocities)};`;
  fs.writeFileSync(outputPath, output, 'utf8');
  console.log(`Written to ${outputPath} (${Math.round(fs.statSync(outputPath).size / 1024)}KB)`);

  // 検算: 速度の統計
  // starvel.js の値は pc/百万年なので、検算時は pc/年 に逆算してから km/s に変換
  const speeds = velocities
    .map(v => Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]))
    .filter(s => s > 0)
    .sort((a, b) => a - b);

  const speedsKmS = speeds.map(s => {
    const vPcPerYear = s / 1e6; // pc/百万年 → pc/年
    return vPcPerYear * 977792; // pc/年 → km/s
  });
  const median = speedsKmS[Math.floor(speedsKmS.length / 2)];

  console.log(`\n【検算結果】`);
  console.log(`速度範囲: ${Math.min(...speedsKmS).toFixed(2)} ～ ${Math.max(...speedsKmS).toFixed(2)} km/s`);
  console.log(`中央値: ${median.toFixed(2)} km/s`);
  console.log(`件数: 照合 ${matched} / 未マッチ ${unmatched} / 距離不明 ${zeroVel}`);

  // 有名星の速度確認（HYG から直接検索）
  const properIdx = header.indexOf('proper');
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
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
