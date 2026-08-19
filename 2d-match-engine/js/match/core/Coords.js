import { Vector2D } from '../../entities/Vector2D.js';
import { Pitch } from '../../entities/Pitch.js';

/**
 * 좌표계 변환 유틸리티.
 *
 * ── 월드 좌표 (world) ─────────────────────────────────────────
 *   x: 0 = 왼쪽 골라인, 105 = 오른쪽 골라인
 *   y: 0 = 위쪽 터치라인, 68 = 아래쪽 터치라인
 *   렌더러·물리·규칙 판정은 모두 월드 좌표를 사용한다.
 *
 * ── 팀 상대 좌표 (team-relative) ──────────────────────────────
 *   x: 0 = 자기 골라인, 105 = 상대 골라인  (항상 "전진 = +x")
 *   y: 0 = 팀 기준 왼쪽, 68 = 팀 기준 오른쪽
 *   전술 계산은 전부 이 좌표계에서 수행한다.
 *
 * 변환은 피치 중심을 기준으로 한 180° 회전이다 (x·y 동시 반전).
 * x만 뒤집으면 좌우 손잡이(handedness)가 바뀌어 "왼쪽 윙어"가
 * 반대편으로 가는 종류의 버그가 생기므로 y도 함께 반전한다.
 *
 * 이 모듈을 거치지 않고 월드 좌표와 팀 상대 좌표를 섞어 쓰는 것은 금지한다.
 */

/** 팀 상대 x → 월드 x (변환이 대칭이므로 역변환도 동일 식) */
export function toTeamX(worldX, dir) {
  return dir === 1 ? worldX : Pitch.LENGTH - worldX;
}

/** 월드 y → 팀 상대 y (대칭이므로 역변환도 동일 식) */
export function toTeamY(worldY, dir) {
  return dir === 1 ? worldY : Pitch.WIDTH - worldY;
}

/** 팀 상대 x → 월드 x */
export function fromTeamX(teamX, dir) {
  return dir === 1 ? teamX : Pitch.LENGTH - teamX;
}

/** 팀 상대 y → 월드 y */
export function fromTeamY(teamY, dir) {
  return dir === 1 ? teamY : Pitch.WIDTH - teamY;
}

/** 월드 위치 → 팀 상대 위치 */
export function toTeamSpace(pos, dir) {
  return new Vector2D(toTeamX(pos.x, dir), toTeamY(pos.y, dir));
}

/** 팀 상대 위치 → 월드 위치 */
export function fromTeamSpace(pos, dir) {
  return new Vector2D(fromTeamX(pos.x, dir), fromTeamY(pos.y, dir));
}

/** 월드 벡터(변위·속도) → 팀 상대 벡터. 위치가 아닌 방향이므로 평행이동 없이 부호만 반전 */
export function toTeamVector(vec, dir) {
  return dir === 1 ? vec.clone() : new Vector2D(-vec.x, -vec.y);
}

/** 팀 상대 벡터 → 월드 벡터 */
export function fromTeamVector(vec, dir) {
  return dir === 1 ? vec.clone() : new Vector2D(-vec.x, -vec.y);
}

/**
 * 팀 상대 정규화 전진도. 0 = 자기 골라인, 1 = 상대 골라인.
 * 전술 파라미터(라인 높이·블록 위치)는 대부분 이 값으로 표현한다.
 */
export function teamNX(worldX, dir) {
  return toTeamX(worldX, dir) / Pitch.LENGTH;
}

/** 정규화 전진도 → 월드 x */
export function fromTeamNX(nx, dir) {
  return fromTeamX(nx * Pitch.LENGTH, dir);
}

/** 팀 상대 정규화 횡방향. 0 = 팀 기준 왼쪽 터치라인, 1 = 오른쪽 터치라인 */
export function teamNY(worldY, dir) {
  return toTeamY(worldY, dir) / Pitch.WIDTH;
}

/** 정규화 횡방향 → 월드 y */
export function fromTeamNY(ny, dir) {
  return fromTeamY(ny * Pitch.WIDTH, dir);
}

/** 해당 팀이 공격하는 골문 중심 (월드 좌표) */
export function attackingGoal(dir) {
  return Pitch.goalCenter(dir === 1 ? 'right' : 'left');
}

/** 해당 팀이 지키는 골문 중심 (월드 좌표) */
export function defendingGoal(dir) {
  return Pitch.goalCenter(dir === 1 ? 'left' : 'right');
}

/** 해당 팀이 지키는 골라인의 월드 x 좌표 */
export function ownGoalLineX(dir) {
  return dir === 1 ? 0 : Pitch.LENGTH;
}

/** 해당 팀이 공격하는 골라인의 월드 x 좌표 */
export function opponentGoalLineX(dir) {
  return dir === 1 ? Pitch.LENGTH : 0;
}

/** 자기 진영 페널티 박스 사각형 */
export function ownPenaltyBox(dir) {
  return Pitch.penaltyBoxRect(dir === 1 ? 'left' : 'right');
}

/** 상대 진영 페널티 박스 사각형 */
export function opponentPenaltyBox(dir) {
  return Pitch.penaltyBoxRect(dir === 1 ? 'right' : 'left');
}

/** 사각형 내부 판정 (경계 포함) */
export function inRect(pos, rect) {
  return pos.x >= rect.x && pos.x <= rect.x + rect.w &&
         pos.y >= rect.y && pos.y <= rect.y + rect.h;
}

/** 값을 [min, max] 범위로 자른다 */
export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/** 0~1 범위로 자른다 */
export function clamp01(v) {
  return clamp(v, 0, 1);
}

/** 선형 보간 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * 구간 [edge0, edge1]을 0~1로 매핑하되 양 끝을 부드럽게 만든다.
 * 임계값 근처에서 동작이 딱딱 끊기는 것을 막는 데 사용한다.
 */
export function smoothstep(edge0, edge1, x) {
  if (edge1 - edge0 === 0) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * 각도 차이를 [-π, π] 범위로 정규화한다.
 * 선회 비용·신체 방향 판정에서 각도가 한 바퀴 도는 문제를 막는다.
 */
export function angleDiff(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
