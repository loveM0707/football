import { Vector2D } from '../../entities/Vector2D.js';
import { Pitch } from '../../entities/Pitch.js';
import {
  clamp, clamp01, smoothstep, teamNX, toTeamY,
  fromTeamSpace, opponentGoalLineX,
} from '../core/Coords.js';
import { Duty, Role } from '../tactics/RoleModel.js';
import { Action } from '../entities/Player.js';
import { nearestOpponentTo, timeToReach, isLaneBlocked } from './Estimates.js';

/**
 * 오프볼 공격 행동 — 임무를 실제 목표 지점으로 바꾼다.
 *
 * 기본 좌표는 TeamShape가 준 anchor다. 임무는 그 anchor를 상황에 맞게
 * 밀고 당기는 역할을 한다. 이렇게 해야 팀 형태를 깨지 않으면서도
 * 침투·폭 유지·지원 각도가 함께 나온다 (Section 23).
 *
 * ⚠ 좌표를 직접 지정하지 않는다. 모든 목표는
 *   "anchor + 관계에서 유도한 변위"로 만든다 (Section 45).
 */

/** 지원 거리 — 볼 소유자와 이 정도 간격을 두면 패스 각도가 살아난다 (m) */
const SUPPORT_DISTANCE = 13;

/** 침투 시 상대 최종 수비 라인을 넘어서는 최대 깊이 (m) */
const RUN_BEHIND_DEPTH = 9;

export class OffBallAI {
  /**
   * @param {MatchEngine} engine
   * @param {Player} player
   * @returns {boolean} 결정을 내렸으면 true
   */
  decide(engine, player) {
    switch (player.duty) {
      case Duty.SUPPORT:
        this._support(engine, player);
        return true;
      case Duty.HOLD_WIDTH:
        this._holdWidth(engine, player);
        return true;
      case Duty.OVERLAP:
        this._overlap(engine, player);
        return true;
      case Duty.RUN_BEHIND:
        this._runBehind(engine, player);
        return true;
      case Duty.RUN_BETWEEN:
        this._runBetween(engine, player);
        return true;
      case Duty.CHECK_TO_BALL:
        this._checkToBall(engine, player);
        return true;
      case Duty.REST_DEFENCE:
        this._restDefence(engine, player);
        return true;
      default:
        return false;
    }
  }

  // ──────────────────────────────────────────────────────────

  /**
   * 지원 — 볼 소유자에게 패스 각도를 제공한다.
   *
   * TacticalEngine이 배정한 supportSlot(0·1·2)에 따라
   * 탐색 깊이(볼 소유자와의 기본 거리)를 달리한다.
   * 세 지원자가 서로 다른 거리대를 선호하므로
   * 같은 지점으로 수렴하는 군집이 자연스럽게 줄어든다.
   *
   *   슬롯 0: 근거리 지원 (볼 소유자 가까이 — 즉시 옵션)
   *   슬롯 1: 중거리 지원 (기본 거리 — 삼각형 꼭짓점)
   *   슬롯 2: 원거리 지원 (더 멀리 — 전환·공간 확보 옵션)
   */
  _support(engine, player) {
    const ball = engine.ball;
    const carrier = ball.carrier;
    const opponents = player.team.opponent?.players ?? [];
    const anchor = player.anchor;

    const origin = carrier ? carrier.position : ball.position;

    // 앵커를 기준으로 소유자와의 간격을 맞춘 후보를 만든다
    const baseDirection = anchor.sub(origin);
    const baseAngle = baseDirection.length() > 0.5
      ? baseDirection.angle()
      : player.team.attackingDirection === 1 ? 0 : Math.PI;

    // 슬롯별 우선 탐색 거리 배율 — 세 지원자가 다른 깊이를 선호하게 한다
    const slot = player.supportSlot;
    const SLOT_DIST_FACTOR = [0.75, 1.0, 1.35];
    const distFactor = (slot >= 0 && slot <= 2) ? SLOT_DIST_FACTOR[slot] : 1.0;

    const candidates = [];
    for (const spread of [-0.7, -0.35, 0, 0.35, 0.7]) {
      for (const distance of [SUPPORT_DISTANCE * 0.75, SUPPORT_DISTANCE, SUPPORT_DISTANCE * 1.35]) {
        const point = Pitch.clampInside(
          origin.add(Vector2D.fromAngle(baseAngle + spread, distance * distFactor)),
          2.0
        );
        candidates.push(point);
      }
    }

    let best = anchor;
    let bestScore = -Infinity;
    for (const point of candidates) {
      // 패스 경로가 열려 있는가
      const blocked = carrier && isLaneBlocked(origin, point, opponents);
      // 상대와 얼마나 떨어져 있는가
      const space = nearestOpponentTo(point, opponents).distance;
      // 자기 자리에서 얼마나 벗어나는가 (팀 형태 유지)
      const drift = point.sub(anchor).length();

      const score =
        smoothstep(1, 10, space) * 1.0 +
        (blocked ? -0.8 : 0.35) -
        smoothstep(6, 22, drift) * 0.9;

      if (score > bestScore) {
        bestScore = score;
        best = point;
      }
    }

    const gap = player.position.sub(best).length();
    player.setDecision(Action.MOVE, best, {
      sprint: gap > 12,
      urgency: clamp01(0.45 + smoothstep(2, 14, gap) * 0.35),
      source: Duty.SUPPORT,
    });
  }

