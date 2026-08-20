import { Vector2D } from '../../entities/Vector2D.js';
import { Pitch } from '../../entities/Pitch.js';
import { clamp, clamp01, smoothstep, angleDiff, opponentGoalLineX } from '../core/Coords.js';
import { stepBallState, GROUND_EPS, REST_SPEED } from '../ball/BallPhysics.js';
import { pressureAt, isLaneBlocked, timeToReach } from './Estimates.js';
import { Role } from '../tactics/RoleModel.js';

/**
 * 슈팅 계획 (Section 27).
 *
 * ⚠ 거리만으로 슛을 정하지 않는다.
 *   "슈팅 사거리 안이니까 찬다"가 아니라, 실제로 골문으로 들어갈
 *   궤적이 존재하는지를 물리로 확인하고 그 질을 평가한다.
 *
 * 평가 요소: 거리 · 각도 · 골키퍼 위치 · 수비 압박 · 신체 방향 ·
 *            볼 통제 상태 · 슛 기술 · 빈 공간
 *
 * 궤적은 BallPhysics.stepBallState로 직접 시뮬레이션한다.
 * 별도 수식을 쓰지 않으므로 "계획한 슛"과 "실제 날아가는 슛"이 같다.
 */

/** 크로스바 높이 (m) */
export const CROSSBAR_HEIGHT = 2.44;

/** 슛 종류 */
export const ShotType = {
  GROUND: 'GROUND',   // 낮게 깔아 차기
  DRIVEN: 'DRIVEN',   // 강하게 밀어 차기 (약간 뜸)
  PLACED: 'PLACED',   // 구석을 노려 정확히
  POWER: 'POWER',     // 최대 파워
  CHIP: 'CHIP',       // 골키퍼 머리 위로
  HEADER: 'HEADER',   // 헤딩
};

/** 이 거리를 넘으면 슛 후보로 보지 않는다 (m) */
const MAX_SHOT_DISTANCE = 32;

/** 골포스트에서 안쪽으로 띄우는 여유 (m) — 정확히 포스트를 노리지 않는다 */
const POST_INSET = 0.55;

/** 궤적 시뮬레이션 상한 (초) */
const MAX_SHOT_FLIGHT = 3.0;

export class ShotPlanner {
  /**
   * @param {number} dt 고정 스텝 — 라이브 물리와 같아야 한다
   */
  constructor(dt) {
    this.dt = dt;
  }

  /**
   * 최선의 슛을 계획한다.
   *
   * @param {MatchEngine} engine
   * @param {Player} shooter
   * @returns {object|null} 슛 옵션 (없으면 null)
   */
  plan(engine, shooter) {
    const options = this.generateOptions(engine, shooter);
    if (options.length === 0) return null;
    options.sort((a, b) => b.utility - a.utility);
    return options[0];
  }

  /** 조준점 × 슛 종류 후보를 만들고 평가한다 */
  generateOptions(engine, shooter) {
    const dir = shooter.team.attackingDirection;
    const goalX = opponentGoalLineX(dir);
    const [goalTop, goalBottom] = Pitch.goalYRange();

    const distance = Math.abs(shooter.position.x - goalX);
    if (distance > MAX_SHOT_DISTANCE) return [];

    const opponents = shooter.team.opponent?.players ?? [];
    const keeper = (shooter.team.opponent?.goalkeeper) ?? null;

    // 골문 안쪽 조준점 — 좌우 구석과 중앙
    const aimYs = [
      goalTop + POST_INSET,
      goalTop + (goalBottom - goalTop) * 0.3,
      (goalTop + goalBottom) / 2,
      goalBottom - (goalBottom - goalTop) * 0.3,
      goalBottom - POST_INSET,
    ];

    const options = [];
    for (const aimY of aimYs) {
      for (const type of [ShotType.GROUND, ShotType.DRIVEN, ShotType.PLACED, ShotType.CHIP]) {
        const option = this._evaluate(engine, shooter, new Vector2D(goalX, aimY), type, opponents, keeper);
        if (option) options.push(option);
      }
    }
    return options;
  }

