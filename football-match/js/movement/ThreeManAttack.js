/**
 * ThreeManAttack - 3인 공격 시 오프볼 침투 모듈
 *
 * 시나리오 하드코딩을 제거하고 모듈에서 공격 패턴을 관리한다.
 * 요구사항: 볼을 갖지 않은 2명 중 최소 1명은 항상 골대 정면(중앙)에 침투해
 * 찬스 공간을 만든다. 나머지 1명은 후방/측면 지원.
 *
 * - 2명의 오프볼 선수를 "중앙 침투자"와 "지원자"로 역할 분담
 * - 중앙 침투자는 골대 정면 PenA(attackGoalX - 120~180, CENTER_Y ±30) 를 목표로 지속 전진
 * - 지원자는 캐리어 기준 전방/후방 + 레인 기반 폭 확보
 * - 매 프레임이 아니라 일정 간격(0.45~0.75s)으로 재타겟해 자연스러운 움직임
 * - 모듈은 위치·속도만 결정하고, 슈팅/패스 판단은 시나리오가 그대로 수행
 */

import { PlayerMovement } from './PlayerMovement.js';
import { angleTo, angleDiff } from './Direction.js';

const SPEEDS = PlayerMovement.SPEEDS;
const LANE_Y = [168, 340, 512];
const CENTER_Y = 340;
const Y_MIN = 45;
const Y_MAX = 635;
const GOAL_R_X = 1050;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function rand(a, b) { return a + Math.random() * (b - a); }

export class ThreeManAttack {
    constructor(players, movements, options = {}) {
        this.players = players; // length 3
        this.movements = movements;
        this.goalX = options.goalX ?? GOAL_R_X;
        this.centerY = options.centerY ?? CENTER_Y;
        this.yMin = options.yMin ?? Y_MIN;
        this.yMax = options.yMax ?? Y_MAX;
        this.laneY = options.laneY ?? LANE_Y;
        // lanes: 각 선수의 기본 레인 인덱스 (상/중/하)
        this.lanes = options.lanes ?? [0, 1, 2];
        this.dir = options.dir ?? 1; // 1: 오른쪽 골 공격, -1: 왼쪽

        // 내부 상태
        this._retargetT = [0, 0, 0];
        this._targets = [null, null, null];
        this._weaveOffset = [Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28];
        this._carrierRetargetT = 0;
    }

