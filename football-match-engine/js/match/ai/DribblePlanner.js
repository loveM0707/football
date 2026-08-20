import { Vector2D } from '../../entities/Vector2D.js';
import { Pitch } from '../../entities/Pitch.js';
import { clamp, clamp01, smoothstep } from '../core/Coords.js';
import { solveGroundPass } from '../ball/PassSolver.js';
import { pressureAt, nearestOpponentTo } from './Estimates.js';

/**
 * 드리블 계획 — 터치 사이클 모델 (Section 21).
 *
 * ⚠ 볼을 선수에게 붙이지 않는다.
 *   드리블은 "선수 이동 + 터치 지점 + 볼 이동 + 다음 터치 판단"의 반복이다.
 *   터치 사이의 볼은 일반 물리로 굴러가고, 선수는 그것을 따라잡는다.
 *
 * ── 터치 거리 ────────────────────────────────────────────────
 * 빠르게 달릴수록 볼을 멀리 밀어놓고, 압박이 심하거나 방향을 꺾을 때는
 * 발밑에 가깝게 둔다. 이 하나의 규칙에서
 *   · 공간이 열리면 볼을 밀고 달리는 모습
 *   · 수비수 앞에서는 볼을 붙여 잔발로 다루는 모습
 * 이 함께 나온다.
 *
 * 터치 세기는 임의로 정하지 않고 PassSolver로 역산한다.
 * 같은 물리 모델을 쓰므로 "밀어놓은 볼이 어디서 멈추는가"가 정확하다.
 */

/** 볼이 이 거리 안에 들어오면 선수가 볼을 따라잡은 것으로 보고 다음 터치를 한다 (m) */
export const TOUCH_TRIGGER_DISTANCE = 1.3;

/** 최소·최대 터치 거리 (m) */
const MIN_TOUCH_DISTANCE = 0.7;
const MAX_TOUCH_DISTANCE = 4.6;

/** 연속 터치 사이 최소 간격 (초) — 한 스텝마다 차는 것을 막는다 */
export const TOUCH_INTERVAL = 0.22;

/** 이 각도 이상 방향을 바꾸면 볼을 짧게 둔다 (rad) */
const SHARP_TURN = Math.PI / 4;

export class DribblePlanner {
  /**
   * @param {number} dt 고정 스텝 — 솔버가 라이브와 같은 물리를 써야 한다
   */
  constructor(dt) {
    this.dt = dt;
  }

  /**
   * 다음 터치를 계획한다.
   *
   * @param {MatchEngine} engine
   * @param {Player} carrier 볼을 몰고 있는 선수
   * @param {Vector2D} moveTarget 선수가 가려는 지점
   * @returns {{
   *   needsTouch:boolean,
   *   touchVelocity:Vector2D|null,
   *   touchPoint:Vector2D|null,
   *   touchDistance:number
   * }}
   */
  plan(engine, carrier, moveTarget) {
    const ball = engine.ball;
    const opponents = carrier.team.opponent?.players ?? [];

    const toBall = ball.position.sub(carrier.position);
    const ballDistance = toBall.length();

    // 아직 볼이 앞에 충분히 있으면 따라가기만 한다
    const needsTouch =
      ballDistance <= TOUCH_TRIGGER_DISTANCE &&
      carrier.touchCooldown <= 0 &&
      !ball.isAirborne;

    const touchDistance = this._touchDistance(carrier, opponents, moveTarget);

    if (!needsTouch) {
      return { needsTouch: false, touchVelocity: null, touchPoint: null, touchDistance };
    }

    // ── 터치 방향 ──────────────────────────────────────────
    const direction = this._touchDirection(carrier, moveTarget, opponents);
    const touchPoint = Pitch.clampInside(
      ball.position.add(direction.scale(touchDistance)),
      0.8
    );

    // ── 터치 세기 역산 ─────────────────────────────────────
    // 볼이 터치 지점에 "선수와 거의 동시에" 도착하도록 세기를 정한다.
    //
    // 도착 속력을 선수 속도보다 크게 낮추면 볼이 선수 뒤로 처져서
    // 선수가 볼을 지나쳐 달려가 버린다. 반대로 너무 세면 볼만 굴러간다.
    // 도착 속력 ≈ 선수 속도(살짝 아래)로 잡으면, 볼이 터치 지점에 닿을 때
    // 선수도 같이 도착해 다음 터치로 자연스럽게 이어진다.
    const speed = carrier.velocity.length();
    const arrivalSpeed = clamp(speed * 0.95, 0.5, 9);
    const solution = solveGroundPass(ball.position, touchPoint, {
      dt: this.dt,
      arrivalSpeed,
    });

    if (!solution) {
      return { needsTouch: false, touchVelocity: null, touchPoint: null, touchDistance };
    }

    return {
      needsTouch: true,
      touchVelocity: solution.velocity,
      touchPoint,
      touchDistance,
    };
  }

