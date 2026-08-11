import { Vector2D } from '../entities/Vector2D.js';
import { Pitch } from '../entities/Pitch.js';

/**
 * 기본은 경기장 전체를 항상 보여주는 'FULL' 모드(전형적인 FM 2D 전술판 뷰).
 * 'FOLLOW' 모드로 전환하면 공을 부드럽게 따라가며 확대해 좀 더 몰입감 있는 시점을 제공한다.
 */
export class Camera {
  constructor() {
    this.mode = 'FULL'; // 'FULL' | 'FOLLOW'
    this.zoom = 1;
    this.lookAt = Pitch.center();
  }

  toggleMode() {
    this.mode = this.mode === 'FULL' ? 'FOLLOW' : 'FULL';
  }

  update(ball, dt) {
    if (this.mode === 'FOLLOW') {
      const targetZoom = 1.8;
      this.zoom += (targetZoom - this.zoom) * Math.min(1, dt * 2);
      const lerpT = Math.min(1, dt * 2.2);
      this.lookAt = Vector2D.lerp(this.lookAt, ball.position, lerpT);
      this.lookAt = this._clampLookAt(this.lookAt);
    } else {
      this.zoom += (1 - this.zoom) * Math.min(1, dt * 3);
      this.lookAt = Vector2D.lerp(this.lookAt, Pitch.center(), Math.min(1, dt * 3));
    }
  }

  _clampLookAt(pos) {
    const viewHalfW = Pitch.canvasWidth / 2 / this.zoom / Pitch.SCALE;
    const viewHalfH = Pitch.canvasHeight / 2 / this.zoom / Pitch.SCALE;
    const minX = Math.min(Pitch.LENGTH / 2, viewHalfW);
    const minY = Math.min(Pitch.WIDTH / 2, viewHalfH);
    return new Vector2D(
      Math.min(Pitch.LENGTH - minX, Math.max(minX, pos.x)),
      Math.min(Pitch.WIDTH - minY, Math.max(minY, pos.y))
    );
  }

  /** ctx.save() 이후 호출하고, 그리기가 끝나면 ctx.restore()로 되돌려야 한다 */
  applyTransform(ctx) {
    const lookPx = Pitch.toCanvas(this.lookAt);
    ctx.translate(Pitch.canvasWidth / 2, Pitch.canvasHeight / 2);
    ctx.scale(this.zoom, this.zoom);
    ctx.translate(-lookPx.x, -lookPx.y);
  }
}
