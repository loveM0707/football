import { Pitch } from '../entities/Pitch.js';

const S = Pitch.SCALE;

/** 계산된 데이터를 화면에 그리기만 하는 순수 렌더러. 로직은 포함하지 않는다(로직/뷰 분리). */
export class Renderer {
  constructor(ctx) {
    this.ctx = ctx;
    this.showAI = false; // AI표시(디버그) 토글 — 켜면 상태·이동 목표 점선 표시
    this._passLines = []; // 최근 패스 궤적 [{fromPos,toPos,type,timestamp,maxAge}]
  }

  /**
   * 패스 이벤트를 받아 궤적 데이터를 저장한다.
   * type: 'regular' | 'long' | 'through' | 'lobbed_through'
   */
  recordPass({ fromPos, toPos, through, lofted, dist }) {
    const type = through
      ? (lofted ? 'lobbed_through' : 'through')
      : (dist >= 30 ? 'long' : 'regular');
    this._passLines.push({ fromPos, toPos, type, timestamp: performance.now() / 1000, maxAge: 1.8 });
    if (this._passLines.length > 12) this._passLines.shift();
  }

  /** 패스 궤적 라인을 그린다. drawPitch() 직후, drawPlayers() 이전에 호출한다. */
  drawPassLines() {
    const ctx = this.ctx;
    const now = performance.now() / 1000;
    this._passLines = this._passLines.filter(l => now - l.timestamp < l.maxAge);

    for (const line of this._passLines) {
      const age = now - line.timestamp;
      const alpha = Math.max(0, 1 - age / line.maxAge);

      let r, g, b, lineW, dash;
      switch (line.type) {
        case 'regular':      r = 255; g = 255; b = 255; lineW = 1.5; dash = []; break;
        case 'long':         r = 255; g = 220; b = 0;   lineW = 2.0; dash = [8, 4]; break;
        case 'through':      r = 0;   g = 220; b = 200; lineW = 2.0; dash = [6, 3]; break;
        case 'lobbed_through': r = 255; g = 140; b = 20; lineW = 2.5; dash = [5, 3]; break;
        default:             r = 255; g = 255; b = 255; lineW = 1.5; dash = []; break;
      }

      const color = `rgba(${r},${g},${b},${(alpha * 0.88).toFixed(2)})`;
      const fx = line.fromPos.x * S;
      const fy = line.fromPos.y * S;
      const tx = line.toPos.x * S;
      const ty = line.toPos.y * S;

      ctx.save();
      ctx.setLineDash(dash);
      ctx.strokeStyle = color;
      ctx.lineWidth = lineW;
      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      ctx.setLineDash([]);

      // 화살촉 (목표 지점)
      const dx = tx - fx, dy = ty - fy;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > 5) {
        const ux = dx / len, uy = dy / len;
        const as = lineW * 4.5;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(tx - ux * as - uy * as * 0.5, ty - uy * as + ux * as * 0.5);
        ctx.lineTo(tx - ux * as + uy * as * 0.5, ty - uy * as - ux * as * 0.5);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }
  }

  clear() {
    const ctx = this.ctx;
    // 변환 리셋 후 전체(피치+골 여백) 클리어
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, Pitch.renderWidth, Pitch.renderHeight);
    // 좌측 골 네트 여백만큼 피치 좌표계를 이동시켜 양쪽 골대가 모두 보이게 한다
    ctx.translate(Pitch.canvasOffsetX, 0);
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

