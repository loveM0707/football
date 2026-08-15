import { Vector2D } from '../entities/Vector2D.js';
import { Pitch } from '../entities/Pitch.js';
import { computeSupportPosition, computeDefensiveSupport } from './OffTheBallMovement.js';
import { selectPressers, MAX_TETHER, computePresserTarget, computeCutoffTarget, computeDefensiveTarget, computeCoveringShift } from './Defending.js';
import { DuelResolver } from './DuelResolver.js';

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

// 경합드리블(SHIELD_DRIVE) 지속 시간(초): 한 번 발동하면 이 시간 동안
// 몸싸움 전진 드리블을 유지한다 (기존 1프레임 즉시 해제 → 1.8초로 연장)
const SHIELD_DRIVE_DURATION = 1.8;

function moveIntent(target, sprint = false, speedFactor = null) {
  return { type: 'MOVE', target, sprint, speedFactor };
}

function segmentPointInfo(p, a, b) {
  const ab = b.sub(a);
  const t = clamp01(p.sub(a).dot(ab) / Math.max(ab.lengthSq(), 1e-6));
  const proj = a.add(ab.scale(t));
  return { dist: p.sub(proj).length(), t };
}

function isPassingLaneBlocked(from, to, opponents) {
  return opponents.some((o) => {
    const { dist, t } = segmentPointInfo(o.position, from, to);
    return dist < 1.8 && t > 0.08 && t < 0.92;
  });
}

/**
 * 전방 빈 공간 탐색 — 상대 골문 방향 부채꼴(±30°, 반경 rClear m) 내
 * 수비수가 없으면 true (클리어 패스 통로 존재).
 * U_goal = 공격 방향 단위벡터, 내적이 cos(30°)를 초과하면 부채꼴 안.
 */
const CONE_COS = Math.cos(Math.PI / 6); // cos(30°) ≈ 0.866

function hasClearPath(player, opponentTeam, attackDir, rClear) {
  const goalDir = attackDir === 1 ? new Vector2D(1, 0) : new Vector2D(-1, 0);
  for (const o of opponentTeam.players) {
    if (o.role === 'GK') continue;
    const toOpp = o.position.sub(player.position);
    const dist = toOpp.length();
    if (dist > rClear || dist < 0.3) continue;
    if (toOpp.normalize().dot(goalDir) > CONE_COS) return false; // 부채꼴 내 수비수 존재
  }
  return true;
}

/**
 * 드리블 스탯·창의성 기반 전방 탐색 반경 R_clear (m).
 * 고스탯 선수(윙어 등)는 rClear가 짧아 수비수가 가까워도 과감히 돌파.
 * 저스탯 선수는 rClear가 길어 넓은 공간이 있을 때만 드리블 시도.
 */
function computeRClear(player) {
  const drib    = player.attributes.dribbling / 100;
  const selfish = Math.max(0, drib * 0.6 + ((player.brainMemory?.creativity ?? 0.5) - 0.5) * 0.4);
  return Math.max(6, 14 - drib * 6 - selfish * 1.5);
  // drib=0.8 → ~9m(공격적), drib=0.4 → ~12m(신중), drib=0.2 → ~14m(보수적)
}

// PhysicsEngine 선형 감쇠 가속도와 동기화
const BALL_MU = 2.4;      // 지상 감속 가속도 (m/s²)
const BALL_GRAVITY = 9.8; // 중력 가속도 (m/s²)

/**
 * 선수가 도달 가능한 교차점을 찾는다.
 *
 * 공중볼: 이차방정식으로 체공시간 t_air를 역산하고 낙하지점(P_land)을 직접 반환한다.
 *   h(t) = h + v_y·t − ½g·t²  →  t_air = (v_y + √(v_y² + 2g·h)) / g
 *   P_land = P_ball + V_horizontal × t_air  (공중에서 수평 마찰 없음)
 *
 * 지상볼: 선형 감쇠 등가속도 모델: x(t) = v₀t − ½μt²,  t_stop = v₀/μ
 */
function computeInterceptionPoint(ball, player) {
  const ballSpeed = ball.velocity.length();
  if (ballSpeed < 0.5) return ball.position.clone();

  // 공중볼 처리: 낙하지점을 물리적으로 역산한다
  if (ball.height > 0 || ball.verticalVelocity > 0) {
    const vy = ball.verticalVelocity;
    const h  = Math.max(0, ball.height);
    const discriminant = vy * vy + 2 * BALL_GRAVITY * h;
    if (discriminant >= 0) {
      const tAir = (vy + Math.sqrt(discriminant)) / BALL_GRAVITY;
      if (tAir > 0) {
        // 수신 가능 높이(CATCH_H, 하강 중)에 도달하는 시점으로 달려간다.
        // 최종 낙하지점까지 기다리면 헤딩/경합 타이밍을 놓치고 수비수가 먼저
        // 차단한다 — 로빙 스루패스 연결 강화.
        const CATCH_H = 1.4;
        let tCatch = tAir;
        if (h >= CATCH_H) {
          // h + vy·t − ½g·t² = CATCH_H  →  t = (vy + √(vy² + 2g(h − CATCH_H))) / g
          const d2 = vy * vy + 2 * BALL_GRAVITY * (h - CATCH_H);
          if (d2 >= 0) {
            const tDown = (vy + Math.sqrt(d2)) / BALL_GRAVITY;
            if (tDown > 0 && tDown < tAir) tCatch = tDown;
          }
        }
        // 수평 마찰 없음: P_catch = P_ball + V_horizontal × t_catch
        const catchPos = ball.position.add(ball.velocity.scale(tCatch));
        return Pitch.clampInside(catchPos, 0.5);
      }
    }
    return ball.position.clone();
  }

  const ballDir = ball.velocity.normalize();
  const playerSpeed = player.maxSpeed;
  const stopTime = ballSpeed / BALL_MU;

  for (let t = 0.1; t <= Math.min(stopTime, 5.0); t += 0.1) {
    const ballDist = Math.max(0, ballSpeed * t - 0.5 * BALL_MU * t * t);
    const futurePos = ball.position.add(ballDir.scale(ballDist));
    if (player.position.sub(futurePos).length() <= playerSpeed * t * 1.05) {
      return futurePos;
    }
  }
  // 공 최종 정지 지점
  const finalDist = (ballSpeed * ballSpeed) / (2 * BALL_MU);
  return ball.position.add(ballDir.scale(finalDist));
}

export function decidePlayerIntent(ctx) {
  const { player, team, ball } = ctx;

  // 드리블 버스트 타이머 감산
  if ((player.brainMemory.dribbleBurstTimer ?? 0) > 0) {
    player.brainMemory.dribbleBurstTimer = Math.max(0, player.brainMemory.dribbleBurstTimer - ctx.dt);
  }

  // 태클 패배 멈칫(Stun/Delay): 잠시 행동 불가
  const stun = player.brainMemory.stunTimer ?? 0;
  if (stun > 0) {
    player.brainMemory.stunTimer = Math.max(0, stun - ctx.dt);
    return { type: 'HOLD' };
  }

  if (player.role === 'GK') return decideGoalkeeper(ctx);
  if (player.hasBall) return decideBallCarrier(ctx);

  if (ball.passTargetPlayer === player && !ball.owner) {
    const intercept = computeInterceptionPoint(ball, player);
    const distToIntercept = player.position.sub(intercept).length();
    const ballSpeed = ball.velocity.length();

    // 능동적 마중 움직임(Come-Short): 느린 패스이거나 수비수가 공에 가까울 때
    // 교차점에서 기다리지 않고 공을 향해 달려 나간다
    const opponentTeam = ctx.opponentTeam;
    let nearestOppDist = Infinity;
    if (opponentTeam) {
      for (const o of opponentTeam.players) {
        if (o.role === 'GK') continue;
        const d = o.position.sub(intercept).length();
        if (d < nearestOppDist) nearestOppDist = d;
      }
    }
    const slowPass = ballSpeed < 6;
    const defenderClosing = nearestOppDist < 6;
    // 공중볼(롱패스)이 날아오고 있을 때는 마중 나가지 않는다.
    // 낙하지점(intercept)에서 버텨야 헤더/볼 경합이 가능하다.
    const shouldComeShort = ball.height === 0 && (slowPass || defenderClosing);

    if (shouldComeShort) {
      // 현재 공 위치를 향해 역방향 가속 — 공과 선수가 중간 지점에서 만난다
      const toBall = ball.position.sub(player.position);
      const meetPoint = player.position.add(toBall.scale(0.6));
      if (toBall.length() > 0.3) player.desiredFacingAngle = toBall.angle();
      return moveIntent(meetPoint, true);
    }

    if (distToIntercept <= 1.2) {
      const toBall = ball.position.sub(player.position);
      if (toBall.length() > 0.3) {
        player.desiredFacingAngle = toBall.angle();
      }
      return { type: 'HOLD' };
    }
    return moveIntent(intercept, true);
  }

  if (!ball.owner) {
    const distToBall = player.position.sub(ball.position).length();
    const closestTeammate = findClosestToBall(team.players, ball);
    // 파리/편향 후 루즈볼: lastTouchedTeam이 null이면 양팀 모두 적극적으로 볼을 쫓는다
    const hotLooseBall = !ball.lastTouchedTeam && ball.velocity.length() > 2;
    const chaseRadius = hotLooseBall ? 20 : 5.0;
    if ((closestTeammate === player || distToBall < chaseRadius) && distToBall < 35) {
      const intercept = computeInterceptionPoint(ball, player);
      return moveIntent(intercept, true);
    }
    // 수비 전환: 아군이 마지막으로 접촉했다 하더라도 상대가 공에 더 가까우면
    // 공격 서포트(SEEKING_SUPPORT 등) 대신 수비로 전환해 수비 구멍을 막는다.
    const oppClosest = ctx.opponentTeam ? findClosestToBall(ctx.opponentTeam.players, ball) : null;
    const teamBallDist = closestTeammate
      ? closestTeammate.position.sub(ball.position).length() : Infinity;
    const oppBallDist = oppClosest
      ? oppClosest.position.sub(ball.position).length() : Infinity;
    const losingTransition = oppBallDist < teamBallDist - 2.0;
    if (ball.lastTouchedTeam === team && !losingTransition) {
      const supportPos = computeSupportPosition({ player, team, ball, inPossession: true });
      const dist = player.position.sub(supportPos).length();
      const sf = dist > 14 ? 0.85 : dist > 5 ? 0.65 : 0.45;
      return moveIntent(supportPos, false, sf);
    }
    return decideDefensiveOffBall(ctx);
  }

  if (ball.owner.team === team) {
    const supportPos = computeSupportPosition({
      player, team, ball, inPossession: true, opponentTeam: ctx.opponentTeam,
    });
    const sprint = player.brainMemory.offBallSprint ?? false;
    const dist = player.position.sub(supportPos).length();
    const sf = sprint ? null : (dist > 14 ? 0.85 : dist > 5 ? 0.65 : 0.45);
    return moveIntent(supportPos, sprint, sf);
  }

  return decideDefensiveOffBall(ctx);
}

