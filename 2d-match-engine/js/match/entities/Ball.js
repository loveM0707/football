import { Vector2D } from '../../entities/Vector2D.js';

/**
 * 볼 상태 컨테이너.
 *
 * 이 클래스는 상태만 담는다. 적분(운동 계산)은 BallPhysics가,
 * 소유 판정은 PossessionModel이, 아웃/득점 판정은 RulesEngine이 담당한다.
 * 볼이 스스로 움직이거나 규칙을 판단하지 않는다.
 *
 * 좌표계:
 *   position, velocity : 월드 평면 좌표 (m, m/s) — 수평 성분만
 *   height             : 지면으로부터의 높이 (m)
 *   verticalVelocity   : 수직 속도 (m/s, +가 위)
 */

/** 볼 비행 종류 — 규칙·통계·수신 판단에서 구분이 필요하다 */
export const BallFlight = {
  NONE: 'NONE',
  PASS: 'PASS',
  CROSS: 'CROSS',
  THROUGH: 'THROUGH',
  SHOT: 'SHOT',
  CLEARANCE: 'CLEARANCE',
  DRIBBLE_TOUCH: 'DRIBBLE_TOUCH',
  THROW_IN: 'THROW_IN',
  GK_DISTRIBUTION: 'GK_DISTRIBUTION',
};

export class Ball {
  constructor() {
    /** 공식 규격(2조): 둘레 68~70cm → 반지름 약 0.11m */
    this.radius = 0.11;
    this.reset();
  }

  reset() {
    this.position = new Vector2D(0, 0);
    this.velocity = new Vector2D(0, 0);
    this.height = 0;
    this.verticalVelocity = 0;
    /** 스핀 (rad/s). 양수 = 백스핀. 현재는 구름 저항 보정에만 쓴다. */
    this.spin = 0;

    /** 현재 볼을 발밑에 두고 있는 선수 (없으면 null) */
    this.carrier = null;

    /** 마지막으로 볼에 접촉한 정보 — 규칙 판정(스로인/골킥/코너)의 근거 */
    this.lastTouch = null;        // { player, team, time }
    /** 마지막 접촉 이전의 접촉 — 굴절 판정용 */
    this.previousTouch = null;

    /** 현재 비행 종류 */
    this.flight = BallFlight.NONE;
    /** 이 비행을 시작시킨 선수 */
    this.kicker = null;
    /** 패스의 의도된 수신자 (렌더러 디버그 표시에도 사용) */
    this.passTargetPlayer = null;
    /** 패스의 의도된 도착 지점 */
    this.passTargetPos = null;
    /** 이 비행이 시작된 시뮬레이션 시각 (초) */
    this.flightStartTime = 0;
    /** 이 비행이 시작된 위치 — 패스 거리 통계·검증용 */
    this.flightStartPos = new Vector2D(0, 0);
  }

  /** 수평 속력 (m/s) */
  get speed() {
    return this.velocity.length();
  }

  /** 공중에 떠 있는가 (지면 접촉 여유 포함) */
  get isAirborne() {
    return this.height > 0.02;
  }

  /** 사실상 정지 상태인가 */
  get isStationary() {
    return this.speed < 0.15 && Math.abs(this.verticalVelocity) < 0.15 && !this.isAirborne;
  }

  /** 누군가 발밑에 두고 있는가 */
  get isCarried() {
    return this.carrier !== null;
  }

  /**
   * 볼을 특정 위치에 정지 상태로 놓는다 (세트피스 배치용).
   * @param {Vector2D} pos
   */
  placeAt(pos) {
    this.position = pos.clone();
    this.velocity = Vector2D.zero();
    this.height = 0;
    this.verticalVelocity = 0;
    this.spin = 0;
    this.carrier = null;
    this.flight = BallFlight.NONE;
    this.kicker = null;
    this.passTargetPlayer = null;
    this.passTargetPos = null;
  }

  /**
   * 볼을 찬다. 물리 적분은 하지 않고 초기 조건만 설정한다.
   *
   * @param {Vector2D} horizontalVelocity 수평 초기 속도 (m/s)
   * @param {number} verticalVelocity 수직 초기 속도 (m/s, 0이면 지상 볼)
   * @param {object} opts
   * @param {object} opts.kicker 찬 선수
   * @param {string} opts.flight BallFlight 값
   * @param {object|null} opts.target 의도된 수신자
   * @param {Vector2D|null} opts.targetPos 의도된 도착 지점
   * @param {number} opts.time 현재 시뮬레이션 시각
   * @param {number} opts.spin 스핀
   */
  kick(horizontalVelocity, verticalVelocity, opts = {}) {
    this.velocity = horizontalVelocity.clone();
    this.verticalVelocity = verticalVelocity;
    this.spin = opts.spin ?? 0;
    this.carrier = null;

    this.flight = opts.flight ?? BallFlight.PASS;
    this.kicker = opts.kicker ?? null;
    this.passTargetPlayer = opts.target ?? null;
    this.passTargetPos = opts.targetPos ? opts.targetPos.clone() : null;
    this.flightStartTime = opts.time ?? 0;
    this.flightStartPos = this.position.clone();

    if (opts.kicker) {
      this.registerTouch(opts.kicker, opts.time ?? 0);
    }
  }

  /**
   * 접촉 기록. 규칙 엔진이 마지막 접촉 팀을 근거로 재개를 판정하므로
   * 모든 접촉은 반드시 이 메서드를 거쳐야 한다.
   * @param {object} player 접촉한 선수
   * @param {number} time 현재 시뮬레이션 시각
   */
  registerTouch(player, time) {
    if (!player) return;
    // 같은 선수의 연속 접촉은 previousTouch를 덮어쓰지 않는다
    // (굴절 판정에서 "직전에 만진 다른 선수"를 잃지 않기 위함)
    if (!this.lastTouch || this.lastTouch.player !== player) {
      this.previousTouch = this.lastTouch;
    }
    this.lastTouch = { player, team: player.team, time };
  }

  /** 볼을 즉시 정지시킨다 (트래핑 성공 등) */
  stop() {
    this.velocity = Vector2D.zero();
    this.verticalVelocity = 0;
    this.height = 0;
    this.spin = 0;
    this.flight = BallFlight.NONE;
    this.passTargetPlayer = null;
    this.passTargetPos = null;
  }

  /** 비행 정보만 해제한다 (볼은 계속 굴러갈 수 있음) */
  clearFlight() {
    this.flight = BallFlight.NONE;
    this.passTargetPlayer = null;
    this.passTargetPos = null;
  }

  /** 결정론 검증용 상태 요약 */
  snapshot() {
    const r = (v) => Math.round(v * 1000) / 1000;
    return {
      x: r(this.position.x),
      y: r(this.position.y),
      vx: r(this.velocity.x),
      vy: r(this.velocity.y),
      h: r(this.height),
      vz: r(this.verticalVelocity),
    };
  }
}
