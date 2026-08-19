import { readdir, readFile } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { suite, test, assert } from './_harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = join(HERE, '..');

/** 엔진 소스 트리의 모든 .js 파일 경로를 모은다 (테스트 폴더 제외) */
async function collectSourceFiles(dir, acc = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'tests') continue;
      await collectSourceFiles(full, acc);
    } else if (entry.name.endsWith('.js')) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * 주석을 제거한 코드 라인 배열을 만든다.
 * 블록 주석(/* *\/) 안의 설명문까지 위반으로 잡히지 않도록,
 * 줄 번호는 유지한 채 주석 내용만 비운다.
 */
function stripComments(text) {
  const lines = text.split('\n');
  let inBlock = false;

  return lines.map((line) => {
    let out = '';
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', i);
        if (end === -1) { i = line.length; }
        else { inBlock = false; i = end + 2; }
        continue;
      }
      const blockStart = line.indexOf('/*', i);
      const lineStart = line.indexOf('//', i);

      if (lineStart !== -1 && (blockStart === -1 || lineStart < blockStart)) {
        out += line.slice(i, lineStart);
        break;
      }
      if (blockStart !== -1) {
        out += line.slice(i, blockStart);
        inBlock = true;
        i = blockStart + 2;
        continue;
      }
      out += line.slice(i);
      break;
    }
    return out;
  });
}

suite('PHASE 3 — 결정론 가드 (소스 검사)');

test('시뮬레이션 소스에 Math.random 직접 호출이 없다', async () => {
  const files = await collectSourceFiles(ENGINE_ROOT);
  assert(files.length > 0, '검사할 소스 파일을 찾지 못했습니다');

  const offenders = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    // 주석에서 "쓰지 말라"고 언급하는 경우는 위반이 아니므로 주석을 제거하고 검사한다
    stripComments(text).forEach((code, i) => {
      if (code.includes('Math.random')) {
        offenders.push(`${relative(ENGINE_ROOT, file)}:${i + 1}`);
      }
    });
  }

  assert(offenders.length === 0,
    `Math.random 직접 호출 발견 (Rng를 사용해야 함):\n    ${offenders.join('\n    ')}`);
});

test('시뮬레이션 소스가 Date.now / performance.now에 의존하지 않는다', async () => {
  // 시뮬레이션 시간은 MatchState.totalSeconds만을 근거로 삼아야 한다.
  // 실제 시계에 의존하면 같은 시드로도 재현이 깨진다.
  const files = await collectSourceFiles(ENGINE_ROOT);
  const offenders = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    stripComments(text).forEach((code, i) => {
      if (code.includes('Date.now') || code.includes('performance.now')) {
        offenders.push(`${relative(ENGINE_ROOT, file)}:${i + 1}`);
      }
    });
  }
  assert(offenders.length === 0,
    `실제 시계 의존 발견 (시뮬레이션 시간을 써야 함):\n    ${offenders.join('\n    ')}`);
});

test('시뮬레이션 소스가 구 엔진 AI 모듈을 참조하지 않는다', async () => {
  // Section 42: 레거시 AI를 이유 없이 가져다 쓰지 않는다.
  const LEGACY = [
    'PlayerBrain', 'PlayerMovementController', 'FormationPositioning',
    'OffTheBallMovement', 'OffBallAttack', 'Defending', 'Passing',
    'ThroughPass', 'SpacePassCalculator', 'TeamTempo', 'DuelResolver',
    'MatchSimulator', 'ActionExecutor', 'PhysicsEngine', 'TeamInstructions',
  ];
  const files = await collectSourceFiles(ENGINE_ROOT);
  const offenders = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (!line.includes('import')) return;
      for (const name of LEGACY) {
        if (line.includes(`/${name}.js`)) {
          offenders.push(`${relative(ENGINE_ROOT, file)}:${i + 1} → ${name}`);
        }
      }
    });
  }
  assert(offenders.length === 0,
    `레거시 AI 모듈 참조 발견:\n    ${offenders.join('\n    ')}`);
});
