import { Vector2D } from '../../entities/Vector2D.js';
import { Pitch } from '../../entities/Pitch.js';
import { clamp01, smoothstep, teamNX } from '../core/Coords.js';
import { Duty, Role } from '../tactics/RoleModel.js';
import { Action } from '../entities/Player.js';
import { PossessionPhase, TRANSITION_DURATION } from '../entities/Team.js';
import { timeToReach } from './Estimates.js';

/**
 * 전환 행동 (Section 26).
 *
 * 소유권이 바뀐 직후 1~3초는 안정 국면과 전혀 다르게 움직여야 한다.
 * 이 구간이 없으면 볼을 잃어도 천천히 제자리로 돌아가고, 볼을 따내도
 * 느긋하게 대형을 갖추느라 역습이 사라진다.
 *
 * ⚠ 전환은 별도의 임무 체계가 아니라 기존 임무 위에 얹는 "긴급도 보정"이다.
 *   임무 배정 권한은 여전히 TacticalEngine 하나뿐이며, 여기서는
 *   특정 선수의 목표와 속도만 상황에 맞게 덮어쓴다.
 */

/** 볼을 잃은 직후 이 반경 안의 선수가 즉시 되쫓는다 (m) */
const COUNTERPRESS_RADIUS = 17;

/** 카운터프레스가 유지되는 시간 (초) — 이후에는 블록으로 후퇴한다 */
const COUNTERPRESS_WINDOW = 2.4;

/** 볼을 딴 직후 전방 침투를 촉진하는 시간 (초) */
const COUNTER_ATTACK_WINDOW = 2.8;

export class TransitionAI {
  /**
   * 전환 상황이면 결정을 덮어쓴다.
   *
   * @param {MatchEngine} engine
   * @param {Player} player
   * @returns {boolean} 덮어썼으면 true (이후 일반 AI를 건너뛴다)
   */
  decide(engine, player) {
    const team = player.team;

    if (team.phase === PossessionPhase.TRANSITION_DEFENCE) {
      return this._afterLosing(engine, player);
    }
    if (team.phase === PossessionPhase.TRANSITION_ATTACK) {
      return this._afterWinning(engine, player);
    }
    return false;
  }

  // ──────────────────────────────────────────────────────────

  /**
   * 볼을 잃은 직후.
   *
   * 볼 근처 선수는 즉시 되쫓아 상대가 고개를 들기 전에 압박하고,
   * 깊은 위치의 선수는 위험 공간부터 막는다.
   * 두 행동을 동시에 해야 카운터프레스가 성립한다.
   */
  _afterLosing(engine, player) {
    const team = player.team;
    if (team.phaseTimer > COUNTERPRESS_WINDOW) return false;

    // 압박·커버 임무는 이미 볼을 향하고 있으므로 건드리지 않는다
    if (player.duty === Duty.PRESS || player.duty === Duty.COVER) return false;
    if (player.role === Role.GK) return false;

    const ball = engine.ball;
    const distance = player.position.sub(ball.position).length();

    if (distance <= COUNTERPRESS_RADIUS) {
      // 즉시 되쫓기 — 상대가 전진 패스를 하기 전에 각을 좁힌다
      const dir = team.attackingDirection;
      const ownGoal = new Vector2D(dir === 1 ? 0 : Pitch.LENGTH, Pitch.WIDTH / 2);
      const toGoal = ownGoal.sub(ball.position);
      const approach = toGoal.length() > 0.5
        ? toGoal.normalize()
        : new Vector2D(-dir, 0);

      const target = Pitch.clampInside(ball.position.add(approach.scale(1.8)), 0.5);
      player.setDecision(Action.MOVE, target, {
        sprint: true,
        urgency: 1,
        source: 'COUNTERPRESS',
      });
      return true;
    }

    // 멀리 있는 선수는 위험 공간(자기 골문 쪽)부터 되찾는다.
    // 전력으로 복귀해야 역습에 뚫리지 않는다.
    const gap = player.position.sub(player.anchor).length();
    if (gap > 6) {
      player.setDecision(Action.MOVE, player.anchor, {
        sprint: true,
        urgency: 1,
        source: 'RECOVER_URGENT',
      });
      return true;
    }

    return false;
  }

  /**
   * 볼을 딴 직후.
   *
   * 전방 선수는 상대가 대형을 갖추기 전에 공간으로 달리고,
   * 가까운 선수는 빠르게 패스 각도를 만든다.
   * 다만 후방 잔류 인원까지 올라가면 다시 뺏겼을 때 무너지므로 제외한다.
   */
  _afterWinning(engine, player) {
    const team = player.team;
    if (team.phaseTimer > COUNTER_ATTACK_WINDOW) return false;
    if (player.role === Role.GK) return false;
    if (player === engine.ball.carrier) return false;
    // 후방 잔류는 전환에서도 자리를 지킨다 (Section 26)
    if (player.duty === Duty.REST_DEFENCE) return false;

    const dir = team.attackingDirection;
    const playerNX = teamNX(player.position.x, dir);
    const ballNX = teamNX(engine.ball.position.x, dir);

    // 볼보다 앞에 있는 선수는 지체 없이 전방으로 달린다.
    // 상대 수비가 정렬되기 전 몇 초가 역습의 전부다.
    if (playerNX > ballNX - 0.05) {
      const existing = player.decision.target ?? player.anchor;
      player.setDecision(Action.MOVE, existing, {
        sprint: true,
        urgency: 1,
        source: 'COUNTER_RUN',
      });
      return true;
    }

    return false;
  }
}

export { COUNTERPRESS_RADIUS, COUNTERPRESS_WINDOW, COUNTER_ATTACK_WINDOW };
