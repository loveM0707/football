/**
 * DefensiveDecision - 수비 역할 분담 판단 공통 모듈
 *
 * 공·공격수·수비수 위치를 보고 "누가 압박하고 누가 커버할 것인가"를
 * 인원수 무관(NvM)하게 결정한다. 1v2는 물론 2v2·3v3·11v11에서도 같은
 * 입력({ ball, attackers, defenders })으로 호출한다.
 *
 * 파이프라인 (Perception → Situation → Decision → Intent):
 *   Perception  ball/attackers/defenders/goal 입력
 *   Situation   홀더 식별 + 위협 순위 (TeamSupport.passOptions 재사용)
 *   Decision    역할 슬롯 배정 (거리 탐욕 + stickiness로 진동 방지)
 *   Intent      목표점 + 권장 속도 (이동 실행은 호출자가 PlayerMovement로 수행)
 *
 * 역할 슬롯 (우선순위 순):
 *   1. press       1차 압박 — 볼에 가장 가까운 수비수 1명
 *   2. lane-block  패스 라인 차단 — 볼 없는 위협이 있으면 (없으면 cover)
 *   3. mark        위협 맨마킹 — 두 번째 위협이 있으면 (없으면 cover)
 *   4+ cover       2차 커버 — 볼→골선상 후방 보호
 *
 * 1v2(위협 없음)에서는 press + cover만 배정되므로 두 수비수가
 * 같은 행동을 하지 않는다. 누가 press인지는 매 호출마다 위치로
 * 재결정되므로 시나리오가 A/B를 지정할 필요가 없고, 공격수가
 * 압박을 벗기면 커버가 자동으로 1차 압박으로 전환된다.
 *
 * 순수 판단 모듈이다 — PlayerMovement를 직접 제어하지 않으므로
 * 호출자(리타겟 타이머·속도 실행은 각자 유지)와 조합한다.
 * 역할 어휘(DEFENSE_ROLE)는 CooperativeDefenseAI와 공유한다 (중복 정의 금지).
 * 위협 순위는 TeamSupport.passOptions를 재사용한다 (중복 구현 금지).
 */
import { PlayerMovement } from './PlayerMovement.js';
import { DEFENSE_ROLE } from './CooperativeDefenseAI.js';
import { TeamSupport } from './TeamSupport.js';

const SPEEDS = PlayerMovement.SPEEDS; // [50, 75, 100, 125, 150]