function findClosestToBall(players, ball) {
  let best = null;
  let bestDist = Infinity;
  for (const p of players) {
    const d = p.position.sub(ball.position).length();
    if (d < bestDist) { bestDist = d; best = p; }
  }
  return best;
}

// ═══════════════════════════════════════════════════════════════
// Stage 1: 상황 인식 — 압박 수치(Pressure Score, 0~100)
//
// 역제곱 가중치 모델: P = Σ (w / d²)
// 수비수가 가까울수록 기하급수적으로 압박감이 높아진다.
// w = 기본 가중치(1.0) × 방향 보정(수비수가 공을 향하면 최대 1.5배)
// ═══════════════════════════════════════════════════════════════
const PRESS_RADIUS = 12;
const PRESS_W_BASE = 18;

function computePressureScore(player, opponentTeam) {
  let raw = 0;
  for (const o of opponentTeam.players) {
    if (o.role === 'GK') continue;
    const toBall = player.position.sub(o.position);
    const dist = toBall.length();
    if (dist > PRESS_RADIUS || dist < 0.3) continue;

    let heading = o.velocity;
    if (heading.length() < 0.3) heading = Vector2D.fromAngle(o.facingAngle);
    const dirFactor = Math.max(0, heading.normalize().dot(toBall.normalize()));
    const w = PRESS_W_BASE * (1.0 + dirFactor * 0.5);
    raw += w / (dist * dist);
  }
  return Math.round(Math.min(100, (1 - Math.exp(-raw * 0.28)) * 110));
}

// ═══════════════════════════════════════════════════════════════
// Stage 2: 슈팅 판단
//
//  - 유효 슈팅 사거리(28m) 이내인지 확인
//  - 골대 양 기둥을 잇는 삼각 시야(Cone)의 각도와, 골대 방향 레이 위/주변의
//    차단 수비수 수를 Raycasting으로 계산해 슈팅 유틸리티(0~1)를 산출한다.
// ═══════════════════════════════════════════════════════════════
const SHOOT_RANGE = 22;
/** 드리블로 접근할 수 있는 상대 골라인 최소 거리 — 골키퍼 뒤로 몰고 가는 현상 방지 */
const MIN_DRIBBLE_DIST_FROM_GOAL_LINE = 9;
/** 이 거리 안에서는 드리블 목표를 골라인 방향이 아니라 페널티 스팟 쪽으로 잡는다 */
const BYLINE_REDIRECT_DIST = 18;

function evaluateShotOpportunity(player, opponentTeam, attackDir) {
  const goalCenter = Pitch.goalCenter(attackDir === 1 ? 'right' : 'left');
  const [topY, bottomY] = Pitch.goalYRange();
  const goalX = goalCenter.x;
  const distToGoal = player.position.sub(goalCenter).length();

  // 골대 양 기둥과 선수를 잇는 시야각 (라디안)
  const toTop = new Vector2D(goalX - player.position.x, topY - player.position.y);
  const toBottom = new Vector2D(goalX - player.position.x, bottomY - player.position.y);
  const angleOpen = Math.abs(toTop.angle() - toBottom.angle());

  // 골대 방향 레이캐스팅: 경로상(반경 1.8m)에 서 있는 수비수 = 차단자
  let blockers = 0;
  for (const o of opponentTeam.players) {
    if (o.role === 'GK') continue;
    const { dist, t } = segmentPointInfo(o.position, player.position, goalCenter);
    if (dist < 1.8 && t > 0.05 && t < 0.97) blockers++;
  }

  const rangeFactor = clamp01((SHOOT_RANGE - distToGoal) / 12);
  const openness = clamp01(angleOpen / 0.55);
  const shooterQuality = 0.6 + (player.attributes.shooting / 100) * 0.6;
  const roleFactor = player.role === 'ST' ? 1.15 : player.role === 'CB' || player.role === 'LB' || player.role === 'RB' ? 0.45 : 0.85;

  // 1v1(GK만 남은 클린 찬스) 보너스
  const clearShot = blockers === 0;
  let score = clamp01(rangeFactor * openness * shooterQuality * roleFactor * (1 - Math.min(1, blockers * 0.45)));
  if (clearShot && distToGoal < 16.5) score = clamp01(score + 0.3);

  return { score, distToGoal, angleOpen, blockers, clearShot, goalCenter };
}

// ═══════════════════════════════════════════════════════════════
// Stage 3: 패스 판단 — 패스 가치(Pass Value) 점수 시스템
//
//  THROUGH (높은 점수): OFF_BALL_ATTACK 상태(PENETRATING)로 수비라인 뒷공간을
//                        침투 중인 동료 + 경로가 막히지 않음
//  FORWARD (중간 점수): 나보다 상대 골대에 가까운 윙어/미드필더가 비어 있음
//  SAFE    (낮은 점수): 압박이 심해 빠르게 뒤로 빼야 할 때, 안전한 백패스
// 시야(vision) 능력치가 낮으면 스루패스 옵션 자체를 인식하지 못할 수 있다.
// ═══════════════════════════════════════════════════════════════
function isBehindDefensiveLine(teammate, opponentTeam, attackDir) {
  const oppOutfield = opponentTeam.players.filter((p) => p.role !== 'GK');
  if (oppOutfield.length === 0) return false;
  const lastDefX = attackDir === 1
    ? Math.max(...oppOutfield.map((p) => p.position.x))
    : Math.min(...oppOutfield.map((p) => p.position.x));
  return attackDir === 1 ? teammate.position.x > lastDefX : teammate.position.x < lastDefX;
}

// 거리 페널티 상수
const DIST_DECAY_K = 0.055;   // S_final = S_base / (1 + k * d)
const D_MAX_LONG = 32;         // 이 거리 이상은 longPass 스탯이 높아야 가능

