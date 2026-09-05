/**
 * PassInterceptor - 지상 패스 차단·몸블록 공통 모듈
 *
 * 소유자 없이 굴러가는 지상 볼이 선수 몸에 닿았을 때 두 갈래로 해소한다:
 *   - 컨트롤 가능 (볼을 정면으로 마주 + 반응 거리 확보 + 볼 속도 이하)
 *       → 가로채기: 즉시 소유 전환 (onControl 콜백으로 상위 레이어에 위임)
 *   - 컨트롤 불가 (너무 근접, 방향전환 미완료, 볼 과속)
 *       → 몸블록: 진행 방향을 선수 몸에 반사시켜 감속 튕겨 나옴 (onBlock)
 *
 * 재사용: Player/Ball 엔티티와 BallMovement만 사용 — 어떤 메뉴에서도 조립 가능.
 * 상위 레이어는 exclude로 지정 수신자를 빼고, onControl/onBlock에서
 * 기존 모듈(BallReception, PossessionContest 흐름 등)과 연결한다.
 */
import { Player } from '../entities/Player.js';
import { Ball }   from '../entities/Ball.js';
import { angleTo, angleDiff } from './Direction.js';

const DEFAULT_CONTROL_SPEED = 160;      // 이 속도 이하일 때만 컨트롤 성공
const DEFAULT_CONTROL_MIN_DIST = 11;    // 이보다 근접 접촉은 반응 불가 → 블록
const DEFAULT_FACING_TOLERANCE = 75;    // 볼 진입 방향 대비 몸 정렬 허용 오차(도)
const DEFAULT_DEFLECT_SPEED = 150;      // 블록 후 튕겨 나가는 속도 기준
const DEFAULT_CONTACT_RADIUS_PAD = 2;   // 접촉 판정 여유
const DEFAULT_STUN_DURATION = 0.18;     // 블록당한 선수의 미세 정지 (재접촉 연타 방지)
const DEFAULT_SCRUM_WINDOW = 2.0;       // 스크럼 판정 시간창 (초)
const DEFAULT_SCRUM_BLOCKS = 4;         // 창구 내 이 횟수만큼 블록되면 다음 접촉은 강제 컨트롤

export class PassInterceptor {
    /**
     * @param {Player[]}           players      판정 대상 선수 목록 (GK 제외 권장)
     * @param {PlayerMovement[]}   movements    players와 같은 순서의 이동 모듈
     * @param {BallMovement}       bm
     * @param {object} [options]
     *   controlSpeed         {number}
     *   controlMinDist       {number}
     *   facingTolerance      {number}
     *   deflectSpeed         {number}
     *   contactRadiusPad     {number}
     *   stunDuration         {number}
     *   onControl            {function(player, idx)} 가로채기 성공 (소유 전환 완료 상태)
     *   onBlock              {function(player, idx)} 몸에 맞고 튕김
     *   scrumWindow          {number} 스크럼 판정 시간창 (초, 기본 2.0)
     *   scrumBlocks          {number} 강제 컨트롤 발동 블록 횟수 (기본 4)
     */
    constructor(players, movements, ballMovement, options = {}) {
        this.players = players.slice();
        this.movements = movements;
        this.bm = ballMovement;

        this.controlSpeed = options.controlSpeed ?? DEFAULT_CONTROL_SPEED;
        this.controlMinDist = options.controlMinDist ?? DEFAULT_CONTROL_MIN_DIST;
        this.facingTolerance = options.facingTolerance ?? DEFAULT_FACING_TOLERANCE;
        this.deflectSpeed = options.deflectSpeed ?? DEFAULT_DEFLECT_SPEED;
        this.radiusPad = options.contactRadiusPad ?? DEFAULT_CONTACT_RADIUS_PAD;
        this.stunDuration = options.stunDuration ?? DEFAULT_STUN_DURATION;
        this.onControl = options.onControl ?? (() => {});
        this.onBlock = options.onBlock ?? (() => {});

        /** 매 프레임 시나리오/AI가 지정 수신자를 제외할 때 사용 */
        this.exclude = null;

        this._stun = new Array(this.players.length).fill(0);
        this._active = false;
        // 스크럼 해소용 블록 기록 — 밀집 스크럼에서 몸블록만 반복돼 볼이
        // 영원히 무소유로 핑퐁되는 데드락을 끊는다 (아래 update 참조)
        this._clock = 0;
        this._blockTimes = [];
        this.scrumWindow = options.scrumWindow ?? DEFAULT_SCRUM_WINDOW;
        this.scrumBlocks = options.scrumBlocks ?? DEFAULT_SCRUM_BLOCKS;
    }