const DEFAULTS = {
    dir: 1,                 // 공격 방향 (+1 = 오른쪽 골 공격, 위협 순위용)
    attackGoalX: 1050,      // 공격 골라인 X (위협 순위용)
    goalX: 1050,            // 수비 골 X (커버·마킹 앵커)
    goalY: 340,             // 수비 골 Y
    centerY: 340,
    minX: 0,
    maxX: 1050,
    yMin: 45,
    yMax: 635,
    pressContain: 30,       // 이 안이면 볼 골사이드 컨테인 (무모한 돌진 방지)
    pressGoalSide: 14,      // 컨테인 시 볼→골 방향 오프셋
    coverDepth: 85,         // 커버: 볼→골선상 뒤처짐 거리
    minSpacing: 55,         // 압박-커버 최소 간격 (이하면 측면으로 벌림)
    laneT: 0.5,             // 레인 차단: 홀더→위협 사이 비율
    markDistance: 25,       // 마킹: 위협 골사이드 간격
    stickiness: 25,         // 역할 유지 여유 (SVG 거리 — 진동 방지)
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

export class DefensiveDecision {
    constructor(options = {}) {
        this.o = { ...DEFAULTS, ...options };
        this._support = new TeamSupport({ dir: this.o.dir });
    }

    /**
     * @param {object} ctx
     *   ball         {x,y}       볼 위치
     *   attackers    {Array}     공격수 Player 배열 (1~11명)
     *   holderIdx    {number}    볼 소유자 인덱스 (기본: 볼에 가장 가까움)
     *   defenders    {Array}     수비수 Player 배열 (1~11명)
     *   prevRoles    {Array}     defenders 순서와 같은 이전 역할 (유지 판단용, 선택)
     * @returns {Array} defenders 순서와 같은 [{ idx, role, targetX, targetY, speed }]
     */
    evaluate(ctx) {
        const o = this.o;
        const ball = ctx.ball;
        const attackers = ctx.attackers ?? [];
        const defenders = ctx.defenders ?? [];
        const prevRoles = ctx.prevRoles ?? null;

        if (defenders.length === 0 || !ball) return [];

        // ── Situation: 홀더 식별 + 위협 순위 ──
        let holder = null;
        if (attackers.length > 0) {
            if (ctx.holderIdx != null && attackers[ctx.holderIdx]) {
                holder = attackers[ctx.holderIdx];
            } else {
                let bd = Infinity;
                for (const a of attackers) {
                    const d = dist(a, ball);
                    if (d < bd) { bd = d; holder = a; }
                }
            }
        }
        const offBall = holder ? attackers.filter(a => a !== holder) : [];
        // 위협 순위 = 공격수가 가장 연결하고 싶어하는 순서 (TeamSupport 재사용)
        const ranked = holder
            ? this._support.passOptions(holder, offBall, defenders, {
                dir: o.dir, attackGoalX: o.attackGoalX,
            }).map(r => r.player)
            : [];

        // ── Decision: 역할 슬롯 (위협 유무로 분기 — NvM) ──
        const slots = [DEFENSE_ROLE.PRESS];
        slots.push(ranked.length > 0 ? DEFENSE_ROLE.LANE_BLOCK : DEFENSE_ROLE.COVER);
        if (defenders.length > 2) {
            slots.push(ranked.length > 1 ? DEFENSE_ROLE.MARK : DEFENSE_ROLE.COVER);
        }
        while (slots.length < defenders.length) slots.push(DEFENSE_ROLE.COVER);

        // ── Intent: 슬롯별 목표점 (커버 간격은 압박 목표를 보고 벌림) ──
        const pressTarget = this._pressTarget(ball, defenders);
        const targets = slots.map((role, k) => {
            if (role === DEFENSE_ROLE.PRESS) return pressTarget;
            if (role === DEFENSE_ROLE.LANE_BLOCK) {
                return this._laneTarget(holder ?? ball, ranked[0] ?? ball);
            }
            if (role === DEFENSE_ROLE.MARK) {
                return this._goalSide(ranked[1] ?? ranked[0] ?? ball, o.markDistance);
            }
            return this._coverTarget(ball, pressTarget, k);
        });

        // ── Decision: 슬롯에 수비수 배정 (거리 탐욕 + 유지 여유) ──
        const assigned = new Array(defenders.length).fill(-1); // defender idx → slot
        slots.forEach((role, s) => {
            let best = -1, bestD = Infinity;
            defenders.forEach((d, i) => {
                if (assigned[i] >= 0) return;
                const dd = dist(d, targets[s]);
                if (dd < bestD) { bestD = dd; best = i; }
            });
            // 유지 판단 — 기존 담당자가 아직 유효하면 역할 진동을 막는다
            if (prevRoles && best >= 0) {
                defenders.forEach((d, i) => {
                    if (assigned[i] >= 0 || prevRoles[i] !== role) return;
                    if (dist(d, targets[s]) <= bestD + o.stickiness) best = i;
                });
            }
            if (best >= 0) assigned[best] = s;
        });

        return defenders.map((d, i) => {
            const s = assigned[i];
            // (슬롯보다 수비수가 많을 수 없으므로 s는 항상 유효)
            const role = slots[s];
            const t = targets[s];
            const dd = dist(d, t);
            const speed = dd > 120 ? SPEEDS[4]
                : dd > 60 ? SPEEDS[3]
                : dd > 25 ? SPEEDS[2]
                : SPEEDS[1];
            return { idx: i, role, targetX: t.x, targetY: t.y, speed };
        });
    }

    /* ── Intent ────────────────────────────────── */

    /** 1차 압박 — 멀면 볼 직행, 붙으면 볼 골사이드 컨테인 */
    _pressTarget(ball, defenders) {
        const o = this.o;
        let nearest = Infinity;
        for (const d of defenders) nearest = Math.min(nearest, dist(d, ball));
        if (nearest > o.pressContain) return { x: ball.x, y: ball.y };
        return this._goalSide(ball, o.pressGoalSide);
    }

    /** 볼→골선상 후방 보호 + 압박과 최소 간격 (겹치면 측면으로 벌림) */
    _coverTarget(ball, pressTarget, slotIndex) {
        const o = this.o;
        const gx = o.goalX - ball.x, gy = o.goalY - ball.y;
        const gDist = Math.hypot(gx, gy) || 1;
        const t = Math.min(1, o.coverDepth / gDist);
        let ax = ball.x + gx * t;
        let ay = ball.y + gy * t;
        // 추가 커버(3명째 수비수부터)는 측면으로 벌려 겹치지 않게 한다
        if (slotIndex >= 3) {
            const side = slotIndex % 2 === 0 ? 1 : -1;
            ay += side * o.minSpacing * Math.floor((slotIndex - 1) / 2);
        }
        // 압박과 겹치면 축 수직 방향으로 벌린다 (수비수 간 거리 확보)
        const px = ax - pressTarget.x, py = ay - pressTarget.y;
        const pd = Math.hypot(px, py);
        if (pd < o.minSpacing) {
            const nx = gDist > 0 ? -gy / gDist : 0;
            const ny = gDist > 0 ? gx / gDist : 1;
            let side = px * nx + py * ny >= 0 ? 1 : -1;
            if (pd < 1) side = ay <= o.centerY ? -1 : 1;
            const push = o.minSpacing - pd;
            ax += nx * side * push;
            ay += ny * side * push;
        }
        return {
            x: clamp(ax, o.minX, o.maxX),
            y: clamp(ay, o.yMin + 15, o.yMax - 15),
        };
    }

    /** 패스 라인 차단 — 홀더→위협 사이 */
    _laneTarget(holder, threat) {
        const o = this.o;
        return {
            x: clamp(holder.x + (threat.x - holder.x) * o.laneT, o.minX, o.maxX),
            y: clamp(holder.y + (threat.y - holder.y) * o.laneT, o.yMin + 15, o.yMax - 15),
        };
    }

    /** 골사이드 — 점과 수비 골 사이 */
    _goalSide(p, offset) {
        const o = this.o;
        const dx = o.goalX - p.x, dy = o.goalY - p.y;
        const d = Math.hypot(dx, dy) || 1;
        const t = Math.min(1, offset / d);
        return {
            x: clamp(p.x + dx * t, o.minX, o.maxX),
            y: clamp(p.y + dy * t, o.yMin + 15, o.yMax - 15),
        };
    }
}
