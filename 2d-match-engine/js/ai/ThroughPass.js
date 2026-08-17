/**
 * @fileoverview 스루패스(Through Pass) 미래 지점 예측(Lead Passing) 전용 계산 모듈.
 *
 * 공이 패서를 떠난 뒤 리시버가 계속 달리기 때문에, 리시버의 "현재 위치"를
 * 목표로 차면 공이 등 뒤로 흐르는 문제가 발생한다.
 * 이를 해결하기 위해 아래의 수학적 모델을 사용한다.
 *
 * 1) 인터셉트 계산:  || P_target(t) - P_passer || = ballSpeed * t
 *    (P_target(t) = P_receiver + V_receiver * t) 를 2차 방정식으로 전개해
 *    가장 작은 양의 실수 t를 구한다.
 * 2) 예외 처리:      판별식 D < 0 또는 ballSpeed <= ||V_receiver|| 인 경우
 *    리시버 진행 방향 전방 공간으로 Fallback. 정지 리시버는 일반 패스로 전환.
 * 3) 안전 검증:      checkPassSafety()가 수비수 차단 위험을 검사하고,
 *    위험 시 오프사이드 라인 전방 또는 측면 공간으로 보정(Offset)한다.
 *
 * 외부 라이브러리 의존 없이 순수 ES6+로 작성되어, 별도 Vec2 유틸리티와 함께
 * 어느 2D 매치 엔진에도 부품처럼 결합할 수 있다.
 */

/** @typedef {{x:number, y:number}} Point  2차원 좌표(또는 Vec2) 호환 객체 */

/**
 * 2차원 벡터 연산 유틸리티. 모든 메서드는 새 인스턴스를 반환해 비파괴적이다.
 * 엔진의 Vector2D 대신 사용하거나, fromPoint()로 평범한 {x,y} 객체를 감싼다.
 */
export class Vec2 {
  /**
   * @param {number} [x=0] x 좌표
   * @param {number} [y=0] y 좌표
   */
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  /**
   * 현재 벡터에 v를 더한 새 벡터를 반환한다.
   * @param {Point} v 더할 벡터
   * @returns {Vec2}
   */
  add(v) {
    return new Vec2(this.x + v.x, this.y + v.y);
  }

  /**
   * 현재 벡터에서 v를 뺀 새 벡터를 반환한다.
   * @param {Point} v 뺄 벡터
   * @returns {Vec2}
   */
  sub(v) {
    return new Vec2(this.x - v.x, this.y - v.y);
  }

  /**
   * 현재 벡터를 스칼라 s로 확대/축소한 새 벡터를 반환한다.
   * @param {number} s 스칼라 배율
   * @returns {Vec2}
   */
  scale(s) {
    return new Vec2(this.x * s, this.y * s);
  }

  /**
   * 벡터의 크기(노름)를 반환한다.
   * @returns {number}
   */
  length() {
    return Math.hypot(this.x, this.y);
  }

  /**
   * 벡터 크기의 제곱을 반환한다. (연산량 절감용)
   * @returns {number}
   */
  lengthSq() {
    return this.x * this.x + this.y * this.y;
  }

  /**
   * 단위 벡터(정규화)를 반환한다. 길이가 0이면 (0,0)을 반환한다.
   * @returns {Vec2}
   */
  normalize() {
    const len = this.length();
    if (len < 1e-9) return new Vec2(0, 0);
    return new Vec2(this.x / len, this.y / len);
  }

  /**
   * 다른 벡터와의 내적(dot product)을 반환한다.
   * @param {Point} v 내적 대상
   * @returns {number}
   */
  dot(v) {
    return this.x * v.x + this.y * v.y;
  }

  /**
   * 시계 반대 방향으로 angle(라디안)만큼 회전한 새 벡터를 반환한다.
   * @param {number} angle 회전각 (라디안)
   * @returns {Vec2}
   */
  rotate(angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return new Vec2(this.x * cos - this.y * sin, this.x * sin + this.y * cos);
  }

