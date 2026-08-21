/**
 * IdleMovement - 볼 없는 선수의 자연스러운 미세 움직임 모듈
 *
 * 선수가 완전히 정지해 있지 않고 홈 포지션 근처에서 약간씩 움직이도록 한다.
 * 주기적으로 새 목표 좌표(앵커 ±AMPLITUDE)를 정해 천천히 이동한다.
 *
 * 사용법:
 *   const idle = new IdleMovement(playerCount);
 *   // tick 안에서, 해당 선수가 다른 이동 없이 대기 중일 때:
 *   idle.update(dt, player, idx, anchorX, anchorY);
 */
export class IdleMovement {
    static SPEED     = 12;   // SVG/s — 느린 체중 이동
    static AMPLITUDE = 5;    // SVG   — 앵커로부터 최대 이탈 거리
    static T_MIN     = 0.5;  // 초    — 방향 전환 최소 간격
    static T_MAX     = 1.5;  // 초    — 방향 전환 최대 간격

    /**
     * @param {number} count  관리할 선수 수
     */
    constructor(count) {
        this._s = Array.from({ length: count }, () => ({
            tx: 0, ty: 0, timer: 0,
        }));
    }

    /**
     * 특정 선수 한 명의 미세 움직임을 업데이트한다.
     *
     * @param {number} dt
     * @param {Player} player
     * @param {number} idx      _s 인덱스 (선수 번호와 매핑)
     * @param {number} anchorX  기준 위치 X (보통 homePositions[idx].x)
     * @param {number} anchorY  기준 위치 Y
     */
    update(dt, player, idx, anchorX, anchorY) {
        const s = this._s[idx];
        s.timer -= dt;
        if (s.timer <= 0) {
            const angle = Math.random() * Math.PI * 2;
            const r     = Math.random() * IdleMovement.AMPLITUDE;
            s.tx    = anchorX + Math.cos(angle) * r;
            s.ty    = anchorY + Math.sin(angle) * r;
            s.timer = IdleMovement.T_MIN
                + Math.random() * (IdleMovement.T_MAX - IdleMovement.T_MIN);
        }
        const dx   = s.tx - player.x;
        const dy   = s.ty - player.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 0.5) {
            const step = Math.min(IdleMovement.SPEED * dt, dist);
            player.setPosition(
                player.x + (dx / dist) * step,
                player.y + (dy / dist) * step,
            );
        }
    }
}