  /**
   * 폭 유지 — 터치라인 쪽으로 벌려 상대 수비를 넓힌다.
   * 이 임무가 유지돼야 중앙에 공간이 생긴다.
   */
  _holdWidth(engine, player) {
    const dir = player.team.attackingDirection;
    const anchor = player.anchor;
    const channel = player.slot?.channel ?? 0;

    // 자기 채널 쪽 터치라인으로 더 벌린다 (팀 상대 기준)
    const anchorTeamY = toTeamY(anchor.y, dir);
    const towardLine = channel >= 0
      ? Pitch.WIDTH - 4.0
      : 4.0;
    const widenedTeamY = anchorTeamY + (towardLine - anchorTeamY) * 0.55;

    const anchorTeamX = teamNX(anchor.x, dir) * Pitch.LENGTH;
    const target = fromTeamSpace(
      new Vector2D(anchorTeamX, widenedTeamY),
      dir
    );

    const gap = player.position.sub(target).length();
    player.setDecision(Action.MOVE, Pitch.clampInside(target, 1.5), {
      sprint: gap > 14,
      urgency: clamp01(0.4 + smoothstep(3, 16, gap) * 0.35),
      source: Duty.HOLD_WIDTH,
    });
  }

  /**
   * 오버랩 — 측면 동료 바깥으로 추월해 올라간다.
   * 바깥 통로를 점유해 상대 수비수를 하나 더 묶는 것이 목적이다.
   */
  _overlap(engine, player) {
    const dir = player.team.attackingDirection;
    const ball = engine.ball;
    const anchor = player.anchor;

    // 자기 채널 쪽 바깥 통로를, 볼보다 앞선 지점에
    const channel = player.slot?.channel ?? 0;
    const outerTeamY = channel >= 0 ? Pitch.WIDTH - 3.5 : 3.5;
    const ballTeamX = teamNX(ball.position.x, dir) * Pitch.LENGTH;
    const anchorTeamX = teamNX(anchor.x, dir) * Pitch.LENGTH;

    // 볼보다 8m 앞, 다만 자기 앵커에서 너무 멀어지지 않게 절충
    const targetTeamX = clamp(
      Math.max(ballTeamX + 8, anchorTeamX),
      anchorTeamX - 4,
      anchorTeamX + 26
    );

    const target = Pitch.clampInside(
      fromTeamSpace(new Vector2D(targetTeamX, outerTeamY), dir),
      1.5
    );

    player.setDecision(Action.MOVE, target, {
      sprint: true,
      urgency: 0.9,
      source: Duty.OVERLAP,
    });
  }

  /**
   * 수비 뒤 침투 — 상대 최종 수비 라인 뒤 공간으로 달린다.
   *
   * 무작정 골문으로 달리지 않는다. 상대 라인 기준으로 깊이를 정해
   * 지나치게 깊이 들어가지 않게 한다 (오프사이드·고립 방지).
   */
  _runBehind(engine, player) {
    const dir = player.team.attackingDirection;
    const opponents = (player.team.opponent?.players ?? []).filter((o) => o.role !== Role.GK);

    // 상대 최종 수비 라인 (뒤에서 두 번째 수비수)
    const lineTeamX = this._opponentLastLineTeamX(opponents, dir);

    // 라인 뒤로 일정 깊이. 상대 골라인 근처까지는 가지 않는다.
    const targetTeamX = clamp(
      lineTeamX + RUN_BEHIND_DEPTH,
      lineTeamX + 2,
      Pitch.LENGTH - 7
    );

    // 좌우는 자기 앵커 채널을 유지해 동료와 겹치지 않게 한다
    const anchorTeamY = toTeamY(player.anchor.y, dir);

    const target = Pitch.clampInside(
      fromTeamSpace(new Vector2D(targetTeamX, anchorTeamY), dir),
      1.5
    );

    player.setDecision(Action.MOVE, target, {
      sprint: true,
      urgency: 1,
      source: Duty.RUN_BEHIND,
    });
  }