function evaluatePassOptions(player, team, opponentTeam) {
  const attackDir = team.attackingDirection;
  const goalPos = Pitch.goalCenter(attackDir === 1 ? 'right' : 'left');
  const isWinger = player.role === 'LM' || player.role === 'RM';
  const wingY = player.role === 'LM' ? Pitch.WIDTH * 0.15 : Pitch.WIDTH * 0.85;
  const vision = (player.attributes.vision ?? player.attributes.positioning) / 100;
  const passingStat = player.attributes.passing;
  const options = [];

  // 시야 능력치 기반 패스 스캔 반경: 높은 비전일수록 더 먼 동료를 인식한다
  const visionStat = player.attributes.vision ?? player.attributes.positioning;
  const maxScanDist = 22 + visionStat * 0.26;  // vision 40→32m, 90→45m

  for (const teammate of team.players) {
    if (teammate === player || teammate.role === 'GK') continue;
    const dist = teammate.position.sub(player.position).length();
    if (dist > maxScanDist || dist < 3) continue;
    // 롱패스 차단: passing < 72면 32m 이상 동료를 패스 대상에서 제외
    if (dist > D_MAX_LONG && passingStat < 72) continue;

    const forwardProgress = (teammate.position.x - player.position.x) * attackDir;
    const nearReceiver = opponentTeam.players.filter(
      (o) => o.role !== 'GK' && o.position.sub(teammate.position).length() < 6
    ).length;
    const blocked = isPassingLaneBlocked(player.position, teammate.position, opponentTeam.players);
    const open = nearReceiver === 0 && !blocked;

    // 옵션 유형 분류
    const ob = teammate.brainMemory?.offBallBehavior;
    const penetrating = ob === 'PENETRATING';
    const overlapping = ob === 'OVERLAPPING';
    // 전방·측면 주자: 침투(PENETRATING)·측면(FLANKING)·박스쇄도(BOX_CRASHING)·
    // 서포트요청(SEEKING_SUPPORT)·서포트(SUPPORTING) 상태의 동료에게는
    // 동료가 뛰어가는 "전방 트인 공간"으로 리드 패스(스루패스)를 보낸다.
    const leadRun = ob === 'PENETRATING' || ob === 'FLANKING' || ob === 'BOX_CRASHING' ||
                    ob === 'SEEKING_SUPPORT' || ob === 'SUPPORTING';
    const behindDef = isBehindDefensiveLine(teammate, opponentTeam, attackDir);

    // 리드 패스 목표 공간: 동료가 달려가는 전방 위치(offBallTarget). 공간이
    // 전방에 열려 있으면 스루패스(로빙 포함)를 보낸다.
    //  - 지상 경로가 막혀 있어도 수비수를 넘기는 로빙 스루패스(lobbed)로 전환 가능
    //  - 공간 근처 수비수 중 "골 방향으로 더 앞선 수비수"만 차단 위협으로 본다.
    //    동료 뒤쪽에서 쫓아오는 수비수는 리드에 따라붙을 수 없어 무시한다.
    const spaceTargetPt = teammate.brainMemory?.offBallTarget ?? null;
    let leadSpaceOpen = false;
    let lobSpaceOpen = false;
    if (leadRun && spaceTargetPt) {
      const spaceAdvance = (spaceTargetPt.x - player.position.x) * attackDir;
      if (spaceAdvance > 3) {
        const groundOpen = !isPassingLaneBlocked(player.position, spaceTargetPt, opponentTeam.players);
        // 공간보다 골 방향으로 더 앞선(차단 위협) 수비수 존재 여부
        const oppAhead = opponentTeam.players.some((o) => {
          if (o.role === 'GK') return false;
          const d = o.position.sub(spaceTargetPt).length();
          if (d > 4.5) return false;
          return (o.position.x - spaceTargetPt.x) * attackDir > -0.5;
        });
        leadSpaceOpen = groundOpen && !oppAhead;
        lobSpaceOpen = !groundOpen && !oppAhead; // 지상 경로 차단 → 수비수 위로 로빙
      }
    }
    const leadPass = leadRun && (leadSpaceOpen || lobSpaceOpen);

    let type = 'SAFE';
    if (penetrating || leadPass || (behindDef && open && dist > 10)) type = 'THROUGH';
    else if (open && (forwardProgress > 4 || overlapping)) type = 'FORWARD';

    // 시야가 낮으면 위험한 스루/전진 옵션을 놓친다 (발동 확률 상향: 0.90 → 0.95)
    if ((type === 'THROUGH' || (type === 'FORWARD' && forwardProgress > 15)) && Math.random() > vision * 0.95) {
      type = 'SAFE';
    }

    // 스루패스 미래 위치: 실제 비행시간 기반 선행(리드) 계산
    //  지상: v₀ = √(vf² + 2μd), 도착 t = (v₀ − vf)/μ  (vf = 스루패스 도착 속도)
    //  공중: t_air = 2·v_vert/g,  v_vert = min(14, 4 + 0.22·d)
    //  기존 0.055s/m 고정 선행은 공보다 선수가 빨라 스루패스가 자꾸 뒤로 떨어졌다.
    let futurePos = null;
    if (type === 'THROUGH' && (penetrating || leadPass)) {
      const THROUGH_VF = 5.5;
      const v0 = Math.sqrt(THROUGH_VF * THROUGH_VF + 2 * BALL_MU * dist);
      const tGround = (v0 - THROUGH_VF) / BALL_MU;
      const vVert = Math.min(14, 4.0 + dist * 0.22);
      const tAir = (2 * vVert) / BALL_GRAVITY;
      const travelTime = Math.min(Math.max(tGround, tAir) * 0.55, 1.8);

      const offBallTarget = teammate.brainMemory?.offBallTarget;
      let leadDir = null;
      if (offBallTarget) {
        const toTarget = offBallTarget.sub(teammate.position);
        if (toTarget.length() > 0.5) leadDir = toTarget.normalize();
      } else if (teammate.velocity.length() > 0.5) {
        leadDir = teammate.velocity.normalize();
      }
      if (leadDir) {
        const leadDist = teammate.maxSpeed * travelTime;
        futurePos = teammate.position.add(leadDir.scale(leadDist));
        // 라인 아웃 방지: 골라인·터치라인에서 충분히 안쪽으로만 리드한다
        // (너무 깊으면 골키퍼가 잡고, 너무 넓으면 스로인이 되어 공격이 끊긴다)
        const goalLineX = attackDir === 1 ? Pitch.LENGTH : 0;
        futurePos = new Vector2D(
          attackDir === 1
            ? Math.min(futurePos.x, goalLineX - 8)
            : Math.max(futurePos.x, goalLineX + 8),
          Math.max(4, Math.min(Pitch.WIDTH - 4, futurePos.y))
        );
        if (futurePos.x < 5 || futurePos.x > Pitch.LENGTH - 5) futurePos = null;
      }
    }

    // 시야 높은 선수는 스루패스 경로를 더 잘 찾아 우선순위 부여
    const visionBonus = type === 'THROUGH' ? Math.round((visionStat - 50) * 0.35) : 0;
    // FORWARD 기본 점수 35→50: 거리 감쇠 후에도 15m 전진패스가 품질 기준을 넘도록
    const typeBase = (type === 'THROUGH' ? 65 : type === 'FORWARD' ? 50 : 18) + visionBonus;

    const isAttacker = teammate.role === 'ST' || teammate.role === 'LM' || teammate.role === 'RM';
    const attackerBonus = isAttacker ? 10 : 0;
    const isMidfield = teammate.role === 'CM';
    const midfieldBonus = isMidfield && forwardProgress > 5 ? 5 : 0;

    const receiverDistToGoal = teammate.position.sub(goalPos).length();
    const senderDistToGoal = player.position.sub(goalPos).length();
    const progressToGoal = Math.max(0, senderDistToGoal - receiverDistToGoal);

    let wingBonus = 0;
    if (isWinger && Math.abs(player.position.y - wingY) < 10) {
      if (teammate.role === 'ST') wingBonus = 15;
      else if (teammate.role === 'CM') wingBonus = 8;
    }

    let score =
      typeBase +
      forwardProgress * 1.5 +
      progressToGoal * 2.0 +
      midfieldBonus +
      attackerBonus +
      wingBonus -
      nearReceiver * 8 -
      (blocked ? 15 : 0) +
      (overlapping && open ? 14 : 0) +
      (leadPass ? 18 : 0) +
      team.tactics.directnessBias * forwardProgress * 0.4;

    // 거리 감쇠 (Distance Decay): S_final = S_base / (1 + k * d)
    // 멀수록 점수 급락 → 숏패스 우선, 무리한 롱패스 억제
    score = score / (1 + DIST_DECAY_K * dist);

    options.push({ player: teammate, score, distance: dist, forwardProgress, open, leadSpaceOpen, lobbed: lobSpaceOpen, type, futurePos });
  }
  return options;
}

