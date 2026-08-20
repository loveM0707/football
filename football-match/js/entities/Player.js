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
 */

const TEAM_STYLE = {
    home: { body: '#d93535' },
    away: { body: '#2e6fd9' },
};

const FOOT_COLOR = '#1a1a1a';

export class Player {
    static BODY_RADIUS = 10;

    constructor({ x, y, team, number, angle = 0 }) {
        this.x = x;
        this.y = y;
        this.team = team;
        this.number = number;
        this.angle = angle;
        this._el = null;
    }

    render(layerEl) {
        const ns = 'http://www.w3.org/2000/svg';
        const r = Player.BODY_RADIUS;
        const colors = TEAM_STYLE[this.team];

        const g = document.createElementNS(ns, 'g');
        g.classList.add('player', `team-${this.team}`);

        // 발: 몸통보다 먼저 그려 몸통 아래 위치, 대부분 몸통 안에 숨겨짐
        g.appendChild(this._makeFoot(ns, -4, r - 3));
        g.appendChild(this._makeFoot(ns,  4, r - 3));

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

        // 등번호 (SVG 사용자 단위로 직접 지정)
        const text = document.createElementNS(ns, 'text');
        text.classList.add('player-number');
        text.setAttribute('x', '0');
        text.setAttribute('y', '3');
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('font-size', '8');
        text.textContent = String(this.number);
        g.appendChild(text);

        layerEl.appendChild(g);
        this._el = g;
        this._syncTransform();
        return this;
    }

    setPosition(x, y) {
        this.x = x;
        this.y = y;
        this._syncTransform();
        return this;
    }

    setAngle(deg) {
        this.angle = deg;
        this._syncTransform();
        return this;
    }

    _makeFoot(ns, cx, cy) {
        const foot = document.createElementNS(ns, 'ellipse');
        foot.classList.add('player-foot');
        foot.setAttribute('cx', String(cx));
        foot.setAttribute('cy', String(cy));
        foot.setAttribute('rx', '3');
        foot.setAttribute('ry', '5');
        foot.setAttribute('fill', FOOT_COLOR);
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
