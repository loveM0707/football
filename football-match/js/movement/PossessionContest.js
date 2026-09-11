/**
 * PossessionContest - 태클로 인한 루즈볼 공방 모듈
 *
 * 수비수가 볼을 쳐내면(태클) 볼은 즉시 누구의 소유도 아닌 루즈볼이 된다.
 * 양 선수가 루즈볼을 향해 달려가 먼저 소유한 선수가 새 볼 보유자(공격수)가 된다.
 *
 * 실제 축구 공통 로직이므로 메뉴/실경기 어디서든 재사용한다.
 *
 * 사용법:
 *   const contest = new PossessionContest(playerA, pmA, playerB, pmB, ballMovement, {
 *       pokeSpeed: 200, catchDistance: 14,
 *   });
 *
 *   // 태클로 루즈볼 생성 (수비수/태클러가 볼을 쳐냄)
 *   contest.start(tackler, {
 *       onLoose: () => { 루즈볼 상태 진입 처리 },
 *       onPossession: (winner) => { winner 소유 시 역할 전환 처리 },
 *   });
 */
import { PlayerMovement } from './PlayerMovement.js';
import { CollisionSystem } from './CollisionSystem.js';

const DEFAULT_POKE_SPEED = 200;
const DEFAULT_CATCH_DISTANCE = 14;
const DEFAULT_MAX_POSSESS_SPEED = 70;
const DEFAULT_CHASE_SPEED = PlayerMovement.SPEEDS[4];
const DEFAULT_POSSESS_OFFSET = 19;
const DEFAULT_STUN_DURATION = 0.2; // 볼을 빼앗긴 선수의 정지 모션 (자세 흐트러짐)
// 태클 시 수비수가 바로 소유를 가져가는 비율 (0~1). 나머지는 볼을 쳐내 루즈볼 → 공방.
const DEFAULT_STEAL_CHANCE = 0.45;
// 스틸 시 볼에 남기는 미세 속도 — 발 근처에 떨어져 수비수가 즉시 소유 판정을 받는다
const STEAL_TOUCH_SPEED = 30;

export class PossessionContest {
    /**
     * @param {Player}  playerA   경합 선수 A
     * @param {object}  pmA       A의 PlayerMovement
     * @param {Player}  playerB   경합 선수 B
     * @param {object}  pmB       B의 PlayerMovement
     * @param {object}  bm        BallMovement
     * @param {object}  options
     *   pokeSpeed          {number} 태클로 쳐낼 속도 (기본 200)
     *   catchDistance      {number} 소유 판정 거리 (기본 14)
     *   maxPossessSpeed    {number} 이 속도 이하일 때 소유 가능 (기본 70)
     *   chaseSpeed         {number} 루즈볼 추적 속도 (기본 SPEEDS[4])
     *   possessOffset      {number} 소유 오프셋 (기본 19)
     *   stunDuration       {number} 볼을 빼앗긴 선수의 정지 시간 (기본 0.2초)
     *   stealChance        {number} 태클 시 수비가 바로 소유를 가져갈 확률 (기본 0.45,
     *                               나머지는 볼을 쳐내 루즈볼 공방)
     */
    constructor(playerA, pmA, playerB, pmB, bm, options = {}) {
        this._a = playerA;
        this._pmA = pmA;
        this._b = playerB;
        this._pmB = pmB;
        this._bm = bm;

        this._pokeSpeed = options.pokeSpeed ?? DEFAULT_POKE_SPEED;
        this._catchDistance = options.catchDistance ?? DEFAULT_CATCH_DISTANCE;
        this._maxPossessSpeed = options.maxPossessSpeed ?? DEFAULT_MAX_POSSESS_SPEED;
        this._chaseSpeed = options.chaseSpeed ?? DEFAULT_CHASE_SPEED;
        this._possessOffset = options.possessOffset ?? DEFAULT_POSSESS_OFFSET;
        this._stunDuration = options.stunDuration ?? DEFAULT_STUN_DURATION;
        this._stealChance = options.stealChance ?? DEFAULT_STEAL_CHANCE;

        this._active = false;
        this._onLoose = null;
        this._onPossession = null;
        // 볼을 빼앗긴 선수 (자세 흐트러짐으로 잠시 정지)
        this._stunned = null;
        this._stunTimer = 0;
    }

    get active() { return this._active; }

