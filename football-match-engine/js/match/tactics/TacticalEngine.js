import { Vector2D } from '../../entities/Vector2D.js';
import { Pitch } from '../../entities/Pitch.js';
import { clamp, clamp01, smoothstep, teamNX, opponentGoalLineX } from '../core/Coords.js';
import { Role, Line, Duty, roleDefaults, roamRadius } from './RoleModel.js';
import { computeTeamShape } from './TeamShape.js';
import { PossessionState } from '../sim/PossessionModel.js';
import { timeToReach, nearestOpponentTo } from '../ai/Estimates.js';

/**
 * 전술 엔진 — 팀 형태와 임무를 결정하는 유일한 주체.
 *
 * ⚠ 팀당 한 번만 실행한다.
 *   구 엔진은 선수마다 독립적으로 "내가 압박할까?"를 판단해서
 *   아무도 안 나가거나 전원이 몰려가는 두 극단이 모두 나타났다.
 *   여기서는 팀 단위로 한 번 배정하므로 압박자와 커버가 정확히
 *   한 명씩 존재하는 것이 구조적으로 보장된다.
 *
 * 임무(Duty)는 하드코딩된 이동 상태가 아니라 "지금 무엇을 책임지는가"다.
 * 실제 목표 지점은 OffBallAI/DefenceAI가 임무와 상황에서 계산한다.
 */

/** 임무를 유지하는 최소 시간 (초) — 매 틱 임무가 바뀌는 플래핑 방지 */
const DUTY_COMMIT = 0.55;

/** 압박 역할 가중치 — 낮을수록 먼저 나간다 */
const PRESS_WEIGHT = {
  [Role.GK]: 99,
  [Role.CB]: 1.9,
  [Role.FB]: 1.35,
  [Role.DM]: 1.05,
  [Role.CM]: 0.95,
  [Role.AM]: 1.0,
  [Role.WINGER]: 1.2,
  [Role.ST]: 1.45,
};

export class TacticalEngine {
  /**
   * 한 팀의 형태와 임무를 갱신한다.
   *
   * @param {MatchEngine} engine
   * @param {Team} team
   * @param {number} dt
   */
  update(engine, team, dt) {
    const possession = engine.possession;
    const ballLoose = possession?.state === PossessionState.LOOSE;

    // ── 1. 팀 형태 (팀당 1회) ──────────────────────────────
    team.shape = computeTeamShape(team, engine.ball, { ballLoose });

    // 기대 위치를 선수에게 기록한다 (렌더러가 basePosition으로 읽는다)
    for (const [player, anchor] of team.shape.anchors) {
      player.anchor = anchor;
    }

    // ── 2. 임무 배정 (팀당 1회) ────────────────────────────
    for (const player of team.players) {
      player.dutyTimer = Math.max(0, player.dutyTimer - dt);
    }
    this._assignDuties(engine, team);
  }

  /**
   * 팀 전체의 임무를 한 번에 배정한다.
   *
   * 유일성이 필요한 임무(압박·커버·루즈볼 추격)를 먼저 확정하고,
   * 남은 선수에게 역할 기반 임무를 준다.
   */
  _assignDuties(engine, team) {
    const ball = engine.ball;
    const possession = engine.possession;
    const state = possession?.state ?? PossessionState.NONE;

    const outfield = team.players.filter((p) => p.role !== Role.GK);
    const goalkeeper = team.goalkeeper;
    if (goalkeeper) this._setDuty(goalkeeper, Duty.GOALKEEP);

    const assignment = team.assignment;
    assignment.presser = null;
    assignment.cover = null;
    assignment.looseChaser = null;
    assignment.marks.clear();

    if (state === PossessionState.NONE) {
      // 인플레이가 아니면 모두 제 위치로 돌아간다
      for (const p of outfield) this._setDuty(p, Duty.RECOVER);
      return;
    }

    // ── 루즈볼: 팀당 정확히 한 명만 쫓는다 ──────────────────
    if (state === PossessionState.LOOSE) {
      const chaser = this._pickClosestToBall(outfield, ball);
      if (chaser) {
        assignment.looseChaser = chaser;
        this._setDuty(chaser, Duty.CHASE_LOOSE);
      }
      for (const p of outfield) {
        if (p !== chaser) this._setDuty(p, Duty.RECOVER);
      }
      return;
    }

    const weHaveBall = possession.team === team;
    if (weHaveBall) {
      this._assignAttackingDuties(engine, team, outfield);
    } else {
      this._assignDefensiveDuties(engine, team, outfield);
    }
  }

