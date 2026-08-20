import { Vector2D } from '../../entities/Vector2D.js';
import { Pitch } from '../../entities/Pitch.js';
import { clamp, clamp01, smoothstep, angleDiff, teamNX, opponentGoalLineX } from '../core/Coords.js';
import { solveGroundPass, solveLoftedPass, traceTrajectory } from '../ball/PassSolver.js';
import {
  timeToReach, futurePosition, pressureAt, nearestOpponentTo, isLaneBlocked,
} from './Estimates.js';
import { Role } from '../tactics/RoleModel.js';

/**
 * 패스 계획 — "패스는 불확실성 아래의 선택"이라는 원칙을 구현한다.
 *
 * 수신자를 고르고 그쪽으로 차는 방식이 아니다. 후보(수신자 × 도착 지점)를
 * 만들고, 각각에 대해 실제 물리 궤적을 풀어 도착 시간을 구한 뒤,
 * 수신자·수비수의 도달 시간과 비교해 효용을 계산한다.
 *
 * ── 구 엔진과 다른 점 ────────────────────────────────────────
 * · 리드 거리를 "수신자 속도 × 임의 상수"로 잡지 않는다.
 *   실제 볼 도착 시간을 먼저 구하고, 그 시간 동안 수신자가 갈 수 있는
 *   지점만 후보로 삼는다. 그래서 볼이 수신자 앞으로 과하게 나가지 않는다.
 * · 가로채기 위험을 직선 거리로 근사하지 않는다.
 *   실제 적분 궤적을 훑어 각 시점의 위치·높이로 판정한다.
 * · 신체 방향과 선회 비용을 효용에 반영한다.
 *   정면을 보고 있는데 등 뒤로 즉시 정확한 패스를 찌를 수 없다.
 */

/** 패스 종류 */
export const PassType = {
  SAFE: 'SAFE',               // 안전한 짧은 패스 (유지)
  PROGRESSIVE: 'PROGRESSIVE', // 전진 패스
  SWITCH: 'SWITCH',           // 방향 전환 (측면 전환)
  THROUGH: 'THROUGH',         // 수비 뒤 공간 침투
  CROSS: 'CROSS',             // 크로스
  BACK: 'BACK',               // 백패스 (재정비)
  CLEARANCE: 'CLEARANCE',     // 걷어내기
};

/**
 * 패스 세기 후보 (도착 속력, m/s).
 *
 * 세기는 고정값이 아니라 선택 차원이다 (Section 14: 필요한 볼 속도를 결정한다).
 *   약한 패스 — 받기 쉽지만 느려서 끊길 시간을 준다
 *   강한 패스 — 끊기 어렵지만 통제가 어렵다
 * 효용 함수가 상황에 따라 둘 중 하나를 고른다.
 *
 * ⚠ 너무 약하게 잡으면 16m 패스가 3초씩 걸려 모든 패스가 가로채기 위험
 *   1.0으로 평가된다. 실제 16m 패스는 1.2~1.5초다.
 */
const ARRIVAL_SPEEDS_FEET = [5.0, 8.5];

/** 달려 들어가는 공간으로 보낼 때 — 수비보다 먼저 닿아야 하므로 세게 */
const ARRIVAL_SPEEDS_SPACE = [7.5];

/** 패스 대상으로 고려할 최대 거리 (m) — 이보다 멀면 후보 생성 전에 제외 */
const MAX_PASS_DISTANCE = 58;

/** 이 거리 안의 표본은 수신자가 경합할 수 있는 구간으로 본다 (m) */
const CONTEST_ZONE = 3.5;

/** 수신자가 이 시간 안에 도착하지 못하면 후보에서 제외 (초) */
const RECEIVER_LATE_TOLERANCE = 0.45;

/** 가로채기 판정에서 수비수가 볼보다 이만큼 일찍 와야 실제로 끊는다 (초) */
const INTERCEPT_MARGIN = 0.12;

/** 수비수가 발로 닿을 수 있는 최대 볼 높이 (m) */
const INTERCEPT_MAX_HEIGHT = 2.1;

