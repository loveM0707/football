import { Vector2D } from '../entities/Vector2D.js';
import { Pitch } from '../entities/Pitch.js';

// ─── 공 물리 상수 (PhysicsEngine과 동기화) ──────────────────────
// 지상: 선형 감쇠 (등가속도) — D = v² / (2μ), v₀ = √(vf² + 2μd)
// 공중: 승법적 감쇠 (공기저항) — 포물선 궤도 기반
const BALL_MU_GROUND = 2.6;    // 지상 감속 가속도 (m/s²) — PhysicsEngine과 동기화 (2.4 → 2.6)
const GRAVITY        = 9.8;    // 중력 가속도 (m/s²)
const CROSSBAR_H     = 2.44;   // 크로스바 높이 (m) — MatchSimulator와 동기화
const PASS_V_MAX     = 28;     // 패스 최대 초기 속도 (m/s)
const D_LONG         = 30;     // 이 거리(m) 이상은 공중 롱패스 처리
const V_ARRIVAL      = 3.0;    // 수신자 발밑 도착 기대 속도 (m/s)
const V_ARRIVAL_THROUGH = 4.2; // 스루패스 도착 기대 속도 — 수신자가 달려오는 공간으로
                               // 띄워주므로 공이 선수보다 빨라야 리드를 잡을 수 있다
                               // 5.5 → 4.2로 낮춰 수신 난이도 완화

/**
 * 지상 패스/클리어가 터치라인·엔드라인을 넘어가지 않도록 킥 세기를 제한한다.
 * 공중볼(isLofted)은 포물선 궤도이므로 이 제한을 적용하지 않는다.
 * 스루패스(isThrough)는 수신자가 쫓아가는 공간 패스이므로 경계 마진을 넓힌다.
 * 선형 감쇠 최대 이동 거리: D = v² / (2μ)
 */
function containKickSpeed(fromPos, dir, speed, isLofted = false, isThrough = false) {
  if (isLofted) return speed;
  const margin = isThrough ? 1.2 : 1.5;
  let maxTravel = Infinity;
  if (dir.x > 1e-6) maxTravel = Math.min(maxTravel, (Pitch.LENGTH - margin - fromPos.x) / dir.x);
  else if (dir.x < -1e-6) maxTravel = Math.min(maxTravel, (margin - fromPos.x) / dir.x);
  if (dir.y > 1e-6) maxTravel = Math.min(maxTravel, (Pitch.WIDTH - margin - fromPos.y) / dir.y);
  else if (dir.y < -1e-6) maxTravel = Math.min(maxTravel, (margin - fromPos.y) / dir.y);

  if (!Number.isFinite(maxTravel) || maxTravel <= 1.0) return speed;
  // 선형 감쇠: D = v² / (2μ)
  const travel = (speed * speed) / (2 * BALL_MU_GROUND);
  if (travel <= maxTravel * (isThrough ? 1.5 : 1.4)) return speed;
  // 클램프: v = √(2μD × 0.95)
  return Math.max(4, Math.sqrt(2 * BALL_MU_GROUND * maxTravel * 0.95));
}

