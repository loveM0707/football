/**
 * SpacePassCalculator — 공간 침투 선수를 위한 감속 스루패스 초기 속도 계산기
 *
 * ┌ 볼 물리 모델 (등감속 직선 운동) ─────────────────────────────────┐
 * │  v² = v₀² − 2·A·d          [운동에너지 방정식]                  │
 * │  T_b = 2·d / (v₀ + v_f)    [사다리꼴 적분 = 등감속에서 정확]   │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * 최적화 목표: 볼이 수신자보다 먼저(T_b ≤ T_r) 목표 구역에 도착하면서
 *             두 도착 시간 차이 |T_r − T_b|를 최소화하는 인터셉션 포인트.
 */

import { Vector2D } from '../entities/Vector2D.js';

// ─── 내부 기하학 유틸리티 ────────────────────────────────────────────────────

/**
 * 광선(O + t·D)과 선분(A→B)의 교차 파라미터 t를 반환한다.
 *
 * 유도 (2D 연립방정식):
 *   O + t·D = A + s·E    (E = B − A, s ∈ [0,1])
 *   → [D  −E]·[t; s] = A − O = C
 *   det = E.x·D.y − E.y·D.x
 *   t   = (E.x·C.y − E.y·C.x) / det
 *   s   = (D.x·C.y − D.y·C.x) / det
 *
 * @param {{ x: number, y: number }} O - 광선 원점
 * @param {{ x: number, y: number }} D - 광선 방향 벡터 (단위벡터 불필요, t의 단위 맞출 것)
 * @param {{ x: number, y: number }} A - 선분 시작점
 * @param {{ x: number, y: number }} B - 선분 끝점
 * @returns {number | null} 교차 t 값 (t ≥ 0), 없으면 null
 */
function raySegmentIntersectT(O, D, A, B) {
  const ex = B.x - A.x;
  const ey = B.y - A.y;
  const cx = A.x - O.x;
  const cy = A.y - O.y;

  const det = ex * D.y - ey * D.x;
  if (Math.abs(det) < 1e-9) return null; // 평행 또는 동일선

  const t = (ex * cy - ey * cx) / det;   // 광선 파라미터
  const s = (D.x * cy - D.y * cx) / det; // 선분 파라미터 [0, 1]

  if (t < -1e-6 || s < -1e-6 || s > 1 + 1e-6) return null;
  return Math.max(0, t);
}

/**
 * 점이 다각형 내부에 있는지 판별 (Ray Casting 알고리즘).
 * @param {{ x: number, y: number }} pt
 * @param {Array<{ x: number, y: number }>} poly - 꼭짓점 배열 (순서대로)
 * @returns {boolean}
 */