  /** 하나의 (조준점, 슛 종류) 후보를 평가한다 */
  _evaluate(engine, shooter, aimPoint, type, opponents, keeper) {
    const dir = shooter.team.attackingDirection;
    const from = shooter.position;
    const toAim = aimPoint.sub(from);
    const distance = toAim.length();
    if (distance < 1) return null;

    const { speed, elevation } = this._launchFor(shooter, type, distance);
    const direction = toAim.normalize();

    // ── 실제 궤적을 시뮬레이션한다 ─────────────────────────
    const trace = this._traceShot(from, direction, speed, elevation, dir);
    if (!trace.crossedGoalLine) return null;

    // 골문 안으로 들어가는가 (폭 + 크로스바 아래)
    const [goalTop, goalBottom] = Pitch.goalYRange();
    const onTarget =
      trace.crossY > goalTop && trace.crossY < goalBottom &&
      trace.crossHeight < CROSSBAR_HEIGHT;
    if (!onTarget) return null;

    // ── 수비 블로킹 ────────────────────────────────────────
    const blockRisk = this._blockRisk(from, trace, opponents, shooter);
    if (blockRisk > 0.9) return null;

    // ── 골키퍼 도달 가능성 ─────────────────────────────────
    const keeperRisk = this._keeperRisk(keeper, trace);

    // ── 슛의 질 ────────────────────────────────────────────
    const quality = this._shotQuality({
      shooter, distance, aimPoint, trace, opponents,
      blockRisk, keeperRisk, type,
    });

    return {
      aimPoint,
      type,
      speed,
      elevation,
      velocity: direction.scale(speed * Math.cos(elevation)),
      verticalVelocity: speed * Math.sin(elevation),
      distance,
      flightTime: trace.crossTime,
      quality,
      blockRisk,
      keeperRisk,
      utility: quality,
    };
  }

  /**
   * 슛 종류별 초기 속도와 발사각.
   * 파워는 능력치에서 나오며, 종류에 따라 정확도와 맞바꾼다.
   */
  _launchFor(shooter, type, distance) {
    const power = shooter.attributes.norm('shotPower');
    // 실제 강슛은 25~32 m/s, 밀어 차기는 15~20 m/s 수준
    const maxSpeed = 19 + power * 12;

    switch (type) {
      case ShotType.GROUND:
        return { speed: maxSpeed * 0.78, elevation: 0 };
      case ShotType.DRIVEN:
        return { speed: maxSpeed * 0.92, elevation: 0.045 };
      case ShotType.PLACED:
        // 정확히 노리는 대신 세기를 줄인다
        return { speed: maxSpeed * 0.66, elevation: 0.03 };
      case ShotType.POWER:
        return { speed: maxSpeed, elevation: 0.06 };
      case ShotType.CHIP:
        // 골키퍼 머리 위로 넘기는 로빙 — 거리가 짧을수록 각을 세운다
        return {
          speed: maxSpeed * 0.52,
          elevation: clamp(0.42 - distance * 0.006, 0.20, 0.45),
        };
      default:
        return { speed: maxSpeed * 0.8, elevation: 0.02 };
    }
  }

  /**
   * 슛 궤적을 시뮬레이션해 골라인 통과 지점을 찾는다.
   * 라이브와 같은 적분기를 쓰므로 예측과 실제가 일치한다.
   */
  _traceShot(from, direction, speed, elevation, attackDir) {
    const goalX = opponentGoalLineX(attackDir);
    const s = {
      x: from.x, y: from.y,
      vx: direction.x * speed * Math.cos(elevation),
      vy: direction.y * speed * Math.cos(elevation),
      h: 0,
      vz: speed * Math.sin(elevation),
    };

    const samples = [];
    const maxSteps = Math.ceil(MAX_SHOT_FLIGHT / this.dt);
    let t = 0;

    for (let i = 0; i < maxSteps; i++) {
      const prevX = s.x;
      const prevY = s.y;
      const prevH = s.h;

      stepBallState(s, this.dt);
      t += this.dt;
      samples.push({ position: new Vector2D(s.x, s.y), height: s.h, time: t });

      // 골라인을 넘었는가
      const crossed = attackDir === 1 ? s.x >= goalX : s.x <= goalX;
      if (crossed) {
        // 스텝 안에서 통과 시점을 보간한다
        const span = s.x - prevX;
        const frac = Math.abs(span) > 1e-9 ? (goalX - prevX) / span : 1;
        return {
          crossedGoalLine: true,
          crossY: prevY + (s.y - prevY) * frac,
          crossHeight: prevH + (s.h - prevH) * frac,
          crossTime: t - this.dt + this.dt * frac,
          samples,
        };
      }

      // 멈췄으면 골라인에 도달하지 못한 것이다
      if (s.h <= GROUND_EPS && Math.hypot(s.vx, s.vy) <= REST_SPEED) break;
    }

    return { crossedGoalLine: false, samples, crossTime: t };
  }

  /**
   * 수비수가 슛을 막을 위험 0~1.
   * 궤적 표본을 훑어 각 시점에 수비수가 닿을 수 있는지 본다.
   */
  _blockRisk(from, trace, opponents, shooter) {
    let worst = 0;
    for (const sample of trace.samples) {
      if (sample.time > trace.crossTime) break;
      // 머리 위로 지나가면 막을 수 없다
      if (sample.height > 2.1) continue;
      // 발을 떠난 직후는 슈터의 몸이 가려준다
      if (sample.time < 0.08) continue;

      for (const o of opponents) {
        if (o.role === Role.GK) continue; // 골키퍼는 따로 평가한다
        const gap = o.position.sub(sample.position).length();
        // 슛은 빠르므로 몸을 던지는 범위만 인정한다
        if (gap > 1.6) continue;
        const eta = timeToReach(o, sample.position, { includeReaction: true });
        const lead = sample.time - eta;
        if (lead > 0) worst = Math.max(worst, smoothstep(0, 0.35, lead));
      }
    }
    return clamp01(worst);
  }

