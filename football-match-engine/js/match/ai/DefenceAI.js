import { Vector2D } from '../../entities/Vector2D.js';
import { Pitch } from '../../entities/Pitch.js';
import { clamp, clamp01, smoothstep, teamNX, inRect, ownPenaltyBox } from '../core/Coords.js';
import { Duty, Role } from '../tactics/RoleModel.js';
import { Action } from '../entities/Player.js';
import { tackleDesirability, TACKLE_RANGE } from './DuelResolver.js';
import { timeToReach } from './Estimates.js';

/**
 * 수비 행동 — 임무를 실제 목표 지점으로 바꾼다.
 *
 * 임무 배정(누가 압박하고 누가 커버하는가)은 TacticalEngine이 이미 끝냈다.
 * 여기서는 "그 임무를 어디에 서서 수행하는가"만 정한다.
 *
 * ⚠ 수비의 기본은 태클이 아니라 지연이다 (Section 22).
 *   압박자는 볼 소유자에게 달려들지만, 곧바로 발을 내밀지 않고
 *   골문 쪽 각도를 막은 채 거리를 좁힌다. 확실한 순간에만 태클한다.
 */

/** 압박자가 볼 소유자와 유지하는 기본 간격 (m) — 이 거리에서 지연시킨다 */
const JOCKEY_DISTANCE = 1.9;

/**
 * 이 값을 넘으면 태클을 시도한다.
 *
 * 너무 높게 잡으면 수비수가 영원히 지연만 하다가 교착 상태가 된다.
 * (실측: 0.55에서는 2분 동안 태클이 한 번도 발생하지 않고,
 *  압박자와 캐리어가 같은 간격을 유지한 채 41%의 시간을 소모했다)
 * 지연이 기본이되, 언젠가는 승부를 걸어야 경기가 진행된다.
 */
const TACKLE_THRESHOLD = 0.42;

/**
 * 이 시간 이상 같은 상대를 압박하고 있으면 태클 문턱을 낮춘다 (초).
 * 동료 커버가 도착할 시간을 벌어준 뒤에는 직접 승부를 건다.
 */
const PATIENCE_LIMIT = 1.6;

/** 마크할 때 상대보다 골문 쪽으로 서는 거리 (m) */
const MARK_GOAL_SIDE = 1.6;

/** 카운터프레스 반경 (m) — 볼을 잃은 직후 이 안의 선수가 즉시 달려든다 */
export const COUNTERPRESS_RADIUS = 18;

export class DefenceAI {
  /**
   * 한 수비 선수의 결정을 만든다.
   *
   * @param {MatchEngine} engine
   * @param {Player} player
   * @returns {boolean} 결정을 내렸으면 true
   */
  decide(engine, player) {
    switch (player.duty) {
      case Duty.PRESS:
        this._press(engine, player);
        return true;
      case Duty.COVER:
        this._cover(engine, player);
        return true;
      case Duty.MARK:
        this._mark(engine, player);
        return true;
      case Duty.HOLD_LINE:
        this._holdLine(engine, player);
        return true;
      case Duty.RECOVER:
        this._recover(engine, player);
        return true;
      case Duty.CHASE_LOOSE:
        this._chaseLoose(engine, player);
        return true;
      default:
        return false;
    }
  }

  // ──────────────────────────────────────────────────────────

