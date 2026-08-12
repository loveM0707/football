import { Vector2D } from '../entities/Vector2D.js';
import { Pitch } from '../entities/Pitch.js';

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ═══════════════════════════════════════════════════════════════
// Stage 1: 포지션별 행동 성향 가중치 (Role Weights)
// penetration: 전방 침투 우선도
// support    : 패스 길 확보 우선도
// safety     : 포메이션 유지 우선도
// width      : 측면 너비 확보 우선도
// ═══════════════════════════════════════════════════════════════
const ROLE_WEIGHTS = {
  GK: { penetration: 0.00, support: 0.00, safety: 1.00, width: 0.00 },
  CB: { penetration: 0.04, support: 0.20, safety: 0.95, width: 0.10 },
  LB: { penetration: 0.18, support: 0.38, safety: 0.65, width: 0.88 },
  RB: { penetration: 0.18, support: 0.38, safety: 0.65, width: 0.88 },
  CM: { penetration: 0.32, support: 0.90, safety: 0.40, width: 0.22 },
  LM: { penetration: 0.78, support: 0.55, safety: 0.12, width: 0.92 },
  RM: { penetration: 0.78, support: 0.55, safety: 0.12, width: 0.92 },
  ST: { penetration: 0.92, support: 0.42, safety: 0.08, width: 0.28 },
};

// ═══════════════════════════════════════════════════════════════
// Stage 2: Raycasting — 패스 길 차단 여부 + 이탈 오프셋 계산
//
// 공 소유자(ballCarrier) → 이 선수(player) 사이에 Ray를 그어
// 상대 수비수가 반경 2.1m 이내에 걸리면 차단(blocked=true).
// 이탈 벡터: Ray 수직 방향으로 수비수 반대쪽으로 3.5~5m 이동.
// ═══════════════════════════════════════════════════════════════
function checkPassLane(player, ballCarrier, opponents) {
  const from = ballCarrier.position;
  const to   = player.position;
  const ray  = to.sub(from);
  const len  = ray.length();
  if (len < 0.5) return { blocked: false };

  const dir = ray.normalize();

  for (const opp of opponents) {
    if (opp.role === 'GK') continue;
    const toOpp = opp.position.sub(from);
    const t     = clamp(toOpp.dot(dir), 0, len);
    const proj  = from.add(dir.scale(t));
    const perpDist = opp.position.sub(proj).length();

    if (perpDist < 2.1 && t > len * 0.1 && t < len * 0.9) {
      // 차단 수비수 발견 — Ray 수직 방향 이탈 벡터
      const perp   = new Vector2D(-dir.y, dir.x);
      const sign   = opp.position.sub(player.position).dot(perp) > 0 ? -1 : 1;
      return {
        blocked: true,
        escapeOffset: perp.scale(sign * (3.5 + Math.random() * 1.5)),
        blocker: opp,
      };
    }
  }
  return { blocked: false };
}

// ═══════════════════════════════════════════════════════════════
// Stage 3: 수비 뒷공간 침투 런 (Penetration Run)
//
// 조건:
//   - 공 소유자 주변 압박 < 2명
//   - 상대 최후방 수비수 뒤에 6m 이상 공간 존재
// 목표: 수비 라인 갭 Y좌표로, 최후방 수비수 뒤 8~14m 지점.
// ═══════════════════════════════════════════════════════════════
function tryPenetrationRun(player, opponentTeam, ballCarrier, attackDir) {
  // 공 소유자 압박 수준 확인
  const pressure = opponentTeam.players.filter(
    o => o.role !== 'GK' && o.position.sub(ballCarrier.position).length() < 4.5
  ).length;
  if (pressure >= 2) return null;

  const oppOutfield = opponentTeam.players.filter(p => p.role !== 'GK');
  if (oppOutfield.length === 0) return null;

  // 상대 최후방 수비수의 X 좌표 (공격 방향에서 가장 전진한 수비수)
  const lastDefX = attackDir === 1
    ? Math.max(...oppOutfield.map(p => p.position.x))
    : Math.min(...oppOutfield.map(p => p.position.x));

  // 골대까지 충분한 공간이 있는지 확인
  const distToGoal = attackDir === 1 ? Pitch.LENGTH - lastDefX : lastDefX;
  if (distToGoal < 6) return null;

  // 수비 라인 근처 선수들의 Y 좌표에서 갭(빈 공간) 탐색
  const nearLine = oppOutfield
    .filter(p => {
      const dx = attackDir === 1 ? p.position.x - lastDefX : lastDefX - p.position.x;
      return dx >= 0 && dx < 14;
    })
    .sort((a, b) => a.position.y - b.position.y);

  const mem = player.brainMemory;
  if (!mem.penRunVariant || Math.random() < 0.008) mem.penRunVariant = Math.random();

  let gapY = Pitch.WIDTH * 0.5 + (mem.penRunVariant - 0.5) * 16;
  if (nearLine.length >= 2) {
    let bestGap = 0;
    for (let i = 0; i < nearLine.length - 1; i++) {
      const g = nearLine[i + 1].position.y - nearLine[i].position.y;
      if (g > bestGap) {
        bestGap = g;
        gapY = (nearLine[i].position.y + nearLine[i + 1].position.y) * 0.5;
      }
    }
  }

  // 침투 목표: 최후방 수비수 뒤 8~14m, 갭 Y 좌표
  const depth = 8 + mem.penRunVariant * 6;
  const penX  = clamp(
    lastDefX + attackDir * depth,
    attackDir === 1 ? 22 : 4,
    attackDir === 1 ? Pitch.LENGTH - 4 : Pitch.LENGTH - 22
  );

  return {
    target: new Vector2D(penX, clamp(gapY, 4, Pitch.WIDTH - 4)),
    sprint: true,
  };
}