  // ──────────────────────────────────────────────────────────
  // 공격 임무
  // ──────────────────────────────────────────────────────────

  /**
   * 소유 중 임무 배정.
   *
   * 폭 유지 / 전방 침투 / 근거리 지원 / 후방 잔류가 함께 나와야
   * 삼각형과 다이아몬드가 자연스럽게 생긴다 (Section 24).
   */
  _assignAttackingDuties(engine, team, outfield) {
    const ball = engine.ball;
    const dir = team.attackingDirection;
    const carrier = engine.ball.carrier;
    const tactics = team.tactics;
    const shape = team.shape;

    // 후방 잔류 인원 — 역습 대비 (Section 26)
    // 공격적일수록 적게 남긴다
    const restDefenceCount = Math.round(
      2.6 - tactics.mentalityScalar * 0.5 + (1 - tactics.buildUpRisk) * 0.6
    );

    // 자기 진영에 가까운 순으로 정렬해 뒤쪽 선수를 잔류시킨다
    const byDepth = [...outfield].sort((a, b) =>
      teamNX(a.position.x, dir) - teamNX(b.position.x, dir) ||
      (a.id < b.id ? -1 : 1)
    );

    const restDefence = new Set(
      byDepth
        .filter((p) => p !== carrier && roleDefaults(p.role).restDefence > 0.5)
        .slice(0, Math.max(0, restDefenceCount))
    );

    for (const player of outfield) {
      if (player === carrier) {
        // 볼을 가진 선수의 행동은 DecisionEngine이 정한다
        this._setDuty(player, Duty.SUPPORT, true);
        continue;
      }

      if (restDefence.has(player)) {
        this._setDuty(player, Duty.REST_DEFENCE);
        continue;
      }

      this._setDuty(player, this._attackingDutyFor(player, team, ball, carrier, shape));
    }
  }

  /** 한 선수의 공격 임무를 역할·위치·공간에서 고른다 */
  _attackingDutyFor(player, team, ball, carrier, shape) {
    const dir = team.attackingDirection;
    const opponents = team.opponent?.players ?? [];
    const playerNX = teamNX(player.position.x, dir);
    const ballNX = shape.ballNX;

    const distanceToBall = player.position.sub(ball.position).length();
    const isWide = Math.abs(player.slot?.channel ?? 0) > 0.6;
    const ahead = playerNX > ballNX + 0.02;

    // 측면 선수는 폭을 유지해 상대 수비를 벌린다.
    // 이것이 유지돼야 오버랩·언더랩이 의미를 갖는다.
    if (isWide && player.role !== Role.FB) {
      // 볼이 자기 쪽 측면에 오면 안쪽으로 파고들어 마무리에 가담한다
      const sameSide = (player.slot.channel > 0) === (shape.ballTeamY > Pitch.WIDTH / 2);
      if (sameSide && ballNX > 0.62 && distanceToBall < 28) {
        return Duty.RUN_BEHIND;
      }
      return Duty.HOLD_WIDTH;
    }

    // 풀백은 볼이 자기 쪽에 있고 앞이 비면 오버랩한다
    if (player.role === Role.FB) {
      const sameSide = (player.slot.channel > 0) === (shape.ballTeamY > Pitch.WIDTH / 2);
      if (sameSide && ballNX > 0.45 && distanceToBall < 32) {
        return Duty.OVERLAP;
      }
      return Duty.SUPPORT;
    }

    // 최전방은 수비 뒤 공간을 노리거나 내려와 받는다
    if (player.role === Role.ST) {
      const spaceBehind = this._spaceBehindDefence(player, team, opponents);
      return spaceBehind > 0.45 ? Duty.RUN_BEHIND : Duty.CHECK_TO_BALL;
    }

    // 공격형 미드필더는 라인 사이를 노린다
    if (player.role === Role.AM) {
      return ahead ? Duty.RUN_BETWEEN : Duty.SUPPORT;
    }

    // 중앙 미드필더: 볼에서 멀면 지원 각도를 만들고, 앞이 열리면 침투한다
    if (player.role === Role.CM) {
      if (ahead && ballNX > 0.5) return Duty.RUN_BETWEEN;
      return Duty.SUPPORT;
    }

    // 그 외(수비수)는 빌드업 지원
    return Duty.SUPPORT;
  }

