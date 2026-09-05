/**
 * SetPieceType - 세트피스 종류·규칙표 공통 모듈
 *
 * 10개 구현 대상의 종류와 방식별 규칙을 한 곳에서 정의한다.
 *   1 킥오프 · 2 스로인 · 3 골킥 · 4 코너킥 · 5 프리킥
 *   6 페널티킥 · 7 직접 프리킥 · 8 간접 프리킥
 *   (9 수비 배치 · 10 공격 배치는 SetPiecePlacement가 담당)
 *
 * 직접/간접은 별도 타입이 아니라 프리킥의 방식(direct 플래그)이다.
 * 필드 수치는 FieldGeometry에서 가져오고, 여기서는 규칙만 정의한다
 * (코드 중복 제거 — 리터럴 분산 금지).
 *
 * 거리 단위: SVG (10 = 1m)
 */
import {
    FIELD_WIDTH, FIELD_HEIGHT, CENTER_X, CENTER_Y,
    GOAL_L_X, GOAL_R_X,
} from './FieldGeometry.js';

// 박스·마크 치수 (FieldGeometry 단일 정의 파생 — 실제 규격)
export const BOX = Object.freeze({
    PEN_DEPTH: 165,                 // 페널티 박스 깊이 (16.5m)
    PEN_HALF: 201.6,                // 박스 반폭 (403.2 / 2)
    PEN_TOP: CENTER_Y - 201.6,      // 138.4
    PEN_BOT: CENTER_Y + 201.6,      // 541.6
    SIX_DEPTH: 55,                  // 골박스 깊이 (5.5m)
    SIX_HALF: 91.6,                 // 골박스 반폭 (183.2 / 2)
    PEN_MARK_DIST: 110,             // 페널티마크 거리 (11m)
    ARC_R: 91.5,                    // 페널티아크·센터서클 반경 (9.15m)
    CORNER_R: 10,                   // 코너아크 반경 (1m)
});

// 재개 종류
export const SET_PIECE = Object.freeze({
    KICKOFF: 'kickoff',     // 1. 킥오프
    THROW_IN: 'throw-in',   // 2. 스로인
    GOAL_KICK: 'goal-kick', // 3. 골킥
    CORNER: 'corner',       // 4. 코너킥
    FREE_KICK: 'free-kick', // 5/7/8. 프리킥 (direct 플래그로 직접·간접 구분)
    PENALTY: 'penalty',     // 6. 페널티킥
});

// 종류별 규칙표 — 공 위치·상대 제한·인플레이·직접 득점 가능 여부
// (선수 위치 계산은 SetPiecePlacement, 상태 전이는 BallInPlay·Controller가 담당)
export const SET_PIECE_RULE = Object.freeze({
    [SET_PIECE.KICKOFF]: Object.freeze({
        oppMinDist: 91.5,           // 상대는 센터서클 밖
        directGoal: false,          // 킥오프로 직접 득점 불가 (규칙 단순화)
        needsSecondTouchForGoal: true,
        kickerRetouchForbidden: true,
    }),
    [SET_PIECE.THROW_IN]: Object.freeze({
        oppMinDist: 20,             // 상대 2m 이상
        directGoal: false,          // 스로인 직접 득점 불가
        needsSecondTouchForGoal: true,
        kickerRetouchForbidden: true,
    }),
    [SET_PIECE.GOAL_KICK]: Object.freeze({
        oppMinDist: 0,              // 현대 규칙: 박스 안 허용 — 박스 밖 강제 대신 최소거리만
        oppOutsideBoxUntilKick: true, // 재개 전 박스 밖 대기 (클래식 운용, 옵션으로 해제 가능)
        directGoal: true,
        needsSecondTouchForGoal: false,
        kickerRetouchForbidden: true,
    }),
    [SET_PIECE.CORNER]: Object.freeze({
        oppMinDist: 91.5,           // 상대 9.15m 이상
        directGoal: true,           // 코너 직접 득점 가능 (올림픽 골)
        needsSecondTouchForGoal: false,
        kickerRetouchForbidden: true,
    }),
    [SET_PIECE.FREE_KICK]: Object.freeze({
        oppMinDist: 91.5,           // 상대 9.15m 이상 (벽)
        directGoal: null,           // 직접 여부에 따라 결정 (아래 참조)
        needsSecondTouchForGoal: null,
        kickerRetouchForbidden: true,
    }),
    [SET_PIECE.PENALTY]: Object.freeze({
        oppMinDist: 91.5,           // 마크에서 9.15m (아크) + 박스 밖
        oppOutsideBoxUntilKick: true,
        directGoal: true,
        needsSecondTouchForGoal: false,
        kickerRetouchForbidden: true,
    }),
});

/**
 * 프리킥 방식(7 직접 / 8 간접)에 따른 득점 규칙을 반환한다.
 * @param {boolean} direct 직접 프리킥이면 true
 * @returns {{ directGoal: boolean, needsSecondTouchForGoal: boolean }}
 */
export function freeKickGoalRule(direct) {
    if (direct) return { directGoal: true, needsSecondTouchForGoal: false };
    return { directGoal: false, needsSecondTouchForGoal: true };
}

/**
 * 공격 방향 기준 자기 진영·상대 진영 골라인을 반환한다.
 * @param {number} dir +1 = 오른쪽 공격, -1 = 왼쪽 공격
 */
export function goalsForDir(dir) {
    const attackGoalX = dir > 0 ? GOAL_R_X : GOAL_L_X;
    const ownGoalX = dir > 0 ? GOAL_L_X : GOAL_R_X;
    return { attackGoalX, ownGoalX };
}

/** 필드 폭·높이 재노출 (배치 모듈이 FieldGeometry 직접 참조 대신 사용 가능) */
export const PITCH = Object.freeze({
    W: FIELD_WIDTH, H: FIELD_HEIGHT, CX: CENTER_X, CY: CENTER_Y,
});
