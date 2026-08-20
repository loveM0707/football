import { Vector2D } from '../../entities/Vector2D.js';
import { Pitch } from '../../entities/Pitch.js';
import { clamp, clamp01, angleDiff } from '../core/Coords.js';
import { Action } from '../entities/Player.js';

/**
 * 이동 엔진 — 선수의 위치·속도를 기록하는 유일한 주체.
 *
 * ⚠ 권한 규칙
 *   player.position / velocity / facingAngle 을 대입하는 코드는 이 파일뿐이다.
 *   판단 계층(DecisionEngine 등)은 "어디로 가고 싶은가"(decision.target)만
 *   남기고, 실제로 어떻게 움직일지는 전부 여기서 정한다.
 *   구 엔진은 이동 권한이 둘로 갈라져 서로 다른 목표로 선수를 잡아당겼다.
 *
 * ── 사람처럼 움직이게 만드는 세 가지 제약 ────────────────────
 *  1. 가속/감속 한계  : 즉시 최고 속도에 도달하지 못한다
 *  2. 선회 가속도 한계: 빠르게 달릴수록 크게 돌아야 한다 (r = v²/a_lat)
 *     → 이것이 없으면 전속력으로 즉시 방향을 꺾어 입자처럼 보인다
 *  3. 도착 감속       : 목표를 지나쳐 진동하지 않도록 미리 감속한다
 *
 * 이 제약들만으로 곡선 주로·가속 지연·회전 반경이 자연히 생긴다.
 * 난수로 흔들어 "자연스럽게" 만들지 않는다 (Section 49).
 */

/** 목표에 이 거리 안으로 들어오면 정지한다 (m) */
const ARRIVE_STOP_RADIUS = 0.25;

/** 이 속력 미만이면 정지로 간주 (m/s) */
const IDLE_SPEED = 0.05;

/** 선수 몸통 반지름 (m) — 물리적 겹침 방지용 */
const BODY_RADIUS = 0.42;

/** 피치 바깥으로 나갈 수 있는 최대 여유 (m) — 스로인 등 */
const OUT_MARGIN = 3.0;

/**
 * 최대 선회 가속도 (m/s²).
 *
 * 사람이 지면 마찰로 낼 수 있는 횡가속도는 대략 4.5~8 m/s²다.
 * 이 값이 일정하므로 회전 반경 r = v²/a_lat 은 속도의 제곱에 비례해 커진다.
 * → 느릴 때는 제자리에서 꺾고, 전속력에서는 크게 돌게 되는 거동이
 *   별도 규칙 없이 자연히 나온다.
 */
function maxLateralAcceleration(player) {
  const agility = player.attributes.norm('agility');
  const balance = player.attributes.norm('balance');
  const base = 4.5 + agility * 3.0 + balance * 0.5;
  // 지친 선수는 방향 전환이 무뎌진다
  return base * (0.82 + 0.18 * player.energy);
}

/**
 * 판단(urgency/sprint)을 실제 목표 속력으로 바꾼다.
 * 항상 전속력으로 달리면 경기가 부자연스럽고 체력 모델도 의미를 잃는다.
 */
function targetSpeedFor(player) {
  const { sprint, urgency } = player.decision;
  // 걷기(0.35) ~ 조깅 ~ 달리기, 스프린트면 최고 속도
  const fraction = sprint ? 1.0 : 0.35 + clamp01(urgency) * 0.5;
  let speed = player.maxSpeed * fraction;
  // 볼을 몰고 있으면 느려진다
  if (player.hasBall) speed *= player.carrySpeedFactor;
  return speed;
}

export class MovementEngine {
  /**
   * @param {MatchEngine} engine
   * @param {number} dt 고정 스텝
   */
  update(engine, dt) {
    const players = engine.allPlayers;

    for (const player of players) {
      this._integrate(player, dt);
    }

    // 물리적 겹침 해소.
    // ⚠ 이것은 "몸이 같은 자리를 차지할 수 없다"는 물리 제약일 뿐,
    //   전술적 간격 유지 수단이 아니다. 팀 형태는 TeamShape가 정한다.
    //   (Section 11: 단순 척력을 팀 형태의 주된 수단으로 쓰지 않는다)
    this._separateBodies(players);
  }

