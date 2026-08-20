import { Vector2D } from '../../entities/Vector2D.js';
import { clamp, clamp01, smoothstep, angleDiff } from '../core/Coords.js';

/**
 * 1대1 경합 판정 (Section 22).
 *
 * ⚠ "가까우면 태클 성공"이 아니다.
 *   태클 성공률은 각도·상대 속도·능력치·타이밍·볼과 발의 거리에서 나온다.
 *   그래서 수비수는 대개 곧바로 달려들기보다 지연시키는 편이 낫고,
 *   그 판단 자체도 여기서 점수로 제공한다.
 */

/** 태클 시도 가능 거리 (m) */
export const TACKLE_RANGE = 2.4;

/** 태클 후 재시도까지의 회복 시간 (초) — 성공/실패 모두 적용 */
export const TACKLE_RECOVERY = 0.9;

/** 태클 실패 시 수비수가 제쳐진 상태로 있는 시간 (초) */
export const BEATEN_DURATION = 1.1;

/** 경합 결과 */
export const DuelOutcome = {
  WIN_CLEAN: 'WIN_CLEAN',   // 볼을 깨끗이 따내 소유 전환
  WIN_LOOSE: 'WIN_LOOSE',   // 볼을 걷어냈지만 아무도 소유하지 못함
  FAIL: 'FAIL',             // 제쳐짐 — 공격수가 계속 소유
  FOUL: 'FOUL',             // 반칙 — 규칙 엔진이 프리킥을 판정한다
};

/**
 * 태클 성공 확률을 구성하는 요소들을 계산한다.
 * 확률뿐 아니라 각 요소를 함께 돌려주어 디버깅과 수비 판단에 쓴다.
 *
 * @param {Player} tackler 수비수
 * @param {Player} carrier 볼을 가진 선수
 * @param {Ball} ball
 */
export function tackleFactors(tackler, carrier, ball) {
  const t = tackler.attributes;
  const c = carrier.attributes;

  // ── 1. 볼이 공격수 발에서 얼마나 떨어져 있는가 ────────────
  // 드리블 터치가 크게 나간 순간이 뺏기 가장 좋은 타이밍이다.
  const ballFromCarrier = ball.position.sub(carrier.position).length();
  const ballExposure = smoothstep(0.4, 2.2, ballFromCarrier);

  // ── 2. 접근 각도 ───────────────────────────────────────────
  // 정면에서 막으면 깨끗이 뺏기 쉽고, 뒤에서 덤비면 반칙 위험이 크다.
  const toCarrier = carrier.position.sub(tackler.position);
  const carrierHeading = carrier.velocity.length() > 0.5
    ? carrier.velocity.angle()
    : carrier.facingAngle;
  // 수비수가 공격수의 진행 방향 기준 어디에 있는가
  const approachOffset = Math.abs(
    angleDiff(toCarrier.angle(), carrierHeading)
  );
  // 0 = 공격수 뒤에서 쫓아감, π = 정면에서 마주봄
  const frontal = approachOffset / Math.PI;
  const fromBehind = 1 - frontal;

  // ── 3. 상대 속도 ───────────────────────────────────────────
  // 서로 빠르게 스쳐 지나가는 상황일수록 타이밍 맞추기가 어렵다.
  const relativeSpeed = carrier.velocity.sub(tackler.velocity).length();
  const speedPenalty = smoothstep(2, 12, relativeSpeed);

  // ── 4. 능력치 대결 ─────────────────────────────────────────
  const defenceSkill =
    t.norm('tackling') * 0.55 +
    t.norm('interceptions') * 0.20 +
    t.norm('strength') * 0.15 +
    t.norm('agility') * 0.10;

  const attackSkill =
    c.norm('dribbling') * 0.50 +
    c.norm('balance') * 0.25 +
    c.norm('agility') * 0.15 +
    c.norm('strength') * 0.10;

  // 체력 저하는 태클 타이밍에 직접 영향을 준다
  const fatigueFactor = 0.82 + 0.18 * tackler.energy;

  // ── 5. 종합 확률 ───────────────────────────────────────────
  let success =
    0.30 +
    (defenceSkill - attackSkill) * 0.55 +
    ballExposure * 0.42 +
    frontal * 0.12 -
    speedPenalty * 0.22;

  success *= fatigueFactor;
  success = clamp01(success);

  // ── 6. 반칙 위험 ───────────────────────────────────────────
  // 뒤에서, 빠른 속도로, 볼이 멀 때 덤비면 반칙이 된다.
  const foulRisk = clamp01(
    0.06 +
    fromBehind * 0.20 +
    speedPenalty * 0.16 +
    (1 - ballExposure) * 0.14 -
    t.norm('tackling') * 0.16
  );

  return {
    success,
    foulRisk,
    ballExposure,
    frontal,
    fromBehind,
    relativeSpeed,
    defenceSkill,
    attackSkill,
  };
}

