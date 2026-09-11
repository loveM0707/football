/**
 * SetPiecePlacement - 세트피스 배치 공통 모듈
 *
 * 공 위치와 선수 위치 목표를 계산한다 (순수 계산 — 이동은 수행하지 않음).
 * 시나리오는 이 모듈이 준 목표를 PlayerMovement로 실행하기만 한다.
 *
 * 포함 범위:
 *   - 공 위치: 종류별 spot 계산 (킥오프/스로인/골킥/코너/프리킥/페널티)
 *   - 9. 세트피스 수비 배치: 벽·골키퍼·마크·존
 *   - 10. 세트피스 공격 배치: 키커·숏옵션·ニア/파포스트·박스외곽
 *   - 상대 선수 제한: 최소거리·박스밖 대기 목표 보정
 *
 * N명 인원에 대해 동작하므로 11v11에서도 그대로 재사용 가능하다.
 */
import { SET_PIECE, BOX, PITCH, goalsForDir } from './SetPieceType.js';
import { CENTER_Y } from './FieldGeometry.js';

const DEFAULTS = {
    wallMax: 4,         // 벽 최대 인원
    markDist: 22,       // 대인 마크 간격
    shortDist: 90,      // 숏옵션 거리
    edgeMargin: 40,     // 박스 외곽 대기 여유
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/** 박스 안 판정 함수 생성 (수비 측 기준) */
function boxTest(defGoalX, dir) {
    const xMin = dir > 0 ? defGoalX : defGoalX - BOX.PEN_DEPTH;
    const xMax = dir > 0 ? defGoalX + BOX.PEN_DEPTH : defGoalX;
    return (x, y) => x >= xMin && x <= xMax && y >= BOX.PEN_TOP && y <= BOX.PEN_BOT;
}

export class SetPiecePlacement {
    constructor(options = {}) {
        this.o = { ...DEFAULTS, ...options };
    }

    /**
     * 공 spot을 계산한다.
     * @param {string} type SET_PIECE 종류
     * @param {object} ctx { dir, exitX, exitY, exitSide, foulX, foulY, direct }
     *   dir: 공격 방향 (+1 = 오른쪽 공격)
     *   exitX/exitY: 볼이 나간 지점 (스로인·코너·골킥 판정용)
     *   exitSide: 'top' | 'bottom' | 'left' | 'right' (나간 라인)
     *   foulX/foulY: 파울 지점 (프리킥용)
     * @returns {{ x, y }}
     */
    ballSpot(type, ctx = {}) {
        const dir = ctx.dir ?? 1;
        const { attackGoalX, ownGoalX } = goalsForDir(dir);

        switch (type) {
            case SET_PIECE.KICKOFF:
                return { x: PITCH.CX, y: PITCH.CY };

            case SET_PIECE.THROW_IN: {
                // 터치라인을 나간 지점 — 필드 안쪽으로 8만큼 당겨 잡기 쉽게
                const side = ctx.exitSide ?? ((ctx.exitY ?? PITCH.CY) < PITCH.CY ? 'top' : 'bottom');
                const x = clamp(ctx.exitX ?? PITCH.CX, 25, PITCH.W - 25);
                const y = side === 'top' ? 8 : PITCH.H - 8;
                return { x, y };
            }

            case SET_PIECE.GOAL_KICK: {
                // 골박스 안에서 출구와 가장 가까운 지점
                const gx = clamp(ctx.exitX ?? ownGoalX + dir * -1 * 30, 0, PITCH.W);
                const sixMin = dir > 0 ? ownGoalX : ownGoalX - BOX.SIX_DEPTH;
                const sixMax = dir > 0 ? ownGoalX + BOX.SIX_DEPTH : ownGoalX;
                const x = clamp(gx, Math.min(sixMin, sixMax) + 8, Math.max(sixMin, sixMax) - 8);
                const y = clamp(ctx.exitY ?? CENTER_Y, CENTER_Y - BOX.SIX_HALF + 8, CENTER_Y + BOX.SIX_HALF - 8);
                return { x, y };
            }

            case SET_PIECE.CORNER: {
                // 출구와 가까운 쪽 코너아크
                const top = (ctx.exitY ?? PITCH.CY) < PITCH.CY;
                const atkRight = attackGoalX > PITCH.CX;
                const x = atkRight ? PITCH.W - 6 : 6;
                const y = top ? 6 : PITCH.H - 6;
                return { x, y };
            }

            case SET_PIECE.FREE_KICK: {
                const x = clamp(ctx.foulX ?? PITCH.CX, 25, PITCH.W - 25);
                const y = clamp(ctx.foulY ?? PITCH.CY, 15, PITCH.H - 15);
                return { x, y };
            }

            case SET_PIECE.PENALTY: {
                const x = attackGoalX - dir * BOX.PEN_MARK_DIST;
                return { x, y: CENTER_Y };
            }

            default:
                return { x: PITCH.CX, y: PITCH.CY };
        }
    }

    /**
     * 10. 공격 배치 목표를 계산한다.
     * @param {string} type 종류
     * @param {Array} attackers 공격 선수 배열 (Player, 키커 제외 N명 — 순서 무관)
     * @param {object} ctx { dir, spot, kicker }
     * @returns {Array} [{ player, x, y, role }]
     */
    attackShape(type, attackers, ctx = {}) {
        const dir = ctx.dir ?? 1;
        const spot = ctx.spot;
        const { attackGoalX } = goalsForDir(dir);
        const out = [];
        attackers.forEach((p, i) => {
            out.push({ player: p, x: p.x, y: p.y, role: 'attack-shape' });
            void i;
        });

        if (type === SET_PIECE.CORNER) {
            // 니어·파포스트 + 숏옵션 + 박스외곽 — 인원수대로 분배
            const nearY = spot.y < PITCH.CY ? BOX.PEN_TOP + 30 : BOX.PEN_BOT - 30;
            const farY = spot.y < PITCH.CY ? BOX.PEN_BOT - 40 : BOX.PEN_TOP + 40;
            const slots = [
                { x: attackGoalX - dir * 70, y: nearY, role: 'near-post' },
                { x: attackGoalX - dir * 90, y: CENTER_Y, role: 'penalty-spot' },
                { x: attackGoalX - dir * 70, y: farY, role: 'far-post' },
                { x: spot.x - dir * this.o.shortDist, y: spot.y + (spot.y < PITCH.CY ? 40 : -40), role: 'short-option' },
            ];
            out.forEach((e, k) => {
                if (k < slots.length) {
                    e.x = clamp(slots[k].x, 25, PITCH.W - 25);
                    e.y = clamp(slots[k].y, 15, PITCH.H - 15);
                    e.role = slots[k].role;
                } else {
                    // 나머지는 박스 외곽 호버 (세컨드볼 대비)
                    e.x = clamp(attackGoalX - dir * (BOX.PEN_DEPTH + this.o.edgeMargin + (k % 3) * 30), 25, PITCH.W - 25);
                    e.y = clamp(CENTER_Y + (k % 2 === 0 ? -1 : 1) * (60 + k * 12), 15, PITCH.H - 15);
                    e.role = 'edge';
                }
            });
        } else if (type === SET_PIECE.FREE_KICK) {
            // 박스 근처면 침투 + 외곽, 중원이면 전개형
            const nearBox = Math.abs(attackGoalX - spot.x) < 320;
            out.forEach((e, k) => {
                if (nearBox && k < 2) {
                    e.x = clamp(attackGoalX - dir * (60 + k * 40), 25, PITCH.W - 25);
                    e.y = clamp(CENTER_Y + (k === 0 ? -35 : 35), 15, PITCH.H - 15);
                    e.role = 'box-run';
                } else if (k === out.length - 1) {
                    e.x = clamp(spot.x - dir * this.o.shortDist, 25, PITCH.W - 25);
                    e.y = clamp(spot.y, 15, PITCH.H - 15);
                    e.role = 'short-option';
                } else {
                    e.x = clamp(spot.x + dir * (80 + k * 25), 25, PITCH.W - 25);
                    e.y = clamp(spot.y + (k % 2 === 0 ? -70 : 70), 15, PITCH.H - 15);
                    e.role = 'support';
                }
            });
        } else if (type === SET_PIECE.THROW_IN) {
            out.forEach((e, k) => {
                if (k === 0) {
                    e.x = clamp(spot.x + dir * 60, 25, PITCH.W - 25);
                    e.y = clamp(spot.y + (spot.y < PITCH.CY ? 50 : -50), 15, PITCH.H - 15);
                    e.role = 'throw-target';
                } else {
                    e.x = clamp(spot.x + dir * (60 + k * 40), 25, PITCH.W - 25);
                    e.y = clamp(PITCH.CY + (k % 2 === 0 ? -90 : 90), 15, PITCH.H - 15);
                    e.role = 'support';
                }
            });
        } else {
            // 킥오프·골킥·페널티 — 하프Shape 유지 (자기 진영 전개)
            out.forEach((e, k) => {
                e.x = clamp(spot.x - dir * (40 + k * 35), 25, PITCH.W - 25);
                e.y = clamp(PITCH.CY + (k % 2 === 0 ? -1 : 1) * (40 + Math.floor(k / 2) * 45), 15, PITCH.H - 15);
                e.role = 'shape';
            });
        }
        return out;
    }

    /**
     * 9. 수비 배치 목표를 계산한다.
     * @param {string} type 종류
     * @param {Array} defenders 수비 선수 배열 (Player — 골키퍼 제외 권장)
     * @param {object} ctx { dir, spot, attackGoalX(수비 대상 골), gk }
     * @returns {Array} [{ player, x, y, role }]
     */
    defenseShape(type, defenders, ctx = {}) {
        const dir = ctx.dir ?? 1;
        const spot = ctx.spot;
        // 수비 대상 골 = 공격 골과 동일 (공격이 노리는 골을 지킨다)
        const { attackGoalX } = goalsForDir(dir);
        const out = defenders.map((p) => ({ player: p, x: p.x, y: p.y, role: 'def-shape' }));

        if (type === SET_PIECE.FREE_KICK || type === SET_PIECE.CORNER) {
            // 벽 — 볼과 골 중심을 잇는 선 위, 볼에서 9.15m
            const gx = attackGoalX, gy = CENTER_Y;
            const dx = gx - spot.x, dy = gy - spot.y;
            const d = Math.max(1, Math.hypot(dx, dy));
            const nx = dx / d, ny = dy / d;
            const wallN = Math.min(this.o.wallMax, defenders.length);
            const wallX = spot.x + nx * 91.5;
            const wallY = spot.y + ny * 91.5;
            // 벽 법선 방향으로 일렬 배치
            const px = -ny, py = nx;
            for (let k = 0; k < wallN; k++) {
                const off = (k - (wallN - 1) / 2) * 20;
                out[k].x = clamp(wallX + px * off, 25, PITCH.W - 25);
                out[k].y = clamp(wallY + py * off, 15, PITCH.H - 15);
                out[k].role = 'wall';
            }
            // 나머지는 존+마크 혼합 (박스 앞 호)
            out.slice(wallN).forEach((e, k) => {
                e.x = clamp(attackGoalX - dir * (50 + (k % 3) * 35), 25, PITCH.W - 25);
                e.y = clamp(CENTER_Y + (k % 2 === 0 ? -1 : 1) * (45 + k * 18), BOX.PEN_TOP, BOX.PEN_BOT);
                e.role = k % 2 === 0 ? 'zone' : 'mark';
            });
        } else if (type === SET_PIECE.PENALTY) {
            // 박스 밖 아크 대기 (키커·GK 외 전원)
            out.forEach((e, k) => {
                e.x = clamp(spot.x - dir * (BOX.ARC_R + 20 + (k % 2) * 25), 25, PITCH.W - 25);
                e.y = clamp(CENTER_Y + (k % 2 === 0 ? -1 : 1) * (50 + k * 15), BOX.PEN_TOP - 20, BOX.PEN_BOT + 20);
                e.role = 'arc-wait';
            });
        } else {
            // 킥오프·스로인·골킥 — 기본 Shape + 최소거리만 Controller가 강제
            out.forEach((e, k) => {
                e.x = clamp(spot.x - dir * -(60 + k * 30), 25, PITCH.W - 25);
                e.y = clamp(PITCH.CY + (k % 2 === 0 ? -1 : 1) * (60 + Math.floor(k / 2) * 40), 15, PITCH.H - 15);
                e.role = 'shape';
            });
        }
        return out;
    }

    /**
     * 상대 제한을 만족하도록 목표를 밀어낸다 (최소거리·박스밖 대기).
     * @param {Array} entries [{ player, x, y, role }]
     * @param {object} spot 공 위치
     * @param {object} rule { minDist, boxBlock, inBox }
     */
    enforceRestriction(entries, spot, rule = {}) {
        const minDist = rule.minDist ?? 0;
        for (const e of entries) {
            const d = Math.hypot(e.x - spot.x, e.y - spot.y);
            if (d < minDist) {
                // 볼에서 방사 방향으로 밀어낸다
                const dx = e.x - spot.x, dy = e.y - spot.y;
                const m = Math.max(1, Math.hypot(dx, dy));
                e.x = clamp(spot.x + (dx / m) * minDist, 25, PITCH.W - 25);
                e.y = clamp(spot.y + (dy / m) * minDist, 15, PITCH.H - 15);
            }
            if (rule.boxBlock && rule.inBox && rule.inBox(e.x, e.y)) {
                // 박스 밖으로 — 가장 가까운 박스 변으로 이동
                e.x = clamp(rule.inBox.exitX ? rule.inBox.exitX(e.x) : e.x, 25, PITCH.W - 25);
            }
        }
        return entries;
    }

    /** 수비 측 박스 판정 + 출구 X 계산기 (enforceRestriction용) */
    boxGuard(defGoalX, dir) {
        const inBox = boxTest(defGoalX, dir);
        const exitX = (x) => (dir > 0 ? defGoalX + BOX.PEN_DEPTH + 15 : defGoalX - BOX.PEN_DEPTH - 15);
        return { inBox, exitX };
    }
}
