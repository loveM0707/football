/**
 * CooperativeDefenseAI - 상황 기반 협력수비 배치·이동 모듈
 *
 * defenders: [{ player, movement }]
 * context:
 *   ball          { x, y }
 *   ballVelocity  { x, y }
 *   attackers     Player[]
 *   holderIndex   현재 볼 소유 공격수 인덱스
 *   receiverIndex 현재 패스 대상 공격수 인덱스
 *   inFlight      패스가 진행 중인지 여부
 *
 * 각 수비수에게 역할을 고정하지 않고, 매 배치 주기마다 역할별 목표점까지의
 * 이동 비용을 비교해 압박·패스 레인 차단·맨마킹·커버를 재배정한다.
 */
import { PlayerMovement } from './PlayerMovement.js';
import { forwardVector, angleTo, angleDiff } from './Direction.js';

export const DEFENSE_ROLE = Object.freeze({
    PRESS: 'press',
    LANE_BLOCK: 'lane-block',
    MARK: 'mark',
    COVER: 'cover',
});

const DEFAULT_SPEEDS = {
    // 기본 상한 — 실제 속도는 거리·상황에 따라 완급 조절(_adaptiveSpeed)
    [DEFENSE_ROLE.PRESS]: PlayerMovement.SPEEDS[4],
    [DEFENSE_ROLE.LANE_BLOCK]: PlayerMovement.SPEEDS[3],
    [DEFENSE_ROLE.MARK]: PlayerMovement.SPEEDS[3],
    [DEFENSE_ROLE.COVER]: PlayerMovement.SPEEDS[3],
};

const DEFAULT_ASSIGNMENT_INTERVAL = 0.20;
const DEFAULT_RETARGET_INTERVAL = 0.08;
const DEFAULT_SWITCH_PENALTY = 35;  // 역할 진동 방지 — 수비수가 자주 역할을 바꾸면 전술 붕괴
const DEFAULT_MARK_DISTANCE = 25;
const DEFAULT_PREDICT_LOOK_AHEAD = 0.60;
const DEFAULT_PRESS_HOLDER = false;
const DEFAULT_GOAL_X = 1050;
const DEFAULT_GOAL_Y = 340;

// ── 예측 상수: 공격수 전진을 앞질러 차단 (앞에서 수비) ───────
const PREDICT_HOLDER_TIME   = 0.38; // 홀더 전방 42 (≈110*0.38) — 크게 도는 현상 방지하며 앞에서 차단
const PREDICT_THREAT_TIME   = 0.45; // 위협 전방 52 — 무볼 침투 커버
const PREDICT_RECEIVER_TIME = 0.35; // 패스 수신자 52 (≈150*0.35)
const PREDICT_LANE_TIME_HOLDER = 0.30;
const PREDICT_LANE_TIME_TARGET = 0.35;
const DEFAULT_HOLDER_SPEED  = 110;
const DEFAULT_THREAT_SPEED  = 115;
const CLAMP_X_MIN = 0, CLAMP_X_MAX = 1050;
const CLAMP_Y_MIN = 45, CLAMP_Y_MAX = 635;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

function interpolate(a, b, ratio) {
    return {
        x: a.x + (b.x - a.x) * ratio,
        y: a.y + (b.y - a.y) * ratio,
    };
}

function movementFor(attacker, attackers, movements) {
    if (!attacker || !attackers || !movements) return null;
    const idx = attackers.indexOf(attacker);
    if (idx >= 0 && idx < movements.length) return movements[idx];
    return null;
}

function estimateVelocity(player, movement, fallbackSpeed) {
    if (movement) {
        if (movement._tx !== null && movement._active) {
            const dx = movement._tx - player.x;
            const dy = movement._ty - player.y;
            const dist = Math.hypot(dx, dy);
            if (dist > 1) {
                const s = movement.speed ?? fallbackSpeed;
                return { x: (dx / dist) * s, y: (dy / dist) * s };
            }
        } else if (movement._tx !== null || movement._active) {
            // movement supplied but idle → attacker momentarily stationary
            return { x: 0, y: 0 };
        }
    }
    const fwd = forwardVector(player.angle);
    return { x: fwd.x * fallbackSpeed, y: fwd.y * fallbackSpeed };
}

