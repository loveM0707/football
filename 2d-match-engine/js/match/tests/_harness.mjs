/**
 * 최소 테스트 하네스 (외부 의존성 없음).
 *
 * 결정론 검증이 목적이므로 프레임워크의 무작위 실행 순서나
 * 병렬 실행을 쓰지 않는다. 등록 순서대로 순차 실행한다.
 */

const registry = [];
let currentSuite = '(no suite)';

/** 테스트 묶음 이름을 지정한다 */
export function suite(name) {
  currentSuite = name;
}

/**
 * 테스트를 등록한다.
 * @param {string} name 테스트 이름
 * @param {() => void | Promise<void>} fn 본문. 실패 시 예외를 던진다.
 */
export function test(name, fn) {
  registry.push({ suite: currentSuite, name, fn });
}

export class AssertionError extends Error {}

function fail(message) {
  throw new AssertionError(message);
}

/** 조건이 참인지 확인 */
export function assert(condition, message = '조건이 거짓입니다') {
  if (!condition) fail(message);
}

/**
 * 값을 사람이 읽을 수 있는 문자열로 만든다.
 * 엔티티(Player/Team)는 서로를 참조하므로 JSON.stringify가 순환 오류를 낸다.
 * 실패 메시지를 만들다가 테스트가 죽으면 진짜 원인을 볼 수 없으므로 방어한다.
 */
function describe(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const type = typeof value;
  if (type === 'string') return `"${value}"`;
  if (type === 'number' || type === 'boolean') return String(value);
  if (type === 'function') return `[function ${value.name || 'anonymous'}]`;
  if (type === 'object') {
    // 엔티티는 식별자만 보여준다
    if (value.id !== undefined && value.role !== undefined) return `Player(${value.id})`;
    if (value.side !== undefined && value.players !== undefined) return `Team(${value.side})`;
    try {
      return JSON.stringify(value);
    } catch {
      return `[${value.constructor?.name ?? 'object'}]`;
    }
  }
  return String(value);
}

/** 엄격 동등 비교 */
export function assertEqual(actual, expected, message = '') {
  if (actual !== expected) {
    fail(`${message}\n  기대값: ${describe(expected)}\n  실제값: ${describe(actual)}`);
  }
}

/** 부동소수 근사 비교 */
export function assertClose(actual, expected, tolerance = 1e-6, message = '') {
  if (!Number.isFinite(actual)) {
    fail(`${message}\n  실제값이 유한수가 아님: ${actual}`);
  }
  const diff = Math.abs(actual - expected);
  if (diff > tolerance) {
    fail(`${message}\n  기대값: ${expected}\n  실제값: ${actual}\n  오차: ${diff} (허용 ${tolerance})`);
  }
}

/** 값이 [min, max] 범위 안인지 확인 */
export function assertRange(actual, min, max, message = '') {
  if (!(actual >= min && actual <= max)) {
    fail(`${message}\n  기대 범위: [${min}, ${max}]\n  실제값: ${actual}`);
  }
}

/** 깊은 동등 비교 (JSON 직렬화 기준) */
export function assertDeepEqual(actual, expected, message = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    fail(`${message}\n  기대값: ${b}\n  실제값: ${a}`);
  }
}

/** 등록된 모든 테스트를 실행하고 결과를 출력한다 */
export async function runAll() {
  const failures = [];
  let passed = 0;
  let lastSuite = null;

  for (const item of registry) {
    if (item.suite !== lastSuite) {
      console.log(`\n── ${item.suite} ${'─'.repeat(Math.max(0, 52 - item.suite.length))}`);
      lastSuite = item.suite;
    }
    try {
      await item.fn();
      passed++;
      console.log(`  ✓ ${item.name}`);
    } catch (err) {
      failures.push({ ...item, err });
      console.log(`  ✗ ${item.name}`);
    }
  }

  console.log(`\n${'='.repeat(56)}`);
  if (failures.length === 0) {
    console.log(`통과 ${passed}/${registry.length} — 전부 성공`);
    return 0;
  }

  console.log(`통과 ${passed}/${registry.length}, 실패 ${failures.length}\n`);
  for (const f of failures) {
    console.log(`실패: [${f.suite}] ${f.name}`);
    const msg = f.err instanceof AssertionError ? f.err.message : (f.err?.stack ?? String(f.err));
    console.log(`${String(msg).split('\n').map((l) => `    ${l}`).join('\n')}\n`);
  }
  return 1;
}