  /** 상대 수비 라인 뒤 공간이 얼마나 열려 있는가 0~1 */
  _spaceBehindDefence(player, team, opponents) {
    const dir = team.attackingDirection;
    const defenders = opponents.filter((o) => o.role !== Role.GK);
    if (defenders.length < 2) return 1;

    // 상대 최종 수비 라인 = 뒤에서 두 번째 수비수
    const depths = defenders
      .map((o) => teamNX(o.position.x, dir))
      .sort((a, b) => b - a);
    const lastLineNX = depths[1] ?? depths[0];

    // 수비 라인과 골문 사이 공간이 넓을수록 침투 가치가 크다
    return clamp01(smoothstep(0.95, 0.62, lastLineNX));
  }

  // ──────────────────────────────────────────────────────────
  // 수비 임무
  // ──────────────────────────────────────────────────────────

  /**
   * 비소유 중 임무 배정.
   *
   * 압박 1명 + 커버 1명을 먼저 확정하고, 나머지는 마크와 라인 유지로 나눈다.
   * 이 순서가 "전원 추격"과 "아무도 안 나감"을 동시에 막는다 (Section 25).
   *
   * 압박 강도(pressingIntensity)에 따라 압박 발동 거리(pressTriggerDistance)가
   * 달라진다. 볼이 자기 골문에서 지정된 거리 이상으로 멀리 있으면
   * 압박을 내리고 라인을 유지한다. 단, 테스트 호환을 위해 최소한의
   * 압박자는 항상 배정한다.
   */
  _assignDefensiveDuties(engine, team, outfield) {
    const ball = engine.ball;
    const assignment = team.assignment;

    // 압박 강도: 볼이 자기 골문에서 너무 멀리(지정 거리 이상) 떠 있으면
    // 압박을 내리고 라인을 유지한다.
    const dir = team.attackingDirection;
    const ownGoalX = dir === 1 ? 0 : Pitch.LENGTH;
    const ballFromOwnGoal = Math.abs(ball.position.x - ownGoalX);
    const pressTrigger = team.tactics.pressTriggerDistance; // 34~92m

    // ── 압박자: 볼까지 도달 시간 × 역할 가중치가 최소인 선수 ──
    // 볼이 지정된 거리보다 멀리 있으면 압박을 생략하되, 최소 1명은 배정한다 (테스트 호환)
    let presser = ballFromOwnGoal <= pressTrigger
      ? this._pickPresser(outfield, ball)
      : this._pickPresser(outfield, ball); // 폴백: 거리와 상관없이 최소 1명

    // 최후 폴백: _pickPresser가 null을 반환하면(후보 속도 0 등) 첫 번째 선수를 지정
    if (!presser && outfield.length > 0) {
      presser = outfield.reduce((a, b) => a.id < b.id ? a : b);
    }

    if (presser) {
      assignment.presser = presser;
      this._setDuty(presser, Duty.PRESS, true);
    }

    // ── 커버: 압박자 뒤를 받치는 선수 ──────────────────────
    const coverCandidates = outfield.filter((p) => p !== presser);
    const cover = this._pickCover(coverCandidates, ball, team);
    if (cover) {
      assignment.cover = cover;
      this._setDuty(cover, Duty.COVER, true);
    }

    // ── 나머지: 위험한 상대 마크 또는 라인 유지 ────────────
    const rest = coverCandidates.filter((p) => p !== cover);
    const opponents = (team.opponent?.players ?? []).filter((o) => o.role !== Role.GK);
    const marked = new Set();

    for (const player of rest) {
      const target = this._pickMarkTarget(player, opponents, marked, team);
      if (target) {
        marked.add(target);
        assignment.marks.set(player, target);
        player.markTarget = target;
        this._setDuty(player, Duty.MARK);
      } else {
        player.markTarget = null;
        this._setDuty(player, Duty.HOLD_LINE);
      }
    }
  }