/**
 * 가로채기 유효 사거리 (m).
 *
 * 수비수는 볼이 지나는 지점에 정확히 도달할 필요가 없다.
 * 발을 뻗거나 슬라이딩하면 그만큼 못 미쳐도 닿는다.
 * 이것을 빼먹으면 경로 옆 수비수가 실제보다 무해하게 평가된다.
 */
const INTERCEPT_REACH = 1.2;

/** 최소 패스 거리 (m) — 이보다 가까우면 패스가 아니라 그냥 건네주는 것 */
const MIN_PASS_DISTANCE = 4.0;

export class PassPlanner {
  /**
   * @param {number} dt 고정 스텝 — 솔버·궤적 추출이 라이브와 같아야 한다
   */
  constructor(dt) {
    this.dt = dt;
  }

  /**
   * 볼을 가진 선수가 낼 수 있는 최선의 패스를 계획한다.
   *
   * @param {MatchEngine} engine
   * @param {Player} passer
   * @returns {object|null} 최선의 패스 옵션 (없으면 null)
   */
  plan(engine, passer) {
    const options = this.generateOptions(engine, passer);
    if (options.length === 0) return null;
    // 효용 내림차순 → 동점이면 수신자 id로 결정론 보장
    options.sort((a, b) =>
      b.utility - a.utility || (a.receiver.id < b.receiver.id ? -1 : 1)
    );
    return options[0];
  }

  /**
   * 모든 패스 후보를 생성하고 평가한다.
   * @returns {Array<object>} 실행 가능한 후보 목록
   */
  generateOptions(engine, passer) {
    const team = passer.team;
    const opponents = team.opponent?.players ?? [];
    const teammates = team.players.filter((p) => p !== passer);

    const options = [];
    for (const receiver of teammates) {
      // 사전 가지치기 — 물리 해를 풀기 전에 명백히 불가능한 대상을 제외한다.
      // (이분법 역산이 비싸므로 후보 수를 먼저 줄인다)
      const roughDistance = receiver.position.sub(passer.position).length();
      if (roughDistance > MAX_PASS_DISTANCE) continue;

      for (const target of this._targetPointsFor(passer, receiver, engine)) {
        const speeds = target.kind === 'FEET'
          ? ARRIVAL_SPEEDS_FEET
          : ARRIVAL_SPEEDS_SPACE;

        for (const arrivalSpeed of speeds) {
          const option = this._evaluate(
            engine, passer, receiver, target, opponents, arrivalSpeed
          );
          if (option) options.push(option);
        }
      }
    }
    return options;
  }

  // ──────────────────────────────────────────────────────────
  // 후보 도착 지점 생성
  // ──────────────────────────────────────────────────────────

  /**
   * 한 수신자에 대한 도착 지점 후보들.
   *
   * 발밑 / 짧은 리드 / 침투 공간의 세 계열을 만든다.
   * 리드 지점은 "수신자 속도 × 상수"가 아니라, 수신자가 실제로 갈 수 있는
   * 범위 안에서만 만든다.
   */
  _targetPointsFor(passer, receiver, engine) {
    const points = [];
    const dir = receiver.team.attackingDirection;

    // ① 발밑 — 가장 안전한 선택
    points.push({ position: receiver.position.clone(), kind: 'FEET', leadTime: 0 });

    // ② 짧은 리드 — 수신자가 움직이는 중일 때만 의미가 있다
    const speed = receiver.velocity.length();
    if (speed > 1.2) {
      for (const leadTime of [0.4, 0.8]) {
        points.push({
          position: futurePosition(receiver, leadTime),
          kind: 'LEAD',
          leadTime,
        });
      }
    }

    // ③ 침투 공간 — 수비 뒤로 보내는 스루패스 후보.
    //    무작정 멀리 던지지 않고, 수신자가 도달할 수 있는 거리만 잡는다.
    //    (Section 17: 정상 속도로 달리는 선수 앞 20m에 볼을 놓지 않는다)
    if (this._isForwardRunner(receiver)) {
      const forward = new Vector2D(dir, 0);
      // 수신자가 1.0~1.6초 동안 갈 수 있는 거리
      for (const runTime of [1.0, 1.6]) {
        const reach = receiver.maxSpeed * runTime * 0.72; // 가속 지연 반영
        const spot = receiver.position
          .add(forward.scale(reach))
          .add(receiver.velocity.normalize().scale(speed > 1 ? 1.5 : 0));
        points.push({
          position: Pitch.clampInside(spot, 1.5),
          kind: 'SPACE',
          leadTime: runTime,
        });
      }
    }

    return points;
  }