  /**
   * 압박 — 볼 소유자에게 다가가되 골문 쪽 각도를 먼저 막는다.
   *
   * 소유자와 자기 골문을 잇는 선 위에 서는 것이 핵심이다.
   * 옆이나 뒤에서 붙으면 그냥 제쳐지고 골문이 열린다.
   */
  _press(engine, player) {
    const ball = engine.ball;
    const carrier = ball.carrier;
    const dir = player.team.attackingDirection;
    const ownGoal = new Vector2D(dir === 1 ? 0 : Pitch.LENGTH, Pitch.WIDTH / 2);

    // 소유자가 없으면 볼 자체로 향한다 (비행 중이거나 루즈볼 직전)
    const targetEntity = carrier ?? { position: ball.position, velocity: ball.velocity };

    // 소유자 → 자기 골문 방향으로 JOCKEY_DISTANCE 만큼 앞에 선다
    const toGoal = ownGoal.sub(targetEntity.position);
    const approach = toGoal.length() > 0.5
      ? toGoal.normalize()
      : new Vector2D(-dir, 0);

    const standoff = Pitch.clampInside(
      targetEntity.position.add(approach.scale(JOCKEY_DISTANCE)),
      0.5
    );

    // 태클 판단 — 충분히 가까울 때만 검토한다
    if (carrier) {
      const distance = player.position.sub(carrier.position).length();

      // 같은 상대를 계속 붙잡고 있는 시간을 센다.
      // 지연이 길어지면 문턱을 낮춰 교착을 끊는다.
      const memory = player.brainMemory;
      if (memory.pressTarget === carrier) {
        memory.pressDuration = (memory.pressDuration ?? 0) + engine.stepSize;
      } else {
        memory.pressTarget = carrier;
        memory.pressDuration = 0;
      }

      if (distance <= TACKLE_RANGE && player.tackleRecovery <= 0) {
        const desire = tackleDesirability(player, carrier, ball, {
          lastDefender: this._isLastDefender(engine, player),
          dangerZone: inRect(carrier.position, ownPenaltyBox(dir)),
          aggression: player.team.tactics.tackleAggression,
        });

        // 오래 지연했으면 문턱을 낮춘다 (최대 0.14까지)
        const patience = smoothstep(PATIENCE_LIMIT, PATIENCE_LIMIT * 2.5,
          memory.pressDuration ?? 0);
        const threshold = TACKLE_THRESHOLD - patience * 0.14;

        if (desire >= threshold) {
          player.setDecision(Action.TACKLE, carrier.position, {
            sprint: true, urgency: 1, source: 'TACKLE',
          });
          return;
        }
      }
    }

    // 지연: 거리를 좁히되 무리하게 뛰어들지 않는다
    const gap = player.position.sub(standoff).length();
    player.setDecision(Action.MOVE, standoff, {
      sprint: gap > 4,
      urgency: clamp01(0.7 + smoothstep(2, 10, gap) * 0.3),
      source: Duty.PRESS,
    });
  }

  /**
   * 커버 — 압박자 뒤, 볼과 골문 사이를 받친다.
   * 압박자가 제쳐졌을 때 다음 방어선이 되어야 한다.
   */
  _cover(engine, player) {
    const ball = engine.ball;
    const dir = player.team.attackingDirection;
    const ownGoal = new Vector2D(dir === 1 ? 0 : Pitch.LENGTH, Pitch.WIDTH / 2);

    // 볼과 골문 사이, 압박자보다 뒤쪽
    const base = Vector2D.lerp(ball.position, ownGoal, 0.30);

    // 팀 형태가 정한 라인보다 앞으로 나가지 않도록 제한한다.
    // 커버가 라인을 깨고 나가면 그 뒤가 완전히 비어버린다.
    const anchor = player.anchor;
    const target = Pitch.clampInside(
      new Vector2D(
        // 전후는 커버 지점과 앵커의 절충
        base.x * 0.62 + anchor.x * 0.38,
        base.y * 0.72 + anchor.y * 0.28
      ),
      1.0
    );

    const gap = player.position.sub(target).length();
    player.setDecision(Action.MOVE, target, {
      sprint: gap > 8,
      urgency: 0.75,
      source: Duty.COVER,
    });
  }