    /**
     * @param {number} dt
     * @param {object} ctx
     * @param {number} ctx.carrierIdx - 볼 소유자 인덱스
     * @param {number} ctx.clock - 전역 클록
     * @param {number} ctx.carrierX - 캐리어 x (선택, 없으면 players[carrierIdx].x 사용)
     * @param {number} ctx.carrierY
     * @param {number} ctx.attackGoalX
     * @param {number} ctx.centerX
     */
    update(dt, ctx = {}) {
        const carrierIdx = ctx.carrierIdx;
        if (carrierIdx == null || carrierIdx < 0 || carrierIdx >= 3) return;
        const carrier = this.players[carrierIdx];
        const carrierX = ctx.carrierX ?? carrier.x;
        const carrierY = ctx.carrierY ?? carrier.y;
        const clock = ctx.clock ?? 0;
        const centerX = ctx.centerX ?? 525;
        const attackGoalX = ctx.attackGoalX ?? this.goalX;
        const dir = this.dir;

        // 2명의 오프볼 인덱스
        const offIndices = [0, 1, 2].filter(k => k !== carrierIdx);
        if (offIndices.length !== 2) return;

        // 중앙 침투자 선정: 현재 중앙 침투 구역에 이미 있는지, 없으면 더 가까운 쪽을 선정
        // 중앙 침투 구역: x > attackGoalX - dir*250, y는 CENTER_Y ±70
        const centralZone = (p) => {
            const dx = Math.abs(attackGoalX - p.x);
            const dy = Math.abs(p.y - this.centerY);
            return dx < 260 && dy < 70;
        };
        let penetratorIdx = null;
        let supporterIdx = null;

        const a = offIndices[0], b = offIndices[1];
        const aInCentral = centralZone(this.players[a]);
        const bInCentral = centralZone(this.players[b]);

        if (aInCentral && !bInCentral) penetratorIdx = a, supporterIdx = b;
        else if (!aInCentral && bInCentral) penetratorIdx = b, supporterIdx = a;
        else if (aInCentral && bInCentral) {
            // 둘 다 중앙이면 더 골에 가까운 쪽을 침투자로 유지, 다른 쪽은 지원으로 전환
            const da = Math.abs(attackGoalX - this.players[a].x);
            const db = Math.abs(attackGoalX - this.players[b].x);
            penetratorIdx = da < db ? a : b;
            supporterIdx = penetratorIdx === a ? b : a;
        } else {
            // 둘 다 중앙 아니면, 중앙 레인(1)에 더 가까운 쪽 또는 골에 더 가까운 쪽을 침투자로
            const laneA = this.lanes[a], laneB = this.lanes[b];
            const laneDistA = Math.abs(this.laneY[laneA] - this.centerY);
            const laneDistB = Math.abs(this.laneY[laneB] - this.centerY);
            if (laneDistA < laneDistB) penetratorIdx = a, supporterIdx = b;
            else if (laneDistB < laneDistA) penetratorIdx = b, supporterIdx = a;
            else {
                // 레인 동일하면 골에 가까운 쪽
                const da = Math.abs(attackGoalX - this.players[a].x);
                const db = Math.abs(attackGoalX - this.players[b].x);
                penetratorIdx = da < db ? a : b;
                supporterIdx = penetratorIdx === a ? b : a;
            }
            // 최소 한 명은 반드시 중앙 침투를 하도록 강제 — 위 선정이 측면이면 중앙으로 보정
            // penetratorIdx가 측면 레인(0 or 2)이어도 목표는 중앙으로 보정되므로 괜찮음
        }

        // 각 오프볼 선수 업데이트
        for (const k of offIndices) {
            const isPenetrator = k === penetratorIdx;
            // 디버그
            // console.log(`k=${k} penetrator=${penetratorIdx} isPen=${isPenetrator} dir=${dir} attackGoalX=${attackGoalX}`);
            this._retargetT[k] -= dt;
            const m = this.players[k];
            const mm = this.movements[k];
            const curT = this._targets[k];
            const need = !curT || !mm.moving || this._retargetT[k] <= 0 || Math.hypot(m.x - curT.x, m.y - curT.y) < 16;

            if (!need) {
                // 미세 sway로 서 있지 않게
                if (Math.hypot((mm._tx ?? m.x) - m.x, (mm._ty ?? m.y) - m.y) < 22 && Math.random() < 0.05) {
                    const swayX = (Math.random() - 0.5) * 10;
                    const swayY = (Math.random() - 0.5) * 14;
                    mm.clearFacingTarget();
                    mm.moveTo(clamp(curT.x + swayX, 25, GOAL_R_X - 25), clamp(curT.y + swayY, this.yMin + 15, this.yMax - 15));
                }
                continue;
            }

            let tx, ty, targetSpeed;
            if (isPenetrator) {
                // 중앙 침투: 골대 정면 PenA 진입 — 최소 한 명 보장
                const depth = rand(110, 175); // 골대에서 11~17.5m 앞
                tx = attackGoalX - dir * depth;
                // 중앙 ±30 + weave로 자연스러움
                ty = this.centerY + rand(-30, 30) + Math.sin(clock * 1.1 + this._weaveOffset[k]) * 12;
                // 캐리어보다 너무 뒤처지지 않게 전방성 보정
                if (dir > 0) tx = Math.max(tx, carrierX + 35);
                else tx = Math.min(tx, carrierX - 35);
                tx = clamp(tx, 25, GOAL_R_X - 25);
                ty = clamp(ty, this.centerY - 55, this.centerY + 55);
                const dd = Math.hypot(m.x - tx, m.y - ty);
                targetSpeed = dd > 140 ? SPEEDS[4] : dd > 70 ? SPEEDS[3] : SPEEDS[2];
            } else {
                // 지원: 캐리어 기준 전방/후방 + 레인 폭, 중앙 침투자와 겹치지 않게
                const carrierLane = this._nearestLane(carrierY);
                let lane = this.lanes[k];
                if (lane === carrierLane) {
                    const alts = [0, 1, 2].filter(l => l !== carrierLane);
                    lane = alts.reduce((a, b) => Math.abs(this.laneY[a] - m.y) <= Math.abs(this.laneY[b] - m.y) ? a : b);
                }
                const laneY = this.laneY[lane] + Math.sin(clock * 1.3 + this._weaveOffset[k]) * 15;
                const forwardness = (carrierX - centerX) * dir;
                if (forwardness > 60) {
                    tx = carrierX - dir * rand(85, 125);
                } else {
                    tx = carrierX + dir * rand(55, 110);
                }
                tx = clamp(tx, 25, GOAL_R_X - 25);
                // 중앙 침투자 근처 겹침 방지
                const penT = this._targets[penetratorIdx];
                if (penT && Math.hypot(tx - penT.x, laneY - penT.y) < 75) {
                    tx -= dir * 45;
                }
                if (Math.abs(carrierY - laneY) < 55 && Math.abs(carrierX - tx) < 80) tx -= dir * 45;
                ty = clamp(laneY, this.yMin + 15, this.yMax - 15);
                const dd = Math.hypot(m.x - tx, m.y - ty);
                const offWave = (Math.sin(clock * 1.05 + this._weaveOffset[k]) + 1) / 2;
                if (dd > 190) targetSpeed = SPEEDS[4];
                else if (dd > 110) targetSpeed = offWave > 0.52 ? SPEEDS[4] : SPEEDS[3];
                else if (dd > 58) targetSpeed = offWave > 0.50 ? SPEEDS[3] : SPEEDS[2];
                else targetSpeed = offWave > 0.35 ? SPEEDS[2] : SPEEDS[1];
            }

            this._targets[k] = { x: tx, y: ty };
            this._retargetT[k] = rand(0.45, 0.75);
            mm.clearFacingTarget();
            mm.speed = targetSpeed;
            mm.moveTo(tx, ty);
        }
    }

