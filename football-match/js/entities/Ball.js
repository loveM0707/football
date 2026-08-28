/**
 * Ball - 공 엔티티
 * SVG 요소를 생성·관리하며, 위치·높이 동기화만 담당한다.
 * 이동 로직은 BallMovement에서 처리한다.
 */
export class Ball {
    static RADIUS = 5;

    constructor(x, y) {
        this.x = x;
        this.y = y;
        this._el       = null;
        this._elCircle = null;
        this._elShadow = null;
        this._height   = 0; // 0 = 지면, 1 = 최고점 (공중)
    }

    render(layerEl) {
        const ns = 'http://www.w3.org/2000/svg';
        const g = document.createElementNS(ns, 'g');
        g.classList.add('ball');

        const shadow = document.createElementNS(ns, 'ellipse');
        shadow.classList.add('ball-shadow');
        shadow.setAttribute('cx', '3');
        shadow.setAttribute('cy', '4');
        shadow.setAttribute('rx', String(Ball.RADIUS * 0.9));
        shadow.setAttribute('ry', String(Ball.RADIUS * 0.5));

        const circle = document.createElementNS(ns, 'circle');
        circle.classList.add('ball-body');
        circle.setAttribute('cx', '0');
        circle.setAttribute('cy', '0');
        circle.setAttribute('r',  String(Ball.RADIUS));

        g.appendChild(shadow);
        g.appendChild(circle);
        layerEl.appendChild(g);

        this._el       = g;
        this._elShadow = shadow;
        this._elCircle = circle;
        this._height   = 0;
        this._syncTransform();
        return this;
    }

    setPosition(x, y) {
        this.x = x;
        this.y = y;
        this._syncTransform();
        return this;
    }

    /**
     * 공의 높이를 설정한다 (0=지면, 1=최고점).
     * 볼이 위로 떠오르고 커지며, 그림자가 아래에 남아 공중감을 표현한다.
     */
    setHeight(h) {
        this._height = Math.max(0, Math.min(1, h));
        this._syncAerial();
        return this;
    }

    get height() { return this._height; }

    _syncTransform() {
        if (this._el) {
            this._el.setAttribute('transform', `translate(${this.x}, ${this.y})`);
            // 드리블 시 볼이 발 아래로 들어가 감춰지는 현상 방지 — 볼을 항상 최상단에 렌더
            if (this._el.parentNode && this._el.parentNode.lastElementChild !== this._el) {
                this._el.parentNode.appendChild(this._el);
            }
        }
    }

    _syncAerial() {
        if (!this._elCircle || !this._elShadow) return;
        const h = this._height;
        // 볼: 위로 떠오르고 커짐 (높이감 표현)
        this._elCircle.setAttribute('cy', String(-(h * 28)));
        this._elCircle.setAttribute('r',  String(Ball.RADIUS * (1 + h * 0.7)));
        // 그림자: 볼과 반대로 낮게 남으며 넓게 퍼짐
        this._elShadow.setAttribute('cx', String(3 + h * 2));
        this._elShadow.setAttribute('cy', String(4 + h * 8));
        this._elShadow.setAttribute('rx', String(Ball.RADIUS * (0.9 + h * 0.5)));
        this._elShadow.setAttribute('ry', String(Ball.RADIUS * (0.5 + h * 0.3)));
    }
}