// ═══════════════════════════════════════════════════════════════
// Stage 4: 측면 너비 확보 (Width Creation) + 측면 오버로드(Flank Overload)
//
// 공이 측면(터치라인 부근)에 있을 때 윙어(WG)/풀백(FB)은 경기장 Y축의 양극단으로
// 강제로 당겨 공격의 너비(width)를 확보한다. 공이 중앙에 있을 때는 덜 극단적으로
// 유지해 포메이션 균형을 지킨다.
// ═══════════════════════════════════════════════════════════════
function applyWidthCreation(target, role, ball) {
  const isLeft  = role === 'LM' || role === 'LB';
  const isRight = role === 'RM' || role === 'RB';
  if (!isLeft && !isRight) return target;

  // 플랭크 판정: 공이 좌/우 터치라인 부근(25% 바깥)에 있는가
  const ballOnLeft  = ball.position.y < Pitch.WIDTH * 0.25;
  const ballOnRight = ball.position.y > Pitch.WIDTH * 0.75;
  const onOwnFlankLeft  = isLeft && (ballOnLeft || ballOnRight);
  const onOwnFlankRight = isRight && (ballOnRight || ballOnLeft);

  if (isLeft) {
    // Flank Overload: 공이 측면에 있으면 자기 쪽 웅(edge)으로 강제 할당
    const edgeY = Pitch.WIDTH * 0.06;
    if (onOwnFlankLeft) return new Vector2D(target.x, edgeY);
    return new Vector2D(target.x, target.y * 0.42 + edgeY * 0.58);
  }
  if (isRight) {
    const edgeY = Pitch.WIDTH * 0.94;
    if (onOwnFlankRight) return new Vector2D(target.x, edgeY);
    return new Vector2D(target.x, target.y * 0.42 + edgeY * 0.58);
  }
  return target;
}

