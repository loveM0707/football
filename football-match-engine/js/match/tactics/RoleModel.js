/**
 * 역할(Role) 모델.
 *
 * 역할은 "기본 책임"만 정의한다. 실제 행동은 역할이 아니라
 * 그때그때 배정되는 임무(Duty) + 팀 상태 + 국소 상황에서 나온다.
 * 따라서 이 파일에는 좌표가 없고, 라인 소속·활동 자유도·성향만 있다.
 */

/** 선수 역할 */
export const Role = {
  GK: 'GK',          // 골키퍼
  CB: 'CB',          // 센터백
  FB: 'FB',          // 풀백
  DM: 'DM',          // 수비형 미드필더
  CM: 'CM',          // 중앙 미드필더
  AM: 'AM',          // 공격형 미드필더
  WINGER: 'WINGER',  // 윙어
  ST: 'ST',          // 스트라이커
};

/** 팀 구조상의 라인 */
export const Line = {
  GK: 'GK',
  BACK: 'BACK',
  MID: 'MID',
  ATTACK: 'ATTACK',
};

/**
 * 임무(Duty) — 매 틱 TacticalEngine이 선수에게 배정하는 현재 역할.
 * 역할(Role)이 "이 선수는 원래 무엇인가"라면, 임무는 "지금 무엇을 하는가"다.
 */
export const Duty = {
  // 공격 시
  SUPPORT: 'SUPPORT',             // 볼 소유자에게 패스 각도 제공
  HOLD_WIDTH: 'HOLD_WIDTH',       // 터치라인 쪽 폭 유지
  OVERLAP: 'OVERLAP',             // 동료 바깥쪽으로 추월
  UNDERLAP: 'UNDERLAP',           // 동료 안쪽 하프스페이스로 침투
  RUN_BEHIND: 'RUN_BEHIND',       // 수비 라인 뒤 공간 침투
  RUN_BETWEEN: 'RUN_BETWEEN',     // 수비 사이 공간 점유
  CHECK_TO_BALL: 'CHECK_TO_BALL', // 볼 쪽으로 내려와 받기
  THIRD_MAN_RUN: 'THIRD_MAN_RUN', // 제3자 침투
  DROP: 'DROP',                   // 뒤로 내려와 빌드업 지원
  REST_DEFENCE: 'REST_DEFENCE',   // 공격 중 후방 잔류 (역습 대비)

  // 수비 시
  PRESS: 'PRESS',                 // 볼 소유자 압박
  COVER: 'COVER',                 // 압박자 뒤 커버
  MARK: 'MARK',                   // 특정 상대 마크
  HOLD_LINE: 'HOLD_LINE',         // 수비 라인 유지
  RECOVER: 'RECOVER',             // 자기 위치로 복귀

  // 공통
  CHASE_LOOSE: 'CHASE_LOOSE',     // 루즈볼 추격 (팀당 1명)
  GOALKEEP: 'GOALKEEP',           // 골키퍼 전용
};

/**
 * 역할별 기본 속성.
 *
 * line          : 소속 라인
 * depthBias     : 소속 라인 기준 전후 미세 조정 (m, +가 전방)
 * widthBias     : 기본 폭 성향 0(중앙) ~ 1(터치라인)
 * attackFreedom : 공격 시 기준 위치에서 벗어날 수 있는 반경 (m)
 * defenceFreedom: 수비 시 기준 위치에서 벗어날 수 있는 반경 (m)
 * pressPriority : 압박 임무 배정 우선도 (낮을수록 먼저 나간다)
 * restDefence   : 공격 시 후방 잔류 성향 0~1
 * dutyAffinity  : 임무별 선호 가중치 (없으면 1.0)
 *
 * 숫자는 "역할 간 상대 관계"를 표현하는 값이며, 위치를 직접 지정하지 않는다.
 * 실제 좌표는 TeamShape가 라인·폭·컴팩트니스에서 계산한다.
 */