  /**
   * 이번 터치로 볼을 얼마나 멀리 밀어놓을지 결정한다.
   *
   * 빠를수록 멀리 / 압박이 심할수록 가깝게 / 방향을 꺾을수록 가깝게 /
   * 앞이 트여 있을수록 멀리.
   */
  _touchDistance(carrier, opponents, moveTarget) {
    const speed = carrier.velocity.length();
    const skill = carrier.attributes.norm('dribbling');

    // 속도가 기본값을 정한다. 걸을 땐 발밑, 전력 질주면 크게 밀어놓는다.
    let distance = 0.85 + speed * 0.42;

    // 볼 다루는 능력이 좋으면 같은 속도에서 더 가깝게 통제할 수 있다.
    // 능력이 낮으면 어쩔 수 없이 크게 밀린다.
    distance *= 1.18 - skill * 0.30;

    // 압박: 가까이 붙으면 볼을 몸 가까이 둔다
    const pressure = pressureAt(carrier.position, opponents);
    distance -= pressure * 1.5;

    // 앞 공간: 가장 가까운 상대가 멀면 과감히 밀고 달린다
    const forward = moveTarget
      ? moveTarget.sub(carrier.position)
      : new Vector2D(carrier.team.attackingDirection, 0);
    if (forward.length() > 0.5) {
      const ahead = carrier.position.add(forward.normalize().scale(6));
      const space = nearestOpponentTo(ahead, opponents).distance;
      distance += smoothstep(4, 14, space) * 0.9;
    }

    // 방향 전환: 크게 꺾을 때는 볼을 짧게 둬야 따라갈 수 있다
    if (speed > 1.0 && forward.length() > 0.5) {
      const turn = Math.acos(
        clamp(carrier.velocity.normalize().dot(forward.normalize()), -1, 1)
      );
      if (turn > SHARP_TURN) {
        distance *= 1 - smoothstep(SHARP_TURN, Math.PI, turn) * 0.55;
      }
    }

    return clamp(distance, MIN_TOUCH_DISTANCE, MAX_TOUCH_DISTANCE);
  }

  /**
   * 터치 방향 — 가려는 쪽을 기본으로 하되, 가까운 수비수 쪽으로는 밀지 않는다.
   */
  _touchDirection(carrier, moveTarget, opponents) {
    const attackDir = new Vector2D(carrier.team.attackingDirection, 0);
    let base = moveTarget
      ? moveTarget.sub(carrier.position)
      : attackDir.clone();

    if (base.length() < 0.3) base = attackDir.clone();
    base = base.normalize();

    // 밀착한 수비수가 있으면 그쪽을 피해 각도를 튼다
    const { distance, player: nearest } = nearestOpponentTo(carrier.position, opponents);
    if (nearest && distance < 5.5) {
      const toDefender = nearest.position.sub(carrier.position);
      if (toDefender.length() > 0.1) {
        const defenderDir = toDefender.normalize();

        // 수비수가 가려는 방향 정면에 있을수록 옆으로 비켜야 한다.
        // 뒤로 물러나는 성분만 섞으면 수비수가 정면에 있을 때
        // 방향이 전혀 바뀌지 않는다 (두 벡터가 정확히 반대라 상쇄될 뿐이다).
        const facing = base.dot(defenderDir); // 1이면 정면
        const lateral = new Vector2D(-base.y, base.x);
        // 수비수 반대쪽 옆으로 방향을 정한다
        const side = lateral.dot(defenderDir) > 0 ? -1 : 1;

        const proximity = smoothstep(5.5, 1.5, distance);
        const frontal = clamp01(facing); // 옆이나 뒤에 있으면 회피할 필요가 적다
        const weight = proximity * frontal * 0.85;

        base = base.scale(1 - weight * 0.4)
          .add(lateral.scale(side * weight));
        if (base.length() < 1e-6) base = attackDir.clone();
        base = base.normalize();
      }
    }

    return base;
  }
}
