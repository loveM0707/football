/**
 * TeamShape - 팀 형태 기하 공통 모듈
 *
 * N명 인원에 대해 포메이션 앵커(목표 골격)를 계산한다. 순수 계산 모듈이다.
 * 4v4 기준으로 조정된 기본값이며, 인원·폭·깊이는 옵션으로 확장된다
 * (5v5→11v11은 같은 함수에 n만 바꿔 호출한다 — 4v4 전용 분기 없음).
 *
 * 담당 (구현 대상 1~5):
 *   1. 팀 간격 유지 — 앵커 간 최소 거리 이완으로 보장
 *   2. 공격 시 폭 유지 — 라인별 측면 분산
 *   3. 공격 시 깊이 유지 — 라인 간격 + 전방 배치
 *   4. 수비 시 폭 축소 — 중앙 압축
 *   5. 수비 시 깊이 유지 — 골사이드 콤팩트 라인
 *
 * 앵커는 볼 위치를 따라 이동한다 (볼 지향 쉬프트).
 * 실제 이동은 호출자가 PlayerMovement로 수행한다.
 */
import { CENTER_Y } from './FieldGeometry.js';

const DEFAULTS = {
    dir: 1,                 // 공격 방향 (+1 = 오른쪽 공격)
    attackGoalX: 1050,
    ownGoalX: 0,
    centerY: CENTER_Y,
    minX: 25,
    maxX: 1025,
    yMin: 45,
    yMax: 635,
    attackWidth: 400,       // 4v4 공격 폭 (인원 증가 시 아래에서 확장)
    defenseWidth: 220,      // 수비 폭 (압축)
    attackLineGap: 110,     // 공격 라인 간격
    defenseLineGap: 70,     // 수비 라인 간격
    widthPerPlayer: 95,     // 인원 증가 시 폭 확장 단가
    minSpacing: 70,         // 앵커 최소 간격
    ballShiftX: 0.35,       // 볼 지향 쉬프트 (x)
    ballShiftY: 0.25,       // 볼 지향 쉬프트 (y)
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export class TeamShape {
    constructor(options = {}) {
        this.o = { ...DEFAULTS, ...options };
    }

    /**
     * @param {number} n 인원수
     * @param {object} ctx
     *   phase {'attack'|'defense'|'loose'}, ballX, ballY,
     *   dir, attackGoalX, ownGoalX
     * @returns {Array} [{ x, y, line, lane }] — 앞 라인부터 순서대로 n개
     */
    formationAnchors(n, ctx = {}) {
        const o = this.o;
        const phase = ctx.phase ?? 'loose';
        const dir = ctx.dir ?? o.dir;
        const ballX = ctx.ballX ?? 525;
        const ballY = ctx.ballY ?? o.centerY;
        const attackGoalX = ctx.attackGoalX ?? o.attackGoalX;
        const ownGoalX = ctx.ownGoalX ?? o.ownGoalX;
        if (n <= 0) return [];

        // 라인 수 — 인원에 비례 (4v4=2라인, 11v11=4라인)
        const lines = n <= 2 ? 1 : n <= 4 ? 2 : n <= 6 ? 3 : 4;
        // 라인별 인원 — 앞 라인부터 균등 분배
        const perLine = [];
        let rest = n;
        for (let l = 0; l < lines; l++) {
            const share = Math.ceil(rest / (lines - l));
            perLine.push(share);
            rest -= share;
        }

        // 폭 — 수비는 압축, 공격은 인원 비례 확장
        const baseWidth = phase === 'defense' ? o.defenseWidth
            : o.attackWidth + Math.max(0, n - 4) * o.widthPerPlayer;
        const lineGap = phase === 'defense' ? o.defenseLineGap : o.attackLineGap;

        // 기준선 — 공격은 볼 전방, 수비는 볼 골사이드
        let frontX;
        if (phase === 'attack') {
            frontX = clamp(ballX + dir * 120, o.minX, attackGoalX - dir * 60);
        } else if (phase === 'defense') {
            frontX = clamp(ballX - dir * 80, ownGoalX + dir * 40, o.maxX);
        } else {
            frontX = clamp(ballX, o.minX, o.maxX);
        }

        const anchors = [];
        for (let l = 0; l < lines; l++) {
            const lx = frontX - dir * l * lineGap;
            const count = perLine[l];
            for (let k = 0; k < count; k++) {
                // 라인 내 측면 분산 — 1명이면 중앙, 그 외 균등
                const t = count === 1 ? 0.5 : k / (count - 1);
                let ay = o.centerY + (t - 0.5) * baseWidth;
                // 볼 지향 쉬프트 — 형태를 유지하며 볼 쪽으로 이동
                const ax = clamp(lx + (ballX - lx) * o.ballShiftX, o.minX, o.maxX);
                ay = clamp(ay + (ballY - o.centerY) * o.ballShiftY, o.yMin, o.yMax);
                anchors.push({ x: ax, y: ay, line: l, lane: t });
            }
        }

        // 1. 간격 유지 — 최소 간격 이완 2회 (앵커 겹침 방지)
        this._relax(anchors);
        return anchors;
    }

    /** 앵커 간 최소 간격을 강제한다 (단순 반발 이완). */
    _relax(anchors) {
        const minD = this.o.minSpacing;
        for (let iter = 0; iter < 2; iter++) {
            for (let i = 0; i < anchors.length; i++) {
                for (let j = i + 1; j < anchors.length; j++) {
                    const a = anchors[i], b = anchors[j];
                    const dx = b.x - a.x, dy = b.y - a.y;
                    const d = Math.hypot(dx, dy);
                    if (d > 0.01 && d < minD) {
                        const push = (minD - d) / 2;
                        const nx = dx / d, ny = dy / d;
                        a.x = clamp(a.x - nx * push, this.o.minX, this.o.maxX);
                        a.y = clamp(a.y - ny * push, this.o.yMin, this.o.yMax);
                        b.x = clamp(b.x + nx * push, this.o.minX, this.o.maxX);
                        b.y = clamp(b.y + ny * push, this.o.yMin, this.o.yMax);
                    }
                }
            }
        }
    }
}
