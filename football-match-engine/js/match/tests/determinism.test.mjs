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

test('새 엔진이 구 엔진 코드를 가져다 쓰지 않는다', async () => {
  // Section 42: 레거시 AI를 이유 없이 가져다 쓰지 않는다.
  //
  // 모듈 이름으로 판정하면 새 엔진이 같은 개념을 새로 구현한 파일까지
  // 오탐한다(예: 새로 작성한 ai/DuelResolver.js). 대신 "경로"로 판정한다.
  // 새 엔진(js/match/) 밖으로 나가는 import는 아래 화이트리스트만 허용한다.
  const ALLOWED_OUTSIDE = [
    '../../entities/Vector2D.js',
    '../../entities/Pitch.js',
    '../../core/EventBus.js',
  ];

  const files = await collectSourceFiles(ENGINE_ROOT);
  const offenders = [];
  const importPattern = /from\s+['"]([^'"]+)['"]/g;

  for (const file of files) {
    const text = await readFile(file, 'utf8');
    stripComments(text).forEach((code, i) => {
      let match;
      importPattern.lastIndex = 0;
      while ((match = importPattern.exec(code)) !== null) {
        const path = match[1];
        // 새 엔진 내부 참조는 언제나 허용
        if (!path.includes('../../')) continue;
        if (ALLOWED_OUTSIDE.includes(path)) continue;
        offenders.push(`${relative(ENGINE_ROOT, file)}:${i + 1} → ${path}`);
      }
    });
  }

  assert(offenders.length === 0,
    `허용되지 않은 외부(구 엔진) 참조 발견:\n    ${offenders.join('\n    ')}\n` +
    `  허용 목록: ${ALLOWED_OUTSIDE.join(', ')}`);
});