  /** 침투 러너로 볼 만한 역할인가 */
  _isForwardRunner(player) {
    return player.role === Role.ST ||
           player.role === Role.WINGER ||
           player.role === Role.AM ||
           player.role === Role.FB;
  }

  // ──────────────────────────────────────────────────────────
  // 후보 평가
  // ──────────────────────────────────────────────────────────

  /**
   * 하나의 (수신자, 도착지점) 후보를 평가한다.
   * 실행 불가능하면 null을 반환한다.
   */
  _evaluate(engine, passer, receiver, target, opponents, arrivalSpeed) {
    const from = passer.position;
    const to = target.position;
    const distance = to.sub(from).length();

    if (distance < MIN_PASS_DISTANCE) return null;

    // ── 1. 물리 해 구하기 ──────────────────────────────────
    // 지상 경로가 막혔으면 띄워야 한다
    const blocked = isLaneBlocked(from, to, opponents);

    let solution = null;
    if (!blocked) {
      const ground = solveGroundPass(from, to, { dt: this.dt, arrivalSpeed });
      if (ground && ground.feasible) solution = ground;
    }
    if (!solution) {
      // 로빙: 막고 선 수비수 머리 위로 넘긴다
      solution = solveLoftedPass(from, to, {
        dt: this.dt,
        minApex: blocked ? 2.4 : 0,
        preferredFlightTime: distance > 30 ? null : 1.1,
      });
    }
    if (!solution) return null;

    // ── 2. 수신자가 제때 닿는가 ────────────────────────────
    const receiverETA = timeToReach(receiver, to);
    const ballETA = solution.flightTime;
    if (receiverETA > ballETA + RECEIVER_LATE_TOLERANCE) return null;

    // ── 3. 가로채기 위험 (실제 궤적 기반) ──────────────────
    const risk = this._interceptionRisk(from, to, solution, opponents, ballETA, receiverETA);
    if (risk >= 0.98) return null; // 사실상 확실히 끊긴다

    // ── 4. 패스 종류 판정 ──────────────────────────────────
    const type = this._classify(passer, receiver, target, distance);

    // ── 5. 효용 계산 ───────────────────────────────────────
    const utility = this._utility({
      engine, passer, receiver, target, solution, type,
      risk, receiverETA, ballETA, opponents, distance, arrivalSpeed,
    });

    return {
      receiver,
      targetPosition: to,
      targetKind: target.kind,
      type,
      solution,
      distance,
      ballETA,
      receiverETA,
      risk,
      utility,
      requestedArrivalSpeed: arrivalSpeed,
      lofted: solution.type === 'LOFTED',
    };
  }