// ═══════════════════════════════════════════════════════════════
// Stage 4: 드리블 판단 — 수비수 회피(Avoidance) 전진 벡터
//
// 슛도 패스도 어렵고 전방 빈 공간이 열렸을 때, 가장 가까운 수비수를 피하면서
// 상대 골대를 향해 전진하는 드리블 타겟을 계산한다.
// ═══════════════════════════════════════════════════════════════
function evaluateDribble(player, team, opponentTeam, pressure) {
  const goalPos = Pitch.goalCenter(team.attackingDirection === 1 ? 'right' : 'left');
  const target = pickDribbleTarget(player, team, opponentTeam, goalPos);

  const noOpponentAhead = hasClearPath(player, opponentTeam, team.attackingDirection, computeRClear(player));
  const dribblingStat = player.attributes.dribbling / 100;
  const creativityBonus = (player.brainMemory.creativity - 0.5) * 0.35;

  let utility;
  if (noOpponentAhead) {
    utility = 1.0 + creativityBonus;
  } else {
    // 수비수가 있어도 드리블 능력+창의성이 높으면 개인 돌파를 시도한다 (이기심 계수)
    const selfishness = dribblingStat * 0.60 + (player.brainMemory.creativity - 0.3) * 0.50;
    utility = 0.30 + selfishness * 0.75;
  }
  utility -= pressure / 260;

  // 전방·측면 공격수: 과감성 부스트 (윙어 +45%, ST +20%)
  const role = player.role;
  if (role === 'LM' || role === 'RM') utility *= 1.45;
  else if (role === 'ST') utility *= 1.20;

  // 쉴드 드라이브: 가장 가까운 수비수 대비 소유 선수의 몸싸움 유지 확률 계산
  let shieldChance = 0.5;
  let nearestOppDist = Infinity;
  let nearestOpp = null;
  for (const o of opponentTeam.players) {
    if (o.role === 'GK') continue;
    const d = o.position.sub(player.position).length();
    if (d < nearestOppDist) { nearestOppDist = d; nearestOpp = o; }
  }
  if (nearestOpp) {
    shieldChance = DuelResolver.computeShieldChance(player, nearestOpp);
    // 쉴드 확률이 높으면 드리블 유틸리티도 상향
    if (shieldChance > 0.55) {
      utility *= 1.0 + (shieldChance - 0.55) * 1.5;
    }
  }

  return { utility, target, noOpponentAhead, shieldChance, nearestOppDist };
}

