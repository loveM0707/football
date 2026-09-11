/**
 * FieldGeometry - 필드·골대 기하 공통 모듈
 *
 * 필드 치수와 골대 위치를 한 곳에서만 정의한다.
 * 기존에 20개 파일에 리터럴(1050, 680, 303.4, 376.6 등)로 분산되어 있던
 * 값을 이 모듈로 통합 — 골대 규격 변경 시 여기만 수정하면 전체에 반영된다.
 *
 * 좌표 규약 (SVG):
 *   - 필드 1050×680 (10 SVG = 1m, 105m×68m), 왼쪽 골 x=0, 오른쪽 골 x=1050
 *   - 단일 골 시나리오는 오른쪽 골을 공격하므로 GOAL_X = GOAL_R_X 별칭 제공
 *   - Y_MIN/Y_MAX는 실제 플레이 여유 경계(라인 아웃 판정은 FIELD_TOP/BOTTOM)
 */

// ── 필드 치수 (SVG 단위) ──
export const FIELD_WIDTH = 1050;
export const FIELD_HEIGHT = 680;
export const FIELD_TOP = 0;
export const FIELD_BOTTOM = 680;

// ── 중앙선 ──
export const CENTER_X = 525;
export const CENTER_Y = 340;
export const HALF_LINE_X = 525;
export const HALF_X = 525; // HALF_LINE_X 별칭 (패스 시나리오 호환)

// ── 플레이 가능 범위 (라인 여유 포함 경계) ──
export const Y_MIN = 45;
export const Y_MAX = 635;
export const FIELD_MIN_X = 25;
export const FIELD_MAX_X = 1025;

// ── 골대 ──
export const GOAL_R_X = 1050; // 오른쪽 골라인
export const GOAL_L_X = 0;    // 왼쪽 골라인
export const GOAL_X = 1050;   // GOAL_R_X 별칭 (단일 골 시나리오 호환)
export const GOAL_TOP_Y = 303.4;
export const GOAL_BOTTOM_Y = 376.6;
export const GOAL_BOT_Y = 376.6; // GOAL_BOTTOM_Y 별칭
export const GOAL_CENTER_Y = 340;
export const GOAL_WIDTH = GOAL_BOTTOM_Y - GOAL_TOP_Y; // 73.2

// ── 골대 물리 ──
export const CROSSBAR_HEIGHT = 2.44; // 크로스바 높이 (m)
export const HEIGHT_SCALE = 3;       // Ball 높이 스케일과 m 단위 변환 계수
export const GOAL_DEPTH = 24;        // 골대 깊이 (SVG)

// ── 동결 객체 (11v11 매치엔진용 묶음 참조) ──
export const FIELD = Object.freeze({
    WIDTH: FIELD_WIDTH,
    HEIGHT: FIELD_HEIGHT,
    TOP: FIELD_TOP,
    BOTTOM: FIELD_BOTTOM,
    CENTER_X,
    CENTER_Y,
    HALF_LINE_X,
    Y_MIN,
    Y_MAX,
    MIN_X: FIELD_MIN_X,
    MAX_X: FIELD_MAX_X,
});

export const GOAL = Object.freeze({
    R_X: GOAL_R_X,
    L_X: GOAL_L_X,
    TOP_Y: GOAL_TOP_Y,
    BOTTOM_Y: GOAL_BOTTOM_Y,
    CENTER_Y: GOAL_CENTER_Y,
    WIDTH: GOAL_WIDTH,
    CROSSBAR_HEIGHT,
    HEIGHT_SCALE,
    DEPTH: GOAL_DEPTH,
});
