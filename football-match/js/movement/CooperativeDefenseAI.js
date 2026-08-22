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

export const DEFENSE_ROLE = Object.freeze({
    PRESS: 'press',
    LANE_BLOCK: 'lane-block',
    MARK: 'mark',
    COVER: 'cover',
});

const DEFAULT_SPEEDS = {
    // 공격수와 동일하게 PlayerMovement의 최고 스피드 단계를 사용한다.
    [DEFENSE_ROLE.PRESS]: PlayerMovement.SPEEDS[4],
    [DEFENSE_ROLE.LANE_BLOCK]: PlayerMovement.SPEEDS[4],
    [DEFENSE_ROLE.MARK]: PlayerMovement.SPEEDS[4],
    [DEFENSE_ROLE.COVER]: PlayerMovement.SPEEDS[4],
};

const DEFAULT_ASSIGNMENT_INTERVAL = 0.35;
const DEFAULT_RETARGET_INTERVAL = 0.15;
const DEFAULT_SWITCH_PENALTY = 14;
const DEFAULT_MARK_DISTANCE = 28;
const DEFAULT_PREDICT_LOOK_AHEAD = 0.35;
const DEFAULT_PRESS_HOLDER = false;

function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

function interpolate(a, b, ratio) {
    return {
        x: a.x + (b.x - a.x) * ratio,
        y: a.y + (b.y - a.y) * ratio,
    };
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

function makeRoles(count) {
    if (count <= 1) return [DEFENSE_ROLE.PRESS];

    const roles = [DEFENSE_ROLE.PRESS, DEFENSE_ROLE.LANE_BLOCK];
    if (count >= 3) roles.push(DEFENSE_ROLE.MARK);
    while (roles.length < count) roles.push(DEFENSE_ROLE.COVER);
    return roles;
}

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
     */
    constructor(defenders, options = {}) {
        this._defenders = defenders;
        this._assignmentInterval = options.assignmentInterval ?? DEFAULT_ASSIGNMENT_INTERVAL;
        this._retargetInterval = options.retargetInterval ?? DEFAULT_RETARGET_INTERVAL;
        this._switchPenalty = options.switchPenalty ?? DEFAULT_SWITCH_PENALTY;
        this._markDistance = options.markDistance ?? DEFAULT_MARK_DISTANCE;
        this._predictLookAhead = options.predictLookAhead ?? DEFAULT_PREDICT_LOOK_AHEAD;
        this._pressHolder = options.pressHolder ?? DEFAULT_PRESS_HOLDER;
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
        const holder = context.holder ?? attackers[context.holderIndex] ?? null;
        const receiver = context.receiver ?? attackers[context.receiverIndex] ?? null;
        const threat = receiver && receiver !== holder
            ? receiver
            : this._findThreat(attackers, holder, ball);

        return {
            ball,
            ballVelocity,
            attackers,
            holder,
            receiver,
            threat,
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

    _assignRoles(state) {
        const roles = makeRoles(this._defenders.length);
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
            assignment.unit.movement.speed = this._speeds[assignment.role];
            assignment.unit.movement.clearFacingTarget();
            assignment.unit.movement.moveTo(target.x, target.y);
        }
    }

    _targetForRole(role, state) {
        const passStart = state.holder ?? state.ball;
        const passEnd = state.receiver ?? state.threat ?? state.ball;

        if (role === DEFENSE_ROLE.PRESS) {
            if (this._pressHolder && state.holder && !state.inFlight) {
                return { x: state.holder.x, y: state.holder.y };
            }
            const speed = Math.hypot(state.ballVelocity.x, state.ballVelocity.y);
            const horizon = Math.min(this._predictLookAhead, 100 / Math.max(speed, 1));
            return {
                x: state.ball.x + state.ballVelocity.x * horizon,
                y: state.ball.y + state.ballVelocity.y * horizon,
            };
        }

        if (role === DEFENSE_ROLE.LANE_BLOCK) {
            return interpolate(passStart, passEnd, state.inFlight ? 0.48 : 0.4);
        }

        if (role === DEFENSE_ROLE.MARK) {
            return state.threat
                ? markPoint(state.threat, state.ball, this._markDistance)
                : { x: state.ball.x, y: state.ball.y };
        }

        return interpolate(passStart, passEnd, state.inFlight ? 0.72 : 0.64);
    }
}