  /**
   * 라인 사이 침투 — 상대 수비와 미드필드 사이 공간을 점유한다.
   * 볼을 등지지 않고 받을 수 있는 위치를 찾는 움직임이다.
   */
  _runBetween(engine, player) {
    const dir = player.team.attackingDirection;
    const opponents = (player.team.opponent?.players ?? []).filter((o) => o.role !== Role.GK);
    const anchor = player.anchor;

    const lineTeamX = this._opponentLastLineTeamX(opponents, dir);
    // 수비 라인 바로 앞 (뒤가 아니라 앞) 공간
    const targetTeamX = clamp(lineTeamX - 6, 20, Pitch.LENGTH - 12);

    // 좌우로는 가장 빈 곳을 고른다
    const anchorTeamY = toTeamY(anchor.y, dir);
    let bestTeamY = anchorTeamY;
    let bestSpace = -Infinity;
    for (const offset of [-9, -4.5, 0, 4.5, 9]) {
      const teamY = clamp(anchorTeamY + offset, 4, Pitch.WIDTH - 4);
      const world = fromTeamSpace(new Vector2D(targetTeamX, teamY), dir);
      const space = nearestOpponentTo(world, opponents).distance;
      if (space > bestSpace) {
        bestSpace = space;
        bestTeamY = teamY;
      }
    }

    const target = Pitch.clampInside(
      fromTeamSpace(new Vector2D(targetTeamX, bestTeamY), dir),
      1.5
    );

    const gap = player.position.sub(target).length();
    player.setDecision(Action.MOVE, target, {
      sprint: gap > 10,
      urgency: 0.8,
      source: Duty.RUN_BETWEEN,
    });
  }

  /**
   * 내려받기 — 볼 쪽으로 내려와 짧은 패스를 받아준다.
   * 전방이 막혔을 때 빌드업을 이어주는 움직임이다.
   */
  _checkToBall(engine, player) {
    const ball = engine.ball;
    const toBall = ball.position.sub(player.position);
    const distance = toBall.length();

    // 볼 쪽으로 일정 거리 내려온다 (너무 가까이 가면 공간을 없앤다)
    const approach = distance > 1
      ? toBall.normalize().scale(Math.min(distance - SUPPORT_DISTANCE * 0.7, 12))
      : Vector2D.zero();

    const target = Pitch.clampInside(player.position.add(approach), 1.5);

    player.setDecision(Action.MOVE, target, {
      sprint: false,
      urgency: 0.65,
      source: Duty.CHECK_TO_BALL,
    });
  }

  /**
   * 후방 잔류 — 공격 중에도 역습에 대비해 남는다 (Section 26).
   * 앵커보다 약간 뒤에 서서 상대 역습 경로를 막는다.
   */
  _restDefence(engine, player) {
    const dir = player.team.attackingDirection;
    const anchor = player.anchor;
    const anchorTeamX = teamNX(anchor.x, dir) * Pitch.LENGTH;
    const anchorTeamY = toTeamY(anchor.y, dir);

    const target = Pitch.clampInside(
      fromTeamSpace(new Vector2D(Math.max(anchorTeamX - 4, 6), anchorTeamY), dir),
      1.5
    );

    const gap = player.position.sub(target).length();
    player.setDecision(Action.MOVE, target, {
      sprint: gap > 14,
      urgency: clamp01(0.35 + smoothstep(3, 18, gap) * 0.4),
      source: Duty.REST_DEFENCE,
    });
  }

  // ──────────────────────────────────────────────────────────

  /**
   * 상대 최종 수비 라인의 팀 상대 x 좌표.
   * 뒤에서 두 번째 수비수를 기준으로 삼는다 (오프사이드 기준선과 같은 개념).
   */
  _opponentLastLineTeamX(opponents, dir) {
    if (opponents.length === 0) return Pitch.LENGTH * 0.75;
    const depths = opponents
      .map((o) => teamNX(o.position.x, dir) * Pitch.LENGTH)
      .sort((a, b) => b - a);
    return depths[1] ?? depths[0];
  }
}
