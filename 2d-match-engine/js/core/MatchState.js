export const Phase = {
  KICKOFF: 'KICKOFF',
  IN_PLAY: 'IN_PLAY',
  THROW_IN: 'THROW_IN',
  CORNER_KICK: 'CORNER_KICK',
  GOAL_KICK: 'GOAL_KICK',
  GK_POSSESSION: 'GK_POSSESSION', // GK가 공을 잡아 선수들이 자기 포지션으로 복귀하는 국면
  GOAL_SCORED: 'GOAL_SCORED',
  HALF_TIME: 'HALF_TIME',
  FULL_TIME: 'FULL_TIME',
};

const HALF_DURATION = 45 * 60; // 경기 내 초 (2700초)

/**
 * 경기의 전반적인 상태(시간/스코어/현재 국면/세트피스 정보)를 중앙에서 관리하는 데이터 컨테이너.
 * 국면 전환 로직 자체는 MatchSimulator가 담당하고, 이 클래스는 상태 저장 + 시간 진행만 수행한다.
 */
export class MatchState {
  constructor() {
    this.half = 1;
    this.matchSeconds = 0; // 전반 0~2700, 후반에도 0~2700으로 리셋 후 half로 구분
    this.phase = Phase.KICKOFF;
    this.phaseTimer = 0;
    this.restartInfo = null; // { type, position, team }
    this.score = { home: 0, away: 0 };
    this.lastEvent = null;
  }

  get displayMinute() {
    const base = this.half === 1 ? 0 : 45;
    return base + Math.floor(this.matchSeconds / 60);
  }

  get displaySecond() {
    return Math.floor(this.matchSeconds % 60);
  }

  isHalfOver() {
    return this.matchSeconds >= HALF_DURATION;
  }

  advanceClock(dt) {
    if (this.phase !== Phase.HALF_TIME && this.phase !== Phase.FULL_TIME) {
      this.matchSeconds += dt;
    }
  }

  startSecondHalf() {
    this.half = 2;
    this.matchSeconds = 0;
  }

  reset() {
    this.half = 1;
    this.matchSeconds = 0;
    this.phase = Phase.KICKOFF;
    this.phaseTimer = 0;
    this.restartInfo = null;
    this.score = { home: 0, away: 0 };
    this.lastEvent = null;
  }
}
