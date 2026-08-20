/**
 * Ball - 공 엔티티
 * SVG 요소를 생성·관리하며, 위치 동기화만 담당한다.
 * 이동 로직은 추후 별도 이동 모듈(BallMovement 등)에서 처리한다.
 */
export class Ball {
    static RADIUS = 7;

    constructor(x, y) {
        this.x = x;
        this.y = y;
        this._el = null;
    }

    /** SVG 레이어에 공 요소를 생성하고 렌더링한다. */
    render(layerEl) {
        const ns = 'http://www.w3.org/2000/svg';

        const g = document.createElementNS(ns, 'g');
        g.classList.add('ball');

        // 그림자 (공이 지면 위에 있는 느낌)
        const shadow = document.createElementNS(ns, 'ellipse');
        shadow.classList.add('ball-shadow');
        shadow.setAttribute('cx', '3');
        shadow.setAttribute('cy', '4');
        shadow.setAttribute('rx', String(Ball.RADIUS * 0.9));
        shadow.setAttribute('ry', String(Ball.RADIUS * 0.5));

        // 공 본체
        const circle = document.createElementNS(ns, 'circle');
        circle.classList.add('ball-body');
        circle.setAttribute('cx', '0');
        circle.setAttribute('cy', '0');
        circle.setAttribute('r', String(Ball.RADIUS));

        g.appendChild(shadow);
        g.appendChild(circle);
        layerEl.appendChild(g);
        this._el = g;
        this._syncTransform();
        return this;
    }

    /** 공 위치를 갱신한다. */
    setPosition(x, y) {
        this.x = x;
        this.y = y;
        this._syncTransform();
        return this;
    }

    _syncTransform() {
        if (this._el) {
            this._el.setAttribute('transform', `translate(${this.x}, ${this.y})`);
        }
    }
}
