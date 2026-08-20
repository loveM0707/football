/**
 * Player - 선수 엔티티
 *
 * 렌더링 구조 (SVG <g> 계층):
 *   <g.player transform="translate(x,y) rotate(angle)">
 *     <ellipse.player-foot />  × 2  (몸통 아래 살짝 보임, 움직임 방향과 함께 회전)
 *     <circle.player-body />        (팀 색상 원)
 *     <circle.player-border />      (흰색 테두리)
 *     <text.player-number />        (등번호)
 *   </g>
 *
 * angle=0 → 발이 화면 아래쪽을 향함 (기본 대기 자세)
 * angle=N → 시계방향 N도 회전 (이동 방향과 일치하도록 이동 모듈이 갱신)
 *
 * 이동·행동 로직은 추후 별도 이동 모듈(PlayerMovement 등)에서 처리한다.
 */

const TEAM_STYLE = {
    home: { body: '#d93535' },
    away: { body: '#2e6fd9' },
};

const FOOT_COLOR = '#1a1a1a';

export class Player {
    static BODY_RADIUS = 14;

    /**
     * @param {object} options
     * @param {number} options.x
     * @param {number} options.y
     * @param {'home'|'away'} options.team
     * @param {number} options.number  등번호
     * @param {number} [options.angle] 초기 회전각(도), 기본 0
     */
    constructor({ x, y, team, number, angle = 0 }) {
        this.x = x;
        this.y = y;
        this.team = team;
        this.number = number;
        this.angle = angle;
        this._el = null;
    }

    /** SVG 레이어에 선수 요소를 생성하고 렌더링한다. */
    render(layerEl) {
        const ns = 'http://www.w3.org/2000/svg';
        const r = Player.BODY_RADIUS;
        const colors = TEAM_STYLE[this.team];

        const g = document.createElementNS(ns, 'g');
        g.classList.add('player', `team-${this.team}`);

        // 왼발 — 몸통보다 먼저 그려서 몸통 뒤에 위치, 대부분 몸통 안에 숨겨짐
        g.appendChild(this._makeFoot(ns, -5, r - 4, FOOT_COLOR));
        // 오른발
        g.appendChild(this._makeFoot(ns, 5, r - 4, FOOT_COLOR));

        // 몸통
        const body = document.createElementNS(ns, 'circle');
        body.classList.add('player-body');
        body.setAttribute('cx', '0');
        body.setAttribute('cy', '0');
        body.setAttribute('r', String(r));
        body.setAttribute('fill', colors.body);
        g.appendChild(body);

        // 흰색 테두리
        const border = document.createElementNS(ns, 'circle');
        border.classList.add('player-border');
        border.setAttribute('cx', '0');
        border.setAttribute('cy', '0');
        border.setAttribute('r', String(r));
        g.appendChild(border);

        // 등번호
        const text = document.createElementNS(ns, 'text');
        text.classList.add('player-number');
        text.setAttribute('x', '0');
        text.setAttribute('y', '4');
        text.setAttribute('text-anchor', 'middle');
        text.textContent = String(this.number);
        g.appendChild(text);

        layerEl.appendChild(g);
        this._el = g;
        this._syncTransform();
        return this;
    }

    /** 선수 위치를 갱신한다. */
    setPosition(x, y) {
        this.x = x;
        this.y = y;
        this._syncTransform();
        return this;
    }

    /**
     * 선수가 바라보는 방향(각도)을 갱신한다.
     * @param {number} deg 시계방향 각도 (0 = 발이 아래를 향하는 기본 자세)
     */
    setAngle(deg) {
        this.angle = deg;
        this._syncTransform();
        return this;
    }

    _makeFoot(ns, cx, cy, fill) {
        const foot = document.createElementNS(ns, 'ellipse');
        foot.classList.add('player-foot');
        foot.setAttribute('cx', String(cx));
        foot.setAttribute('cy', String(cy));
        foot.setAttribute('rx', '4');
        foot.setAttribute('ry', '6');
        foot.setAttribute('fill', fill);
        return foot;
    }

    _syncTransform() {
        if (this._el) {
            this._el.setAttribute(
                'transform',
                `translate(${this.x}, ${this.y}) rotate(${this.angle})`
            );
        }
    }
}