const ROLE_DEFAULTS = {
  [Role.GK]: {
    line: Line.GK,
    depthBias: 0,
    widthBias: 0.0,
    attackFreedom: 6,
    defenceFreedom: 10,
    pressPriority: 99,
    restDefence: 1.0,
    dutyAffinity: { [Duty.GOALKEEP]: 1 },
  },
  [Role.CB]: {
    line: Line.BACK,
    depthBias: 0,
    widthBias: 0.22,
    attackFreedom: 8,    // 공격 시 활동 자유 작음
    defenceFreedom: 12,
    pressPriority: 5,
    restDefence: 0.95,
    dutyAffinity: { [Duty.HOLD_LINE]: 1.4, [Duty.COVER]: 1.3, [Duty.REST_DEFENCE]: 1.5 },
  },
  [Role.FB]: {
    line: Line.BACK,
    depthBias: 1,
    widthBias: 0.92,
    attackFreedom: 22,   // 오버랩으로 크게 전진 가능
    defenceFreedom: 14,
    pressPriority: 3,
    restDefence: 0.55,
    dutyAffinity: { [Duty.OVERLAP]: 1.6, [Duty.HOLD_WIDTH]: 1.3, [Duty.MARK]: 1.2 },
  },
  [Role.DM]: {
    line: Line.MID,
    depthBias: -4,
    widthBias: 0.28,
    attackFreedom: 12,
    defenceFreedom: 13,
    pressPriority: 2,
    restDefence: 0.85,
    dutyAffinity: { [Duty.COVER]: 1.5, [Duty.REST_DEFENCE]: 1.4, [Duty.SUPPORT]: 1.2 },
  },
  [Role.CM]: {
    line: Line.MID,
    depthBias: 0,
    widthBias: 0.35,
    attackFreedom: 20,   // 중간 정도 자유도
    defenceFreedom: 15,
    pressPriority: 1,
    restDefence: 0.45,
    dutyAffinity: { [Duty.SUPPORT]: 1.4, [Duty.RUN_BETWEEN]: 1.2, [Duty.THIRD_MAN_RUN]: 1.3 },
  },
  [Role.AM]: {
    line: Line.MID,
    depthBias: 6,
    widthBias: 0.32,
    attackFreedom: 26,
    defenceFreedom: 16,
    pressPriority: 2,
    restDefence: 0.2,
    dutyAffinity: { [Duty.RUN_BETWEEN]: 1.6, [Duty.CHECK_TO_BALL]: 1.3, [Duty.THIRD_MAN_RUN]: 1.4 },
  },
  [Role.WINGER]: {
    line: Line.ATTACK,
    depthBias: -2,
    widthBias: 0.95,
    attackFreedom: 28,   // 활동 자유도 큼
    defenceFreedom: 20,
    pressPriority: 4,
    restDefence: 0.15,
    dutyAffinity: { [Duty.HOLD_WIDTH]: 1.7, [Duty.RUN_BEHIND]: 1.3, [Duty.UNDERLAP]: 1.2 },
  },
  [Role.ST]: {
    line: Line.ATTACK,
    depthBias: 0,
    widthBias: 0.18,
    attackFreedom: 30,   // 활동 자유도 큼
    defenceFreedom: 22,
    pressPriority: 6,
    restDefence: 0.05,
    dutyAffinity: { [Duty.RUN_BEHIND]: 1.8, [Duty.CHECK_TO_BALL]: 1.2, [Duty.RUN_BETWEEN]: 1.3 },
  },
};

/** 역할 기본값 조회 (알 수 없는 역할이면 CM으로 대체) */
export function roleDefaults(role) {
  return ROLE_DEFAULTS[role] ?? ROLE_DEFAULTS[Role.CM];
}

/** 역할이 속한 라인 */
export function roleLine(role) {
  return roleDefaults(role).line;
}

/** 골키퍼인가 */
export function isGoalkeeper(role) {
  return role === Role.GK;
}

/** 수비 라인 소속인가 (골키퍼 제외) */
export function isDefender(role) {
  return roleLine(role) === Line.BACK;
}

/** 최전방 라인 소속인가 */
export function isForward(role) {
  return roleLine(role) === Line.ATTACK;
}

/**
 * 현재 국면에서 이 역할이 기준 위치를 벗어날 수 있는 반경(m).
 * 공격/수비에 따라 자유도가 달라진다.
 * @param {string} role
 * @param {boolean} attacking 팀이 공격 국면인가
 */
export function roamRadius(role, attacking) {
  const d = roleDefaults(role);
  return attacking ? d.attackFreedom : d.defenceFreedom;
}

/**
 * 임무 선호 가중치. TacticalEngine의 임무 배정 비용 계산에 곱해진다.
 * 값이 클수록 그 임무를 맡기 적합하다는 뜻이다.
 */
export function dutyAffinity(role, duty) {
  return roleDefaults(role).dutyAffinity?.[duty] ?? 1.0;
}

/**
 * 표시용 라벨.
 * 렌더러는 기존 엔진의 짧은 포지션 표기를 그리므로,
 * 새 역할 체계를 화면 표기로만 변환한다 (시뮬레이션 로직과 무관).
 */
const DISPLAY_LABEL = {
  [Role.GK]: 'GK',
  [Role.CB]: 'CB',
  [Role.FB]: 'FB',
  [Role.DM]: 'DM',
  [Role.CM]: 'CM',
  [Role.AM]: 'AM',
  [Role.WINGER]: 'WG',
  [Role.ST]: 'ST',
};

export function roleLabel(role) {
  return DISPLAY_LABEL[role] ?? role;
}
