/**
 * AerialHeadingController - 공중볼·헤딩 공통 오케스트레이터
 *
 * 접근 → 위치 조정 → 점프 판단 → 점프 → 접촉 → 헤딩 방향 결정 → 착지
 * 과정을 하나의 파이프라인으로 묶는다.
 *
 * 원칙 준수:
 * - 선수를 공 위치로 순간이동시키지 않는다 (기존 3 시나리오의 teleport 제거 대상)
 * - 방향·회전·가속은 PlayerMovement에 위임한다 (직접 setPosition 금지)
 * - 낙하지점 예측은 AerialTrajectory, 슛 물리는 HeadingShot을 재사용한다
 * - 크로스·코너킥·롱패스·골킥 모두 같은 입력(볼·후보·목표)으로 동작한다
 *
 * 사용법:
 *   const ctrl = new AerialHeadingController();
 *   ctrl.beginFlight(); // 킥 발사 직후
 *   // 매 프레임:
 *   const res = ctrl.update(dt, {
 *       ball, bm, candidates: [{ player, movement, ability }],
 *       type: 'pass', targetX, targetY, goalX, ...
 *   });
 *   if (res.header) { // 헤딩 성립 — 시나리오는 결과 연출만 }
 */
import { AerialTrajectory } from './AerialTrajectory.js';
import { AerialApproach } from './AerialApproach.js';
import { HeadingJump, JUMP_PHASE } from './HeadingJump.js';
import { HeadingExecution, HEADING_TYPE } from './HeadingExecution.js';
import { AerialDuel } from './AerialDuel.js';
import { angleTo } from './Direction.js';

const DEFAULTS = {
    contactRadius: 20,  // 접촉 수평 반경 (Jump와 동일)
    headerSkill: 0.5,
};

export class AerialHeadingController {
    constructor(options = {}) {
        this.o = { ...DEFAULTS, ...options };
        this._traj = options.trajectory ?? new AerialTrajectory();
        this._approach = options.approach ?? new AerialApproach({});
        this._exec = options.execution ?? new HeadingExecution({});
        this._duel = options.duel ?? new AerialDuel({});
        // 점프 상태는 선수별 — Player를 키로 관리한다
        this._jumps = new Map();
        this._consumed = false; // 이번 비행에서 헤딩이 성립했는지
    }

    /** 새로운 공중볼 비행 시작 (킥 발사 직후 호출) */
    beginFlight() {
        this._jumps.clear();
        this._consumed = false;
    }

    /** 시나리오 리셋용 */
    reset() {
        this.beginFlight();
    }

    _jumpFor(player) {
        let j = this._jumps.get(player);
        if (!j) {
            j = new HeadingJump({ contactRadius: this.o.contactRadius });
            this._jumps.set(player, j);
        }
        return j;
    }

    /**
     * @param {number} dt
     * @param {object} ctx
     *   ball {x,y,height}, bm {BallMovement},
     *   candidates [{ player, movement, ability }],
     *   type {HEADING_TYPE}, targetX/Y, goalX, incomingSpeed/Height, headerSkill,
     *   duel {boolean} 경합 허용 (기본 true)
     * @returns {{ landing, intents, header }}
     *   intents [{ player, targetX, targetY, speed, phase, contact }]
     *   header null | { winner, plan, contested }
     */
    update(dt, ctx = {}) {
        const ball = ctx.ball;
        const bm = ctx.bm;
        const candidates = ctx.candidates ?? [];
        const out = { landing: null, intents: [], header: null };

        // 비행 중이 아니면 할 일이 없다 (세컨드볼은 별도 모듈이 담당)
        if (!bm.isAerial && !bm.isBouncing) return out;
        if (this._consumed) return out;

        // 1. 낙하지점 예측 (속도·궤적 기반)
        const landing = this._traj.predictLanding(ball, bm);
        out.landing = landing;
        if (!landing) return out;

        // 후보별 접근 + 점프 갱신
        const duelPool = [];
        for (const c of candidates) {
            const player = c.player;
            const movement = c.movement;
            const jump = this._jumpFor(player);

            // 2. 접근 (어디로·얼마나 빨리)
            const ap = this._approach.evaluate(player, landing);
            const playerDist = Math.hypot(ball.x - player.x, ball.y - player.y);
            const tWin = this._traj.timeToWindow(bm);

            // 3·4. 점프 판단·타이밍 + 접촉·착지
            const js = jump.update(dt, {
                playerDist,
                ballHeight: ball.height ?? 0,
                timeToWindow: tWin,
                approachReady: !ap.reachable && playerDist < 8 ? true : ap.reachable && playerDist <= 8,
            });

            // 5. 위치 조정 — PlayerMovement에 위임 (중앙화 원칙)
            if (js.contact) {
                // 접촉 창구 — 제자리에서 점프·헤딩 자세 (이동 멈춤)
                movement.stop();
                movement.setFacingTarget(angleTo(player.x, player.y, ball.x, ball.y));
            } else if (ap.reachable) {
                movement.speed = ap.speed;
                movement.setFacingTarget(angleTo(player.x, player.y, ap.targetX, ap.targetY));
                movement.moveTo(ap.targetX, ap.targetY);
            } else {
                movement.stop();
                movement.setFacingTarget(angleTo(player.x, player.y, ball.x, ball.y));
            }
            movement.update(dt);

            out.intents.push({
                player,
                targetX: ap.targetX,
                targetY: ap.targetY,
                speed: ap.speed,
                phase: js.phase,
                contact: js.contact,
                jumpBoost: js.jumpBoost,
            });

            if (js.contact) {
                duelPool.push({
                    player,
                    movement,
                    ability: c.ability ?? this.o.headerSkill,
                    jumpBoost: js.jumpBoost,
                    contact: true,
                });
            }
        }

        if (duelPool.length === 0) return out;

        // 8. 경합 — 접촉 창구에 든 선수들 중 승자 1명만 헤딩한다
        let winnerEntry = duelPool[0];
        let contested = false;
        if (duelPool.length > 1 && (ctx.duel ?? true)) {
            const res = this._duel.resolve(duelPool, landing);
            if (!res) return out;
            winnerEntry = { player: res.winner, ability: res.ranked[0]?.ability ?? 0.5 };
            contested = res.contested;
        }

        // 6. 접촉 확인 — 승자가 볼에 닿을 수 있는지 최종 검증
        const winner = winnerEntry.player;
        const wDist = Math.hypot(winner.x - ball.x, winner.y - ball.y);
        if (wDist > this.o.contactRadius) return out;

        // 7. 헤딩 방향 결정 → 적용 (순간이동 없이 releaseAerial만)
        const type = ctx.type ?? HEADING_TYPE.PASS;
        const plan = this._exec.plan(winner, ball, {
            type,
            targetX: ctx.targetX,
            targetY: ctx.targetY,
            goalX: ctx.goalX,
            incomingSpeed: ctx.incomingSpeed ?? Math.hypot(bm.aerialState?.vx ?? 0, bm.aerialState?.vy ?? 0),
            incomingHeight: ctx.incomingHeight ?? ball.height ?? 0.5,
            headerSkill: ctx.headerSkill ?? winnerEntry.ability ?? this.o.headerSkill,
            clearDir: ctx.clearDir,
        });
        this._exec.apply(bm, plan);

        // 이번 비행 소비 — 같은 프레임 중복 헤딩 방지, 점프 상태 초기화
        this._consumed = true;
        for (const j of this._jumps.values()) j.resetFlight();

        out.header = { winner, plan, contested };
        return out;
    }
}

export { HEADING_TYPE, JUMP_PHASE };