    _nearestLane(y) {
        let bi = 0, bd = Infinity;
        for (let l = 0; l < 3; l++) {
            const d = Math.abs(this.laneY[l] - y);
            if (d < bd) { bd = d; bi = l; }
        }
        return bi;
    }

    /**
     * 캐리어 드리블 이동 — 모듈에서 직접 관리해 시나리오는 호출만
     * @param {number} dt
     * @param {object} ctx
     * @param {number} ctx.carrierIdx
     * @param {number} ctx.clock
     * @param {Array} ctx.defenders - 상대 선수 배열
     * @param {boolean} ctx.canTurn - 볼이 발에 붙었는지 (180도 턴 가드)
     */
    updateCarrier(dt, ctx = {}) {
        const carrierIdx = ctx.carrierIdx;
        if (carrierIdx == null) return;
        const p = this.players[carrierIdx];
        const pm = this.movements[carrierIdx];
        const defenders = ctx.defenders ?? [];
        const clock = ctx.clock ?? 0;
        const canTurn = ctx.canTurn ?? true;
        const attackGoalX = ctx.attackGoalX ?? this.goalX;
        const dir = this.dir;
        const goalDist = Math.abs(attackGoalX - p.x);

        let presser = null, pressD = Infinity;
        for (const o of defenders) {
            const d = Math.hypot(o.x - p.x, o.y - p.y);
            if (d < pressD) { pressD = d; presser = o; }
        }

        this._carrierRetargetT -= dt;
        const EDGE = 52;
        const nearEdgeX = p.x < EDGE || p.x > GOAL_R_X - EDGE;
        const nearEdgeY = p.y < EDGE || p.y > 680 - EDGE;
        if (nearEdgeX || nearEdgeY) {
            const ix = clamp(p.x, EDGE + 14, GOAL_R_X - EDGE - 14);
            const iy = clamp(p.y, 62, 680 - 62);
            pm.clearFacingTarget();
            pm.moveTo(ix, iy);
            pm.speed = SPEEDS[3];
            return;
        }
        if (!pm.moving || this._carrierRetargetT <= 0) {
            const fwdMax = Math.max(goalDist - 45, 40);
            const fwd = clamp(rand(75, 135), 30, fwdMax);
            let lateral = presser
                ? ((presser.y - p.y) > 0 ? -1 : 1) * rand(22, 48)
                : Math.sin(clock * 0.9 + this._weaveOffset[carrierIdx]) * 22;
            if (goalDist < 260 && Math.random() < 0.45) lateral += (this.centerY - p.y) * 0.22;
            const candTx = clamp(p.x + dir * fwd, EDGE + 20, GOAL_R_X - EDGE - 20);
            const candTy = clamp(p.y + lateral, 70, 680 - 70);
            if (!canTurn) {
                const desired = angleTo(p.x, p.y, candTx, candTy);
                const diff = Math.abs(angleDiff(desired, p.angle));
                if (diff > 70) {
                    this._carrierRetargetT = 0.14;
                    return;
                }
            }
            this._carrierRetargetT = rand(0.62, 0.95);
            pm.clearFacingTarget();
            pm.moveTo(candTx, candTy);
        }
    }

    /**
     * 결정적 찬스인데 몸이 골대를 등지고 있을 때, 캐리어를 골문 쪽으로 몰고 간다.
     * 순간 회전으로 때리는 대신 한두 터치로 슛 자세를 잡게 하는 용도다.
     *
     * @param {object} ctx
     *   carrierIdx  {number}
     *   attackGoalX {number}
     *   aimY        {number} 노리는 골문 지점 (없으면 골 중앙)
     */
    driveAtGoal(ctx = {}) {
        const carrierIdx = ctx.carrierIdx;
        if (carrierIdx == null) return;
        const p = this.players[carrierIdx];
        const pm = this.movements[carrierIdx];
        const attackGoalX = ctx.attackGoalX ?? this.goalX;
        const aimY = ctx.aimY ?? this.centerY;
        const dir = this.dir;

        // 골문 바로 앞을 목표로 — 슛 사거리 안쪽까지 곧장 밀고 들어간다
        const tx = clamp(attackGoalX - dir * 55, 25, GOAL_R_X - 25);
        const ty = clamp(aimY, this.yMin + 15, this.yMax - 15);
        pm.clearFacingTarget();
        pm.speed = SPEEDS[3];
        pm.moveTo(tx, ty);
        // 다음 프레임에 일반 드리블 로직이 이 목표를 덮어쓰지 않도록 유지 시간 확보
        this._carrierRetargetT = 0.35;
    }

    reset() {
        this._retargetT = [0, 0, 0];
        this._targets = [null, null, null];
        this._carrierRetargetT = 0;
    }
}