  /**
   * 마크 — 상대보다 골문 쪽에 서서 패스를 받지 못하게 한다.
   *
   * 상대에게 딱 붙는 것이 아니라, 볼과 상대를 잇는 선을 가리면서
   * 골문 쪽 위치를 선점한다. 위험한 지역일수록 바짝 붙는다.
   *
   * 구역 이탈 방지: 상대가 앵커에서 너무 멀리 벗어나면 더 이상 따라가지 않는다.
   * 수비수가 끌려나간 자리에 생기는 공간이 더 위험하기 때문이다.
   */
  _mark(engine, player) {
    const target = player.markTarget;
    if (!target) {
      this._holdLine(engine, player);
      return;
    }

    const ball = engine.ball;
    const dir = player.team.attackingDirection;
    const ownGoal = new Vector2D(dir === 1 ? 0 : Pitch.LENGTH, Pitch.WIDTH / 2);
    const anchor = player.anchor;

    // 골문 쪽으로 서는 방향
    const toGoal = ownGoal.sub(target.position);
    const goalSide = toGoal.length() > 0.5
      ? toGoal.normalize()
      : new Vector2D(-dir, 0);

    // 볼에서 상대로 이어지는 패스 길목을 가리는 방향
    const fromBall = target.position.sub(ball.position);
    const laneSide = fromBall.length() > 0.5
      ? fromBall.normalize().scale(-1)
      : goalSide;

    // 위험 지역(자기 박스 근처)일수록 바짝, 멀수록 길목 차단 위주
    const dangerNX = 1 - clamp01(teamNX(target.position.x, dir) / 0.4);
    const tightness = clamp01(0.35 + dangerNX * 0.5);

    const offset = goalSide.scale(MARK_GOAL_SIDE * tightness)
      .add(laneSide.scale(MARK_GOAL_SIDE * (1 - tightness)));

    const trackSpot = Pitch.clampInside(target.position.add(offset), 0.5);

    // 앵커에서 MAX_MARK_DRIFT 이상 벗어나지 않는다.
    // 상대가 수비수를 자기 구역 밖으로 끌어내도 이 거리가 상한선이다.
    const MAX_MARK_DRIFT = 18;
    const toTrack = trackSpot.sub(anchor);
    const drift = toTrack.length();
    const markSpot = drift > MAX_MARK_DRIFT
      ? Pitch.clampInside(anchor.add(toTrack.normalize().scale(MAX_MARK_DRIFT)), 0.5)
      : trackSpot;

    const gap = player.position.sub(markSpot).length();
    player.setDecision(Action.MOVE, markSpot, {
      sprint: gap > 7,
      urgency: clamp01(0.55 + tightness * 0.35),
      source: Duty.MARK,
    });
  }

  /** 라인 유지 — 팀 형태가 정한 기대 위치를 지킨다 */
  _holdLine(engine, player) {
    const target = player.anchor;
    const gap = player.position.sub(target).length();
    player.setDecision(Action.MOVE, target, {
      sprint: gap > 12,
      urgency: clamp01(0.35 + smoothstep(2, 14, gap) * 0.45),
      source: Duty.HOLD_LINE,
    });
  }

  /** 복귀 — 자기 위치로 빠르게 돌아간다 */
  _recover(engine, player) {
    const target = player.anchor;
    const gap = player.position.sub(target).length();
    player.setDecision(Action.MOVE, target, {
      sprint: gap > 8,
      urgency: clamp01(0.5 + smoothstep(3, 20, gap) * 0.5),
      source: Duty.RECOVER,
    });
  }

  /** 루즈볼 추격 — 볼이 갈 곳으로 달린다 */
  _chaseLoose(engine, player) {
    const ball = engine.ball;
    // 현재 위치가 아니라 볼이 굴러갈 지점으로 향해야 따라잡는다
    const intercept = this._interceptPoint(engine, player);
    player.setDecision(Action.MOVE, intercept, {
      sprint: true,
      urgency: 1,
      source: Duty.CHASE_LOOSE,
    });
  }

  /**
   * 볼 요격 지점 — 선수가 볼을 따라잡을 수 있는 가장 이른 지점.
   *
   * 볼의 미래 위치를 실제 물리로 예측하고, 선수 도달 시간과 비교해
   * 가장 빨리 만나는 지점을 고른다. 현재 위치로 달리면 항상 뒤를 쫓게 된다.
   */
  _interceptPoint(engine, player) {
    const ball = engine.ball;
    const physics = engine.physics;

    // 물리 시스템이 없으면 현재 위치로 향한다 (테스트 등)
    if (!physics) return ball.position.clone();

    const stop = physics.predictStop(ball);
    // 볼 경로를 몇 지점 훑어 가장 빨리 도달 가능한 곳을 찾는다
    const samples = 6;
    for (let i = 1; i <= samples; i++) {
      const t = i / samples;
      const point = Vector2D.lerp(ball.position, stop.position, t);
      const ballTime = stop.time * t;
      if (timeToReach(player, point) <= ballTime + 0.15) {
        return point;
      }
    }
    return stop.position;
  }

  /** 뒤에 커버가 없는 마지막 수비수인가 */
  _isLastDefender(engine, player) {
    const dir = player.team.attackingDirection;
    const myNX = teamNX(player.position.x, dir);
    for (const mate of player.team.players) {
      if (mate === player || mate.role === Role.GK) continue;
      if (teamNX(mate.position.x, dir) < myNX - 0.01) return false;
    }
    return true;
  }
}