// ═══════════════════════════════════════════════════════════════
// Stage 5: 능력치·압박 기반 실수(RNG/Error)는 ActionExecutor에서 실행한다.
// 여기서는 SHOOT / PASS / DRIBBLE 중 하나를 유틸리티 가중치로 결정하고,
// 시각 디버깅용 debugIntent를 brainMemory에 기록한다.
// ═══════════════════════════════════════════════════════════════
function decideBallCarrier(ctx) {
  const { player, team, opponentTeam, dt } = ctx;
  const mem = player.brainMemory;

  mem.possessionTimer = (mem.possessionTimer ?? 0) + dt;

  // 경합드리블 지속 타이머: 설정 지속시간 동안 흔들리지 않고 몸싸움 드리블을 유지
  if ((mem.shieldDriveTimer ?? 0) > 0) {
    mem.shieldDriveTimer = Math.max(0, mem.shieldDriveTimer - dt);
  }

  if (mem.controlTimer > 0) {
    mem.controlTimer -= dt;
    mem.debugIntent = null;
    return { type: 'MOVE', target: player.position.clone(), sprint: false };
  }

  if (mem.decisionCooldown > 0) {
    mem.decisionCooldown -= dt;
    if (mem.lastIntent) return mem.lastIntent;
  }
  // 판단 주기를 늘려 매 프레임 마음이 바뀌는 산만한 플레이를 줄인다
  mem.decisionCooldown = 0.30 + Math.random() * 0.30;

  const attackDir = team.attackingDirection;

  // 볼을 잡은 직후 1.2초 동안은 패스보다 운반(드리블)을 선호한다 — 탁구 패스 방지
  const settleFactor = clamp01((mem.possessionTimer - 0.2) / 1.2);

  // ── Stage 1: 압박 수치 계산 ────────────────────────────────
  const pressure = computePressureScore(player, opponentTeam);
  mem.pressureScore = pressure;

  // 클리어링: 수비수가 자기 페널티 박스 근처에서 강한 압박을 받을 때만 걷어낸다.
  // (임계값이 낮으면 여유가 있는데도 뜬금없이 볼을 걷어차 버린다)
  const ownGoalX = attackDir === 1 ? 0 : Pitch.LENGTH;
  const distFromOwnGoal = Math.abs(player.position.x - ownGoalX);
  const isDefender = player.role === 'CB' || player.role === 'LB' || player.role === 'RB';
  if (isDefender && distFromOwnGoal < 22 && pressure >= 48) {
    mem.lastIntent = { type: 'CLEAR', pressure };
    mem.debugIntent = null;
    return mem.lastIntent;
  }

  // ── Stage 2: 슈팅 판단 ─────────────────────────────────────
  const shot = evaluateShotOpportunity(player, opponentTeam, attackDir);
  const canShootNow = shot.distToGoal < SHOOT_RANGE && shot.angleOpen > 0.11 && (shot.clearShot || pressure < 60);
  // rangeFactor: 22m에서 0, 10m 이내에서 1.0 — 제곱을 적용해 장거리 슛 확률을 급감시킨다
  const rangeFactor = clamp01((SHOOT_RANGE - shot.distToGoal) / 12);
  const creativeBonus = (mem.creativity - 0.5) * 0.2;
  const baseShootProb = clamp01(
    (rangeFactor * rangeFactor * (0.6 + (player.attributes.shooting / 100) * 0.6) *
      (player.role === 'ST' ? 1.15 : isDefender ? 0.45 : 0.85) * (0.75 + shot.angleOpen * 0.6) +
      creativeBonus * rangeFactor) * 0.35
  );
  // 노마크 찬스여도 거리에 따라 급격히 감소 (25m 노마크 = 거의 안 참)
  const clearShotUtility = clamp01(rangeFactor * rangeFactor * 0.9);
  const shootUtility = canShootNow
    ? (shot.clearShot ? Math.max(clearShotUtility, baseShootProb) : baseShootProb) * (1 + pressure / 400)
    : 0;

  // 골문 근처에서 각이 확실히 열려 있으면 무조건 슛 — 드리블 우선 방지
  // 강제슛 구간 확대: 기존 17m(각 0.25)/12m(각 0.18) 이분 구간을 페널티박스 전체
  // (16.5m, 각 0.15) + 좁은 각 허용으로 넓혀, 박스 안에서 결정적으로 마무리하게 한다.
  // 박스 가장자리(16.5~19m)는 강제슛에서 제외해 중거리 일발슛을 억제한다.
  const inShootingBox = !isDefender && (
    (shot.distToGoal < Pitch.PENALTY_BOX_LENGTH && shot.angleOpen > 0.15) ||
    (shot.distToGoal < 12 && shot.angleOpen > 0.10) ||
    (shot.distToGoal < 8  && shot.angleOpen > 0.05)
  );
  if (inShootingBox && (shot.clearShot || pressure < 70)) {
    const intent = { type: 'SHOOT', pressure };
    mem.debugIntent = { type: 'SHOOT', target: shot.goalCenter.clone() };
    mem.lastIntent = intent;
    return intent;
  }

  // 1v1 골키퍼 단독 찬스: GK 외 수비수가 없으면 무조건 슛 — 뒤나 측면으로 패스하는 현상 방지
  // 단, 15m 이내에서만 무조건 슛한다. 15~22m의 장거리 1v1은 슛 대신 드리블로 더
  // 접근하거나 박스 안 동료를 활용해 마무리 품질을 끌어올린다 (박스 밖 중거리슛 남발 억제).
  if (!isDefender && shot.clearShot && canShootNow && shot.distToGoal < 15 && shot.angleOpen > 0.22) {
    const intent = { type: 'SHOOT', pressure };
    mem.debugIntent = { type: 'SHOOT', target: shot.goalCenter.clone() };
    mem.lastIntent = intent;
    return intent;
  }

  // ── 빌드업 아웃렛: 수비수가 볼을 잡으면 써포트 미드필더에게 빠르게 배급 ──
  // (Decision Override 드리블보다 먼저 판단 — 빼앗은 뒤 멀리 드리블하는 현상 방지)
  if (isDefender && pressure < 70 && mem.possessionTimer >= 0.5) {
    const inOwnHalf = attackDir === 1
      ? player.position.x < Pitch.LENGTH * 0.55
      : player.position.x > Pitch.LENGTH * 0.45;
    if (inOwnHalf) {
      const outletOptions = evaluatePassOptions(player, team, opponentTeam).filter(
        (o) => (o.player.role === 'CM' || o.player.role === 'LM' || o.player.role === 'RM') &&
               o.open && o.distance < 30 && o.forwardProgress > -8
      );
      if (outletOptions.length > 0) {
        const outlet = outletOptions.reduce((a, b) => b.score > a.score ? b : a);
        const intent = {
          type: 'PASS',
          targetPlayer: outlet.player,
          targetPos: null,
          lofted: outlet.distance > 32,
          pressure,
        };
        mem.lastIntent = intent;
        mem.debugIntent = { type: 'PASS', target: outlet.player.position.clone() };
        return intent;
      }
    }
  }

  // ── 측면 돌파 (Flank Breakthrough): 윙어가 터치라인을 타고 골라인 방향으로 길게 드리블 ──
  // 측면에서 공을 잡은 윙어가 전방(골라인 방향)에 공간이 열리면 안쪽으로 돌지 않고
  // 터치라인을 따라 길게 돌파해 크로스 기회를 만든다. 이때 flankBreakthrough 플래그를
  // 세워 중앙 동료(ST·CM·반대편 윙어)가 골대 쪽으로 침투(박스 쇄도)하게 한다.
  {
    const isWinger = player.role === 'LM' || player.role === 'RM';
    const onFlank = player.role === 'LM'
      ? player.position.y < Pitch.WIDTH * 0.30
      : player.role === 'RM'
        ? player.position.y > Pitch.WIDTH * 0.70
        : false;
    if (isWinger && onFlank && !inShootingBox && pressure < 60 && !(canShootNow && shot.clearShot)) {
      const opGX = attackDir === 1 ? Pitch.LENGTH : 0;
      const bylineDist = Math.abs(player.position.x - opGX);
      // 크로스 존(페널티박스+10m) 밖에서만 돌파 — 존 안에서는 드리블을 멈추고
      // 아래 크로스 블록이 공을 박스로 올린다 (크로스 우선).
      const crossEdge = Pitch.PENALTY_BOX_LENGTH + 10;
      if (bylineDist >= crossEdge && bylineDist <= 50) {
        const aheadDir = new Vector2D(attackDir, 0);
        let blockedAhead = false;
        for (const o of opponentTeam.players) {
          if (o.role === 'GK') continue;
          const rel = o.position.sub(player.position);
          if (rel.dot(aheadDir) < 0) continue; // 뒤에 있는 수비수는 무시
          const lateral = Math.abs(o.position.y - player.position.y);
          if (lateral < 4.5 && rel.length() < 6.5) { blockedAhead = true; break; }
        }
        // 가까운 수비수를 확인해 몸싸움 우위(쉴드) 판단
        let nearestOppDist = Infinity;
        let nearestOpp = null;
        for (const o of opponentTeam.players) {
          if (o.role === 'GK') continue;
          const d = o.position.sub(player.position).length();
          if (d < nearestOppDist) { nearestOppDist = d; nearestOpp = o; }
        }
        const shieldChance = nearestOpp
          ? DuelResolver.computeShieldChance(player, nearestOpp)
          : 0;
        // 측면 경합드리블: 최전방/뒤에서 수비수가 달라붙었거나 바로 앞을 막고 있어도
        // 강한 윙어는 몸으로 밀치고 터치라인을 따라 돌파를 계속한다.
        const flankShield = nearestOppDist < 7 && shieldChance >= 0.50;
        if (!blockedAhead || flankShield) {
          // 터치라인을 따라 골라인 쪽으로 길게 드리블 (한 번에 12~20m)
          const breakLen = Math.max(12, Math.min(20, bylineDist - 8));
          const flankY = player.role === 'LM' ? Pitch.WIDTH * 0.10 : Pitch.WIDTH * 0.90;
          const keepFlank = new Vector2D(0, Math.sign(flankY - player.position.y));
          const steer = aheadDir.scale(0.9).add(keepFlank.scale(0.1)).normalize();
          const target = Pitch.clampInside(player.position.add(steer.scale(breakLen)), 1.5);
          mem.flankBreakthrough = true;
          if (flankShield) {
            if ((mem.shieldDriveTimer ?? 0) <= 0) mem.shieldDriveTimer = SHIELD_DRIVE_DURATION;
            mem.debugIntent = { type: 'SHIELD_DRIVE', target: target.clone() };
          } else {
            mem.debugIntent = { type: 'DRIBBLE', target: target.clone(), flank: true };
          }
          mem.lastIntent = { type: 'MOVE', target, sprint: true, pressure };
          return mem.lastIntent;
        }
      }
    }
    if (mem.flankBreakthrough) mem.flankBreakthrough = false;
  }

  // ── 전방 빈 공간 탐색: Cone이 비었으면 드리블 강제 전환 (Decision Override) ──────
  // 패스 점수 계산을 건너뛰고 즉시 DRIBBLE 상태로 강제 전환한다.
  // 조건: ±30° 부채꼴(반경 rClear) 안에 수비수 0명 + 슈팅 박스 밖 + 고압박 아님(<65)
  const rClearVal = computeRClear(player);
  // 윙어·ST는 압박이 있어도 열린 공간이면 과감히 돌파
  const isAttackingRole = player.role === 'LM' || player.role === 'RM' || player.role === 'ST';
  const dribblerPressureLimit = isAttackingRole ? 72 : 65;
  if (hasClearPath(player, opponentTeam, attackDir, rClearVal) &&
      !inShootingBox && !(canShootNow && shot.clearShot) && pressure < dribblerPressureLimit) {
    const overrideGoal   = Pitch.goalCenter(attackDir === 1 ? 'right' : 'left');
    const overrideTarget = pickDribbleTarget(player, team, opponentTeam, overrideGoal);
    mem.debugIntent = { type: 'DRIBBLE', target: overrideTarget.clone() };
    mem.lastIntent  = { type: 'MOVE', target: overrideTarget, sprint: true, pressure };
    return mem.lastIntent;
  }

  // ── 볼 보유 최소 시간 (Retention Timer) — 탁구 패스 FSM ─────
  // tMin(0.5~0.9s)이 지나야 패스 허용. P_CRITICAL 이상이면 즉시 긴급 패스 가능.
  const P_CRITICAL = 70;
  const canPass = mem.possessionTimer >= (mem.tMin ?? 1.0) || pressure >= P_CRITICAL;

  // ── Stage 3: 패스 판단 ─────────────────────────────────────
  // 패스는 ① 열린 수신자+높은 스코어(품질 패스) ② 스루패스 ③ 고압박으로 불가피할 때만 우선
  const passOptions = evaluatePassOptions(player, team, opponentTeam);
  const bestOption = passOptions.length > 0
    ? passOptions.reduce((a, b) => (b.score > a.score ? b : a))
    : null;
  const passQuality = bestOption ? bestOption.score : 0;
  // 품질 임계값 55→38: 거리 감쇠 후 15m 전진패스도 quality로 인정
  const passIsQuality = bestOption && ((bestOption.open && passQuality > 38) || bestOption.type === 'THROUGH');
  const passForced = pressure > 60;
  // settleFactor: 볼을 잡은 직후에는 패스 가치를 크게 깎아 곧바로 되받아 차지 않게 한다
  // canPass: tMin 이전에는 패스 유틸리티 자체를 0으로 차단 (긴급 상황 제외)
  // 분모 260→220, non-quality 0.14→0.28: 패스 유틸리티 전반 상향
  const passUtility = bestOption && canPass
    ? clamp01(passQuality / 220) * (passForced ? 1.5 : passIsQuality ? 0.90 : 0.28) *
      (pressure > 50 ? 1.3 : 1) * (passForced ? 1 : 0.25 + settleFactor * 0.75)
    : 0;

  // ── Stage 4: 드리블 판단 ───────────────────────────────────
  const dribble = evaluateDribble(player, team, opponentTeam, pressure);

  // ── 경합드리블(SHIELD_DRIVE): 강한 선수가 밀착 수비를 몸으로 밀치며 전진 ──
  // shieldChance >= 0.55 / nearestOppDist < 7.0: 몸싸움 우위를 확보하면
  // 일반 드리블/패스 판단보다 우선해 과감히 돌파한다. shieldDriveTimer 동안
  // 지속되어 판단 주기마다 마음이 바뀌지 않고 몸싸움 드리블을 유지한다.
  // (최전방 드리블, 측면 돌파 모두 이 경로로 경합드리블을 낼 수 있다)
  const goalFromCarrier = attackDir === 1 ? Pitch.LENGTH : 0;
  const wingInDeepCrossZone =
    ((player.role === 'LM' && player.position.y < Pitch.WIDTH * 0.30) ||
     (player.role === 'RM' && player.position.y > Pitch.WIDTH * 0.70)) &&
    Math.abs(player.position.x - goalFromCarrier) < Pitch.PENALTY_BOX_LENGTH + 10;
  const shieldActive = (mem.shieldDriveTimer ?? 0) > 0;
  const shieldEngage = dribble.shieldChance >= 0.55 && dribble.nearestOppDist < 7.0;
  if (!isDefender && !inShootingBox && !wingInDeepCrossZone && !canShootNow &&
      (shieldActive || shieldEngage) && pressure < 88) {
    if (!shieldActive) mem.shieldDriveTimer = SHIELD_DRIVE_DURATION;
    mem.debugIntent = { type: 'SHIELD_DRIVE', target: dribble.target.clone() };
    mem.lastIntent = { type: 'MOVE', target: dribble.target, sprint: true, pressure };
    return mem.lastIntent;
  }

  // ── Pressure Threshold 기반 강제 행동 ──────────────────────────
  // 이기적 성향(드리블 스탯↑ + 창의성↑ + 판단력↓)이면 더 오래 드리블을 고집한다.
  const dribStat = player.attributes.dribbling / 100;
  const decStat = (player.attributes.decisionMaking ?? 70) / 100;
  const selfishness = Math.max(0, dribStat * 0.6 + (mem.creativity - 0.5) * 0.4 - decStat * 0.3);
  const DRIBBLE_THRESHOLD = 20 + Math.round(selfishness * 15);   // 20~27.5
  const PASS_FORCE_THRESHOLD = 65 + Math.round(selfishness * 20); // 65~77

  if (pressure < DRIBBLE_THRESHOLD && dribble.noOpponentAhead && !canShootNow) {
    const intent = { type: 'MOVE', target: dribble.target, sprint: true, pressure };
    mem.debugIntent = { type: 'DRIBBLE', target: dribble.target.clone() };
    mem.lastIntent = intent;
    return intent;
  }

  if (pressure >= PASS_FORCE_THRESHOLD && bestOption && !inShootingBox && !canShootNow && settleFactor > 0.3 && canPass) {
    const safeOptions = passOptions.filter(o => o.open && o.score > 20);
    const safeBest = safeOptions.length > 0
      ? safeOptions.reduce((a, b) => b.score > a.score ? b : a)
      : bestOption;
    const isThrough = safeBest.type === 'THROUGH' && safeBest.futurePos;
    const intent = {
      type: 'PASS',
      targetPlayer: safeBest.player,
      targetPos: isThrough ? safeBest.futurePos : null,
      lofted: isThrough || safeBest.lobbed || safeBest.distance > 32,
      pressure,
    };
    mem.lastIntent = intent;
    mem.debugIntent = { type: 'PASS', target: (isThrough ? safeBest.futurePos : safeBest.player.position).clone() };
    return intent;
  }

  // ── 스루패스 타이밍 단축: 최전방이 침투 중이면 소유 후 빠르게 전달 ──
  // 오프사이드가 되거나 침투 런이 닫히기 전에 더 빨리 스루패스를 내준다.
  if (!inShootingBox && !canShootNow && mem.possessionTimer >= 0.4) {
    const through = passOptions.find((o) => o.type === 'THROUGH' && (o.open || o.leadSpaceOpen || o.lobbed));
    if (through) {
      const intent = {
        type: 'PASS',
        targetPlayer: through.player,
        targetPos: through.futurePos ?? null,
        lofted: !!through.futurePos || through.distance > 32,
        pressure,
      };
      mem.lastIntent = intent;
      mem.debugIntent = { type: 'PASS', target: (through.futurePos ?? through.player.position).clone() };
      return intent;
    }
  }

  // ── Cross check: 측면 깊은 지역에서는 각도가 없으므로 박스로 크로스 ──────
  {
    const opGX = attackDir === 1 ? Pitch.LENGTH : 0;
    const distGL = Math.abs(player.position.x - opGX);
    // 측면 판정: 윙어는 자기 쪽 측면, 그 외에는 좌우 어느 쪽이든 터치라인 근처
    const onFlank = player.role === 'LM'
      ? player.position.y < Pitch.WIDTH * 0.30
      : player.role === 'RM'
        ? player.position.y > Pitch.WIDTH * 0.70
        : player.position.y < Pitch.WIDTH * 0.24 || player.position.y > Pitch.WIDTH * 0.76;
    if (onFlank && distGL < Pitch.PENALTY_BOX_LENGTH + 10 && !canShootNow && canPass) {
      const [gTopY, gBottomY] = Pitch.goalYRange();
      const goalHint = new Vector2D(opGX, (gTopY + gBottomY) / 2);
      const receivers = team.players.filter((p) =>
        p !== player && p.role !== 'GK' &&
        Math.abs(p.position.x - opGX) < Pitch.PENALTY_BOX_LENGTH + 8
      );
      if (receivers.length > 0) {
        // 골대 쪽에 가장 가까운(침투한) 동료를 최우선 수신자로 삼고,
        // ST는 가산점을 줘 박스 중앙 공략을 유도한다.
        const recv = receivers.reduce((a, b) => {
          const sa = a.position.sub(goalHint).length() - (a.role === 'ST' ? 3 : 0);
          const sb = b.position.sub(goalHint).length() - (b.role === 'ST' ? 3 : 0);
          return sb < sa ? b : a;
        });
        const crossX = attackDir === 1 ? Pitch.LENGTH - 9 : 9;
        const crossCenter = new Vector2D(crossX, (gTopY + gBottomY) / 2);
        // 수신자 미래 위치(0.6s 선행)를 기준으로 크로스를 올린다
        const recvFuture = recv.position.add(recv.velocity.scale(0.6));
        const targetPos = Vector2D.lerp(recvFuture, crossCenter, 0.4);
        const intent = { type: 'PASS', targetPlayer: recv, targetPos, lofted: true, pressure };
        mem.lastIntent = intent;
        mem.debugIntent = { type: 'CROSS', target: targetPos.clone() };
        mem.flankBreakthrough = false; // 크로스 후 돌파 종료
        return intent;
      }
    }
  }

  // ── 파이널 서드 예외 로직 (상대 페널티 박스 근처) ──────────
  const opponentGoalX = attackDir === 1 ? Pitch.LENGTH : 0;
  const distToOpponentGoal = Math.abs(player.position.x - opponentGoalX);
  const isInFinalThird = distToOpponentGoal < Pitch.PENALTY_BOX_LENGTH + 5.5;

  let effectiveShootUtility = shootUtility;
  let effectivePassUtility = passUtility;
  let effectiveDribbleUtility = dribble.utility;
  let effectiveBestOption = bestOption;

  if (isInFinalThird) {
    // 파이널 서드: 위치에 따라 슈팅/패스/드리블 가중치를 조정해
    // "박스 밖 중거리 일발슛"을 억제하고 박스 안 마무리·조합 공격을 유도한다.
    // - 박스 안쪽(16.5m 이내): 슛 우선 (결단성 있는 마무리)
    // - 박스 밖(16.5m~22m): 슛 유틸리티를 깎고, 드리블로 접근하거나 박스 동료에게 패스
    // 슈팅 하한선: 확실한 클린 찬스에만 적용 (무리한 장거리 슛 억제)
    const inBoxZone = distToOpponentGoal < Pitch.PENALTY_BOX_LENGTH;
    const floor = canShootNow && shot.clearShot && shot.distToGoal < Pitch.PENALTY_BOX_LENGTH
      ? 0.4 * rangeFactor
      : 0;
    effectiveShootUtility = Math.max(shootUtility, floor) * (inBoxZone ? 2.6 : 0.5);
    effectiveDribbleUtility = dribble.utility * (inBoxZone ? 1.1 : 1.5);
    // 파이널 서드 패스: 단거리·전진 옵션 중 "거리순"이 아니라 품질(점수)순으로 고르고,
    // 스루패스(미래 공간 침투)를 최우선한다 — 최전방 패스 연결 실패를 줄인다.
    const finalThirdOptions = passOptions.filter(
      (o) => o.forwardProgress >= -3 && o.distance < 24
    );
    effectiveBestOption = finalThirdOptions.length > 0
      ? finalThirdOptions.reduce((a, b) => {
          const scoreOf = (o) => o.score + (o.type === 'THROUGH' ? 20 : o.type === 'FORWARD' ? 6 : 0);
          return scoreOf(b) > scoreOf(a) ? b : a;
        })
      : null;
    // 박스 안 열린 동료가 있으면 패스를 우선시한다 (박스 밖 슛 억제와 연동).
    effectivePassUtility = effectiveBestOption ? passUtility * (inBoxZone ? 0.85 : 1.4) : 0;
  }

  // ── Stage 5: 유틸리티 가중 랜덤 결정 + decisionMaking 노이즈 ──
  const dm = (player.attributes.decisionMaking ?? 70) / 100;
  const addNoise = (u) => Math.max(0, u + (Math.random() - 0.5) * (1 - dm) * 0.4);

  // 슛이 불가능한 상황(사거리 밖·각도 없음)에서는 판단 노이즈로도 슛이 나오지 않게 한다.
  // (노이즈만으로 슛이 선택되면 하프라인 부근에서 뜬금없이 장거리 슛을 때린다)
  const noisedShoot = canShootNow ? addNoise(effectiveShootUtility) : 0;
  const noisedPass = addNoise(effectivePassUtility);
  const noisedDribble = addNoise(effectiveDribbleUtility);
  const total = noisedShoot + noisedPass + noisedDribble;
  const roll = Math.random() * total;

  let intent;
  if (roll < noisedShoot) {
    intent = { type: 'SHOOT', pressure };
    mem.debugIntent = { type: 'SHOOT', target: shot.goalCenter.clone() };
  } else if (roll < noisedShoot + noisedPass && effectiveBestOption) {
    const isThrough = effectiveBestOption.type === 'THROUGH' && effectiveBestOption.futurePos;
    intent = {
      type: 'PASS',
      targetPlayer: effectiveBestOption.player,
      targetPos: isThrough ? effectiveBestOption.futurePos : null,
      lofted: isThrough || effectiveBestOption.lobbed || effectiveBestOption.distance > 32,
      pressure,
    };
    const debugTarget = isThrough
      ? effectiveBestOption.futurePos.clone()
      : effectiveBestOption.player.position.clone();
    mem.debugIntent = { type: 'PASS', target: debugTarget };
  } else if (noisedDribble > 0.05) {
    intent = { type: 'MOVE', target: dribble.target, sprint: true, pressure };
    mem.debugIntent = { type: 'DRIBBLE', target: dribble.target.clone() };
  } else if (effectiveBestOption) {
    intent = { type: 'PASS', targetPlayer: effectiveBestOption.player, lofted: effectiveBestOption.distance > 32, pressure };
    mem.debugIntent = { type: 'PASS', target: effectiveBestOption.player.position.clone() };
  } else if (pressure === 0) {
    intent = { type: 'MOVE', target: player.position.clone(), sprint: false, speedFactor: 0.2 };
    mem.debugIntent = null;
  } else {
    intent = { type: 'MOVE', target: dribble.target, sprint: true, pressure };
    mem.debugIntent = { type: 'DRIBBLE', target: dribble.target.clone() };
  }

  mem.lastIntent = intent;
  return intent;
}

