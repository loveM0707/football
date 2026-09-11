/**
 * AerialApproach - 공중볼 접근 공통 모듈
 *
 * 2. 공중볼 접근을 전담한다.
 * 낙하지점·남은 시간·선수 속도를 받아 "어디로·얼마나 빨리"를 정한다.
 * (Decision + Intent — 실제 이동은 호출자가 PlayerMovement로 수행한다)
 *
 * BallReception._trackAerial/BallReception._trackBounce/시나리오 3곳의
 * 착지점 추적 코드를 이 모듈 하나로 통합한다.
 * 크로스·코너킥·롱패스·골킥 모두 같은 기준으로 접근한다.
 */
import { PlayerMovement } from './PlayerMovement.js';

const SPEEDS = PlayerMovement.SPEEDS; // [50, 75, 100, 125, 150]

const DEFAULTS = {
    arriveMargin: 0.12,  // 낙하보다 이만큼 일찍 도착한다 (자세 잡기 여유)
    maxDist: 320,        // 이보다 멀면 추적하지 않는다 (체력 낭비 방지)
    minSpeed: SPEEDS[1],
    maxSpeed: SPEEDS[4],
};

export class AerialApproach {
    constructor(options = {}) {
        this.o = { ...DEFAULTS, ...options };
    }

    /**
     * 접근 의도를 계산한다.
     * @param {object} player 선수 { x, y }
     * @param {object} landing 낙하지점 { x, y, time }
     * @returns {{ reachable: boolean, targetX: number, targetY: number,
     *             speed: number, urgency: number, reason: string }}
     */
    evaluate(player, landing) {
        const o = this.o;
        const deny = (reason) => ({
            reachable: false, targetX: player.x, targetY: player.y,
            speed: SPEEDS[0], urgency: 0, reason,
        });
        if (!landing) return deny('비행 중 아님');
        if (landing.time <= 0.02) return deny('착지 임박');

        const dx = landing.x - player.x;
        const dy = landing.y - player.y;
        const dist = Math.hypot(dx, dy);
        if (dist > o.maxDist) return deny('도달 불가 거리');
        // 이미 낙하지점에 서 있으면 움직이지 않는다 (왕복 진동 방지)
        if (dist < 6) {
            return {
                reachable: true, targetX: player.x, targetY: player.y,
                speed: SPEEDS[0], urgency: 0.2, reason: '위치 선점 완료',
            };
        }

        // 여유를 두고 도착하도록 필요 속도 역산
        const timeAvail = Math.max(0.05, landing.time - o.arriveMargin);
        const required = dist / timeAvail;
        if (required > o.maxSpeed * 1.05) return deny('시간 내 도달 불가');

        // 속도는 5단계 중 필요 속도를 감당하는 최소 단계 (자연스러운 완급)
        let speed = o.maxSpeed;
        for (const s of SPEEDS) {
            if (s >= required) { speed = s; break; }
        }
        speed = Math.max(o.minSpeed, Math.min(o.maxSpeed, speed));

        const urgency = Math.max(0.2, Math.min(1, required / o.maxSpeed));
        return {
            reachable: true,
            targetX: landing.x,
            targetY: landing.y,
            speed,
            urgency,
            reason: '낙하지점 접근',
        };
    }
}
