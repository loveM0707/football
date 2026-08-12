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

  drawPlayers(players, ball = null) {
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

      // 두 발: 바라보는 방향(facingAngle) 쪽에 좌우로 살짝 벌려 그려 진행/응시 방향을 표현한다
      const fx = Math.cos(p.facingAngle);
      const fy = Math.sin(p.facingAngle);
      const perpX = -fy;
      const perpY = fx;
      const footForward = r * 1.25;
      const footSpread = r * 0.62;
      ctx.fillStyle = '#14161b';
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 0.6;
      for (const side of [-1, 1]) {
        const fxp = cx + fx * footForward + perpX * footSpread * side;
        const fyp = cy + fy * footForward + perpY * footSpread * side;
        ctx.beginPath();
        ctx.arc(fxp, fyp, 2.4, 0, Math.PI * 2);
        ctx.fill();
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

      // 온 더 볼 의사결정 디버그 오버레이 (Stage 6)
      if (p.hasBall) {
        this._drawBallCarrierIntent(ctx, p, cx, cy);
      }

      // 오프 더 볼 행동 디버그 오버레이
      const behavior = p.brainMemory?.offBallBehavior;
      if (behavior === 'PENETRATING') {
        // 노란 위쪽 삼각형 화살표
        ctx.save();
        ctx.strokeStyle = '#ffd700';
        ctx.fillStyle = '#ffd700';
        ctx.lineWidth = 1.5;
        const arrowTip = cy - r - 4;
        ctx.beginPath();
        ctx.moveTo(cx, arrowTip - 7);
        ctx.lineTo(cx - 4, arrowTip);
        ctx.lineTo(cx + 4, arrowTip);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      } else if (behavior === 'SEEKING_SUPPORT' && ball) {
        // 빨간 점선: 선수 → 공
        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = 'rgba(255,60,60,0.7)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(ball.position.x * S, ball.position.y * S);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }
    }
  }

  /**
   * 공 소유 선수가 고려 중인 행동을 시각화한다.
   *  - SHOOT  : 골대를 향한 굵은 빨간색 실선
   *  - PASS   : 타겟 동료를 향한 파란색 점선
   *  - DRIBBLE: 전진 방향의 녹색 화살표
   */
  _drawBallCarrierIntent(ctx, p, cx, cy) {
    const di = p.brainMemory?.debugIntent;
    if (!di || !di.target) return;

    if (di.type === 'SHOOT') {
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 30, 30, 0.9)';
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(di.target.x * S, di.target.y * S);
      ctx.stroke();
      ctx.restore();
      return;
    }

    if (di.type === 'PASS') {
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = 'rgba(60, 130, 255, 0.95)';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(di.target.x * S, di.target.y * S);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      return;
    }

    if (di.type === 'DRIBBLE') {
      const dir = di.target.sub(p.position).normalize();
      const len = 26;
      const tipX = cx + dir.x * len;
      const tipY = cy + dir.y * len;
      ctx.save();
      ctx.strokeStyle = 'rgba(40, 200, 70, 0.95)';
      ctx.fillStyle = 'rgba(40, 200, 70, 0.95)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(tipX, tipY);
      ctx.stroke();
      // 화살촉
      const backAngle = Math.atan2(dir.y, dir.x) + Math.PI;
      const arrowSize = 7;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX + Math.cos(backAngle + 0.5) * arrowSize, tipY + Math.sin(backAngle + 0.5) * arrowSize);
      ctx.lineTo(tipX + Math.cos(backAngle - 0.5) * arrowSize, tipY + Math.sin(backAngle - 0.5) * arrowSize);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  drawBall(ball) {
    const ctx = this.ctx;
    const cx = ball.position.x * S;
    const cy = ball.position.y * S;
    const height = ball.height;
    const heightPx = height * S * 0.6;

    // 그림자: 높이가 높을수록 크고 흐려짐 (롱패스/클리어 시 공중볼 표현)
    const shadowR = Math.max(2.5, 4.5 + height * 1.2);
    const shadowAlpha = Math.max(0.08, 0.4 - height * 0.04);
    ctx.beginPath();
    ctx.ellipse(cx, cy, shadowR, shadowR * 0.4, 0, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(0,0,0,${shadowAlpha})`;
    ctx.fill();

    // 공중에 떠있을 때 연결선 (높이 1m 이상일 때)
    if (height > 1) {
      ctx.beginPath();
      ctx.setLineDash([2, 3]);
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx, cy - heightPx);
      ctx.strokeStyle = `rgba(0,0,0,${Math.min(0.25, height * 0.04)})`;
      ctx.lineWidth = 0.8;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const ballR = ball.radius * S * (1 + Math.min(0.8, height * 0.25));
    ctx.beginPath();
    ctx.arc(cx, cy - heightPx, ballR, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#111111';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}