  /**
   * 실제 궤적을 훑어 가로채기 위험을 계산한다 0~1.
   *
   * 각 표본 시점마다 "그 지점에 수비수가 볼보다 먼저 닿는가"를 본다.
   * 공중에 떠 있어 발이 닿지 않는 구간은 위험에서 제외한다.
   */
  _interceptionRisk(from, to, solution, opponents, ballETA, receiverETA) {
    const samples = traceTrajectory(from, solution, this.dt, {
      until: ballETA,
      interval: 0.12,
    });

    let worst = 0;
    for (const sample of samples) {
      // 머리 위로 지나가는 구간은 끊을 수 없다
      if (sample.height > INTERCEPT_MAX_HEIGHT) continue;
      // 출발 직후는 패서 자신의 보호 아래 있다
      if (sample.time < 0.12) continue;

      // 도착 지점 근처는 수신자가 경합하는 구간이다.
      // 수신자가 먼저 닿을 수 있으면 그것은 가로채기가 아니라 경합이며,
      // 결과는 퍼스트 터치·몸싸움이 결정한다.
      const nearTarget = sample.position.sub(to).length() < CONTEST_ZONE;

      for (const opponent of opponents) {
        // 볼이 지나는 지점까지 전부 달릴 필요는 없다.
        // 발이 닿는 거리(INTERCEPT_REACH)만큼 못 미쳐도 끊을 수 있다.
        const toOpponent = opponent.position.sub(sample.position);
        const gap = toOpponent.length();
        const reachPoint = gap > INTERCEPT_REACH
          ? sample.position.add(toOpponent.normalize().scale(INTERCEPT_REACH))
          : opponent.position;
        const eta = timeToReach(opponent, reachPoint);

        // 수신자보다 늦게 오는 수비수는 그 지점을 지배하지 못한다
        if (nearTarget && receiverETA <= eta) continue;

        // 볼보다 얼마나 여유 있게 먼저 오는가
        const lead = sample.time - eta - INTERCEPT_MARGIN;
        if (lead <= 0) continue;
        // 0초 여유 = 위험 0, 0.6초 이상 여유 = 위험 1
        const danger = smoothstep(0, 0.6, lead);
        if (danger > worst) worst = danger;
      }
    }
    return clamp01(worst);
  }

  /** 패스 종류를 기하학적으로 분류한다 */
  _classify(passer, receiver, target, distance) {
    const dir = passer.team.attackingDirection;
    const passerNX = teamNX(passer.position.x, dir);
    const targetNX = teamNX(target.position.x, dir);
    const progression = targetNX - passerNX;

    const lateral = Math.abs(target.position.y - passer.position.y);
    const goalX = opponentGoalLineX(dir);
    const nearByline = Math.abs(target.position.x - goalX) < Pitch.PENALTY_BOX_LENGTH + 8;
    const wide = Math.abs(passer.position.y - Pitch.WIDTH / 2) > Pitch.WIDTH * 0.28;

    if (target.kind === 'SPACE' && progression > 0.03) return PassType.THROUGH;
    if (wide && nearByline && lateral > 12) return PassType.CROSS;
    if (progression < -0.02) return PassType.BACK;
    if (lateral > 24 && Math.abs(progression) < 0.08) return PassType.SWITCH;
    if (progression > 0.05) return PassType.PROGRESSIVE;
    return PassType.SAFE;
  }