function pointInPolygon(pt, poly) {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if ((yi > pt.y) !== (yj > pt.y) &&
        pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// ─── 메인 함수 ───────────────────────────────────────────────────────────────

/**
 * 목표 구역으로 굴러가는 스루패스의 초기 속도 벡터(V_ball_init)를 계산한다.
 *
 * @param {object} params
 * @param {Vector2D}   params.passerPos
 *   패서의 현재 위치.
 *
 * @param {Vector2D}   params.receiverPos
 *   리시버의 현재 위치.
 *
 * @param {number}     params.receiverMaxSpeed
 *   리시버의 전력질주 속도 (m/s). 예: 8 ~ 10.
 *
 * @param {Vector2D}   params.receiverDir
 *   리시버의 침투 방향 단위벡터. 예: new Vector2D(-1, 0).
 *
 * @param {Vector2D[]} params.zoneCorners
 *   목표 구역(직사각형 또는 볼록 다각형)의 꼭짓점 배열.
 *   예: [topLeft, topRight, bottomRight, bottomLeft] (순서대로).
 *
 * @param {number}     params.ballDeceleration
 *   볼의 지면 마찰 감속도 (m/s², 양수). 권장: 5.
 *   ※ 실제 게임 물리는 PhysicsEngine.BALL_MU_GROUND = 2.6 m/s².
 *      현실적인 패스를 위해 2 ~ 7 범위에서 조정.
 *
 * @param {number}     params.ballTargetSpeed
 *   목표 구역 도착 시 볼의 희망 속도 (m/s). 권장: 1.5 ~ 2.5.
 *   낮을수록 구역 안에서 볼이 느리게 굴러가 "플레이 가능" 상태가 됨.
 *
 * @param {number}     params.maxKickSpeed
 *   선수가 낼 수 있는 최대 킥 속도 (m/s). 강킥 기준 ~30.
 *
 * @param {number}    [params.samples=24]
 *   구간 샘플링 횟수. 높을수록 정밀하지만 계산 비용 증가.
 *
 * @returns {{
 *   velocity:       Vector2D | null,
 *   interceptPoint: Vector2D | null,
 *   initSpeed:      number,
 *   ballTravelTime: number,
 *   receiverTime:   number,
 *   valid:          boolean,
 *   overpowered:    boolean,
 * }}
 *
 * 반환 값 설명
 * ├ velocity       : V_ball_init — 이 벡터를 ball.velocity에 그대로 설정
 * ├ interceptPoint : 최적 인터셉션 지점 (목표 구역 내)
 * ├ initSpeed      : 클램프 후 초기 속도 스칼라 (m/s)
 * ├ ballTravelTime : 볼이 인터셉션 지점에 도달하는 데 걸리는 시간 (초)
 * ├ receiverTime   : 리시버가 인터셉션 지점에 도달하는 데 걸리는 시간 (초)
 * ├ valid          : false면 패스 불가 (구역이 경로 밖 등)
 * └ overpowered    : true면 maxKickSpeed로 클램프됨 (볼이 더 멀리 갈 수 있음)
 */
export function computeSpacePassVelocity({
  passerPos,
  receiverPos,
  receiverMaxSpeed,
  receiverDir,
  zoneCorners,
  ballDeceleration,
  ballTargetSpeed,
  maxKickSpeed,
  samples = 24,
}) {
  const FAIL = {
    velocity: null, interceptPoint: null,
    initSpeed: 0, ballTravelTime: 0, receiverTime: 0,
    valid: false, overpowered: false,
  };

  // ── 1단계: 리시버 이동 경로 → 목표 구역 교차 구간 탐색 ────────────────────
  //
  // 이동 경로: Path(t) = receiverPos + t · D     [t 단위: 초]
  // D = receiverDir · receiverMaxSpeed            [m/s]
  //
  // → t 값이 초 단위이므로, 교차 t_start~t_end 는 곧 리시버의 도착 시간 범위.

  // Vector2D.scale() : 스칼라 곱
  const D = receiverDir.scale(receiverMaxSpeed);

  const intersectTs = [];
  for (let i = 0; i < zoneCorners.length; i++) {
    const A = zoneCorners[i];
    const B = zoneCorners[(i + 1) % zoneCorners.length];
    const t = raySegmentIntersectT(receiverPos, D, A, B);
    if (t !== null) intersectTs.push(t);
  }

  let tStart, tEnd;
  if (intersectTs.length >= 2) {
    // 정상 케이스: 구역에 진입·퇴장하는 두 교차점
    tStart = Math.min(...intersectTs);
    tEnd   = Math.max(...intersectTs);
  } else if (intersectTs.length === 1 && pointInPolygon(receiverPos, zoneCorners)) {
    // 리시버가 이미 구역 내부: 현재 위치(t=0)에서 퇴장 지점까지
    tStart = 0;
    tEnd   = intersectTs[0];
  } else {
    return FAIL; // 리시버 경로가 구역과 교차하지 않음
  }

  if (tEnd - tStart < 1e-6) return FAIL; // 유효 구간 없음

  // ── 2단계: 구간 샘플링 → 피트니스 점수 최대화 ────────────────────────────
  //
  // 후보 지점 P_cand = receiverPos + t_cand · D  (t_cand ∈ [tStart, tEnd])
  //
  // ■ 리시버 도착 시간: T_r = t_cand          (경로 파라미터 = 초 단위)
  // ■ 패스 거리:        d   = |P_cand − passerPos|
  // ■ 초기 볼 속도:     S₀  = √(v_f² + 2·A·d)    (등감속 역방향 계산)
  // ■ 볼 이동 시간:     T_b = 2·d / (S₀ + v_f)   (사다리꼴 = 등감속 정확)
  // ■ 피트니스 점수:    −(T_r − T_b)²             (T_b ≤ T_r 조건 위반 시 큰 페널티)

  const BIG_PENALTY = -1e9;
  let bestScore      = -Infinity;
  let bestT          = tStart;
  let bestInitSpd    = 0;
  let bestTb         = 0;

  for (let i = 0; i <= samples; i++) {
    const t_cand = tStart + (tEnd - tStart) * (i / samples);

    // Vector2D.add(), Vector2D.scale() : P_cand = receiverPos + t_cand · D
    const P_cand = receiverPos.add(D.scale(t_cand));

    const T_r = t_cand; // 리시버 도착 시간 (초)

    // Vector2D.sub(), Vector2D.length() : 패스 거리
    const d = P_cand.sub(passerPos).length();
    if (d < 0.5) continue; // 패서와 목표가 동일 위치에 가까움

    // ■ 필요 초기 볼 속도 (등감속 공식)
    //   v_f² = v₀² − 2·A·d  →  v₀² = v_f² + 2·A·d
    const v0sq = ballTargetSpeed * ballTargetSpeed + 2 * ballDeceleration * d;
    if (v0sq <= 0) continue; // 이론상 불가

    const S0 = Math.sqrt(v0sq);

    // ■ 볼 이동 시간 (사다리꼴 적분 — 등감속에서 정확한 값)
    //   T_b = 2d / (v₀ + v_f)
    const T_b = (2 * d) / (S0 + ballTargetSpeed);

    // ■ 피트니스 점수
    let score;
    if (T_b > T_r + 1e-6) {
      // 볼이 늦게 도착: 리시버가 이미 지나쳐 버림 → 큰 페널티
      score = BIG_PENALTY - (T_b - T_r) * 1000;
    } else {
      // T_b ≤ T_r: 볼이 먼저 도착. 차이가 작을수록(0에 가까울수록) 최적.
      // Score = −(T_r − T_b)²
      const delta = T_r - T_b;
      score = -(delta * delta);
    }

    if (score > bestScore) {
      bestScore  = score;
      bestT      = t_cand;
      bestInitSpd = S0;
      bestTb     = T_b;
    }
  }

  if (bestScore < BIG_PENALTY / 2) return FAIL; // 유효한 후보 없음

  // ── 3단계: 최적 인터셉션 지점 → 초기 속도 벡터 계산 ─────────────────────

  // Vector2D.add(), Vector2D.scale()
  const P_optimal = receiverPos.add(D.scale(bestT));

  // 최대 킥 속도 초과 처리
  const overpowered  = bestInitSpd > maxKickSpeed;
  const clampedSpeed = overpowered ? maxKickSpeed : bestInitSpd;

  // 패스 방향 단위벡터: V_pass_dir = (P_optimal − passerPos).normalize()
  // Vector2D.sub(), Vector2D.normalize()
  const passDir = P_optimal.sub(passerPos).normalize();

  // 최종 초기 속도 벡터: V_ball_init = clampedSpeed · V_pass_dir
  // Vector2D.scale()
  const velocity = passDir.scale(clampedSpeed);

  return {
    velocity,                  // Vector2D — ball.velocity에 설정할 값
    interceptPoint: P_optimal, // Vector2D — 최적 인터셉션 지점
    initSpeed: clampedSpeed,   // number   — 클램프 후 초기 속도 (m/s)
    ballTravelTime: bestTb,    // number   — 볼 도달 시간 (초)
    receiverTime: bestT,       // number   — 리시버 도달 시간 (초)
    valid: true,
    overpowered,               // boolean  — true면 볼이 목표 너머로 갈 수 있음
  };
}