// ═══════════════════════════════════════════════════════════════
// Stage 4.5: 박스 쇄도 (Box Crashing)
//
// 측면 선수가 공을 잡고 크로스/돌파 타이밍(상대 페널티 박스 부근)이 되면,
// 중앙 공격수(ST)와 반대편 윙어 등 최소 2~3명이 아래 목표로 스프린트한다.
//   - ST 1명   → 페널티 스팟
//   - ST 2명   → 1명은 페널티 스팟, 1명은 니어 포스트
//   - 같은 쪽  → 니어 포스트(Near Post)
//   - 반대편   → 파 포스트(Far Post)
// ═══════════════════════════════════════════════════════════════
function tryBoxCrashing({ player, team, ball, attackDir }) {
  const role = player.role;
  if (role !== 'ST' && role !== 'LM' && role !== 'RM') return null;
  if (!ball.owner || ball.owner.team !== team) return null;

  const carrier = ball.owner;
  if (carrier === player) return null;
  // 크로스 담당은 측면 선수(윙어/풀백)
  const carrierIsFlank = carrier.role === 'LM' || carrier.role === 'RM' || carrier.role === 'LB' || carrier.role === 'RB';
  if (!carrierIsFlank) return null;

  // 크로스 타이밍: 상대 페널티 박스 부근(골라인에서 28m 이내)
  const opGoalX = attackDir === 1 ? Pitch.LENGTH : 0;
  const carrierDistToGoalLine = Math.abs(carrier.position.x - opGoalX);
  if (carrierDistToGoalLine > Pitch.PENALTY_BOX_LENGTH + 12) return null;

  const intoField = attackDir === 1 ? -1 : 1; // 상대 골라인 → 필드 안쪽
  const goalX = opGoalX;
  const [gTopY, gBottomY] = Pitch.goalYRange();
  const centerY = (gTopY + gBottomY) / 2;
  const carrierIsLeft = carrier.role === 'LM' || carrier.role === 'LB';

  const nearPost = new Vector2D(goalX + intoField * 5.5, carrierIsLeft ? gTopY + 1.5 : gBottomY - 1.5);
  const farPost = new Vector2D(goalX + intoField * 9.5, carrierIsLeft ? gBottomY - 1.5 : gTopY + 1.5);
  const penSpot = new Vector2D(goalX + intoField * Pitch.PENALTY_SPOT_DIST, centerY);

  let crashTarget = null;
  let behavior = 'BOX_CRASHING';
  if (role === 'ST') {
    const mySt = team.outfieldPlayers.filter((p) => p.role === 'ST');
    const stIdx = mySt.indexOf(player);
    const stCount = mySt.length;
    // ST 2명일 때 1명은 니어 포스트까지 쇄도해 크로스 수신 지점을 다양화한다
    crashTarget = stCount >= 2 && stIdx === 1 ? nearPost : penSpot;
  } else {
    const playerIsLeft = role === 'LM';
    crashTarget = playerIsLeft === carrierIsLeft ? nearPost : farPost;
  }

  if (!crashTarget) return null;
  return {
    target: Pitch.clampInside(crashTarget, 1.2),
    sprint: true,
    behavior,
  };
}

// ═══════════════════════════════════════════════════════════════
// Stage 5: 오프사이드 방지 (Offside Trap Avoidance)
//
// 공이 소유자 발에 있는 동안(아직 패스 전) X 좌표를 클램프.
// 상대 최후방 수비수보다 0.35m 뒤에 머문다.
// ═══════════════════════════════════════════════════════════════
function applyOffsideClamping(target, opponentTeam, attackDir) {
  const oppOutfield = opponentTeam.players.filter(p => p.role !== 'GK');
  if (oppOutfield.length === 0) return target;

  if (attackDir === 1) {
    const lastDefX = Math.max(...oppOutfield.map(p => p.position.x));
    return new Vector2D(Math.min(target.x, lastDefX - 0.35), target.y);
  } else {
    const lastDefX = Math.min(...oppOutfield.map(p => p.position.x));
    return new Vector2D(Math.max(target.x, lastDefX + 0.35), target.y);
  }
}

