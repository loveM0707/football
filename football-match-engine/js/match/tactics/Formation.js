import { Role, Line, roleDefaults } from './RoleModel.js';

/**
 * 포메이션 모델.
 *
 * 포메이션은 좌표의 집합이 아니라 "구조"다. 여기서 정의하는 것은:
 *   - 어떤 역할이 몇 명 있는가
 *   - 각 선수가 어느 라인에 속하는가
 *   - 라인 안에서 좌우 어느 채널(통로)을 담당하는가
 *   - 라인 사이의 상대적 간격 비율
 *
 * 실제 미터 좌표는 TeamShape가 팀 상태(블록 높이·폭·컴팩트니스·볼 위치)와
 * 결합해 매 틱 계산한다. 이 파일에는 절대 좌표가 존재하지 않는다.
 *
 * channel: -1(팀 기준 왼쪽 터치라인) ~ 0(중앙) ~ +1(오른쪽 터치라인)
 *          실제 좌우 거리는 팀 폭(teamWidth) 설정에 비례해 정해진다.
 * depth  : 소속 라인 기준 전후 미세 조정 (m, +가 전방). 역할 기본값에 더해진다.
 */

/**
 * 라인 간 상대 간격.
 * 0 = 최후방 라인, 1 = 최전방 라인. 실제 거리는 teamLength에 비례한다.
 */
const DEFAULT_LINE_SPACING = {
  [Line.BACK]: 0.0,
  [Line.MID]: 0.46,
  [Line.ATTACK]: 1.0,
};

const FORMATIONS = {
  '4-4-2': {
    name: '4-4-2',
    lineSpacing: DEFAULT_LINE_SPACING,
    slots: [
      { role: Role.GK,     channel:  0.00 },
      { role: Role.FB,     channel: -0.86 },
      { role: Role.CB,     channel: -0.30 },
      { role: Role.CB,     channel:  0.30 },
      { role: Role.FB,     channel:  0.86 },
      { role: Role.WINGER, channel: -0.88, line: Line.MID, depth: -2 },
      { role: Role.CM,     channel: -0.26 },
      { role: Role.CM,     channel:  0.26 },
      { role: Role.WINGER, channel:  0.88, line: Line.MID, depth: -2 },
      { role: Role.ST,     channel: -0.20 },
      { role: Role.ST,     channel:  0.20 },
    ],
  },

  '4-3-3': {
    name: '4-3-3',
    // 3톱은 전방 라인이 더 높고 미드필드가 촘촘하다
    lineSpacing: { [Line.BACK]: 0.0, [Line.MID]: 0.44, [Line.ATTACK]: 1.0 },
    slots: [
      { role: Role.GK,     channel:  0.00 },
      { role: Role.FB,     channel: -0.86 },
      { role: Role.CB,     channel: -0.30 },
      { role: Role.CB,     channel:  0.30 },
      { role: Role.FB,     channel:  0.86 },
      { role: Role.DM,     channel:  0.00 },
      { role: Role.CM,     channel: -0.42, depth: 4 },
      { role: Role.CM,     channel:  0.42, depth: 4 },
      { role: Role.WINGER, channel: -0.90 },
      { role: Role.ST,     channel:  0.00 },
      { role: Role.WINGER, channel:  0.90 },
    ],
  },

  '4-2-3-1': {
    name: '4-2-3-1',
    lineSpacing: { [Line.BACK]: 0.0, [Line.MID]: 0.42, [Line.ATTACK]: 1.0 },
    slots: [
      { role: Role.GK,     channel:  0.00 },
      { role: Role.FB,     channel: -0.86 },
      { role: Role.CB,     channel: -0.30 },
      { role: Role.CB,     channel:  0.30 },
      { role: Role.FB,     channel:  0.86 },
      { role: Role.DM,     channel: -0.24 },
      { role: Role.DM,     channel:  0.24 },
      // 2선(3) 은 미드 라인보다 앞, 최전방보다 뒤 — depth 로 표현한다
      { role: Role.WINGER, channel: -0.88, line: Line.MID, depth: 12 },
      { role: Role.AM,     channel:  0.00, line: Line.MID, depth: 12 },
      { role: Role.WINGER, channel:  0.88, line: Line.MID, depth: 12 },
      { role: Role.ST,     channel:  0.00 },
    ],
  },
};

/**
 * 포메이션 정의를 가져온다. 없으면 4-4-2로 대체한다.
 * @param {string} name
 */
export function getFormation(name) {
  return FORMATIONS[name] ?? FORMATIONS['4-4-2'];
}

/** 사용 가능한 포메이션 이름 목록 */
export function formationNames() {
  return Object.keys(FORMATIONS);
}

/**
 * 포메이션 슬롯을 정규화해 반환한다.
 * 역할 기본값(라인·깊이 성향)과 슬롯 재정의를 합쳐 최종 구조를 만든다.
 *
 * @param {string} name 포메이션 이름
 * @returns {Array<{role:string, line:string, channel:number, depth:number, index:number}>}
 */
export function resolveSlots(name) {
  const formation = getFormation(name);
  return formation.slots.map((slot, index) => {
    const defaults = roleDefaults(slot.role);
    return {
      index,
      role: slot.role,
      // 슬롯이 라인을 명시하면 그것을 쓰고, 아니면 역할 기본 라인을 쓴다
      line: slot.line ?? defaults.line,
      channel: slot.channel,
      // 역할의 기본 깊이 성향 + 슬롯 고유 조정
      depth: (defaults.depthBias ?? 0) + (slot.depth ?? 0),
    };
  });
}

/**
 * 라인의 상대 간격 비율을 반환한다 (0 = 최후방, 1 = 최전방).
 * @param {string} name 포메이션 이름
 * @param {string} line Line 값
 */
export function lineSpacing(name, line) {
  const formation = getFormation(name);
  return formation.lineSpacing?.[line] ?? DEFAULT_LINE_SPACING[line] ?? 0.5;
}

/**
 * 포메이션 정합성 검사 — 개발 중 슬롯 정의 실수를 잡는다.
 * @returns {string[]} 문제 목록 (비어 있으면 정상)
 */
export function validateFormation(name) {
  const problems = [];
  const slots = resolveSlots(name);

  if (slots.length !== 11) {
    problems.push(`${name}: 선수 수가 11명이 아님 (${slots.length}명)`);
  }

  const gkCount = slots.filter((s) => s.role === Role.GK).length;
  if (gkCount !== 1) {
    problems.push(`${name}: 골키퍼가 정확히 1명이 아님 (${gkCount}명)`);
  }

  for (const s of slots) {
    if (s.channel < -1 || s.channel > 1) {
      problems.push(`${name}: 슬롯 ${s.index}(${s.role}) 채널 범위 초과 (${s.channel})`);
    }
  }

  return problems;
}