  /**
   * 효용 계산.
   *
   * 전진 가치 + 수신 여유 공간 + 안전성 − 선회 비용 − 위험 지역 손실.
   * 팀 전술(전진 성향·리스크 감수)이 가중치를 조절한다.
   */
  _utility({ engine, passer, receiver, target, solution, type, risk, receiverETA, ballETA, opponents, distance, arrivalSpeed }) {
    const tactics = passer.team.tactics;
    const dir = passer.team.attackingDirection;

    // ── 전진 가치 ──────────────────────────────────────────
    const passerNX = teamNX(passer.position.x, dir);
    const targetNX = teamNX(target.position.x, dir);
    const progression = targetNX - passerNX;
    // 전진 성향이 높을수록 앞으로 보내는 것을 더 높게 친다
    const progressWeight = 1.6 + tactics.passingDirectness * 1.8;
    let value = progression * progressWeight;

    // 상대 골문에 가까운 지역으로 보낼수록 추가 가치 (마지막 3분의 1)
    value += smoothstep(0.62, 0.92, targetNX) * 0.30;

    // ── 수신 공간 ──────────────────────────────────────────
    const space = nearestOpponentTo(target.position, opponents).distance;
    value += smoothstep(2, 12, space) * 0.35;

    // ── 안전성 ─────────────────────────────────────────────
    // 리스크 감수 성향이 낮으면 위험 패스를 훨씬 강하게 기피한다
    const riskAversion = 1.9 - tactics.buildUpRisk * 1.0;
    value -= risk * riskAversion;

    // ── 신체 방향과 선회 비용 (Section 18) ─────────────────
    // 정면을 보고 있는데 등 뒤로 즉시 정확한 패스를 찌를 수는 없다
    const passDirection = target.position.sub(passer.position).angle();
    const turnAngle = Math.abs(angleDiff(passDirection, passer.facingAngle));
    // 0~60도는 부담 없음, 180도는 큰 비용
    const turnCost = smoothstep(Math.PI / 3, Math.PI, turnAngle);
    value -= turnCost * 0.55;

    // ── 압박 상황 보정 ─────────────────────────────────────
    // 압박을 심하게 받으면 안전한 선택의 가치가 올라간다
    const pressure = pressureAt(passer.position, opponents);
    if (pressure > 0.4) {
      const relief = smoothstep(0.4, 1.0, pressure);
      // 압박 탈출: 위험이 낮은 패스에 가산점
      value += relief * (1 - risk) * 0.45;
      // 다만 선회 비용은 압박 아래에서 더 크게 작용한다
      value -= relief * turnCost * 0.30;
    }

    // ── 자기 진영 위험 지역 감점 ───────────────────────────
    // 자기 골문 근처에서 끊기면 실점으로 직결된다
    const ownThird = 1 - smoothstep(0.18, 0.42, passerNX);
    value -= risk * ownThird * 1.1;

    // ── 종류별 보정 ────────────────────────────────────────
    value += this._typeBonus(type, tactics, target, receiver, dir);

    // ── 거리 보정 ──────────────────────────────────────────
    // 아주 긴 패스는 성공률이 낮으므로 능력치가 받쳐줄 때만 가치가 있다
    if (distance > 32) {
      const longSkill = passer.attributes.norm('longPassing');
      value -= (1 - longSkill) * smoothstep(32, 60, distance) * 0.75;
    }

    // ── 수신 여유 ──────────────────────────────────────────
    // 수신자가 볼보다 먼저 도착해 기다릴 수 있으면 통제가 쉽다
    const waitTime = ballETA - receiverETA;
    value += smoothstep(-0.2, 0.6, waitTime) * 0.20;

    // ── 패스 세기의 대가 ───────────────────────────────────
    // 세게 찰수록 끊기지 않지만 통제가 어렵다.
    // 위험 항목이 이미 "빠를수록 좋다"를 반영하므로, 여기서는
    // 반대쪽 대가만 계산해 둘 사이에서 균형이 잡히게 한다.
    // (PHASE 6의 퍼스트 터치 난이도와 같은 전제를 쓴다)
    const controlSkill = receiver.attributes.norm('firstTouch');
    const hardness = smoothstep(4, 14, arrivalSpeed);
    value -= hardness * (1 - controlSkill * 0.6) * 0.45;

    return value;
  }

  /** 패스 종류별 전술 보정 */
  _typeBonus(type, tactics, target, receiver, dir) {
    switch (type) {
      case PassType.THROUGH:
        // 스루패스는 기하가 받쳐줄 때만 나와야 하므로 기본 가산점을 두지 않는다.
        // 전진 가치와 공간 항목이 이미 반영되어 있다. (Section 17: 드물게 발생)
        return -0.15 + tactics.buildUpRisk * 0.35;

      case PassType.CROSS:
        return 0.20 + tactics.attackDirectness * 0.25;

      case PassType.SWITCH:
        // 측면 전환은 폭을 넓게 쓰는 팀에서 가치가 크다
        return tactics.width * 0.30;

      case PassType.BACK:
        // 백패스는 필요하지만 남발되면 안 된다.
        // 기본 감점을 둬서 다른 선택지가 없을 때만 뽑히게 한다.
        return -0.45 + (1 - tactics.passingDirectness) * 0.20;

      case PassType.PROGRESSIVE:
        return 0.10;

      case PassType.SAFE:
      default:
        return 0;
    }
  }
}