  /**
   * 현재 벡터의 사본을 반환한다.
   * @returns {Vec2}
   */
  clone() {
    return new Vec2(this.x, this.y);
  }

  /**
   * 평범한 {x,y} 객체 또는 Vec2를 Vec2로 변환한다. (내부 파괴 없이)
   * @param {Point} p 좌표 객체
   * @returns {Vec2}
   */
  static fromPoint(p) {
    if (!p) return new Vec2(0, 0);
    return p instanceof Vec2 ? p.clone() : new Vec2(p.x ?? 0, p.y ?? 0);
  }

  /**
   * 두 점 사이의 거리를 반환한다.
   * @param {Point} a 점 A
   * @param {Point} b 점 B
   * @returns {number}
   */
  static distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  /**
   * 각도와 길이로 벡터를 생성한다.
   * @param {number} angle 각도 (라디안)
   * @param {number} [length=1] 길이
   * @returns {Vec2}
   */
  static fromAngle(angle, length = 1) {
    return new Vec2(Math.cos(angle) * length, Math.sin(angle) * length);
  }

  /**
   * 두 점 사이를 비율 t로 선형 보간한 지점을 반환한다.
   * @param {Point} a 시작점
   * @param {Point} b 끝점
   * @param {number} t 보간 비율 (0~1)
   * @returns {Vec2}
   */
  static lerp(a, b, t) {
    return new Vec2(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
  }
}

/**
 * 0~1 사이로 값을 고정한다.
 * @param {number} v 입력값
 * @returns {number}
 */
function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

/**
 * 2차 방정식의 근의 공식을 안전하게 푼다. (a가 0이면 선형으로 처리)
 * @param {number} a 2차 계수
 * @param {number} b 1차 계수
 * @param {number} c 상수항
 * @returns {number[]} 양의 실수 해 목록 (오름차순, 근사 해 제외)
 */
function solveQuadraticPositive(a, b, c) {
  if (Math.abs(a) < 1e-9) {
    // 선형 방정식 b*t + c = 0
    if (Math.abs(b) < 1e-9) return [];
    const t = -c / b;
    return t > 1e-6 && Number.isFinite(t) ? [t] : [];
  }
  const D = b * b - 4 * a * c;
  if (D < 0) return [];
  const sqrtD = Math.sqrt(D);
  const denom = 2 * a;
  const roots = [(-b + sqrtD) / denom, (-b - sqrtD) / denom]
    .filter((t) => Number.isFinite(t) && t > 1e-6)
    .sort((t1, t2) => t1 - t2);
  return roots;
}

/**
 * 인터셉트(추격) 문제를 2차 방정식으로 풀어, 공이 리시버의 미래 위치와
 * 만나는 가장 작은 양의 시간 t와 그 시점의 목표 좌표를 계산한다.
 *
 * 모델:
 *   P_target(t) = P_receiver + V_receiver * t
 *   ||P_target(t) - P_passer|| = ballSpeed * t
 *
 * 양변을 제곱해 전개하면:
 *   (V·V - ballSpeed²) t² + 2(d0·V) t + (d0·d0) = 0
 *   (단, d0 = P_receiver - P_passer)
 *
 * 예외 처리:
 * - 리시버 정지(V = 0):   일반 패스로 안전 전환 (현재 위치 그대로).
 * - ballSpeed <= ||V||:    공이 절대 따라잡을 수 없음 → 전방 공간 Fallback.
 * - D < 0 또는 양수 해 없음:  → 전방 공간 Fallback.
 *
 * @param {Point} passer 패서 위치
 * @param {Point} receiver 리시버 위치
 * @param {Point} receiverVelocity 리시버 속도 벡터 {vx, vy}
 * @param {number} ballSpeed 공의 속력 (px/sec 또는 px/frame)
 * @param {Object} [options] 옵션
 * @param {Array<number>} [options.leadRange=[20,40]] Fallback 시 전방 리드 거리 범위 [min,max]
 * @param {number} [options.leadDist] 고정 전방 리드 거리 (지정 시 leadRange 무시)
 * @returns {{t: number|null, target: Vec2, method: string, valid: boolean}}
 *   - t: 공 도달 시간 (Fallback 시 null)
 *   - target: 리시버의 미래 수신 지점 (또는 Fallback 지점)
 *   - method: 'quadratic' | 'stationary' | 'fallback-lead'
 *   - valid: true면 수학적으로 유효한 인터셉트, false면 Fallback
 */
export function solveIntercept(passer, receiver, receiverVelocity, ballSpeed, options = {}) {
  const P = Vec2.fromPoint(passer);
  const R = Vec2.fromPoint(receiver);
  const V = Vec2.fromPoint(receiverVelocity);
  const speed = Math.max(0.001, ballSpeed);

  const d0 = R.sub(P);
  const c = d0.lengthSq();
  const b = 2 * d0.dot(V);
  const a = V.lengthSq() - speed * speed;

  // ── 예외 1: 리시버 정지 → 일반 패스(현재 위치)로 안전 전환 ──
  if (V.lengthSq() < 1e-6) {
    const t = Math.sqrt(c) / speed;
    return { t, target: R.clone(), method: 'stationary', valid: true };
  }

  // ── 예외 2: 공 속력이 리시버 속력 이하 → 절대 따라잡을 수 없음 ──
  if (speed <= V.length()) {
    return fallbackLead(R, V, options);
  }

  // ── 정상: 2차 방정식 근의 공식 ──
  const roots = solveQuadraticPositive(a, b, c);
  if (roots.length === 0) {
    // D < 0 또는 양수 해가 없음
    return fallbackLead(R, V, options);
  }

  const t = roots[0]; // 가장 작은 양의 실수
  const target = R.add(V.scale(t));
  return { t, target, method: 'quadratic', valid: true };
}

/**
 * 공이 리시버를 따라잡을 수 없을 때 사용하는 Fallback 목표 계산.
 * 리시버 진행 방향 전방(기본 20~40px) 공간 좌표를 반환한다.
 * 리시버가 멈춰 있다면 옵션의 stationaryLead(m)만큼 앞선 지점을 반환한다.
 *
 * @param {Vec2} receiver 리시버 위치
 * @param {Vec2} velocity 리시버 속도 벡터
 * @param {Object} [options] 옵션 (solveIntercept와 동일)
 * @param {Array<number>} [options.leadRange=[20,40]] 전방 리드 범위
 * @param {number} [options.leadDist] 고정 전방 리드
 * @param {number} [options.stationaryLead=1.5] 정지 리시버용 전방 리드
 * @returns {{t:null, target:Vec2, method:string, valid:boolean}}
 */
function fallbackLead(receiver, velocity, options = {}) {
  const speed = velocity.length();
  let leadDist = options.leadDist;
  if (typeof leadDist !== 'number') {
    const [min, max] = options.leadRange ?? [20, 40];
    leadDist = min + Math.random() * (max - min);
  }
  const dir = speed > 1e-9 ? velocity.normalize() : new Vec2(0, 0);
  const target = receiver.add(dir.scale(leadDist));
  return { t: null, target, method: 'fallback-lead', valid: false };
}

/**
 * 선분(from→to) 위로부터 수비수까지의 최단 거리와 투영 파라미터 t를 계산한다.
 * @param {Point} p 수비수 위치
 * @param {Point} from 선분 시작점
 * @param {Point} to 선분 끝점
 * @returns {{dist:number, t:number}} 최단 거리, 투영 위치 비율(0~1)
 */
function segmentPointInfo(p, from, to) {
  const a = Vec2.fromPoint(from);
  const b = Vec2.fromPoint(to);
  const ab = b.sub(a);
  const abLenSq = ab.lengthSq();
  const t = clamp01(Vec2.fromPoint(p).sub(a).dot(ab) / Math.max(abLenSq, 1e-9));
  const proj = a.add(ab.scale(t));
  return { dist: Vec2.fromPoint(p).sub(proj).length(), t };
}

/**
 * 패스 궤적(from→to)을 차단하는 수비수 목록을 반환한다.
 * 수비수는 {x,y} 객체 또는 {position:{x,y}} 형태 모두 허용한다.
 *
 * @param {Point} from 패서 위치
 * @param {Point} to 목표 지점
 * @param {Array} defenders 수비수 목록
 * @param {number} radius 차단 판정 반경
 * @returns {Array<{pos:Vec2, dist:number, t:number}>} 차단하는 수비수 목록
 */
function collectBlockers(from, to, defenders, radius) {
  const result = [];
  for (const d of defenders || []) {
    const pos = Vec2.fromPoint(d.position ?? d);
    const { dist, t } = segmentPointInfo(pos, from, to);
    if (t > 0.05 && t < 0.95 && dist < radius) {
      result.push({ pos, dist, t });
    }
  }
  return result;
}

/**
 * 목표 지점을 옵션 경계(bounds) 안으로 고정한다.
 * @param {Vec2} target 목표 지점
 * @param {Object} [options] 옵션
 * @param {Array<Array<number>>} [options.bounds] [[minX,maxX],[minY,maxY]] 경계
 * @returns {Vec2}
 */
function clampToBounds(target, options = {}) {
  const bounds = options.bounds;
  if (!bounds) return target;
  const x = Math.max(bounds[0][0], Math.min(bounds[0][1], target.x));
  const y = Math.max(bounds[1][0], Math.min(bounds[1][1], target.y));
  return new Vec2(x, y);
}

/**
 * 패스 안전성 검증 및 위험 시 목표 보정.
 *
 * 1. 패서→목표 선분 상에 수비수가 차단 반경 안으로 들어오는지 검사한다.
 * 2. 안전하면 그대로 두고, 위험하면 아래 전략 중 차단이 가장 적은 곳으로 보정한다.
 *    - (a) 오프사이드 라인 전방: options.offsideLineX로 온사이드 유지 목표.
 *    - (b) 측면 공간: 차단 수비수 평균 위치의 법선 방향으로 옆으로 우회.
 *
 * @param {Point} passer 패서 위치
 * @param {Point} target 계산된 원래 목표 지점
 * @param {Array} defenders 상대 수비수 목록 ({x,y} 또는 {position:{x,y}})
 * @param {Object} [options] 옵션
 * @param {number} [options.interceptRadius=1.5] 차단 판정 반경
 * @param {number} [options.sideClearance=3.0] 측면 우회 거리
 * @param {number} [options.offsideLineX=null] 오프사이드 라인 X (미지정 시 생략)
 * @param {number} [options.offsideMargin=1.0] 오프사이드 라인 안쪽 여유
 * @param {number} [options.attackDir=1] 공격 방향 (1=우측 공격, -1=좌측 공격)
 * @param {Point} [options.receiver] 리시버 위치 (오프사이드 보정의 y 기준)
 * @param {Array<Array<number>>} [options.bounds] 목표 고정 경계
 * @returns {{safe:boolean, target:Vec2, clearanceScore:number, blockers:Array, reason:string|null}}
 *   - safe: true면 보정 없음, false면 보정됨
 *   - target: 최종 목표 지점
 *   - clearanceScore: 최종 경로의 안전도 (0~100, 클수록 안전)
 *   - blockers: 원래 목표를 차단한 수비수
 *   - reason: 보정 사유 ('offside-line' | 'side' | null)
 */
export function checkPassSafety(passer, target, defenders, options = {}) {
  const from = Vec2.fromPoint(passer);
  const to = Vec2.fromPoint(target);
  const radius = options.interceptRadius ?? 1.5;

  const blockers = collectBlockers(from, to, defenders, radius);
  if (blockers.length === 0) {
    return {
      safe: true,
      target: clampToBounds(to.clone(), options),
      clearanceScore: 100,
      blockers: [],
      reason: null,
    };
  }

  // ── 후보 목표 생성 ──
  const candidates = [];
  const attackDir = options.attackDir ?? 1;

  // 후보 (a): 오프사이드 라인 전방 — 리시버 라인을 유지한 채 온사이드로
  if (options.offsideLineX !== null && options.offsideLineX !== undefined && options.receiver) {
    const recv = Vec2.fromPoint(options.receiver);
    const margin = options.offsideMargin ?? 1.0;
    const onsideX = options.offsideLineX - attackDir * margin;
    candidates.push({
      pos: new Vec2(onsideX, recv.y),
      reason: 'offside-line',
      weight: 1.2, // 온사이드 유지는 우선 고려
    });
  }

  // 후보 (b): 차단 수비수 평균 위치의 양쪽 법선 공간
  if (blockers.length > 0) {
    const center = blockers
      .reduce((acc, d) => acc.add(d.pos), new Vec2(0, 0))
      .scale(1 / blockers.length);
    const toCenter = center.sub(from);
    const perp = new Vec2(-toCenter.y, toCenter.x).normalize();
    const clearance = radius + (options.sideClearance ?? 3.0);
    candidates.push({ pos: to.add(perp.scale(clearance)), reason: 'side', weight: 1.0 });
    candidates.push({ pos: to.add(perp.scale(-clearance)), reason: 'side', weight: 1.0 });
  }

  // ── 각 후보의 차단 재검사 + 가중 점수 ──
  let best = null;
  for (const cand of candidates) {
    const candBlockers = collectBlockers(from, cand.pos, defenders, radius);
    const penalty = candBlockers.length * 40;
    const bounded = clampToBounds(cand.pos, options);
    const distancePenalty = Vec2.distance(to, bounded) * 0.5; // 원래 목표에서 멀어질수록 감점
    const score = Math.max(0, 100 - penalty - distancePenalty) * cand.weight;
    if (!best || score > best.score) {
      best = { pos: bounded, reason: cand.reason, score };
    }
  }

  if (!best) {
    // 보정할 곳이 없으면 원래 목표 유지 (차단 리스크 감수)
    return {
      safe: false,
      target: clampToBounds(to.clone(), options),
      clearanceScore: 0,
      blockers,
      reason: null,
    };
  }

  return {
    safe: false,
    target: best.pos,
    clearanceScore: Math.round(best.score),
    blockers,
    reason: best.reason,
  };
}

/**
 * 스루패스 리드 목표 계산의 최상위 진입점.
 * 인터셉트 계산 → 안전성 검증/보정을 차례로 수행하고 최종 목표를 반환한다.
 *
 * @param {Point} passer 패서 위치
 * @param {Point} receiver 리시버 위치
 * @param {Point} receiverVelocity 리시버 속도 벡터 {vx, vy}
 * @param {number} ballSpeed 공의 속력
 * @param {Array} [defenders] 상대 수비수 목록
 * @param {Object} [options] solveIntercept/checkPassSafety 공통 옵션
 * @returns {{target:Vec2, t:number|null, method:string, valid:boolean,
 *            safe:boolean, clearanceScore:number, reason:string|null}}
 *   - target: 최종 목표 지점 (보정 반영)
 *   - t: 공 도달 시간 (Fallback 시 null)
 *   - method: 인터셉트 계산 방식
 *   - valid: 수학적으로 유효한 인터셉트 여부
 *   - safe: 패스 경로가 안전(차단 없음)한지
 *   - clearanceScore: 최종 경로 안전도
 *   - reason: 보정 사유
 */
export function calculateThroughPassTarget(passer, receiver, receiverVelocity, ballSpeed, defenders = [], options = {}) {
  const intercept = solveIntercept(passer, receiver, receiverVelocity, ballSpeed, options);
  const safety = checkPassSafety(passer, intercept.target, defenders, {
    ...options,
    receiver,
  });

  return {
    target: safety.target,
    t: intercept.t,
    method: intercept.method,
    valid: intercept.valid,
    safe: safety.safe,
    clearanceScore: safety.clearanceScore,
    reason: safety.reason,
  };
}

export default {
  Vec2,
  solveIntercept,
  checkPassSafety,
  calculateThroughPassTarget,
};