    this._drawGoal(ctx, 'left');
    this._drawGoal(ctx, 'right');
  }

  /** 골대(포스트 + 네트) 그리기. 골라인 바깥으로 네트가 들어가도록 여백에 그린다. */
  _drawGoal(ctx, side) {
    const [goalTop, goalBottom] = Pitch.goalYRange();
    const depth = Pitch.GOAL_DEPTH * S;
    const frontX = side === 'left' ? 0 : Pitch.canvasWidth;
    const backX = side === 'left' ? -depth : Pitch.canvasWidth + depth;
    const minX = Math.min(frontX, backX);
    const maxX = Math.max(frontX, backX);
    const topY = goalTop * S;
    const h = (goalBottom - goalTop) * S;

    // 골문 안쪽 어두운 영역 (네트 안)
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.20)';
    ctx.fillRect(minX, topY, maxX - minX, h);
    // 네트 그리드
    ctx.strokeStyle = 'rgba(255,255,255,0.30)';
    ctx.lineWidth = 0.7;
    const cell = 4;
    for (let y = topY + cell; y < topY + h; y += cell) {
      ctx.beginPath();
      ctx.moveTo(minX, y);
      ctx.lineTo(maxX, y);
      ctx.stroke();
    }
    for (let x = minX + cell; x < maxX; x += cell) {
      ctx.beginPath();
      ctx.moveTo(x, topY);
      ctx.lineTo(x, topY + h);
      ctx.stroke();
    }
    ctx.restore();

    // 골대 프레임: 양쪽 기둥(가로 방향 연결) + 뒤 크로스바
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.moveTo(frontX, topY);
    ctx.lineTo(backX, topY);
    ctx.lineTo(backX, topY + h);
    ctx.lineTo(frontX, topY + h);
    ctx.closePath();
    ctx.stroke();
    // 앞쪽(골라인) 양 기둥 점 표시
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(frontX, topY, 2.4, 0, Math.PI * 2);
    ctx.arc(frontX, topY + h, 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
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

      // 패스 수신자 표시: 빨간색 원 (모든 패스 유형 - 짧은패스, 롱패스, 스루패스, 로빙 등)
      if (ball && ball.passTargetPlayer === p) {
        ctx.beginPath();
        ctx.arc(cx, cy, r + 5, 0, Math.PI * 2);
        ctx.strokeStyle = '#ff3333';
        ctx.lineWidth = 3;
        ctx.stroke();
        // 펄싱 효과를 위한 내부 원
        ctx.beginPath();
        ctx.arc(cx, cy, r + 2, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,51,51,0.5)';
        ctx.lineWidth = 1.5;
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
    }

    // AI표시(디버그) 토글: 모든 선수의 상태·이동 목표를 점선으로 표시
    if (this.showAI) this._drawAIDebug(ctx, players, ball);
  }

  /**
   * AI표시(디버그) 오버레이: 모든 선수의 현재 상태를 머리 위에 표시하고,
   * 현재 이동하려는 목표 지점까지 흰색 점선을 그린다.
   */
  _drawAIDebug(ctx, players, ball) {
    // 공 소유자의 패스 옵션 맵 생성 (수신자 ID -> 옵션 정보)
    // 선수 번호는 팀 간 중복될 수 있으므로 고유 ID 사용
    const passOptionMap = new Map();
    for (const p of players) {
      if (p.hasBall && p.brainMemory?.passOptions) {
        for (const opt of p.brainMemory.passOptions) {
          passOptionMap.set(opt.player.id, opt);
        }
        break; // 공 소유자는 한 명뿐
      }
    }

    for (const p of players) {
      const cx = p.position.x * S;
      const cy = p.position.y * S;
      const state = this._resolveAIState(p, ball);
      const target = this._resolveAITarget(p);

      if (target) {
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = 'rgba(255,255,255,0.65)';
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(target.x * S, target.y * S);
        ctx.stroke();
        ctx.setLineDash([]);
        // 목표 지점 표시
        ctx.beginPath();
        ctx.arc(target.x * S, target.y * S, 2.6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // 패스 수신 후보 선수 아래에 점수 표시 (자팀만)
      const passOpt = passOptionMap.get(p.id);
      if (passOpt) {
        this._drawPassScore(ctx, cx, cy, passOpt);
      }

      if (state) {
        ctx.save();
        ctx.font = 'bold 10px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.strokeText(state, cx, cy - 12);
        ctx.fillStyle = this._stateColor(state);
        ctx.fillText(state, cx, cy - 12);
        ctx.restore();
      }
    }
  }

  /** 선수가 현재 향하는 목표 좌표. 상황별 brainMemory 필드를 우선순위로 참조한다. */
  _resolveAITarget(p) {
    const mem = p.brainMemory;
    if (mem?.debugIntent?.target) return mem.debugIntent.target; // 공 소유자 의사결정 목표
    if (mem?.offBallTarget) return mem.offBallTarget;            // 공격 시 이동 목표
    if (mem?.pressTarget) return mem.pressTarget;                // 압박 목표
    if (mem?.defendTarget) return mem.defendTarget;              // 수비 이동 목표
    if (mem?.markTarget) return mem.markTarget.position;         // 마크 대상
    if (p.basePosition) return p.basePosition;                   // 기본 포지션
    return null;
  }

  /** 선수의 현재 상태를 한글로 요약한다. */
  _resolveAIState(p, ball) {
    if (p.role === 'GK') return 'GK';
    if ((p.brainMemory?.contestTimer ?? 0) > 0 || ball?.contest?.holder === p || ball?.contest?.challenger === p) {
      return '경합';
    }
    if (p.hasBall) {
      const t = p.brainMemory?.debugIntent?.type;
      if (t) return { SHOOT: '슛', PASS: '패스', CROSS: '크로스', DRIBBLE: '드리블', SHIELD_DRIVE: '경합드리블', SCAN: '살피기', HOLD_UP: '볼키핑', MOVE: '드리블', CLEAR: '클리어', HOLD: '홀드' }[t] || t;
      return '소유';
    }
    const ob = p.brainMemory?.offBallBehavior;
    if (ob) return { PENETRATING: '침투', OVERLAPPING: '오버래핑', COVERING_BACK: '잔류수비', SUPPORTING: '서포트', SEEKING_SUPPORT: '서포트요청', SPACE_FINDING: '공간탐색', FLANKING: '측면', BOX_CRASHING: '박스쇄도', OPP_RUN: '반대침투' }[ob] || ob;
    const db = p.brainMemory?.defendBehavior;
    if (db) return { PRESSING: '압박', CONTAINING: '지연수비', MARKING: '마크', COVER_SHADOW: '커버', COVER_RUN: '브레이크아웃', BLOCK: '지역수비' }[db] || db;
    if (!ball?.owner) return '루즈볼';
    return '복귀';
  }

  /** 상태에 따른 라벨 색상: 공격=연두, 수비=빨강, 골키퍼=파랑 */
  _stateColor(state) {
    const attack = ['침투', '오버래핑', '서포트', '공간탐색', '측면', '박스쇄도', '반대침투', '드리블', '경합드리블', '소유', '슛'];
    const defense = ['압박', '마크', '커버', '브레이크아웃', '수비'];
    if (state === 'GK') return '#7db4ff';
    if (state === '경합') return '#ffd54a';
    if (attack.includes(state)) return '#7ddb6a';
    if (defense.includes(state)) return '#ff6b6b';
    return '#e6e6e6';
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

  /** 패스 수신 후보 선수 아래에 점수 표시 (타입별 색상) */
  _drawPassScore(ctx, cx, cy, opt) {
    ctx.save();
    ctx.font = 'bold 12px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    const y = cy + 10; // 선수 발밑 아래

    // 타입별 색상 (시각화 색상과 동일)
    let color = '#e6e6e6';
    if (opt.type === 'THROUGH') {
      color = '#7ddb6a';   // 연두: 스루패스
    } else if (opt.type === 'FORWARD') {
      color = '#ffd54a';   // 노랑: 전진패스
    } else if (opt.type === 'SAFE') {
      color = '#7db4ff';   // 파랑: 안전패스
    }

    // 베스트 옵션이면 더 크게, 테두리 추가
    const isBest = opt.isBest;
    if (isBest) {
      ctx.font = 'bold 14px Arial';
      // 배경 원
      ctx.beginPath();
      ctx.arc(cx, y + 7, 14, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,213,74,0.25)';
      ctx.fill();
      ctx.strokeStyle = '#ffd54a';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // 점수 텍스트 (검은 테두리로 가독성 확보)
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.strokeText(`${opt.score}`, cx, y);
    ctx.fillStyle = color;
    ctx.fillText(`${opt.score}`, cx, y);

    ctx.restore();
  }
}