// ═══════════════════════════════════════════════════════════════
// 메인 함수: 6단계 오프 더 볼 공격 포지셔닝
//
// baseTarget: FormationPositioning 5단계 파이프라인 결과
// 반환값: 정제된 목표 좌표 (Vector2D)
// 부수효과: player.brainMemory에 offBallBehavior, offBallSprint 저장
// ═══════════════════════════════════════════════════════════════
export function computeOffBallAttack({ player, team, opponentTeam, ball, baseTarget }) {
  const role        = player.role;
  const mem         = player.brainMemory;
  const attackDir   = team.attackingDirection;
  const ballCarrier = ball.owner;

  if (role === 'GK') {
    mem.offBallBehavior = null;
    mem.offBallSprint   = false;
    return baseTarget.clone();
  }

  const w = ROLE_WEIGHTS[role] ?? { penetration: 0.3, support: 0.5, safety: 0.5, width: 0.3 };
  let target   = baseTarget.clone();
  let sprint   = false;
  let behavior = null;

  // ── Stage 2: 패스 길 레이캐스팅 ─────────────────────────────
  if (ballCarrier?.team === team && opponentTeam && w.support >= 0.4) {
    const lane = checkPassLane(player, ballCarrier, opponentTeam.players);
    if (lane.blocked) {
      target   = target.add(lane.escapeOffset);
      behavior = 'SEEKING_SUPPORT';
    }
  }

  // ── Stage 3: 침투 런 ────────────────────────────────────────
  if (w.penetration >= 0.7 && ballCarrier?.team === team && opponentTeam) {
    // 고침투 역할(ST, LM, RM): 항상 침투 런 시도
    const pen = tryPenetrationRun(player, opponentTeam, ballCarrier, attackDir);
    if (pen) {
      target   = pen.target;
      sprint   = pen.sprint;
      behavior = 'PENETRATING';
    }
  } else if (w.penetration >= 0.25 && !behavior && ballCarrier?.team === team && opponentTeam) {
    // 중간 역할(CM, LB, RB): 확률적으로 제한적 침투
    const pen = tryPenetrationRun(player, opponentTeam, ballCarrier, attackDir);
    if (pen && Math.random() < w.penetration * 0.55) {
      target   = Vector2D.lerp(target, pen.target, 0.38);
      behavior = 'SUPPORTING';
    }
  }

  // ── 패스 수신자 서포트 (2, 3단계 미해당 시) ─────────────────
  if (!behavior && ball.passTargetPlayer?.team === team && player !== ball.passTargetPlayer) {
    const recv = ball.passTargetPlayer;
    const d    = player.position.sub(recv.position).length();
    if (d < 20 && d > 2.5) {
      const ang  = recv.position.sub(player.position).angle() + (Math.random() - 0.5) * 0.8;
      const supp = recv.position.add(Vector2D.fromAngle(ang).scale(4 + Math.random() * 2));
      target   = Vector2D.lerp(target, supp, 0.3);
      behavior = 'SUPPORTING';
    }
  }

  // ── Stage 4: 측면 너비 확보 + 플랭크 오버로드 ────────────────
  if (w.width >= 0.8 && behavior !== 'PENETRATING') {
    target = applyWidthCreation(target, role, ball);
  }

  // ── Stage 4.5: 박스 쇄도 (Box Crashing) — 크로스 타이밍 스프린트 ──
  // 측면 선수가 공을 잡고 크로스 지역일 때 ST/윙어가 니어·파 포스트/페널티 스팟으로
  // 스프린트한다. 측면 푸시보다 우선해 박스 안쪽 목표를 강제한다.
  const crash = tryBoxCrashing({ player, team, ball, attackDir });
  if (crash) {
    target = crash.target;
    sprint = true;
    behavior = crash.behavior;
  }

  // ── Winger Forward Flank Push (LM/RM 공격 시 전방 측면으로 전진) ──
  // 공격 국면에서 측면 공격수를 전방 측면 포지션으로 강제 올린다.
  // 단, 박스 쇄도(크로스 수신)가 발동한 경우에는 박스 안 목표를 유지한다.
  if ((role === 'LM' || role === 'RM') && ballCarrier?.team === team && behavior !== 'BOX_CRASHING') {
    const flankY = role === 'LM' ? Pitch.WIDTH * 0.12 : Pitch.WIDTH * 0.88;
    // Y: 측면 쪽으로 75% 바이어스
    target = new Vector2D(target.x, target.y * 0.25 + flankY * 0.75);
    // X: 공격 3분의 1 이상(공격 방향으로 55% 이상)으로 밀어 올린다
    if (attackDir === 1) {
      target = new Vector2D(Math.max(target.x, Pitch.LENGTH * 0.55), target.y);
    } else {
      target = new Vector2D(Math.min(target.x, Pitch.LENGTH * 0.45), target.y);
    }
    behavior = behavior || 'FLANKING';
  }

  // ── Ball Carrier Repulsion: 공 소유자와 최소 8m 거리 유지 ──
  if (ballCarrier && ballCarrier !== player && ballCarrier.team === team) {
    const MIN_DIST_FROM_CARRIER = 8;
    const toCarrier = target.sub(ballCarrier.position);
    const dist = toCarrier.length();
    if (dist < MIN_DIST_FROM_CARRIER && dist > 0.01) {
      const pushStr = (MIN_DIST_FROM_CARRIER - dist) / MIN_DIST_FROM_CARRIER;
      const pushDir = toCarrier.normalize();
      target = target.add(pushDir.scale(pushStr * MIN_DIST_FROM_CARRIER * 0.8));
    }
  }

  // ── Stage 5: 오프사이드 방지 ────────────────────────────────
  if (ball.owner && opponentTeam) {
    target = applyOffsideClamping(target, opponentTeam, attackDir);
  }

  // ── Stage 6: 상태 저장 (렌더링용) ───────────────────────────
  mem.offBallBehavior = behavior;
  mem.offBallSprint   = sprint;
  mem.offBallTarget   = target.clone();

  return Pitch.clampInside(target, 1.2);
}