function predictFuture(player, movement, lookAhead, fallbackSpeed) {
    if (!player) return null;
    const v = estimateVelocity(player, movement, fallbackSpeed);
    let nx = player.x + v.x * lookAhead;
    let ny = player.y + v.y * lookAhead;
    nx = clamp(nx, CLAMP_X_MIN, CLAMP_X_MAX);
    ny = clamp(ny, CLAMP_Y_MIN, CLAMP_Y_MAX);
    return { x: nx, y: ny };
}

function markPoint(attacker, ball, markDistance) {
    const dx = ball.x - attacker.x;
    const dy = ball.y - attacker.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.01) return { x: attacker.x, y: attacker.y };

    const ratio = Math.min(1, markDistance / dist);
    return {
        x: attacker.x + dx * ratio,
        y: attacker.y + dy * ratio,
    };
}

function markPointGoalSide(attacker, goal, markDistance) {
    const dx = goal.x - attacker.x;
    const dy = goal.y - attacker.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.01) return { x: attacker.x, y: attacker.y };
    const ratio = Math.min(1, markDistance / dist);
    return {
        x: attacker.x + dx * ratio,
        y: attacker.y + dy * ratio,
    };
}

// makeRoles는 _makeRoles() 인스턴스 메서드로 이동 — inFlight 상황 분기 지원

function findBestAssignment(costs) {
    const count = costs.length;
    const rowPotential = new Array(count + 1).fill(0);
    const columnPotential = new Array(count + 1).fill(0);
    const matchedRow = new Array(count + 1).fill(0);
    const previousColumn = new Array(count + 1).fill(0);

    // Hungarian algorithm: O(n³), so a full defensive line remains inexpensive.
    for (let row = 1; row <= count; row++) {
        matchedRow[0] = row;
        let column = 0;
        const minCost = new Array(count + 1).fill(Infinity);
        const visited = new Array(count + 1).fill(false);

        do {
            visited[column] = true;
            const matched = matchedRow[column];
            let delta = Infinity;
            let nextColumn = 0;
            for (let candidate = 1; candidate <= count; candidate++) {
                if (visited[candidate]) continue;
                const currentCost = costs[matched - 1][candidate - 1]
                    - rowPotential[matched] - columnPotential[candidate];
                if (currentCost < minCost[candidate]) {
                    minCost[candidate] = currentCost;
                    previousColumn[candidate] = column;
                }
                if (minCost[candidate] < delta) {
                    delta = minCost[candidate];
                    nextColumn = candidate;
                }
            }

            for (let candidate = 0; candidate <= count; candidate++) {
                if (visited[candidate]) {
                    rowPotential[matchedRow[candidate]] += delta;
                    columnPotential[candidate] -= delta;
                } else {
                    minCost[candidate] -= delta;
                }
            }
            column = nextColumn;
        } while (matchedRow[column] !== 0);

        do {
            const previous = previousColumn[column];
            matchedRow[column] = matchedRow[previous];
            column = previous;
        } while (column !== 0);
    }

    const assignment = new Array(count);
    for (let column = 1; column <= count; column++) {
        assignment[matchedRow[column] - 1] = column - 1;
    }
    return assignment;
}

export class CooperativeDefenseAI {
    /**
     * @param {{ player: object, movement: object }[]} defenders
     * @param {object} [options]
     *   assignmentInterval {number} 역할 재배치 주기(초)
     *   retargetInterval   {number} 역할 목표 갱신 주기(초)
     *   switchPenalty       {number} 역할 변경 억제 비용
     *   markDistance        {number} 공격수와 맨마킹 수비수 간 목표 간격
     *   speeds              {object} 역할별 이동 속도
     *   goalX               {number} 골대 X (마크 시 골대-공격수 직선상 위치)
     *   goalY               {number} 골대 Y (기본 340)
     */
    constructor(defenders, options = {}) {
        this._defenders = defenders;
        this._assignmentInterval = options.assignmentInterval ?? DEFAULT_ASSIGNMENT_INTERVAL;
        this._retargetInterval = options.retargetInterval ?? DEFAULT_RETARGET_INTERVAL;
        this._switchPenalty = options.switchPenalty ?? DEFAULT_SWITCH_PENALTY;
        this._markDistance = options.markDistance ?? DEFAULT_MARK_DISTANCE;
        this._predictLookAhead = options.predictLookAhead ?? DEFAULT_PREDICT_LOOK_AHEAD;
        this._pressHolder = options.pressHolder ?? DEFAULT_PRESS_HOLDER;
        this._goalX = options.goalX ?? DEFAULT_GOAL_X;
        this._goalY = options.goalY ?? DEFAULT_GOAL_Y;
        this._speeds = { ...DEFAULT_SPEEDS, ...(options.speeds ?? {}) };

        this._active = false;
        this._assignmentTimer = 0;
        this._retargetTimer = 0;
        this._assignments = [];
    }

