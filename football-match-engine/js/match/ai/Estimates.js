import { Vector2D } from '../../entities/Vector2D.js';
import { clamp01 } from '../core/Coords.js';

/**
 * 공용 추정 유틸리티.
 *
 * "이 선수가 저 지점에 몇 초에 도달하는가", "지금 얼마나 압박받는가" 같은
 * 질문은 패싱·수비·전환·골키퍼가 모두 던진다. 각자 다르게 계산하면
 * 같은 상황을 두고 서로 모순된 판단을 하게 되므로 여기에 한 번만 정의한다.
 *
 * 모든 추정은 PHASE 5 이동 모델(가속 한계·선회 한계)과 같은 전제를 쓴다.
 */

/** 압박 계산 반경 (m) */
export const PRESSURE_RADIUS = 9;

/**
 * 선수가 특정 지점에 도달하는 데 걸리는 시간 (초).
 *
 * 단순히 거리/최고속도로 계산하면 실제보다 훨씬 낙관적이다.
 * 실제로는 (1) 반응 지연 (2) 가속 구간 (3) 관성을 되돌리는 비용이 든다.
 * 이 세 가지를 반영해야 "수비수가 먼저 닿을 수 있는가" 판단이 맞는다.
 *
 * @param {Player} player
 * @param {Vector2D} point 목표 지점
 * @param {object} [opts]
 * @param {boolean} [opts.includeReaction] 반응 지연 포함 여부 (기본 true)
 * @returns {number} 도달 예상 시간 (초)
 */
export function timeToReach(player, point, { includeReaction = true } = {}) {
  const toPoint = point.sub(player.position);
  const distance = toPoint.length();

  const reaction = includeReaction ? player.reactionDelay : 0;
  if (distance < 0.25) return reaction;

  const direction = toPoint.normalize();
  const vMax = player.maxSpeed;
  const accel = player.maxAcceleration;

  // 목표 방향으로의 현재 속도 성분 (뒤로 달리는 중이면 음수)
  const v0 = player.velocity.dot(direction);

  // 최고 속도까지 가속하는 구간
  const tAccel = Math.max(0, (vMax - v0) / accel);
  const dAccel = v0 * tAccel + 0.5 * accel * tAccel * tAccel;

  let travelTime;
  if (dAccel >= distance) {
    // 가속 도중에 도달한다: d = v₀t + ½at²  →  t = (−v₀ + √(v₀² + 2ad)) / a
    const disc = Math.max(0, v0 * v0 + 2 * accel * distance);
    travelTime = (-v0 + Math.sqrt(disc)) / accel;
  } else {
    travelTime = tAccel + (distance - dAccel) / vMax;
  }

  // 관성 전환 비용: 지금 다른 방향으로 달리고 있으면 그 운동량을 되돌려야 한다.
  // PHASE 5의 횡가속도 한계와 같은 전제를 쓴다.
  const speed = player.velocity.length();
  let turnCost = 0;
  if (speed > 0.5) {
    const cos = player.velocity.normalize().dot(direction);
    const lateralAccel = 5.5; // 대표값 — 개인차는 위 가속 항이 이미 반영한다
    turnCost = (speed * (1 - cos)) / (2 * lateralAccel);
  }

  return reaction + travelTime + turnCost;
}

/**
 * 볼이 특정 지점에 도달하는 시간과, 그때 수비수가 닿을 수 있는지 비교한다.
 *
 * @param {Vector2D} point
 * @param {number} ballTime 볼이 그 지점에 닿는 시각 (초)
 * @param {Player[]} opponents
 * @returns {{canIntercept:boolean, margin:number, player:Player|null}}
 *          margin: 볼보다 얼마나 일찍 도착하는가 (양수면 가로채기 가능)
 */
export function interceptionMargin(point, ballTime, opponents) {
  let best = null;
  let bestMargin = -Infinity;

  for (const opponent of opponents) {
    const eta = timeToReach(opponent, point);
    const margin = ballTime - eta;
    if (margin > bestMargin) {
      bestMargin = margin;
      best = opponent;
    }
  }

  return {
    canIntercept: bestMargin > 0,
    margin: bestMargin,
    player: best,
  };
}

/**
 * 근접 상대에 의한 압박 정도 0~1.
 * 거리의 제곱에 반비례해 가까울수록 급격히 커진다.
 *
 * @param {Vector2D} position 압박을 재는 지점
 * @param {Player[]} opponents
 * @param {number} [radius] 압박 반경
 */
export function pressureAt(position, opponents, radius = PRESSURE_RADIUS) {
  let pressure = 0;
  for (const o of opponents) {
    const d = o.position.sub(position).length();
    if (d >= radius) continue;
    pressure += (1 - d / radius) ** 2;
  }
  return clamp01(pressure);
}

/** 선수가 받는 압박 (자기 팀 상대 기준) */
export function pressureOn(player) {
  const opponents = player.team?.opponent?.players ?? [];
  return pressureAt(player.position, opponents);
}

/**
 * 지점 주변의 여유 공간 — 가장 가까운 상대까지의 거리로 근사한다.
 * @returns {{distance:number, player:Player|null}}
 */
export function nearestOpponentTo(position, opponents) {
  let best = null;
  let bestDistance = Infinity;
  for (const o of opponents) {
    const d = o.position.sub(position).length();
    if (d < bestDistance) {
      bestDistance = d;
      best = o;
    }
  }
  return { distance: bestDistance, player: best };
}

/**
 * 선수의 미래 위치 예측.
 *
 * 등속으로 외삽하되, 먼 미래일수록 감쇠시킨다.
 * 사람은 계속 같은 속도로 직진하지 않으므로, 2초 뒤 위치를
 * 속도 × 2초로 잡으면 실제보다 훨씬 멀리 예측하게 된다.
 * 이것이 구 엔진에서 패스가 수신자 앞으로 과하게 나가던 원인 중 하나다.
 *
 * @param {Player} player
 * @param {number} time 몇 초 뒤
 */
export function futurePosition(player, time) {
  if (time <= 0) return player.position.clone();
  // 감쇠 계수: 0.5초까지는 거의 그대로, 그 뒤로는 점점 보수적으로
  const damping = 1 / (1 + time * 0.55);
  return player.position.add(player.velocity.scale(time * damping));
}

/**
 * 패스 경로가 상대 몸에 막혀 있는지 (지상 패스용).
 *
 * @param {Vector2D} from
 * @param {Vector2D} to
 * @param {Player[]} opponents
 * @param {number} [radius] 차단 판정 반경 (m)
 */
export function isLaneBlocked(from, to, opponents, radius = 0.9) {
  const delta = to.sub(from);
  const length = delta.length();
  if (length < 0.1) return false;
  const direction = delta.normalize();

  for (const o of opponents) {
    const toOpp = o.position.sub(from);
    const along = toOpp.dot(direction);
    // 경로 구간 밖(뒤쪽이거나 목표 너머)은 무시
    if (along <= 0.5 || along >= length - 0.3) continue;
    const perpendicular = toOpp.sub(direction.scale(along)).length();
    if (perpendicular < radius) return true;
  }
  return false;
}