function pickDribbleTarget(player, team, opponentTeam, goalPos) {
  const attackDirEarly = team.attackingDirection;
  const goalLineX = attackDirEarly === 1 ? Pitch.LENGTH : 0;
  const distToGoalLine = Math.abs(player.position.x - goalLineX);

  const aimPos = distToGoalLine < BYLINE_REDIRECT_DIST
    ? new Vector2D(goalLineX - attackDirEarly * Pitch.PENALTY_SPOT_DIST, Pitch.WIDTH / 2)
    : goalPos;

  // ── 드리블 회피 벡터 (Avoidance Dribble) ────────────────────
  // V_dribble = w1 * û_goal + w2 * V_avoid
  // V_avoid: 반경 내 수비수들의 역제곱 반발력 합산 (멀수록 약해짐)
  const AVOID_RADIUS = 11;
  const SLALOM_DIST = 5.5; // 이 거리 안의 전방 차단자는 측면 돌파(슬라롬) 대상
  const goalDir = aimPos.sub(player.position).length() > 0.5
    ? aimPos.sub(player.position).normalize()
    : new Vector2D(-attackDirEarly, 0);

  let avoidVec = Vector2D.zero();
  let nearestDist = Infinity;
  let nearestOpp = null;
  let closeBlocker = null; // 전방 진행 경로를 막고 있는 수비수 (측면 회피 대상)
  for (const o of opponentTeam.players) {
    if (o.role === 'GK') continue;
    const toOpp = o.position.sub(player.position);
    const d = toOpp.length();
    if (d < nearestDist) { nearestDist = d; nearestOpp = o; }
    if (d < 0.5 || d > AVOID_RADIUS) continue;
    // 진행 방향 정면에 가까운 수비수일수록 반발력을 강화 (측면 수비수는 가볍게)
    const front = Math.max(0, toOpp.normalize().dot(goalDir));
    avoidVec = avoidVec.add(toOpp.normalize().scale(-(1 / (d * d)) * (1 + 2.0 * front * front)));
    // 전방 SLALOM_DIST 이내에서 진행 방향을 막고 있으면 측면 돌파가 필요하다
    if (d < SLALOM_DIST && front > 0.45) {
      if (!closeBlocker || d < closeBlocker.dist) closeBlocker = { player: o, dist: d };
    }
  }
  const avoidMag = avoidVec.length();
  const avoidNorm = avoidMag > 1e-6 ? avoidVec.scale(1 / avoidMag) : Vector2D.zero();

  let steer;
  // 공격적 역할(윙어·ST)은 전진 성분 가중치를 높여 더 과감하게 돌파한다
  const isAttacker = player.role === 'LM' || player.role === 'RM' || player.role === 'ST';
  const w1 = isAttacker ? 0.70 : 0.62;
  const w2 = Math.min(0.9, avoidMag * 2.2);
  if (closeBlocker) {
    // ── 밀착 차단자 측면 돌파 (Slalom) ─────────────────────────
    // 가까울수록 날카롭게, 멀리 있으면 부드럽게 방향을 꺾어 수비수를
    // 향해 그대로 돌진하지 않는다 (전진 성분은 거리에 비례해 유지)
    const toBlocker = closeBlocker.player.position.sub(player.position);
    let lateral = new Vector2D(-toBlocker.y, toBlocker.x);
    if (lateral.dot(goalDir) < 0) lateral = lateral.scale(-1);
    const closeness = Math.max(0, Math.min(1, (SLALOM_DIST - closeBlocker.dist) / SLALOM_DIST));
    const fwdW = 0.75 - closeness * 0.4;
    const sideW = 0.45 + closeness * 0.4;
    steer = goalDir.scale(fwdW).add(lateral.normalize().scale(sideW)).normalize();
  } else {
    steer = (avoidMag > 0.05)
      ? goalDir.scale(w1).add(avoidNorm.scale(w2)).normalize()
      : goalDir;
  }

  const isWinger = player.role === 'LM' || player.role === 'RM';
  const centerY = Pitch.WIDTH / 2;
  const wingY = player.role === 'LM' ? Pitch.WIDTH * 0.1 : Pitch.WIDTH * 0.9;
  const pressFront = nearestOpp && nearestDist < 8;

  if (!closeBlocker && isWinger && pressFront) {
    if (Math.random() < 0.4) {
      steer = goalDir.scale(0.5).add(new Vector2D(0, centerY - player.position.y).normalize().scale(0.5)).normalize();
    } else {
      steer = goalDir.scale(w1).add(avoidNorm.scale(0.35)).normalize();
    }
  } else if (!closeBlocker && isWinger) {
    const isOnFlank = player.role === 'LM'
      ? player.position.y < Pitch.WIDTH * 0.35
      : player.position.y > Pitch.WIDTH * 0.65;
    if (isOnFlank && distToGoalLine >= BYLINE_REDIRECT_DIST) {
      const forwardDir = new Vector2D(team.attackingDirection, 0);
      const keepFlank = new Vector2D(0, Math.sign(wingY - player.position.y));
      steer = forwardDir.scale(0.82).add(keepFlank.scale(0.18)).normalize();
    } else if (isOnFlank) {
      steer = goalDir;
    } else {
      const sideDir = new Vector2D(0, Math.sign(wingY - player.position.y));
      steer = goalDir.scale(0.65).add(sideDir.scale(0.35)).normalize();
    }
  } else if (!closeBlocker && pressFront && Math.random() < 0.25) {
    // 페이크 무브: 가끔 측면으로 방향 전환해 수비수를 따돌린다
    const lateral = new Vector2D(-goalDir.y, goalDir.x).scale(Math.random() < 0.5 ? 1 : -1);
    steer = goalDir.scale(0.35).add(lateral.scale(0.5)).add(avoidNorm.scale(0.25)).normalize();
  }

  const dribbleDist = nearestOpp && nearestDist < 4
    ? 8 + Math.random() * 5
    : 6 + Math.random() * 5;
  let target = Pitch.clampInside(player.position.add(steer.scale(dribbleDist)), 1.5);

  // 최종 목표 보정: 수비수 몸(2.2m)에 닿는 지점이면 밀어내 빈 공간을 향하게 한다
  for (const o of opponentTeam.players) {
    if (o.role === 'GK') continue;
    const d = target.sub(o.position).length();
    if (d < 2.2) {
      const away = target.sub(o.position).normalize().scale(2.2 - d);
      target = Pitch.clampInside(target.add(away), 1.5);
    }
  }

  // 상대 골라인 근처로는 몰고 가지 않는다 (골키퍼 뒤로 드리블해 나가는 현상 방지)
  const attackDir = team.attackingDirection;
  const opponentGoalX = attackDir === 1 ? Pitch.LENGTH : 0;
  const limitX = opponentGoalX - attackDir * MIN_DRIBBLE_DIST_FROM_GOAL_LINE;
  const clampedX = attackDir === 1 ? Math.min(target.x, limitX) : Math.max(target.x, limitX);
  if (clampedX !== target.x) {
    // X를 잘라내는 대신 골문 중앙 쪽으로 방향을 틀어 슛 각도를 확보한다
    target = new Vector2D(clampedX, target.y * 0.55 + (Pitch.WIDTH / 2) * 0.45);
  }
  return target;
}