    start() {
        this._active = true;
        this._assignmentTimer = 0;
        this._retargetTimer = 0;
    }

    stop() {
        this._active = false;
        for (const { movement } of this._defenders) movement.stop();
        this._assignments = [];
    }

    /** 현재 역할 배치 확인용 스냅샷. 향후 디버그 UI에도 사용할 수 있다. */
    getAssignments() {
        return this._assignments.map(({ unit, role, target }) => ({
            player: unit.player,
            role,
            target: target ? { ...target } : null,
        }));
    }

    update(dt, context = {}) {
        if (!this._active || this._defenders.length === 0) return;

        const state = this._buildState(context);
        this._assignmentTimer -= dt;
        if (this._assignments.length === 0 || this._assignmentTimer <= 0) {
            this._assignRoles(state);
            this._assignmentTimer = this._assignmentInterval;
            this._retargetTimer = 0;
        }

        this._retargetTimer -= dt;
        if (this._retargetTimer <= 0) {
            this._retarget(state);
            this._retargetTimer = this._retargetInterval;
        }

        for (const { movement } of this._defenders) movement.update(dt);
    }

    _buildState(context) {
        const ball = context.ball ?? { x: 0, y: 0 };
        const ballVelocity = context.ballVelocity ?? { x: 0, y: 0 };
        const attackers = context.attackers ?? [];
        const attackerMovements = context.attackerMovements ?? context.attackerMoves ?? null;
        const holder = context.holder ?? attackers[context.holderIndex] ?? null;
        const receiver = context.receiver ?? attackers[context.receiverIndex] ?? null;
        const threat = receiver && receiver !== holder
            ? receiver
            : this._findThreat(attackers, holder, ball);
        const goal = context.goal ?? { x: this._goalX, y: this._goalY };

        return {
            ball,
            ballVelocity,
            attackers,
            attackerMovements,
            holder,
            receiver,
            threat,
            goal,
            inFlight: Boolean(context.inFlight && receiver),
        };
    }

    _findThreat(attackers, holder, ball) {
        let threat = null;
        let threatDistance = Infinity;
        for (const attacker of attackers) {
            if (attacker === holder) continue;
            const currentDistance = distance(attacker, ball);
            if (currentDistance < threatDistance) {
                threat = attacker;
                threatDistance = currentDistance;
            }
        }
        return threat;
    }

    /**
     * 상황에 따라 역할 목록을 반환한다.
     * 2v2: 볼 비행 중 → PRESS+MARK(수신자 밀착), 드리블 중 → PRESS+LANE_BLOCK(패스 레인 차단)
     * 3+: 항상 PRESS+LANE_BLOCK+MARK+COVER
     */
    _makeRoles(count, inFlight) {
        if (count <= 1) return [DEFENSE_ROLE.PRESS];
        if (count === 2) {
            return inFlight
                ? [DEFENSE_ROLE.PRESS, DEFENSE_ROLE.MARK]       // 수신 차단
                : [DEFENSE_ROLE.PRESS, DEFENSE_ROLE.LANE_BLOCK]; // 패스 레인 차단
        }
        const roles = [DEFENSE_ROLE.PRESS, DEFENSE_ROLE.LANE_BLOCK];
        if (count >= 3) roles.push(DEFENSE_ROLE.MARK);
        while (roles.length < count) roles.push(DEFENSE_ROLE.COVER);
        return roles;
    }