export const ActionExecutor = {
  execute(player, intent, ball, eventBus) {
    switch (intent.type) {
      case 'MOVE':
        this._executeMove(player, intent, ball);
        break;
      case 'PASS':
        this._executePass(player, intent, ball, eventBus);
        break;
      case 'SHOOT':
        this._executeShoot(player, intent, ball, eventBus);
        break;
      case 'CLEAR':
        this._executeClear(player, intent, ball, eventBus);
        break;
      case 'HEAD_SHOT':
        this._executeHeaderShoot(player, intent, ball, eventBus);
        break;
      case 'HEAD_PASS':
        this._executeHeaderPass(player, intent, ball, eventBus);
        break;
      case 'HEAD_CLEAR':
        this._executeHeaderClear(player, intent, ball, eventBus);
        break;
      case 'HOLD':
      default:
        player.desiredVelocity = Vector2D.zero();
        player.state = 'HOLD';
        break;
    }
  },

  _executeMove(player, intent, ball) {
    const toTarget = intent.target.sub(player.position);
    const dist = toTarget.length();
    const isDribble = player.hasBall && intent.type === 'MOVE';
    let speedFactor = intent.speedFactor ?? (intent.sprint ? 1.0 : 0.55);

    if (isDribble) {
      // 드리블 기본 속도 낮춤 (0.55). sprint=true여도 드리블은 0.65로 제한.
      speedFactor = intent.speedFactor ?? (intent.sprint ? 0.65 : 0.55);

      // 드리블 돌파 성공 시 순간 가속 부스트
      if ((player.brainMemory && player.brainMemory.dribbleBurstTimer || 0) > 0) {
        speedFactor = Math.max(speedFactor, 1.15);
      }

      // 창의적이고 빠른 선수는 가끔 전력질주 (약 8% 확률)
      if (intent.sprint && !intent._speedRollDone) {
        const dribbling = player.attributes.dribbling / 100;
        const pace = player.attributes.pace / 100;
        const creativity = (player.brainMemory && player.brainMemory.creativity) || 0.5;
        const burstChance = 0.05 + (dribbling + pace + creativity) / 3 * 0.08; // 5%~13%
        if (Math.random() < burstChance) {
          speedFactor = 1.0;
          intent._speedRollDone = true;
        }
      }
    }

    let desiredSpeed = player.maxSpeed * speedFactor;
    if (dist < 1.2) desiredSpeed *= Math.max(0.15, dist / 1.2);

    player.desiredVelocity = dist > 1e-6 ? toTarget.normalize().scale(desiredSpeed) : Vector2D.zero();
    player.state = intent.sprint ? 'SPRINT' : 'MOVE';

    if (player.hasBall && dist > 0.5) {
      // 드리블 중: 진행 방향으로 facingAngle 즉시 스냅 (360도 회전 방지)
      player.desiredFacingAngle = toTarget.angle();
      player.facingAngle = player.desiredFacingAngle;
    } else {
      const moveSpeed = player.velocity.length();
      if (moveSpeed > 1.0) {
        player.desiredFacingAngle = dist > 0.2 ? toTarget.angle() : player.velocity.angle();
      } else if (player.hasBall) {
        const attackDir = player.team.attackingDirection;
        player.desiredFacingAngle = attackDir === 1 ? 0 : Math.PI;
      } else if (ball) {
        const toBall = ball.position.sub(player.position);
        if (toBall.length() > 0.3) player.desiredFacingAngle = toBall.angle();
      }
    }
  },

  _executePass(passer, intent, ball, eventBus) {
    const receiver = intent.targetPlayer;

    // 스루패스(Through Pass): targetPos가 있으면 수신자 현위치 대신 미래 빈 공간으로 차낸다
    const aimPoint = intent.targetPos
      ? intent.targetPos.clone()
      : (() => {
          const rawDist = receiver.position.sub(passer.position).length();
          const leadTime = Math.min(0.9, rawDist / 18); // 1.1→0.9, 16→18: 리드 타임 축소로 공이 선수 앞이 아닌 발밑 쪽에 떨어지게
          return receiver.position.add(receiver.velocity.scale(leadTime));
        })();

    let toAim = aimPoint.sub(passer.position);
    const dist = Math.max(0.1, toAim.length());

    // ── 실수(Error) 로직: 낮은 패스/시야 능력치 + 높은 압박 → 목표 오차 증가 ──
    const passingSkill = passer.attributes.passing / 100;
    const vision = (passer.attributes.vision ?? passer.attributes.positioning) / 100;
    const pressurePenalty = (intent.pressure ?? 0) / 100;
    const skillError = 1 - passingSkill * 0.7 - vision * 0.3;
    // 기본 오차 0.35→0.22, 압박 계수 0.9→0.65: 70능력치 선수 평상시 각도오차 ±4→±2.4°
    const errorScale = skillError * (0.22 + pressurePenalty * 0.65);

    // 각도 오차(rad) + 세기 오차
    const angleError = (Math.random() - 0.5) * 2 * errorScale * 0.55;
    const powerError = 1 + (Math.random() - 0.5) * errorScale * 0.5;
    const aimDir = toAim.normalize();
    let dir = aimDir.rotate(angleError);

    // 극단 상황(고압박 + 저실력)에서는 빗맞는다. 다만 완전히 반대로 차버리지는
    // 않도록 각도 폭을 좁혀 뜬금없이 라인 밖으로 나가는 현상을 막는다.
    const misplaceChance = errorScale * 0.20;
    if (Math.random() < misplaceChance) {
      const badAngle = (Math.random() - 0.5) * 1.4; // ±약 40도
      dir = dir.rotate(badAngle);
    }

    // D_LONG(30m) 이상이면 공중 롱패스, 아니면 지정된 lofted 값 사용
    const isLong = intent.lofted || dist >= D_LONG;
    const isThroughPass = !!intent.targetPos;

    // 롱패스 고도: 거리에 비례해 높게 차올려 체공 시간 확보
    // vertical이 클수록 t_air = 2·v_vert/g 가 길어져 수평 속도를 낮출 수 있음
    // 로빙 스루패스는 더 낮게 차서 수신하기 쉽게 조정
    let vertical = 0;
    if (isLong) {
      if (isThroughPass) {
        vertical = Math.min(10, 3.0 + dist * 0.15); // 로빙 스루: 더 낮고 빠르게
      } else {
        vertical = Math.min(14, 4.0 + dist * 0.22); // 일반 롱패스/크로스
      }
    }

    // ── 초기 속도 역산 (Required Initial Velocity) ────────────────
    // • 지상 패스: v₀ = d × μ_ground + v_arrival  (승법적 감쇠 역산)
    //   총 이동 거리 D = v₀ / μ이므로, 타겟까지 d를 커버하려면 v₀ = d·μ + v_arrival
    // • 공중 롱패스: 체공 중 마찰 거의 없으므로 비행시간 기반 역산
    //   t_air = 2·v_vert / g,  v_h = d / t_air = d·g / (2·v_vert)
    let speed;
    if (isLong) {
      // 공중 롱패스: 비행시간 기반 수평 속도 (포물선 궤도 유지)
      // v_h = d × g / (2 × v_vert),  t_air = 2·v_vert/g
      speed = dist * GRAVITY / (2 * Math.max(1, vertical));
    } else {
      // 지상 패스: 선형 감쇠 역산 — v₀ = √(vf² + 2μd)
      // vf = V_ARRIVAL(도착 기대 속도), μ = BALL_MU_GROUND
      // 스루패스는 달려오는 동료의 리드를 잡아야 하므로 도착 속도를 높인다
      const vf = intent.targetPos ? V_ARRIVAL_THROUGH : V_ARRIVAL;
      speed = Math.sqrt(vf * vf + 2 * BALL_MU_GROUND * dist);
    }
    speed *= powerError;
    // passSpeed 능력치: 롱패스는 영향을 줄여 비행 속도를 일정하게 유지
    const psScale = (passer.attributes.passSpeed ?? 70) / 100;
    speed *= isLong ? 0.92 + psScale * 0.2 : 0.8 + psScale * 0.5;

    // V_max 클램프: 초과 시 수신자가 computeInterceptionPoint로 공 쪽으로 마중 나감
    speed = Math.min(PASS_V_MAX, speed);

    // 지상 패스만 구역 이탈 방지 적용 (공중볼은 포물선 궤도라 적용 불필요)
    speed = containKickSpeed(passer.position, aimDir, speed, isLong, !!intent.targetPos);

    ball.kick(dir.scale(speed), vertical, passer);
    ball.isShot = false;
    ball.passTargetPlayer = receiver;
    // 스루패스(공간 패스) 표시 — 수신자는 발밑으로 마중 나가지 않고
    // 공이 떨어질 공간으로 달려 들어간다 (PlayerBrain 수신 로직에서 사용)
    ball.isThroughPass = !!intent.targetPos;

    passer.hasBall = false;
    passer.desiredVelocity = Vector2D.zero();
    passer.state = 'PASS';
    passer.facingAngle = dir.angle();
    passer.desiredFacingAngle = passer.facingAngle;
    eventBus.emit('pass', { from: passer, to: receiver, team: passer.team, src: intent.src, through: !!intent.targetPos, lofted: isLong, dist, targetPos: intent.targetPos ?? null });
  },

  _executeShoot(shooter, intent, ball, eventBus) {
    const opponentGoalSide = shooter.team.attackingDirection === 1 ? 'right' : 'left';
    const goalX = opponentGoalSide === 'left' ? 0 : Pitch.LENGTH;
    const [topY, bottomY] = Pitch.goalYRange();

    const accuracy = shooter.attributes.shooting / 100;
    // ── 실수(Error) 로직: 슛 능력치가 낮거나 압박이 심하면 오차 증가 ──
    // 슈팅 시도 자체는 늘리되(PlayerBrain), 결정력은 여기서 낮춘다.
    const pressurePenalty = (intent.pressure ?? 0) / 100;
    const dist = shooter.position.sub(new Vector2D(goalX, Pitch.WIDTH / 2)).length();
    // 거리 페널티: 멀수록 좌우 오차가 커진다 (22m에서 +0.28)
    const distPenalty = Math.max(0, (dist - 11) / 40);
    const spread = 0.15 + (1 - accuracy) * (0.9 + pressurePenalty * 0.8) + distPenalty;
    let targetY = topY + (bottomY - topY) * (0.5 + (Math.random() - 0.5) * spread);

    // 좌우로 크게 빗나감 (골대 옆)
    const wideMissChance = (1 - accuracy) * 0.50 + pressurePenalty * 0.34 + distPenalty * 0.70;
    if (Math.random() < wideMissChance) {
      targetY = Math.random() < 0.5 ? topY - 2 - Math.random() * 4 : bottomY + 2 + Math.random() * 4;
    }

    const targetPoint = new Vector2D(goalX, targetY);
    const dir = targetPoint.sub(shooter.position).normalize();
    // shotSpeed 능력치: 0.85~1.25배 범위로 슈팅 파워 조절
    const shotSpeedScale = 0.85 + (shooter.attributes.shotSpeed ?? 70) / 100 * 0.4;
    const power = (16 + accuracy * 8 + Math.random() * 2) * shotSpeedScale;

    // ── 수직 궤도: 위로 뜨는 슛(Over the bar) 확률 ────────────────
    // 크로스바(2.44m)를 넘길 만큼 뜨면 골이 아니라 골킥이 된다.
    // 도달 시간 t ≈ dist / power 를 기준으로, 그 시점 높이가 크로스바를
    // 넘도록 초기 수직속도를 잡아야 "위로 떴다"가 성립한다.
    const flightTime = Math.max(0.35, dist / Math.max(power, 1));
    // 크로스바를 겨우 넘기는 수직 초속 (h = v·t − ½g·t² = 2.44)
    const vOverBar = (CROSSBAR_H + 0.5 * GRAVITY * flightTime * flightTime) / flightTime;

    const skyMissChance = (1 - accuracy) * 0.38 + pressurePenalty * 0.32 + distPenalty * 0.72;
    let vertical;
    if (Math.random() < skyMissChance) {
      // 위로 크게 띄워 버린 슛
      vertical = vOverBar * (1.05 + Math.random() * 0.45);
    } else {
      // 유효 슛: 크로스바 아래로 지나가도록 수직속도를 제한한다
      const safeMax = Math.max(0, vOverBar * 0.75);
      vertical = Math.min(safeMax, dist > 15 ? 0.8 + Math.random() * 1.6 : Math.random() * 0.8);
    }

    ball.kick(dir.scale(power), vertical, shooter);
    ball.isShot = true;

    shooter.hasBall = false;
    shooter.desiredVelocity = Vector2D.zero();
    shooter.state = 'SHOOT';
    shooter.facingAngle = dir.angle();
    shooter.desiredFacingAngle = shooter.facingAngle;
    // 유효 슈팅: 좌우로도, 위로도 골대를 벗어나지 않은 슛
    const onTarget = targetY >= topY && targetY <= bottomY && vertical < vOverBar * 0.92;
    eventBus.emit('shot', { by: shooter, team: shooter.team, onTarget, src: intent.src });
  },

  _executeHeaderShoot(player, intent, ball, eventBus) {
    const opponentGoalSide = player.team.attackingDirection === 1 ? 'right' : 'left';
    const goalX = opponentGoalSide === 'left' ? 0 : Pitch.LENGTH;
    const [topY, bottomY] = Pitch.goalYRange();
    const headingSkill = (player.attributes.heading ?? 65) / 100;

    const spread = 0.08 + (1 - headingSkill) * 0.28;
    const targetY = topY + (bottomY - topY) * (0.5 + (Math.random() - 0.5) * spread);
    const targetPoint = new Vector2D(goalX, targetY);
    const dir = targetPoint.sub(player.position).normalize();
    const power = 7 + headingSkill * 5 + Math.random() * 1.5;

    ball.kick(dir.scale(power), 0.4, player);
    ball.isShot = true;

    player.hasBall = false;
    player.desiredVelocity = Vector2D.zero();
    player.state = 'SHOOT';
    player.facingAngle = dir.angle();
    player.desiredFacingAngle = player.facingAngle;
    const onTarget = targetY >= topY && targetY <= bottomY;
    eventBus.emit('shot', { by: player, team: player.team, header: true, onTarget });
  },

  _executeHeaderPass(player, intent, ball, eventBus) {
    const receiver = intent.targetPlayer;
    const aimPoint = receiver.position.add(receiver.velocity.scale(0.4));
    const toAim = aimPoint.sub(player.position);
    const dist = Math.max(0.1, toAim.length());
    const dir = toAim.normalize();

    const headingSkill = (player.attributes.heading ?? 65) / 100;
    const angleError = (Math.random() - 0.5) * (0.20 - headingSkill * 0.12);
    const finalDir = dir.rotate(angleError);

    const speed = Math.min(10, Math.sqrt(4 + 2 * BALL_MU_GROUND * dist));

    ball.kick(finalDir.scale(speed), 1.2, player);
    ball.isShot = false;
    ball.passTargetPlayer = receiver;

    player.hasBall = false;
    player.desiredVelocity = Vector2D.zero();
    player.state = 'PASS';
    player.facingAngle = finalDir.angle();
    player.desiredFacingAngle = player.facingAngle;
    eventBus.emit('pass', { from: player, to: receiver, team: player.team, header: true });
  },

  _executeHeaderClear(player, intent, ball, eventBus) {
    const attackDir = player.team.attackingDirection;
    const lateralOffset = (Math.random() - 0.5) * 18;
    const targetX = player.position.x + attackDir * 35;
    const targetY = Math.max(5, Math.min(Pitch.WIDTH - 5, Pitch.WIDTH / 2 + lateralOffset));
    const target = new Vector2D(targetX, targetY);
    const dir = target.sub(player.position).normalize();
    const speed = 8 + Math.random() * 3;

    ball.kick(dir.scale(speed), 2.0 + Math.random() * 1.5, player);
    ball.isShot = false;
    ball.passTargetPlayer = null;

    player.hasBall = false;
    player.desiredVelocity = Vector2D.zero();
    player.state = 'PASS';
    player.facingAngle = dir.angle();
    player.desiredFacingAngle = player.facingAngle;
    eventBus.emit('clear', { by: player, team: player.team, header: true });
  },

  _executeClear(player, intent, ball, eventBus) {
    const attackDir = player.team.attackingDirection;
    // 자기 진영 깊은 곳에서 → 전방 + 약간 측면으로 롱킥
    const lateralOffset = (Math.random() - 0.5) * 20;
    const targetX = player.position.x + attackDir * 45;
    const targetY = Math.max(5, Math.min(Pitch.WIDTH - 5, Pitch.WIDTH / 2 + lateralOffset));
    const target = new Vector2D(targetX, targetY);
    const dir = target.sub(player.position).normalize();
    // 라인 밖으로 걷어차 버리지 않도록 세기를 제한한다
    const speed = containKickSpeed(player.position, dir, 14 + Math.random() * 4);

    ball.kick(dir.scale(speed), 5.5 + Math.random() * 2.5, player);
    ball.isShot = false;
    ball.passTargetPlayer = null;

    player.hasBall = false;
    player.desiredVelocity = Vector2D.zero();
    player.state = 'PASS';
    player.facingAngle = dir.angle();
    player.desiredFacingAngle = player.facingAngle;
    eventBus.emit('clear', { by: player, team: player.team });
  },
};