function decideDefensiveOffBall(ctx) {
  const { player, team, opponentTeam, ball } = ctx;
  const mem = player.brainMemory;
  const distToBall = player.position.sub(ball.position).length();
  const ownGoalX = team.attackingDirection === 1 ? 0 : Pitch.LENGTH;

  // 수비 진입 시 공격 오프볼 상태(서포트요청 등) 라벨을 초기화해
  // 수비 전환 상황에서 헷갈리는 표시가 남지 않게 한다.
  mem.offBallBehavior = null;
  mem.offBallTarget = null;

  // Stage 2: 비용 함수(C_i = dist × W_role)로 1차/2차 압박 선수 선정
  // 전술 압박 수치가 높으면(pressing > 0.65) 2명 선정
  const presserCount = team.tactics.pressing > 0.65 ? 2 : 1;
  const pressers = selectPressers(team.outfieldPlayers, ball, presserCount);

  if (pressers.includes(player)) {
    // 테더 체크: 기본 위치에서 MAX_TETHER(18m) 이상 이탈하면 압박 해제 → 수비 블록 복귀
    const tooFar = player.basePosition &&
      player.position.sub(player.basePosition).length() > MAX_TETHER;

    if (!tooFar) {
      // 골 사이드 접근 벡터: 공→우리 골대 방향으로 rTackle 미터 앞에 서서 경로 차단
      const isPrimary = pressers[0] === player;
      const pressTarget = isPrimary
        ? computePresserTarget(ball, team)
        : computeCutoffTarget(ball, team);
      const sprint = distToBall > 5;
      mem.defendBehavior = 'PRESSING';
      mem.markTarget = null;
      mem.pressTarget = pressTarget.clone();
      return moveIntent(pressTarget, sprint);
    }
    // 테더 초과 시 압박 해제 — 아래 수비 블록 로직으로 낙하
  }

  // Stage 1+3: 수비 서포트(골 사이드 지능 배치) + 대인 마크/커버 섀도우
  const baseTarget = computeDefensiveSupport({ player, team, opponentTeam, ball });
  const defensive = computeDefensiveTarget({
    player, team, opponentTeam, ball, baseTarget,
  });

  // 커버링 쉬프트: 압박 선수(1차)가 비운 위치를 가장 가까운 1-2명이 20-30% 채운다
  let finalTarget = defensive.target;
  const primaryPresser = pressers[0];
  if (primaryPresser && primaryPresser !== player && primaryPresser.basePosition) {
    const coverCandidates = team.outfieldPlayers
      .filter((p) => !pressers.includes(p) && p.role !== 'GK')
      .sort((a, b) =>
        a.position.sub(primaryPresser.basePosition).length() -
        b.position.sub(primaryPresser.basePosition).length()
      );
    if (coverCandidates.indexOf(player) < 2) {
      finalTarget = computeCoveringShift(defensive.target, primaryPresser, player);
    }
  }

  mem.defendBehavior = defensive.behavior;
  mem.markTarget = defensive.markTarget;
  mem.pressTarget = null;
  mem.defendTarget = finalTarget.clone(); // AI표시 디버그용 이동 목표 저장

  const threatLevel = clamp01(1 - Math.abs(ball.position.x - ownGoalX) / 45);
  const dist = player.position.sub(finalTarget).length();
  // 3단계 속도: 원거리 이동(고속) → 중거리 크루즈(중속) → 근거리 정착(저속)
  const sf = dist > 14 ? 0.75 + threatLevel * 0.25 :
             dist > 6  ? 0.55 + threatLevel * 0.20 :
                         0.35 + threatLevel * 0.15;
  return moveIntent(finalTarget, false, sf);
}

