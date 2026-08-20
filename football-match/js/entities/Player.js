/**
 * Player - 선수 엔티티
 *
 * SVG 구조 (두 겹 그룹으로 등번호 회전 분리):
 *   <g.player transform="translate(x,y)">        ← 위치만 담당
 *     <g.player-body-group transform="rotate(θ)"> ← 방향만 담당
 *       <ellipse.player-foot />  × 2
 *       <circle.player-body />
 *       <circle.player-border />
 *     </g>
 *     <text.player-number />                      ← 회전 무관, 항상 정방향
 *   </g>
 *
 * 방향 규약 (SVG rotate 기준, fwd = (-sin θ, cos θ)):
 *   angle=0   → 발이 화면 아래(남), 전진 방향 (0, +1)
 *   angle=-90 → 발이 화면 오른쪽(동), 전진 방향 (+1, 0)
 *   angle=90  → 발이 화면 왼쪽(서), 전진 방향 (-1, 0)
 *   angle=180 → 발이 화면 위(북), 전진 방향 (0, -1)
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
        this._elOuter = null;  // 위치 그룹
        this._elInner = null;  // 회전 그룹
    }

    render(layerEl) {
        const ns = 'http://www.w3.org/2000/svg';
        const r = Player.BODY_RADIUS;
        const colors = TEAM_STYLE[this.team];

        // 외부 그룹: translate만 (등번호 포함)
        const outer = document.createElementNS(ns, 'g');
        outer.classList.add('player', `team-${this.team}`);

        // 내부 그룹: rotate만 (발, 몸통, 테두리)
        const inner = document.createElementNS(ns, 'g');
        inner.classList.add('player-body-group');

        // 발 (몸통보다 먼저 그려 몸통 아래에 위치)
        inner.appendChild(this._makeFoot(ns, -4, r - 3));
        inner.appendChild(this._makeFoot(ns,  4, r - 3));

        // 몸통
        const body = document.createElementNS(ns, 'circle');
        body.classList.add('player-body');
        body.setAttribute('cx', '0');
        body.setAttribute('cy', '0');
        body.setAttribute('r', String(r));
        body.setAttribute('fill', colors.body);
        inner.appendChild(body);

        // 흰색 테두리
        const border = document.createElementNS(ns, 'circle');
        border.classList.add('player-border');
        border.setAttribute('cx', '0');
        border.setAttribute('cy', '0');
        border.setAttribute('r', String(r));
        inner.appendChild(border);

        outer.appendChild(inner);

        // 등번호: 외부 그룹에 직접 배치 → 회전에 무관하게 항상 정방향
        const text = document.createElementNS(ns, 'text');
        text.classList.add('player-number');
        text.setAttribute('x', '0');
        text.setAttribute('y', '0');
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('dominant-baseline', 'central');
        text.setAttribute('font-size', '8');
        text.textContent = String(this.number);
        outer.appendChild(text);

        layerEl.appendChild(outer);
        this._elOuter = outer;
        this._elInner = inner;
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
        // 위치: 외부 그룹에만 적용
        if (this._elOuter) {
            this._elOuter.setAttribute('transform', `translate(${this.x}, ${this.y})`);
        }
        // 방향: 내부 그룹에만 적용 (텍스트는 영향 없음)
        if (this._elInner) {
            this._elInner.setAttribute('transform', `rotate(${this.angle})`);
        }
    }
}