    start() {
        this._active = true;
        this._stun.fill(0);
        this._blockTimes.length = 0;
    }

    stop() {
        this._active = false;
    }

    /**
     * 매 프레임 호출.
     * @returns {{ type: 'control'|'block', player: Player, idx: number, forced?: boolean } | null}
     */
    update(dt) {
        if (!this._active) return null;
        const bm = this.bm;
        // 소유 중이거나 공중·바운드 볼은 대상 아님 (지상 패스 전용)
        // 소유가 해소되면 스크럼 기록도 초기화 (외부 경로로 정상화된 경우)
        if (bm.owner || bm.isAerial || bm.isBouncing) {
            if (bm.owner) this._blockTimes.length = 0;
            return null;
        }
        const spd = Math.hypot(bm.vx, bm.vy);

        // 시계·기록 정리는 저속 리턴보다 먼저 — 느린 볼 기간에도 시간창이 흘러
        // 오래된 블록 기록이 나중에 부활해 엉뚱한 강제 컨트롤을 만들지 않게 한다.
        this._clock += dt;
        while (this._blockTimes.length > 0 && this._clock - this._blockTimes[0] > this.scrumWindow) {
            this._blockTimes.shift();
        }
        if (spd < 40) return null; // 느린 볼은 수령 모듈 영역

        const R = Player.BODY_RADIUS + Ball.RADIUS + this.radiusPad;

        // 스크럼 해소 판정 — 시간창 안 블록이 임계치를 넘으면 다음 접촉은 강제 컨트롤.
        // 밀집 시 접촉이 근거리(d<11)·역방향으로만 일어나 컨트롤 조건을 영원히 못 만나고
        // 블록→재가속→블록 핑퐁으로 볼이 무소유로 도는 데드락을 끊는다.
        const scrumTrip = this._blockTimes.length >= this.scrumBlocks;

        for (let i = 0; i < this.players.length; i++) {
            if (this._stun[i] > 0) { this._stun[i] -= dt; continue; }
            const p = this.players[i];
            if (this.exclude === p) continue;

            const dx = bm.ball.x - p.x;
            const dy = bm.ball.y - p.y;
            const d = Math.hypot(dx, dy);
            if (d > R) continue;

            // ── 접촉 ──
            const incomingAngle = angleTo(bm.ball.x, bm.ball.y, p.x, p.y);
            const facingErr = Math.abs(angleDiff(incomingAngle, p.angle));
            const canControl = d >= this.controlMinDist
                && facingErr <= this.facingTolerance
                && spd <= this.controlSpeed;

            if (canControl || (scrumTrip && d <= R)) {
                // 가로채기: 즉시 소유 — 상위 레이어가 드리블/위상 전환을 잇는다
                // (scrumTrip이면 강제 해소 — 일반 컨트롤과 동일하게 처리)
                bm.possess(p, Player.BODY_RADIUS + 8);
                bm.snapToFront();
                this._blockTimes.length = 0;
                this.onControl(p, i);
                if (scrumTrip && !canControl) {
                    return { type: 'control', player: p, idx: i, forced: true };
                }
                return { type: 'control', player: p, idx: i };
            }

            // 몸블록: 진행 방향을 선수 중심 법선으로 반사 + 랜덤 산포 → 감속 튕김
            const nx = dx / (d || 1);
            const ny = dy / (d || 1);
            const dot = bm.vx * nx + bm.vy * ny;
            let rvx = bm.vx - 2 * dot * nx;
            let rvy = bm.vy - 2 * dot * ny;
            const spread = (Math.random() - 0.5) * 0.9; // ±26° 산포
            const cos = Math.cos(spread), sin = Math.sin(spread);
            const sx = rvx * cos - rvy * sin;
            const sy = rvx * sin + rvy * cos;
            const mag = Math.hypot(sx, sy) || 1;
            const outSpeed = this.deflectSpeed * (0.7 + Math.random() * 0.5);
            bm.release((sx / mag) * outSpeed, (sy / mag) * outSpeed);

            this._stun[i] = this.stunDuration;
            this._blockTimes.push(this._clock);
            const mv = this.movements[i];
            if (mv && mv.stop) mv.stop(); // 맞고 비틀거리는 표현
            this.onBlock(p, i);
            return { type: 'block', player: p, idx: i };
        }
        return null;
    }
}
