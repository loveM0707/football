import { EventBus } from '../../core/EventBus.js';
import { Ball } from '../entities/Ball.js';
import { MatchState, Phase } from './MatchState.js';
import { FixedStep } from '../sim/FixedStep.js';
import { Rng } from './Rng.js';

/**
 * 경기 엔진 — 시뮬레이션의 단일 진입점이자 유일한 진행 권한자.
 *
 * ── 틱 순서 (권한 순서) ──────────────────────────────────────
 *  1. 시계 전진
 *  2. RulesEngine 사전 판정 (인플레이 여부 확인)
 *  3. PossessionModel 갱신    — 소유 상태의 유일한 판정자
 *  4. TacticalEngine 갱신      — 팀당 1회, 형태·임무 배정
 *  5. DecisionEngine 갱신      — 선수별 판단 (의도만 산출)
 *  6. MovementEngine 적분      — 선수 위치/속도의 유일한 기록자
 *  7. BallPhysics 적분         — 볼 운동의 유일한 기록자
 *  8. RulesEngine 사후 판정    — 아웃/득점/오프사이드/파울 → 재개
 *  9. MatchStatistics 표본 수집
 *
 * 이 순서는 고정이며, 각 단계는 앞 단계의 결과만 읽는다.
 * 같은 값을 두 곳에서 쓰는 일이 없도록 권한을 단계별로 분리했다.
 *
 * ⚠ 국면(Phase) 변경은 오직 RulesEngine의 판정을 받아 이 클래스만 수행한다.
 *   선수 AI는 사건을 발생시킬 뿐 경기 국면을 직접 바꾸지 못한다.
 */
export class MatchEngine {
  /**
   * @param {object} opts
   * @param {Team} opts.homeTeam
   * @param {Team} opts.awayTeam
   * @param {EventBus} [opts.eventBus]
   * @param {number} [opts.seed] 결정론 시드
   * @param {number} [opts.step] 고정 스텝 (초)
   */
  constructor({ homeTeam, awayTeam, eventBus, seed = 12345, step = 1 / 60 }) {
    this.homeTeam = homeTeam;
    this.awayTeam = awayTeam;
    this.teams = [homeTeam, awayTeam];

    // 상대 팀 상호 참조 주입
    homeTeam.opponent = awayTeam;
    awayTeam.opponent = homeTeam;

    this.eventBus = eventBus ?? new EventBus();
    this.ball = new Ball();
    this.state = new MatchState();
    this.fixedStep = new FixedStep({ step });

    // ── 난수 스트림 분리 ────────────────────────────────────
    // 시스템별로 독립 스트림을 쓴다. 한 시스템의 호출 횟수가 변해도
    // 다른 시스템의 난수열이 흔들리지 않아 디버깅이 쉬워진다.
    this.seed = seed;
    this.rootRng = new Rng(seed);
    this.rng = {
      touch: this.rootRng.stream('touch'),       // 터치·트래핑 오차
      pass: this.rootRng.stream('pass'),         // 패스 정확도
      shot: this.rootRng.stream('shot'),         // 슛 정확도
      duel: this.rootRng.stream('duel'),         // 경합·태클
      decision: this.rootRng.stream('decision'), // 판단 편차
      gk: this.rootRng.stream('gk'),             // 골키퍼
    };

    // ── 하위 시스템 (페이즈별로 주입된다) ────────────────────
    // 아직 구현되지 않은 단계는 null이며, 해당 단계는 건너뛴다.
    this.possession = null;
    this.tactical = null;
    this.decisions = null;
    this.movement = null;
    this.physics = null;
    this.rules = null;
    this.restarts = null;
    this.statistics = null;

    /** 총 실행 스텝 수 — 결정론 검증용 */
    this.stepCount = 0;
  }

  /** 하위 시스템을 주입한다 (페이즈 구현이 늘어날 때마다 호출) */
  install(systems = {}) {
    Object.assign(this, systems);
    return this;
  }

