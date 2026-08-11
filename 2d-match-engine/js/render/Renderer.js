import { Pitch } from '../entities/Pitch.js';

const S = Pitch.SCALE;

/** 계산된 데이터를 화면에 그리기만 하는 순수 렌더러. 로직은 포함하지 않는다(로직/뷰 분리). */
export class Renderer {
  constructor(ctx) {
    this.ctx = ctx;
  }

  clear() {
    this.ctx.clearRect(0, 0, Pitch.canvasWidth, Pitch.canvasHeight);
  }

  drawPitch() {
    const ctx = this.ctx;
    const w = Pitch.canvasWidth;
    const h = Pitch.canvasHeight;
    const centerX = w / 2;
    const centerY = h / 2;

    const darkGreen = '#256b20';
    const lightGreen = '#2c7a26';
    ctx.fillStyle = darkGreen;
    ctx.fillRect(0, 0, w, h);

    const numStripes = 12;
    const stripeW = w / numStripes;
    for (let i = 0; i < numStripes; i++) {
      if (i % 2 === 0) {
        ctx.fillStyle = lightGreen;
        ctx.fillRect(i * stripeW, 0, stripeW, h);
      }
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2;

    ctx.strokeRect(1, 1, w - 2, h - 2);

    ctx.beginPath();
    ctx.moveTo(centerX, 0);
    ctx.lineTo(centerX, h);
    ctx.stroke();

    const centerR = Pitch.CENTER_CIRCLE_RADIUS * S;
    ctx.beginPath();
    ctx.arc(centerX, centerY, centerR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(centerX, centerY, 3, 0, Math.PI * 2);
    ctx.fill();

    this._drawBoxes(ctx, 'left', centerY, centerR);
    this._drawBoxes(ctx, 'right', centerY, centerR);

    const cornerR = Pitch.CORNER_ARC_RADIUS * S;
    ctx.beginPath();
    ctx.arc(0, 0, cornerR, 0, Math.PI / 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, h, cornerR, -Math.PI / 2, 0);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(w, 0, cornerR, Math.PI / 2, Math.PI);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(w, h, cornerR, Math.PI, -Math.PI / 2);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    const [goalTop, goalBottom] = Pitch.goalYRange();
    const goalDepth = Pitch.GOAL_DEPTH * S;
    ctx.strokeRect(-goalDepth, goalTop * S, goalDepth, (goalBottom - goalTop) * S);
    ctx.strokeRect(w, goalTop * S, goalDepth, (goalBottom - goalTop) * S);
  }

  _drawBoxes(ctx, side, centerY, centerR) {
    const pBox = Pitch.penaltyBoxRect(side);
    const gBox = Pitch.goalBoxRect(side);
    ctx.strokeRect(pBox.x * S, pBox.y * S, pBox.w * S, pBox.h * S);
    ctx.strokeRect(gBox.x * S, gBox.y * S, gBox.w * S, gBox.h * S);

    const spotX = side === 'left' ? Pitch.PENALTY_SPOT_DIST * S : Pitch.canvasWidth - Pitch.PENALTY_SPOT_DIST * S;
    ctx.beginPath();
    ctx.arc(spotX, centerY, 2.5, 0, Math.PI * 2);
    ctx.fill();

    const distToLine = Pitch.PENALTY_BOX_LENGTH - Pitch.PENALTY_SPOT_DIST;
    const arcAngle = Math.acos(Math.min(1, distToLine / Pitch.CENTER_CIRCLE_RADIUS));
    ctx.beginPath();
    if (side === 'left') {
      ctx.arc(spotX, centerY, centerR, -arcAngle, arcAngle);
    } else {
      ctx.arc(spotX, centerY, centerR, Math.PI - arcAngle, Math.PI + arcAngle);
    }
    ctx.stroke();
  }

  drawPlayers(players) {
    const ctx = this.ctx;
    for (const p of players) {
      const cx = p.position.x * S;
      const cy = p.position.y * S;
      const r = 6.5;

      if (p.hasBall) {
        ctx.beginPath();
        ctx.arc(cx, cy, r + 3, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffd54a';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = p.team.color;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1.3;
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 8px Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.number, cx, cy);
    }
  }

  drawBall(ball) {
    const ctx = this.ctx;
    const cx = ball.position.x * S;
    const cy = ball.position.y * S;
    const heightPx = ball.height * S * 0.6;

    ctx.beginPath();
    ctx.ellipse(cx, cy + 2, 4 + heightPx * 0.15, 2, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(cx, cy - heightPx, ball.radius * S, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#111111';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}
