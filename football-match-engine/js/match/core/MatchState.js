/**
 * 경기 국면(Phase) 정의 — IFAB 경기규칙 8/9조 기준.
 *
 * 이 목록은 경기의 공식 상태이며, 오직 RulesEngine / MatchEngine만
 * 변경할 수 있다. 선수 AI는 국면을 직접 바꾸지 못하고 사건(이벤트)만
 * 발생시킨다. 어떤 재개로 이어질지는 규칙 엔진이 판정한다.
 */
export const Phase = {
  PRE_MATCH: 'PRE_MATCH',                   // 킥오프 이전 대기
  KICKOFF: 'KICKOFF',                       // 킥오프 배치 완료, 차기 직전
  IN_PLAY: 'IN_PLAY',                       // 인플레이 (9조: 볼이 경기 중)
  BALL_OUT: 'BALL_OUT',                     // 아웃 판정 직후, 재개 종류 확정 전
  OFFSIDE: 'OFFSIDE',                       // 오프사이드 반칙 성립 (11조)
  FOUL_STOP: 'FOUL_STOP',                   // 파울 선언 직후, 재개 종류 확정 전
  DIRECT_FREE_KICK: 'DIRECT_FREE_KICK',     // 직접 프리킥 (13조)
  INDIRECT_FREE_KICK: 'INDIRECT_FREE_KICK', // 간접 프리킥 (13조)
  PENALTY: 'PENALTY',                       // 페널티킥 (14조)
  THROW_IN: 'THROW_IN',                     // 스로인 (15조)
  GOAL_KICK: 'GOAL_KICK',                   // 골킥 (16조)
  CORNER_KICK: 'CORNER_KICK',               // 코너킥 (17조)
  GOAL: 'GOAL',                             // 득점 성립, 킥오프 재개 대기
  HALF_TIME: 'HALF_TIME',
  FULL_TIME: 'FULL_TIME',
};

/**
 * 경기 시계가 흐르지 않는 국면.
 * IFAB 기준으로 실제 경기 시계는 계속 흐르지만, 이 시뮬레이션에서는
 * 재개 준비 시간을 "추가 시간"으로 따로 적립해 90분 경기 흐름을 유지한다.
 */
const CLOCK_STOPPED_PHASES = new Set([
  Phase.PRE_MATCH,
  Phase.HALF_TIME,
  Phase.FULL_TIME,
]);

/**
 * 볼이 인플레이 상태인 국면 (9조).
 * 이 집합에 속하지 않으면 볼은 아웃오브플레이이며, 선수 AI는
 * 재개 배치 동작만 수행한다.
 */
const BALL_IN_PLAY_PHASES = new Set([
  Phase.IN_PLAY,
]);

const HALF_DURATION = 45 * 60; // 한 하프의 정규 시간 (초)

/** 추가 시간 상한 (초) — 비현실적으로 길어지는 것을 방지 (5분) */
const MAX_ADDED_TIME = 5 * 60;

/**
 * 경기의 공식 상태 컨테이너.
 *
 * 상태 저장과 시간 진행만 담당하며, 국면 전환 판단 자체는 하지 않는다.
 * (전환 판단은 RulesEngine, 전환 실행은 MatchEngine)
 */
export class MatchState {
  constructor() {
    this.reset();
  }

  reset() {
    this.half = 1;
    /** 현재 하프의 정규 경과 시간 (초, 0~2700) */
    this.halfSeconds = 0;
    /** 현재 하프에 적립된 추가 시간 (초) */
    this.stoppageSeconds = 0;
    /** 경기 시작부터의 총 시뮬레이션 시간 (초) — 결정론 검증·통계용 */
    this.totalSeconds = 0;

    this.phase = Phase.PRE_MATCH;
    /** 현재 국면이 유지된 시간 (초) */
    this.phaseTimer = 0;

    this.score = { home: 0, away: 0 };

    /**
     * 현재 재개 정보.
     * { type, position, team, kicker, reason } — RestartEngine이 채운다.
     */
    this.restart = null;

    /** 직전에 확정된 경기 사건 (디버그·로그용) */
    this.lastEvent = null;
  }

  // ── 표시용 시계 ────────────────────────────────────────────

  /** 스코어보드에 표시할 분 (후반은 45분부터 이어서 표시) */
  get displayMinute() {
    const base = this.half === 1 ? 0 : 45;
    return base + Math.floor(this.halfSeconds / 60);
  }

  /** 스코어보드에 표시할 초 */
  get displaySecond() {
    return Math.floor(this.halfSeconds % 60);
  }

  /** 표시용 추가 시간(분). 0이면 표시하지 않는다. */
  get displayStoppageMinutes() {
    return Math.floor(this.stoppageSeconds / 60);
  }

  // ── 국면 질의 ──────────────────────────────────────────────

  /** 볼이 인플레이인가 (9조) */
  get isBallInPlay() {
    return BALL_IN_PLAY_PHASES.has(this.phase);
  }

  /** 경기 시계가 흐르는 국면인가 */
  get isClockRunning() {
    return !CLOCK_STOPPED_PHASES.has(this.phase);
  }

  /** 재개(세트피스) 배치 중인가 — 인플레이도 종료 국면도 아닌 상태 */
  get isRestartPending() {
    return !this.isBallInPlay &&
           this.phase !== Phase.PRE_MATCH &&
           this.phase !== Phase.HALF_TIME &&
           this.phase !== Phase.FULL_TIME;
  }

  /** 하프 정규 시간이 끝났는가 */
  get isHalfExpired() {
    return this.halfSeconds >= HALF_DURATION;
  }

  /** 추가 시간까지 모두 소진했는가 — 하프 종료 조건 */
  get isHalfComplete() {
    return this.halfSeconds >= HALF_DURATION + this.stoppageSeconds;
  }

  // ── 상태 변경 (MatchEngine/RulesEngine 전용) ────────────────

  /**
   * 국면을 전환하고 국면 타이머를 초기화한다.
   * @param {string} phase Phase 값
   * @param {object|null} restart 재개 정보 (없으면 null로 초기화)
   */
  setPhase(phase, restart = null) {
    this.phase = phase;
    this.phaseTimer = 0;
    this.restart = restart;
  }

  /**
   * 한 스텝만큼 시간을 전진시킨다.
   * @param {number} dt 고정 스텝 (초)
   */
  advance(dt) {
    this.totalSeconds += dt;
    this.phaseTimer += dt;
    if (this.isClockRunning) {
      this.halfSeconds += dt;
    }
  }

  /**
   * 재개 준비로 소모된 시간을 추가 시간으로 적립한다 (7조 취지).
   * @param {number} seconds
   */
  addStoppage(seconds) {
    this.stoppageSeconds = Math.min(MAX_ADDED_TIME, this.stoppageSeconds + seconds);
  }

  /** 득점 기록 */
  addGoal(side) {
    if (side === 'home') this.score.home++;
    else this.score.away++;
  }

  /** 후반 시작 — 시계와 추가 시간을 리셋한다 */
  startSecondHalf() {
    this.half = 2;
    this.halfSeconds = 0;
    this.stoppageSeconds = 0;
  }

  /**
   * 결정론 검증용 상태 요약.
   * 동일 시드로 두 번 돌렸을 때 이 값이 일치해야 한다.
   */
  snapshot() {
    return {
      half: this.half,
      halfSeconds: Math.round(this.halfSeconds * 1000) / 1000,
      phase: this.phase,
      score: { ...this.score },
    };
  }
}

export { HALF_DURATION };