    /**
     * 태클로 루즈볼을 생성한다. tackler가 볼을 반대 방향으로 쳐낸다.
     * @param {Player} tackler   볼을 쳐낸 선수
     * @param {object} callbacks
     *   onLoose       ()                 루즈볼 상태 진입 시
     *   onPossession  (winner: Player)   볼을 소유한 선수 결정 시
     */
    start(tackler, callbacks = {}) {
        this._active = true;
        this._onLoose = callbacks.onLoose ?? null;
        this._onPossession = callbacks.onPossession ?? null;

        // 태클 직전 볼을 소유하던 선수 = 볼을 빼앗긴 선수 → 잠시 정지 (자세 흐트러짐)
        // 스탠 해제 전까지 소유 판정에서도 제외된다(update).
        const previousOwner = this._bm.owner;
        if (previousOwner && previousOwner !== tackler) {
            this._stunned = previousOwner;
            this._stunTimer = this._stunDuration;
            // 빼앗긴 선수는 즉시 이동 중지
            if (previousOwner === this._a) this._pmA.stop();
            else if (previousOwner === this._b) this._pmB.stop();
        } else {
            this._stunned = null;
            this._stunTimer = 0;
        }

        // 태클 결과 이원화:
        //   스틸  — 볼을 짧게 터치해 발근처에 둠 → 수비수가 즉시 소유 판정 ("바로 뺏기")
        //   포크  — 볼을 반대 방향으로 쳐냄 → 루즈볼 공방 ("쳐내기")
        if (Math.random() < this._stealChance) {
            const touch = CollisionSystem.bounceVelocity(tackler, this._bm.ball, STEAL_TOUCH_SPEED);
            this._bm.release(touch.vx, touch.vy);
        } else {
            const { vx, vy } = CollisionSystem.bounceVelocity(tackler, this._bm.ball, this._pokeSpeed);
            this._bm.release(vx, vy);
        }

        if (this._onLoose) this._onLoose();
    }

    stop() {
        this._active = false;
        this._pmA.stop();
        this._pmB.stop();
        this._onLoose = null;
        this._onPossession = null;
        this._stunned = null;
        this._stunTimer = 0;
    }

    /**
     * 매 프레임 호출.
     * @returns {Player|null} 이번 프레임에 소유가 결정되면 승자, 아니면 null
     */
    update(dt) {
        if (!this._active) return null;

        // 볼을 빼앗긴 선수의 정지 타이머 감소
        if (this._stunned) {
            this._stunTimer -= dt;
            if (this._stunTimer <= 0) {
                this._stunned = null;
                this._stunTimer = 0;
            }
        }

        // 양 선수가 루즈볼을 향해 질주 (빼앗긴 선수는 자세 회복 전까지 정지)
        this._pmA.speed = this._chaseSpeed;
        this._pmB.speed = this._chaseSpeed;
        this._pmA.clearFacingTarget();
        this._pmB.clearFacingTarget();
        if (this._stunned !== this._a) this._pmA.moveTo(this._bm.ball.x, this._bm.ball.y);
        if (this._stunned !== this._b) this._pmB.moveTo(this._bm.ball.x, this._bm.ball.y);

        this._pmA.update(dt);
        this._pmB.update(dt);
        this._bm.update(dt);

        // 볼 속도가 충분히 낮을 때만 소유 판정
        const speed = Math.hypot(this._bm.vx, this._bm.vy);
        if (speed > this._maxPossessSpeed) return null;

        // 스탠 중인(볼을 빼앗긴) 선수는 자세 회복 전까지 소유 판정 제외 — 0.2초 딜레이
        const aEligible = this._stunned !== this._a;
        const bEligible = this._stunned !== this._b;
        if (!aEligible && !bEligible) return null;

        const distA = Math.hypot(this._bm.ball.x - this._a.x, this._bm.ball.y - this._a.y);
        const distB = Math.hypot(this._bm.ball.x - this._b.x, this._bm.ball.y - this._b.y);
        const minDist = Math.min(aEligible ? distA : Infinity, bEligible ? distB : Infinity);

        if (minDist <= this._catchDistance) {
            const winner = aEligible && (!bEligible || distA <= distB) ? this._a : this._b;
            this._active = false;
            this._pmA.stop();
            this._pmB.stop();
            this._bm.possess(winner, this._possessOffset);
            this._bm.snapToFront();
            this._stunned = null;
            this._stunTimer = 0;
            if (this._onPossession) this._onPossession(winner);
            return winner;
        }

        return null;
    }
}