  /**
   * 한 선수의 운동을 한 스텝 적분한다.
   * @param {Player} player
   * @param {number} dt
   */
  _integrate(player, dt) {
    const decision = player.decision;
    const speed = player.velocity.length();

    // ── 0. 체력 갱신 ───────────────────────────────────────
    // 속도 한계가 체력에 의존하므로, 이번 스텝의 모든 한계가
    // 같은 체력 값을 쓰도록 맨 앞에서 갱신한다.
    // (뒤에서 갱신하면 상한을 적용한 직후 상한이 내려가 한 스텝 어긋난다)
    const exertion = player.maxSpeed > 0 ? clamp01(speed / player.maxSpeed) : 0;
    player.updateEnergy(dt, exertion);

    // ── 1. 원하는 속도 벡터 ────────────────────────────────
    let desiredVelocity = Vector2D.zero();

    if (decision.target && decision.action !== Action.IDLE) {
      const toTarget = decision.target.sub(player.position);
      const distance = toTarget.length();

      if (distance > ARRIVE_STOP_RADIUS) {
        const direction = toTarget.normalize();
        let desiredSpeed = targetSpeedFor(player);

        // 도착 감속: 남은 거리에서 정확히 멈출 수 있는 속력으로 제한한다.
        // v = √(2·a·d) — 이 이상으로 달리면 목표를 지나친다.
        const stoppingSpeed = Math.sqrt(2 * player.maxDeceleration * distance);
        desiredSpeed = Math.min(desiredSpeed, stoppingSpeed);

        desiredVelocity = direction.scale(desiredSpeed);
      }
      // 목표 반경 안이면 desiredVelocity = 0 (정지)
    }

    // ── 2. 조향 벡터를 전후/횡 성분으로 분해 ────────────────
    const steer = desiredVelocity.sub(player.velocity);

    // 현재 진행 방향. 거의 멈춰 있으면 몸이 향한 쪽을 기준으로 삼는다.
    const heading = speed > IDLE_SPEED
      ? player.velocity.normalize()
      : Vector2D.fromAngle(player.facingAngle);

    const alongMagnitude = steer.dot(heading);            // 전후 성분 (부호 있음)
    const lateralVector = steer.sub(heading.scale(alongMagnitude)); // 횡 성분
    const lateralMagnitude = lateralVector.length();

    // ── 3. 가속도 한계 적용 ────────────────────────────────
    // 전진 가속과 감속은 한계가 다르다 (감속이 더 빠르다)
    const alongLimit = alongMagnitude >= 0
      ? player.maxAcceleration
      : player.maxDeceleration;
    const alongAccel = clamp(alongMagnitude / dt, -alongLimit, alongLimit);

    const lateralLimit = maxLateralAcceleration(player);
    const lateralAccel = Math.min(lateralMagnitude / dt, lateralLimit);

    let newVelocity = player.velocity
      .add(heading.scale(alongAccel * dt));

    if (lateralMagnitude > 1e-9) {
      newVelocity = newVelocity.add(
        lateralVector.normalize().scale(lateralAccel * dt)
      );
    }

    // ── 4. 속력 상한 ───────────────────────────────────────
    const speedCap = targetSpeedFor(player);
    if (newVelocity.length() > speedCap) {
      newVelocity = newVelocity.normalize().scale(speedCap);
    }
    if (newVelocity.length() < IDLE_SPEED) {
      newVelocity = Vector2D.zero();
    }

    player.velocity = newVelocity;

    // ── 5. 위치 적분 ───────────────────────────────────────
    player.position = player.position.add(newVelocity.scale(dt));
    this._clampToField(player);

    // ── 6. 신체 방향 ───────────────────────────────────────
    this._updateFacing(player, dt);
  }

  /**
   * 신체 방향 갱신.
   *
   * 몸은 진행 방향으로 향하되, 선회율 한계 때문에 즉시 돌지 못한다.
   * 이 지연이 패스 방향 판단(Section 18)의 근거가 된다 —
   * 등 뒤로 즉시 정확한 패스를 찌를 수 없는 이유다.
   */
  _updateFacing(player, dt) {
    const speed = player.velocity.length();

    let desiredAngle = player.facingAngle;
    if (speed > 0.6) {
      // 달리는 중에는 진행 방향을 본다
      desiredAngle = player.velocity.angle();
    } else if (player.decision.target) {
      // 거의 멈춰 있으면 가려는 쪽을 본다
      const toTarget = player.decision.target.sub(player.position);
      if (toTarget.length() > 0.3) desiredAngle = toTarget.angle();
    }

    const diff = angleDiff(desiredAngle, player.facingAngle);
    // 빠르게 달릴수록 상체를 비틀기 어렵다
    const turnRate = player.maxTurnRate * (speed > 0.6 ? 0.6 : 1.0);
    const maxStep = turnRate * dt;

    player.facingAngle += clamp(diff, -maxStep, maxStep);
    // 각도를 -π~π로 정규화해 무한히 누적되지 않게 한다
    player.facingAngle = Math.atan2(
      Math.sin(player.facingAngle),
      Math.cos(player.facingAngle)
    );
  }

  /** 선수가 경기장에서 지나치게 벗어나지 않도록 제한한다 */
  _clampToField(player) {
    const p = player.position;
    const x = clamp(p.x, -OUT_MARGIN, Pitch.LENGTH + OUT_MARGIN);
    const y = clamp(p.y, -OUT_MARGIN, Pitch.WIDTH + OUT_MARGIN);
    if (x !== p.x || y !== p.y) {
      player.position = new Vector2D(x, y);
      // 경계에 부딪히면 그 방향 속도를 없애 벽에 비비지 않게 한다
      player.velocity = new Vector2D(
        x !== p.x ? 0 : player.velocity.x,
        y !== p.y ? 0 : player.velocity.y
      );
    }
  }

  /**
   * 몸이 겹친 선수들을 밀어내 물리적으로 분리한다.
   * 22명이므로 단순 이중 루프로 충분하다 (231쌍).
   */
  _separateBodies(players) {
    const minDist = BODY_RADIUS * 2;
    const n = players.length;

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = players[i];
        const b = players[j];
        const delta = b.position.sub(a.position);
        const dist = delta.length();

        if (dist >= minDist) continue;

        const overlap = minDist - dist;
        // 정확히 같은 자리에 겹쳤으면 결정론적으로 갈라놓는다.
        // (난수를 쓰면 재현성이 깨지므로 인덱스 기반으로 방향을 정한다)
        const direction = dist > 1e-6
          ? delta.normalize()
          : new Vector2D(i % 2 === 0 ? 1 : -1, 0);

        const push = direction.scale(overlap / 2);
        a.position = a.position.sub(push);
        b.position = b.position.add(push);
      }
    }
  }
}