function decideGoalkeeper(ctx) {
  const { player, team, ball, dt } = ctx;
  const mem = player.brainMemory;
  const ownGoalSide = team.attackingDirection === 1 ? 'left' : 'right';
  const goalX = ownGoalSide === 'left' ? 0 : Pitch.LENGTH;
  const [topY, bottomY] = Pitch.goalYRange();
  const centerY = (topY + bottomY) / 2;
  const outward = ownGoalSide === 'left' ? 1 : -1;

  if (player.hasBall) {
    mem.gkHoldTimer = (mem.gkHoldTimer ?? 0) + dt;
    if (mem.gkHoldTimer > 1.1) {
      mem.gkHoldTimer = 0;
      return decideGkDistribution(ctx);
    }
    return { type: 'HOLD' };
  }

  const distToGoalLine = Math.abs(ball.position.x - goalX);
  const distToBall = player.position.sub(ball.position).length();

  // 루즈볼 수집: 가까울 때만 (1v1 상황이 아니면 골대를 비우지 않는다)
  if (!ball.owner && distToBall < 6 && distToGoalLine < 14) {
    return moveIntent(ball.position.clone(), true);
  }

  if (ball.isShot && ball.velocity.x !== 0) {
    const timeToLine = (goalX - ball.position.x) / ball.velocity.x;
    if (timeToLine > 0 && timeToLine < 2.5) {
      const predictedY = ball.position.y + ball.velocity.y * timeToLine;
      const clampedY = Math.max(topY - 4, Math.min(bottomY + 4, predictedY));
      return moveIntent(new Vector2D(goalX + outward * 1.0, clampedY), true);
    }
  }

  // GK 포지셔닝: 골대 근처에서만 움직인다. 너무 멀리 나가지 않는다.
  let targetY = centerY + (ball.position.y - centerY) * 0.55;
  targetY = Math.max(topY - 4, Math.min(bottomY + 4, targetY));
  let depth = 2.0;
  if (distToGoalLine < 18) depth = 2.0 + (18 - distToGoalLine) * 0.12;
  // 최대 전진 거리 제한 (골대를 비우지 않음)
  depth = Math.min(depth, 5.5);
  const targetX = goalX + outward * depth;

  return moveIntent(new Vector2D(targetX, targetY));
}

function decideGkDistribution(ctx) {
  const { player, team, opponentTeam } = ctx;
  let best = null;
  let bestScore = -Infinity;
  for (const t of team.outfieldPlayers) {
    const pressure = opponentTeam.players.filter((o) => o.position.sub(t.position).length() < 5).length;
    const forwardness = (t.position.x - player.position.x) * team.attackingDirection;
    const score = -pressure * 10 + forwardness * 0.3;
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return { type: 'PASS', targetPlayer: best ?? team.outfieldPlayers[0], lofted: true };
}

/**
 * 공중볼 경합에서 이긴 선수가 헤딩으로 무엇을 할지 결정한다.
 * HEAD_SHOT: 골대와 가깝고 각도가 열려 있을 때
 * HEAD_PASS: 전방 열린 동료가 있을 때
 * HEAD_CLEAR: 수비 진영이거나 위험 지역에서
 */
export function decideHeaderIntent(player, ball, opponentTeam, team) {
  const attackDir = team.attackingDirection;
  const ownGoalX = attackDir === 1 ? 0 : Pitch.LENGTH;
  const opponentGoalX = attackDir === 1 ? Pitch.LENGTH : 0;
  const distFromOwnGoal = player.position.sub(new Vector2D(ownGoalX, Pitch.WIDTH / 2)).length();
  const distToGoal = player.position.sub(new Vector2D(opponentGoalX, Pitch.WIDTH / 2)).length();
  const isDefender = player.role === 'CB' || player.role === 'LB' || player.role === 'RB';

  if (isDefender || distFromOwnGoal < 28) {
    return { type: 'HEAD_CLEAR' };
  }

  const [topY, bottomY] = Pitch.goalYRange();
  const toTop = new Vector2D(opponentGoalX - player.position.x, topY - player.position.y);
  const toBottom = new Vector2D(opponentGoalX - player.position.x, bottomY - player.position.y);
  const angleOpen = Math.abs(toTop.angle() - toBottom.angle());

  if (distToGoal < 20 && angleOpen > 0.12) {
    return { type: 'HEAD_SHOT' };
  }

  // 전방 열린 동료가 있으면 헤딩 패스
  for (const t of team.players) {
    if (t === player || t.role === 'GK') continue;
    const dist = t.position.sub(player.position).length();
    const forwardProgress = (t.position.x - player.position.x) * attackDir;
    if (dist < 25 && dist > 2 && forwardProgress > 3) {
      const blocked = isPassingLaneBlocked(player.position, t.position, opponentTeam.players);
      if (!blocked) {
        return { type: 'HEAD_PASS', targetPlayer: t };
      }
    }
  }

  return { type: 'HEAD_CLEAR' };
}
