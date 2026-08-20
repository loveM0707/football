import { Vector2D } from '../../entities/Vector2D.js';
import { Pitch } from '../../entities/Pitch.js';
import {
  clamp, clamp01, smoothstep, teamNX, inRect, ownPenaltyBox,
} from '../core/Coords.js';
import { Action } from '../entities/Player.js';
import { Duty, Role } from '../tactics/RoleModel.js';
import { PossessionState } from '../sim/PossessionModel.js';
import { timeToReach } from './Estimates.js';
import { CROSSBAR_HEIGHT } from './ShotPlanner.js';

/**
 * 골키퍼 판단 (Section 28).
 *
 * 골키퍼는 "속도만 다른 필드 플레이어"가 아니다. 판단 기준 자체가 다르다.
 *   · 볼을 쫓는 것이 아니라 골문과 볼 사이의 각을 지운다
 *   · 페널티 박스 안에서는 손을 쓸 수 있어 도달 범위가 훨씬 넓다
 *   · 뒷공간으로 넘어온 볼은 수비 라인보다 먼저 처리해야 한다 (스위핑)
 *
 * ⚠ 세이브의 성공 여부는 여기서 판정하지 않는다.
 *   볼에 손을 대는 것은 ActionSystem의 몫이며, 여기서는 어디에 설지만 정한다.
 */

/** 손을 쓸 수 있는 다이빙 도달 반경의 기준값 (m) */
export const GK_DIVE_REACH = 2.1;

/** 손으로 잡을 수 있는 최대 높이 (m) */
export const GK_CATCH_HEIGHT = 2.5;

/** 이 시간 안에 도달할 수 있으면 뛰쳐나가 처리한다 (초) */
const SWEEP_TIME_ADVANTAGE = 0.25;

/** 골라인에서 최대한 나올 수 있는 거리 (m) — 페널티 박스를 크게 벗어나지 않는다 */
const MAX_ADVANCE = Pitch.PENALTY_BOX_LENGTH + 2;

export class GoalkeeperAI {
  /**
   * @param {MatchEngine} engine
   * @param {Player} gk
   * @returns {boolean} 결정을 내렸으면 true
   */
  decide(engine, gk) {
    if (gk.role !== Role.GK) return false;

    const ball = engine.ball;
    const state = engine.possession?.state ?? PossessionState.NONE;

    // ── 1. 볼을 직접 잡고 있으면 배급한다 ──────────────────
    if (ball.carrier === gk) {
      this._distribute(engine, gk);
      return true;
    }

    // ── 2. 슛이 날아오면 막으러 간다 ───────────────────────
    if (state === PossessionState.SHOT_IN_FLIGHT && this._shotThreatensGoal(engine, gk)) {
      this._blockShot(engine, gk);
      return true;
    }

    // ── 3. 뒷공간으로 넘어온 볼은 먼저 나가서 처리한다 ─────
    const sweep = this._sweepTarget(engine, gk);
    if (sweep) {
      gk.setDecision(Action.MOVE, sweep, {
        sprint: true, urgency: 1, source: 'GK_SWEEP',
      });
      return true;
    }

    // ── 4. 평상시: 각을 지우는 위치 ────────────────────────
    const target = this._anglePosition(engine, gk);
    const gap = gk.position.sub(target).length();
    gk.setDecision(Action.MOVE, target, {
      sprint: gap > 6,
      urgency: clamp01(0.4 + smoothstep(1, 8, gap) * 0.5),
      source: Duty.GOALKEEP,
    });
    return true;
  }

  // ──────────────────────────────────────────────────────────

  /**
   * 각도 축소 위치.
   *
   * 골문 중앙과 볼을 잇는 선 위에서, 볼이 가까울수록 앞으로 나온다.
   * 이렇게 서면 슈터가 노릴 수 있는 골문 폭이 줄어든다.
   */
  _anglePosition(engine, gk) {
    const dir = gk.team.attackingDirection;
    const ball = engine.ball;
    const goalX = dir === 1 ? 0 : Pitch.LENGTH;
    const goalCenter = new Vector2D(goalX, Pitch.WIDTH / 2);

    const toBall = ball.position.sub(goalCenter);
    const ballDistance = toBall.length();

    // 볼이 멀면 라인 근처, 가까우면 적극적으로 나온다.
    // 다만 너무 나오면 로빙에 넘어가므로 상한을 둔다.
    const closeness = smoothstep(45, 12, ballDistance);
    const positioning = gk.attributes.norm('positioning');
    let advance = 1.0 + closeness * (4.5 + positioning * 3.0);

    // 수비 라인이 높으면 스위퍼처럼 함께 올라온다
    const shape = gk.team.shape;
    if (shape) {
      advance += smoothstep(0.25, 0.55, shape.backLineNX) * 6.0;
    }
    advance = clamp(advance, 0.6, MAX_ADVANCE);

    const direction = ballDistance > 0.5
      ? toBall.normalize()
      : new Vector2D(dir, 0);

    const target = goalCenter.add(direction.scale(advance));

    // 골문 폭에서 지나치게 벗어나지 않도록 y를 제한한다
    const [goalTop, goalBottom] = Pitch.goalYRange();
    return new Vector2D(
      target.x,
      clamp(target.y, goalTop - 4.5, goalBottom + 4.5)
    );
  }