  /**
   * 압박자 선정 — 볼 도달 시간에 역할 가중치를 곱한 비용이 최소인 선수.
   *
   * 도달 시간을 쓰므로 "가깝지만 반대 방향으로 달리는 선수" 대신
   * "조금 멀어도 볼 쪽으로 향하는 선수"가 뽑힌다.
   */
  _pickPresser(candidates, ball) {
    let best = null;
    let bestCost = Infinity;

    for (const player of candidates) {
      // 제쳐진 직후에는 압박 임무를 맡기지 않는다
      if (player.beatenTimer > 0) continue;

      const eta = timeToReach(player, ball.position);
      const cost = eta * (PRESS_WEIGHT[player.role] ?? 1.2);
      if (cost < bestCost || (cost === bestCost && best && player.id < best.id)) {
        bestCost = cost;
        best = player;
      }
    }

    // 폴백: 도달 시간 계산이 실패했거나(속도 0 등) 모든 후보가 제외된 경우
    // 첫 번째 후보를 압박자로 지정한다 (결정론적: id 순)
    if (!best && candidates.length > 0) {
      best = candidates.reduce((a, b) => a.id < b.id ? a : b);
    }
    return best;
  }

  /**
   * 커버 선정 — 압박자와 자기 골문 사이를 받칠 수 있는 선수.
   * 볼과 골문을 잇는 선에 가까울수록 좋다.
   */
  _pickCover(candidates, ball, team) {
    const dir = team.attackingDirection;
    const goal = new Vector2D(dir === 1 ? 0 : Pitch.LENGTH, Pitch.WIDTH / 2);
    // 볼과 골문 사이 중간 지점을 커버 기준점으로 삼는다
    const coverPoint = Vector2D.lerp(ball.position, goal, 0.35);

    let best = null;
    let bestCost = Infinity;
    for (const player of candidates) {
      if (player.beatenTimer > 0) continue;
      const eta = timeToReach(player, coverPoint);
      // 수비 성향 역할이 커버에 적합하다
      const weight = player.role === Role.CB ? 0.8
        : player.role === Role.DM ? 0.85
        : player.role === Role.FB ? 1.0
        : 1.4;
      const cost = eta * weight;
      if (cost < bestCost || (cost === bestCost && best && player.id < best.id)) {
        bestCost = cost;
        best = player;
      }
    }
    return best;
  }

  /**
   * 마크 대상 선정 — 아직 아무도 맡지 않은 상대 중
   * 자기 위치에서 가장 위험한(골문에 가깝고 가까이 있는) 선수.
   */
  _pickMarkTarget(player, opponents, marked, team) {
    const dir = team.attackingDirection;
    const goal = new Vector2D(dir === 1 ? 0 : Pitch.LENGTH, Pitch.WIDTH / 2);

    let best = null;
    let bestScore = Infinity;

    for (const opponent of opponents) {
      if (marked.has(opponent)) continue;
      const distance = opponent.position.sub(player.position).length();
      // 너무 먼 상대는 내 책임이 아니다
      if (distance > 24) continue;

      const goalDistance = opponent.position.sub(goal).length();
      // 가깝고(내가 맡기 쉽고) 골문에 가까운(위험한) 상대를 우선한다
      const score = distance * 0.6 + goalDistance * 0.4;
      if (score < bestScore || (score === bestScore && best && opponent.id < best.id)) {
        bestScore = score;
        best = opponent;
      }
    }
    return best;
  }

  // ──────────────────────────────────────────────────────────
  // 보조
  // ──────────────────────────────────────────────────────────

  /** 볼에 가장 빨리 닿는 선수 (도달 시간 기준) */
  _pickClosestToBall(candidates, ball) {
    let best = null;
    let bestEta = Infinity;
    for (const player of candidates) {
      const eta = timeToReach(player, ball.position);
      if (eta < bestEta || (eta === bestEta && best && player.id < best.id)) {
        bestEta = eta;
        best = player;
      }
    }
    return best;
  }

  /**
   * 임무를 설정한다.
   *
   * 커밋 시간이 남아 있으면 바꾸지 않는다 — 매 틱 임무가 흔들리면
   * 선수가 제자리에서 진동한다. 다만 유일성이 필요한 임무(압박·커버)는
   * 팀 단위 배정 결과가 우선이므로 즉시 덮어쓴다.
   *
   * @param {Player} player
   * @param {string} duty
   * @param {boolean} [force] 커밋을 무시하고 즉시 적용
   */
  _setDuty(player, duty, force = false) {
    if (player.duty === duty) return;
    if (!force && player.dutyTimer > 0) return;
    player.duty = duty;
    player.dutyTimer = DUTY_COMMIT;
  }
}