    _assignRoles(state) {
        const roles = this._makeRoles(this._defenders.length, state.inFlight);
        const targets = roles.map(role => this._targetForRole(role, state));
        const previousRoles = new Map(this._assignments.map(assignment => [assignment.unit, assignment.role]));
        const costs = this._defenders.map(unit => roles.map((role, roleIndex) => {
            const previousRole = previousRoles.get(unit);
            const switchCost = previousRole && previousRole !== role ? this._switchPenalty : 0;
            return distance(unit.player, targets[roleIndex]) + switchCost;
        }));
        const roleIndexes = findBestAssignment(costs);

        this._assignments = this._defenders.map((unit, unitIndex) => ({
            unit,
            role: roles[roleIndexes[unitIndex]],
            target: null,
        }));
    }

    _retarget(state) {
        for (const assignment of this._assignments) {
            const target = this._targetForRole(assignment.role, state);
            assignment.target = target;
            const dist = distance(assignment.unit.player, target);
            let speed = this._adaptiveSpeed(assignment.role, dist, assignment.unit.player, state);
            // 급회전 시 속도 제한 — 큰 루프 방지, 거리 멀면 완화해 빠르게 전진 차단
            const targetAngle = angleTo(assignment.unit.player.x, assignment.unit.player.y, target.x, target.y);
            const turnDiff = Math.abs(angleDiff(targetAngle, assignment.unit.player.angle));
            if (turnDiff > 120) speed = Math.min(speed, dist > 45 ? PlayerMovement.SPEEDS[1] : PlayerMovement.SPEEDS[0]);
            else if (turnDiff > 90) speed = Math.min(speed, dist > 35 ? PlayerMovement.SPEEDS[2] : PlayerMovement.SPEEDS[1]);
            else if (turnDiff > 60) speed = Math.min(speed, PlayerMovement.SPEEDS[2]);
            assignment.unit.movement.speed = speed;
            assignment.unit.movement.clearFacingTarget();
            assignment.unit.movement.moveTo(target.x, target.y);
        }
    }

    _adaptiveSpeed(role, dist, defender, state) {
        // 완급 조절: 전력질주만 하지 않고 거리·상황에 따라 템포 조절로 공격 지연
        const baseMax = this._speeds[role] ?? PlayerMovement.SPEEDS[3];
        // PRESS: 홀더와 가까울수록 자키(jockey)로 전환 — 예측 앵커가 멀면 스프린트로 앞에서 차단
        if (role === DEFENSE_ROLE.PRESS) {
            const holder = state.holder;
            const dToHolder = holder ? distance(defender, holder) : dist;
            // 예측으로 인해 target이 멀리 앞에 있을 때는 거리 기반으로 스프린트 우선
            if (dist > 140) return Math.min(baseMax, PlayerMovement.SPEEDS[4]);
            if (dist > 90) return Math.min(baseMax, PlayerMovement.SPEEDS[3]);
            if (dist > 45) {
                if (dToHolder < 18) return PlayerMovement.SPEEDS[2]; // 100 - 앞에 서기 위해 50보다 빠르게
                if (dToHolder < 32) return PlayerMovement.SPEEDS[2];
                return Math.min(baseMax, PlayerMovement.SPEEDS[2]);
            }
            if (dToHolder < 18) return PlayerMovement.SPEEDS[0]; // 50 초근접 셔플 (target도 가까울 때만)
            if (dToHolder < 32) return PlayerMovement.SPEEDS[1]; // 75 자키
            if (dToHolder < 60) return PlayerMovement.SPEEDS[2]; // 100 컨테인
            if (dist > 18) return PlayerMovement.SPEEDS[1];
            return PlayerMovement.SPEEDS[0];
        }
        // MARK / LANE_BLOCK / COVER: 골사이드 유지하며 셔플, 스프린트 남용 방지
        if (dist > 120) return Math.min(baseMax, PlayerMovement.SPEEDS[4]);
        if (dist > 70) return PlayerMovement.SPEEDS[3];
        if (dist > 35) return PlayerMovement.SPEEDS[2];
        if (dist > 18) return PlayerMovement.SPEEDS[1];
        return PlayerMovement.SPEEDS[0]; // 50 미세 조정
    }