  /**
   * 슛이 우리 골문을 위협하는가.
   * 볼이 골문 쪽으로 향하고 있고 아직 골라인을 넘지 않았을 때만 참이다.
   */
  _shotThreatensGoal(engine, gk) {
    const dir = gk.team.attackingDirection;
    const ball = engine.ball;
    const goalX = dir === 1 ? 0 : Pitch.LENGTH;

    // 볼이 우리 골문 쪽으로 이동 중인가
    const towardGoal = dir === 1 ? ball.velocity.x < -1 : ball.velocity.x > 1;
    if (!towardGoal) return false;

    // 이미 골라인을 넘었으면 의미 없다
    const behind = dir === 1 ? ball.position.x <= goalX : ball.position.x >= goalX;
    return !behind;
  }

  /**
   * 슛 차단 위치 — 볼이 골라인을 지나는 지점으로 몸을 움직인다.
   *
   * 볼의 실제 궤적을 물리로 예측하므로, 감속·낙하가 반영된 지점으로 간다.
   */
  _blockShot(engine, gk) {
    const dir = gk.team.attackingDirection;
    const goalX = dir === 1 ? 0 : Pitch.LENGTH;
    const ball = engine.ball;

    // 골라인까지 남은 거리와 현재 속도로 통과 지점을 추정한다
    const remaining = Math.abs(ball.position.x - goalX);
    const speedX = Math.abs(ball.velocity.x);
    const timeToLine = speedX > 0.5 ? remaining / speedX : 1;

    const crossY = ball.position.y + ball.velocity.y * timeToLine;
    const [goalTop, goalBottom] = Pitch.goalYRange();

    // 골문 폭 안으로 제한 — 골대 밖으로 몸을 던지지 않는다
    const target = new Vector2D(
      goalX + dir * 0.8,
      clamp(crossY, goalTop - 1.0, goalBottom + 1.0)
    );

    gk.setDecision(Action.MOVE, target, {
      sprint: true, urgency: 1, source: 'GK_BLOCK',
    });
  }

  /**
   * 스위핑 — 수비 뒤로 넘어온 볼을 먼저 처리한다.
   *
   * 상대 공격수보다 먼저 닿을 수 있을 때만 나간다.
   * 늦으면 골키퍼가 비운 골문으로 그대로 밀어 넣힌다.
   */
  _sweepTarget(engine, gk) {
    const ball = engine.ball;
    const dir = gk.team.attackingDirection;

    // 볼이 우리 진영 깊숙이 있고, 아무도 소유하지 않은 상태여야 한다
    if (ball.carrier && ball.carrier.team === gk.team) return null;
    const ballNX = teamNX(ball.position.x, dir);
    if (ballNX > 0.28) return null;

    // 박스 근처까지 온 볼만 대상으로 한다
    const box = ownPenaltyBox(dir);
    const nearBox = inRect(ball.position, {
      x: box.x - 6, y: box.y - 6, w: box.w + 12, h: box.h + 12,
    });
    if (!nearBox) return null;

    const myTime = timeToReach(gk, ball.position);

    // 가장 빨리 닿을 수 있는 상대보다 여유 있게 빨라야 나간다
    const opponents = gk.team.opponent?.players ?? [];
    let bestOpponent = Infinity;
    for (const o of opponents) {
      bestOpponent = Math.min(bestOpponent, timeToReach(o, ball.position));
    }

    if (myTime + SWEEP_TIME_ADVANTAGE < bestOpponent) {
      return ball.position.clone();
    }
    return null;
  }

  /**
   * 배급 — 볼을 잡았을 때 어디로 보낼지.
   *
   * 짧게 빌드업할지 길게 걷어낼지는 팀 지시(gkDistribution)와
   * 상대 압박 상황에서 나온다. 실제 킥은 ActionSystem이 실행한다.
   */
  _distribute(engine, gk) {
    // 볼을 잡은 직후에는 잠시 상황을 본다 (즉시 차내지 않는다)
    const memory = gk.brainMemory;
    memory.holdTime = (memory.holdTime ?? 0) + engine.stepSize;

    if (memory.holdTime < 0.8) {
      gk.setDecision(Action.SHIELD, gk.position.clone(), {
        urgency: 0.2, source: 'GK_HOLD',
      });
      return;
    }

    // 배급 판단은 온볼 판단(DecisionEngine)에 맡긴다.
    // 여기서는 "이제 내보내도 된다"는 신호만 준다.
    gk.setDecision(Action.PASS, gk.position.clone(), {
      urgency: 0.5, source: 'GK_DISTRIBUTE',
    });
  }

  /**
   * 골키퍼가 볼에 손을 댈 수 있는가.
   * ActionSystem이 세이브를 실행하기 전에 확인한다.
   *
   * @param {Player} gk
   * @param {Ball} ball
   * @returns {boolean}
   */
  static canHandle(gk, ball) {
    const dir = gk.team.attackingDirection;
    // 손은 자기 페널티 박스 안에서만 쓸 수 있다 (Law 12)
    if (!inRect(gk.position, ownPenaltyBox(dir))) return false;
    if (ball.height > GK_CATCH_HEIGHT) return false;
    return gk.position.sub(ball.position).length() <= GK_DIVE_REACH;
  }
}