  /** 현재 고정 스텝 크기 (초) */
  get stepSize() {
    return this.fixedStep.step;
  }

  // ── 진행 ───────────────────────────────────────────────────

  /**
   * 실시간 프레임에서 호출한다. 배속은 스텝 수를 늘릴 뿐 dt를 바꾸지 않는다.
   * @param {number} realDt 실제 경과 시간 (초)
   * @param {number} timeScale 배속
   * @returns {number} 실행된 스텝 수
   */
  advance(realDt, timeScale = 1) {
    return this.fixedStep.advance(realDt, timeScale, (dt) => this.step(dt));
  }

  /**
   * 헤드리스/테스트용: 정확히 n스텝 실행한다.
   * @param {number} n
   */
  runSteps(n) {
    this.fixedStep.runSteps(n, (dt) => this.step(dt));
  }

  /**
   * 시뮬레이션 시간 기준으로 지정 초만큼 실행한다.
   * @param {number} seconds
   */
  runSeconds(seconds) {
    this.runSteps(this.fixedStep.stepsForSeconds(seconds));
  }

  /**
   * 한 스텝 진행 — 위에 정의한 틱 순서를 그대로 따른다.
   * @param {number} dt 고정 스텝 (초)
   */
  step(dt) {
    this.stepCount++;

    // 1. 시계
    this.state.advance(dt);
    for (const team of this.teams) team.advancePhase(dt);

    // 2. 규칙 사전 판정 — 재개 대기 중이면 배치만 진행한다
    if (this.rules) this.rules.preStep(this, dt);

    // 3. 소유 상태
    if (this.possession) this.possession.update(this, dt);

    // 4. 팀 전술 (팀당 1회)
    if (this.tactical) {
      for (const team of this.teams) this.tactical.update(this, team, dt);
    }

    // 5. 선수 판단 (의도만 산출)
    if (this.decisions) this.decisions.update(this, dt);

    // 6. 선수 이동 적분 (위치/속도의 유일한 기록자)
    if (this.movement) this.movement.update(this, dt);

    // 7. 볼 물리 적분 (볼 운동의 유일한 기록자)
    if (this.physics) this.physics.update(this, dt);

    // 8. 규칙 사후 판정 → 재개 생성
    if (this.rules) this.rules.postStep(this, dt);

    // 9. 통계 표본
    if (this.statistics) this.statistics.sample(this, dt);
  }

  // ── 국면 제어 (RulesEngine의 판정을 받아 이 클래스만 수행) ──

  /**
   * 경기 국면을 전환한다.
   * @param {string} phase Phase 값
   * @param {object|null} restart 재개 정보
   */
  setPhase(phase, restart = null) {
    const previous = this.state.phase;
    if (previous === phase && restart === null) return;
    this.state.setPhase(phase, restart);
    this.eventBus.emit('phase', { from: previous, to: phase, restart });
  }

  /** 팀 식별자로 팀 객체를 얻는다 */
  teamBySide(side) {
    return side === 'home' ? this.homeTeam : this.awayTeam;
  }

  /** 모든 선수 (양 팀) */
  get allPlayers() {
    return [...this.homeTeam.players, ...this.awayTeam.players];
  }

  /** 현재 시뮬레이션 시각 (초) */
  get time() {
    return this.state.totalSeconds;
  }

  // ── 결정론 검증 ────────────────────────────────────────────

  /**
   * 현재 시뮬레이션 상태의 요약.
   * 같은 시드로 같은 스텝 수를 돌리면 이 값이 완전히 일치해야 한다.
   */
  snapshot() {
    return {
      steps: this.stepCount,
      state: this.state.snapshot(),
      ball: this.ball.snapshot(),
      teams: this.teams.map((t) => t.snapshot()),
    };
  }

  /** 스냅샷을 문자열 해시로 압축한다 (테스트 비교용) */
  hash() {
    const json = JSON.stringify(this.snapshot());
    let h = 2166136261 >>> 0;
    for (let i = 0; i < json.length; i++) {
      h ^= json.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }
}

export { Phase };