    _targetForRole(role, state) {
        const passStart = state.holder ?? state.ball;
        const passEnd = state.receiver ?? state.threat ?? state.ball;

        if (role === DEFENSE_ROLE.PRESS) {
            // 지능적 지연 + 전진 예측: 홀더가 전진할 위치의 골사이드에서 미리 차단
            if (state.holder && !state.inFlight) {
                const dBallHolder = distance(state.ball, state.holder);
                const goal = state.goal ?? { x: this._goalX, y: this._goalY };
                if (dBallHolder < 35) {
                    const holderMov = movementFor(state.holder, state.attackers, state.attackerMovements);
                    const predicted = predictFuture(state.holder, holderMov, PREDICT_HOLDER_TIME, DEFAULT_HOLDER_SPEED);
                    const anchor = predicted ?? state.holder;
                    // 골사이드 20 지점에 미리 위치 — 전진하는 공격수를 앞에서 맞이
                    const containDist = 20;
                    return markPointGoalSide(anchor, goal, containDist);
                }
                if (this._pressHolder) {
                    return { x: state.holder.x, y: state.holder.y };
                }
            }
            // 루즈볼·패스 중에는 볼 예측 지점으로 이동 (완급 조절 전에도 빠르지 않게)
            const speed = Math.hypot(state.ballVelocity.x, state.ballVelocity.y);
            const horizon = state.inFlight
                ? Math.min(this._predictLookAhead * 1.6, 180 / Math.max(speed, 1))
                : Math.min(this._predictLookAhead, 100 / Math.max(speed, 1));
            return {
                x: state.ball.x + state.ballVelocity.x * horizon,
                y: state.ball.y + state.ballVelocity.y * horizon,
            };
        }

        if (role === DEFENSE_ROLE.LANE_BLOCK) {
            // 패스 레인 차단 — 예측된 홀더/수신자 사이를 더 앞에서 가로막음
            const t = state.inFlight ? 0.58 : 0.48;
            let start = passStart;
            let end = passEnd;
            if (state.holder) {
                const hm = movementFor(state.holder, state.attackers, state.attackerMovements);
                const pStart = predictFuture(state.holder, hm, PREDICT_LANE_TIME_HOLDER, DEFAULT_HOLDER_SPEED);
                if (pStart) start = pStart;
            }
            const endPlayer = state.receiver ?? state.threat;
            if (endPlayer) {
                const em = movementFor(endPlayer, state.attackers, state.attackerMovements);
                const pEnd = predictFuture(endPlayer, em, PREDICT_LANE_TIME_TARGET, DEFAULT_THREAT_SPEED);
                if (pEnd) end = pEnd;
            }
            return interpolate(start, end, t);
        }

        if (role === DEFENSE_ROLE.MARK) {
            // 골대-공격수 직선상 골사이드 마킹 + 전진 예측 (앞에서 수비)
            const goal = state.goal ?? { x: this._goalX, y: this._goalY };
            if (state.inFlight && state.receiver) {
                const recMov = movementFor(state.receiver, state.attackers, state.attackerMovements);
                const predRec = predictFuture(state.receiver, recMov, PREDICT_RECEIVER_TIME, PlayerMovement.SPEEDS[4]);
                const anchorRec = predRec ?? state.receiver;
                return markPointGoalSide(anchorRec, goal, this._markDistance * 0.65);
            }
            if (state.threat) {
                const threatMov = movementFor(state.threat, state.attackers, state.attackerMovements);
                const predThreat = predictFuture(state.threat, threatMov, PREDICT_THREAT_TIME, DEFAULT_THREAT_SPEED);
                const anchor = predThreat ?? state.threat;
                return markPointGoalSide(anchor, goal, this._markDistance);
            }
            return { x: state.ball.x, y: state.ball.y };
        }

        // 커버 — 예측된 앵커 사이 후방 보호
        {
            let covStart = passStart;
            let covEnd = passEnd;
            if (state.holder) {
                const hm = movementFor(state.holder, state.attackers, state.attackerMovements);
                const pS = predictFuture(state.holder, hm, PREDICT_LANE_TIME_HOLDER, DEFAULT_HOLDER_SPEED);
                if (pS) covStart = pS;
            }
            const covPlayer = state.receiver ?? state.threat;
            if (covPlayer) {
                const em = movementFor(covPlayer, state.attackers, state.attackerMovements);
                const pE = predictFuture(covPlayer, em, PREDICT_LANE_TIME_TARGET, DEFAULT_THREAT_SPEED);
                if (pE) covEnd = pE;
            }
            return interpolate(covStart, covEnd, state.inFlight ? 0.78 : 0.62);
        }
    }
}