/**
 * 태클을 실행하고 결과를 반환한다.
 *
 * @param {object} params
 * @param {Player} params.tackler
 * @param {Player} params.carrier
 * @param {Ball} params.ball
 * @param {Rng} params.rng 경합 전용 난수 스트림
 * @returns {{outcome:string, factors:object, ballVelocity:Vector2D|null}}
 */
export function resolveTackle({ tackler, carrier, ball, rng }) {
  const factors = tackleFactors(tackler, carrier, ball);

  // 반칙 판정이 먼저다. 무리한 태클은 성공 여부와 무관하게 반칙이 된다.
  if (rng.chance(factors.foulRisk)) {
    return { outcome: DuelOutcome.FOUL, factors, ballVelocity: null };
  }

  if (!rng.chance(factors.success)) {
    return { outcome: DuelOutcome.FAIL, factors, ballVelocity: null };
  }

  // 성공. 다만 깨끗이 따내는지, 걷어내기만 하는지는 상황에 달렸다.
  // 볼이 공격수 발에서 멀고 수비수가 정면일수록 깨끗이 가져간다.
  const cleanChance = clamp01(
    0.30 + factors.ballExposure * 0.35 + factors.frontal * 0.25 -
    smoothstep(4, 12, factors.relativeSpeed) * 0.20
  );

  if (rng.chance(cleanChance)) {
    return { outcome: DuelOutcome.WIN_CLEAN, factors, ballVelocity: Vector2D.zero() };
  }

  // 걷어내기 — 볼이 수비수 진행 방향으로 튀어나간다
  const direction = tackler.velocity.length() > 0.5
    ? tackler.velocity.normalize()
    : carrier.position.sub(tackler.position).normalize().scale(-1);
  const power = 3.5 + factors.defenceSkill * 3.0;

  return {
    outcome: DuelOutcome.WIN_LOOSE,
    factors,
    ballVelocity: direction.rotate(rng.range(-0.6, 0.6)).scale(power),
  };
}

/**
 * 지금 태클을 시도하는 것이 합리적인가 (0~1).
 *
 * 수비의 기본은 태클이 아니라 지연이다 (Section 22).
 * 성공 확률이 충분히 높거나, 위험 지역이라 지금 끊어야 할 때만 시도한다.
 *
 * @param {Player} tackler
 * @param {Player} carrier
 * @param {Ball} ball
 * @param {object} [context]
 * @param {boolean} [context.lastDefender] 뒤에 커버가 없는가
 * @param {boolean} [context.dangerZone] 자기 진영 위험 지역인가
 * @param {number} [context.aggression] 팀 태클 적극성 0~1
 */
export function tackleDesirability(tackler, carrier, ball, context = {}) {
  const { lastDefender = false, dangerZone = false, aggression = 0.5 } = context;
  const factors = tackleFactors(tackler, carrier, ball);

  // 기본은 성공 확률에서 반칙 위험을 뺀 값
  let desire = factors.success - factors.foulRisk * 1.4;

  // 최후의 수비수는 함부로 덤비면 안 된다. 지연시켜 동료를 기다린다.
  if (lastDefender) desire -= 0.35;

  // 위험 지역에서는 그래도 끊어야 한다
  if (dangerZone) desire += 0.20;

  // 볼이 공격수 발에서 크게 떠 있으면 지금이 기회다
  desire += factors.ballExposure * 0.25;

  // 팀 지시
  desire += (aggression - 0.5) * 0.40;

  return clamp01(desire);
}

/**
 * 몸싸움(쉴드) 유지 확률 — 볼을 등지고 지키는 상황.
 * 홀드업 플레이와 루즈볼 경합에서 쓴다.
 */
export function shieldStrength(holder, challenger) {
  const h = holder.attributes;
  const c = challenger.attributes;
  const holderPower =
    h.norm('strength') * 0.55 + h.norm('balance') * 0.30 + h.norm('dribbling') * 0.15;
  const challengerPower =
    c.norm('strength') * 0.60 + c.norm('balance') * 0.25 + c.norm('tackling') * 0.15;

  return clamp01(0.5 + (holderPower - challengerPower) * 0.85);
}
