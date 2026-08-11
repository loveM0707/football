import { Vector2D } from './Vector2D.js';

/**
 * 경기장 좌표계는 미터 단위(0,0 = 좌상단)이며, 렌더링 시 SCALE(px/m)을 곱해
 * 캔버스 픽셀 좌표로 변환한다. 실제 규정 규격(105m x 68m, 골 폭 7.32m)을 사용해
 * 페널티 박스/골대/센터서클 등의 상대 위치가 실제 축구 경기장과 일치하도록 한다.
 */
export class Pitch {
  static LENGTH = 105;
  static WIDTH = 68;
  static SCALE = 10; // px per meter

  static GOAL_WIDTH = 7.32;
  static GOAL_DEPTH = 2;
  static PENALTY_BOX_LENGTH = 16.5;
  static PENALTY_BOX_WIDTH = 40.32;
  static GOAL_BOX_LENGTH = 5.5;
  static GOAL_BOX_WIDTH = 18.32;
  static PENALTY_SPOT_DIST = 11;
  static CENTER_CIRCLE_RADIUS = 9.15;
  static CORNER_ARC_RADIUS = 1;

  static get canvasWidth() {
    return this.LENGTH * this.SCALE;
  }

  static get canvasHeight() {
    return this.WIDTH * this.SCALE;
  }

  static center() {
    return new Vector2D(this.LENGTH / 2, this.WIDTH / 2);
  }

  static toCanvas(p) {
    return { x: p.x * this.SCALE, y: p.y * this.SCALE };
  }

  static goalYRange() {
    const half = this.GOAL_WIDTH / 2;
    return [this.WIDTH / 2 - half, this.WIDTH / 2 + half];
  }

  static clampInside(pos, margin = 0) {
    return new Vector2D(
      Math.min(this.LENGTH - margin, Math.max(margin, pos.x)),
      Math.min(this.WIDTH - margin, Math.max(margin, pos.y))
    );
  }

  static isBehindGoalLine(x) {
    return x <= 0 || x >= this.LENGTH;
  }

  static isOutOfBoundsY(y) {
    return y < 0 || y > this.WIDTH;
  }

  /** side: 0 = x<=0 골라인, 1 = x>=LENGTH 골라인. 골문 안이면 true */
  static isGoal(x, y) {
    const [top, bottom] = this.goalYRange();
    return this.isBehindGoalLine(x) && y >= top && y <= bottom;
  }

  static penaltyBoxRect(side) {
    // side: 'left' | 'right'
    const y0 = this.WIDTH / 2 - this.PENALTY_BOX_WIDTH / 2;
    const x0 = side === 'left' ? 0 : this.LENGTH - this.PENALTY_BOX_LENGTH;
    return { x: x0, y: y0, w: this.PENALTY_BOX_LENGTH, h: this.PENALTY_BOX_WIDTH };
  }

  static goalBoxRect(side) {
    const y0 = this.WIDTH / 2 - this.GOAL_BOX_WIDTH / 2;
    const x0 = side === 'left' ? 0 : this.LENGTH - this.GOAL_BOX_LENGTH;
    return { x: x0, y: y0, w: this.GOAL_BOX_LENGTH, h: this.GOAL_BOX_WIDTH };
  }

  static goalCenter(side) {
    return new Vector2D(side === 'left' ? 0 : this.LENGTH, this.WIDTH / 2);
  }
}