  /**
   * 골키퍼가 막을 위험 0~1.
   *
   * 골라인 통과 지점과 골키퍼 사이의 거리, 그리고 반응할 시간으로 판단한다.
   * 골키퍼가 각을 좁혀 나와 있으면 도달 가능 범위가 넓어진다.
   */
  _keeperRisk(keeper, trace) {
    if (!keeper) return 0;

    const crossPoint = new Vector2D(
      keeper.team.attackingDirection === 1 ? Pitch.LENGTH : 0,
      trace.crossY
    );
    // 골키퍼가 통과 지점까지 가야 하는 거리
    const lateral = Math.abs(keeper.position.y - trace.crossY);
    const depth = Math.abs(keeper.position.x - crossPoint.x);

    // 반응 시간을 뺀 실제 이동 가능 시간
    const reaction = 0.28 - keeper.attributes.norm('reactions') * 0.12;
    const available = Math.max(0, trace.crossTime - reaction);

    // 다이빙 도달 거리 — 민첩성과 시간에 비례
    const diveSpeed = 3.2 + keeper.attributes.norm('agility') * 2.2;
    const reach = 0.9 + available * diveSpeed;

    // 필요한 이동 거리 (횡 + 전후 보정)
    const required = Math.hypot(lateral, depth * 0.35);

    // 높은 슛은 더 어렵다
    const heightPenalty = smoothstep(0.6, 2.2, trace.crossHeight) * 0.25;

    const coverage = clamp01((reach - required) / Math.max(1.2, reach)) - heightPenalty;
    return clamp01(coverage);
  }

  /**
   * 슛의 질 — 이 값이 곧 효용이다.
   * 다른 선택지(패스·드리블)와 비교되므로 크기를 맞춰 둔다.
   */
  _shotQuality({ shooter, distance, aimPoint, trace, opponents, blockRisk, keeperRisk, type }) {
    const a = shooter.attributes;

    // ── 거리 ───────────────────────────────────────────────
    // 7m에서 거의 1, 30m에서 거의 0
    const distanceScore = smoothstep(30, 7, distance);

    // ── 각도 ───────────────────────────────────────────────
    // 골문 양 포스트를 보는 시야각이 넓을수록 좋다
    const [goalTop, goalBottom] = Pitch.goalYRange();
    const goalX = aimPoint.x;
    const toTop = new Vector2D(goalX, goalTop).sub(shooter.position);
    const toBottom = new Vector2D(goalX, goalBottom).sub(shooter.position);
    const openAngle = Math.abs(angleDiff(toTop.angle(), toBottom.angle()));
    // 정면 6m에서 약 0.6 rad, 먼 측면에서 0.1 rad 이하
    const angleScore = clamp01(openAngle / 0.55);

    // ── 신체 방향 ──────────────────────────────────────────
    // 골문을 등지고 있으면 제대로 찰 수 없다
    const toAim = aimPoint.sub(shooter.position);
    const turn = Math.abs(angleDiff(toAim.angle(), shooter.facingAngle));
    const orientationScore = 1 - smoothstep(Math.PI / 4, Math.PI, turn);

    // ── 압박과 볼 통제 ─────────────────────────────────────
    const pressure = pressureAt(shooter.position, opponents);
    const composure = a.norm('decisionMaking');

    // ── 기술 ───────────────────────────────────────────────
    const technique = a.norm('finishing') * 0.6 + a.norm('shooting') * 0.4;

    // ── 기하 요소는 곱한다 ─────────────────────────────────
    // 더하면 "멀지만 각도는 좋다"가 "가깝고 각도도 좋다"와 비슷해져
    // 30m 슛이 남발된다. 슛은 거리와 각도와 몸 방향이 "모두" 받쳐줘야
    // 성립하므로 곱셈이 맞다.
    const geometry =
      distanceScore *
      Math.pow(angleScore, 0.7) *
      Math.pow(orientationScore, 0.5);

    const base = 1.6 + technique * 0.8;

    let quality =
      base * geometry -
      pressure * (0.70 - composure * 0.25) -
      blockRisk * 1.30 -
      keeperRisk * 1.10;

    // 칩슛은 골키퍼가 나와 있을 때만 의미가 있다
    if (type === ShotType.CHIP) quality -= 0.35;
    // 정확히 노리는 슛은 압박이 없을 때 유리하다
    if (type === ShotType.PLACED) quality += (1 - pressure) * 0.20;

    return quality;
  }
}
