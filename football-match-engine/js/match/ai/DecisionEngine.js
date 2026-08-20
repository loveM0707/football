import { Vector2D } from '../../entities/Vector2D.js';
import { Pitch } from '../../entities/Pitch.js';
import { clamp, clamp01, smoothstep, teamNX, angleDiff } from '../core/Coords.js';
import { Action } from '../entities/Player.js';
import { Duty, Role } from '../tactics/RoleModel.js';
import { PossessionState } from '../sim/PossessionModel.js';
import { PassPlanner } from './PassPlanner.js';
import { ShotPlanner } from './ShotPlanner.js';
import { OffBallAI } from './OffBallAI.js';
import { DefenceAI } from './DefenceAI.js';
import { TransitionAI } from './TransitionAI.js';
import { GoalkeeperAI } from './GoalkeeperAI.js';
import { pressureAt, nearestOpponentTo, timeToReach } from './Estimates.js';

/**
 * 판단 엔진 — 선수별 의도를 만드는 유일한 주체.
 *
 * ⚠ 여기서는 "무엇을 하고 싶은가"만 정한다.
 *   위치·속도는 MovementEngine이, 볼 접촉은 ActionSystem이 실행한다.
 *
 * ── 처리 순서 ────────────────────────────────────────────────
 *  1. 볼 소유자      → 온볼 판단 (패스 / 드리블 / 버티기)
 *  2. 패스 수신자    → 볼 마중
 *  3. 전환 국면      → 카운터프레스 / 역습 침투 (긴급도 덮어쓰기)
 *  4. 임무별 행동    → 수비 AI 또는 오프볼 AI
 *
 * 온볼 판단에는 행동 커밋을 둔다. 매 틱 마음을 바꾸면 선수가 제자리에서
 * 떨거나 패스 직전에 취소하는 부자연스러운 모습이 나온다 (Section 19).
 */

/** 온볼 판단을 유지하는 시간 (초) */
const ON_BALL_COMMIT = 0.28;

/** 패스 계획을 다시 세우는 주기 (초) — 역산 비용이 크므로 매 틱 하지 않는다 */
const PLAN_INTERVAL = 0.20;

/**
 * 이 효용 미만의 패스는 실행하지 않는다.
 *
 * 다만 압박을 받으며 오래 붙잡고 있으면 문턱이 내려간다.
 * 고정 문턱만 두면 "좋은 선택지가 없으니 계속 버틴다"가 반복되어
 * 캐리어와 수비수가 서로 붙잡힌 교착 상태가 만들어진다.
 * 실제 선수는 몰리면 완벽하지 않은 패스라도 내준다.
 */
const PASS_UTILITY_FLOOR = -0.35;

/** 압박 아래서 버틸 수 있는 시간 (초). 넘으면 문턱이 급격히 내려간다 */
const HOLD_PATIENCE = 1.4;

/**
 * 이 값 미만의 슛은 시도하지 않는다.
 *
 * 슛에는 별도 문턱을 둔다. 패스·드리블과 단순 비교만 하면
 * 각도가 없는 먼 거리에서도 "그나마 제일 나은 선택"이라는 이유로
 * 슛이 남발된다. 실제로는 슛이 패스보다 훨씬 드물다 (Section 31).
 */
const SHOT_UTILITY_FLOOR = 0.85;

export class DecisionEngine {
  /**
   * @param {number} dt 고정 스텝
   */
  constructor(dt) {
    this.dt = dt;
    this.passPlanner = new PassPlanner(dt);
    this.shotPlanner = new ShotPlanner(dt);
    this.offBall = new OffBallAI();
    this.defence = new DefenceAI();
    this.transition = new TransitionAI();
    this.goalkeeper = new GoalkeeperAI();
  }

  /**
   * @param {MatchEngine} engine
   * @param {number} dt
   */
  update(engine, dt) {
    if (!engine.state.isBallInPlay) {
      // 재개 대기 중에는 배치만 한다 (RestartEngine이 목표를 준다)
      for (const player of engine.allPlayers) {
        player.setDecision(Action.MOVE, player.anchor, { urgency: 0.3 });
      }
      return;
    }

    for (const player of engine.allPlayers) {
      this._decide(engine, player, dt);
    }
  }

  /** 한 선수의 판단 */
  _decide(engine, player, dt) {
    const ball = engine.ball;

    // ── 1. 볼을 가진 선수 ──────────────────────────────────
    // 골키퍼가 볼을 잡았을 때도 배급은 온볼 판단을 거친다
    if (ball.carrier === player) {
      if (player.role === Role.GK) {
        this.goalkeeper.decide(engine, player);
        // 골키퍼가 "이제 내보내도 된다"고 판단했을 때만 패스를 계획한다
        if (player.decision.action === Action.PASS) {
          this._decideOnBall(engine, player, dt);
        }
        return;
      }
      this._decideOnBall(engine, player, dt);
      return;
    }

    // 볼이 없는 골키퍼는 전용 판단을 따른다
    if (player.role === Role.GK) {
      this.goalkeeper.decide(engine, player);
      return;
    }

    // ── 2. 나에게 오는 패스 마중 ───────────────────────────
    if (this._isIncomingPassTarget(engine, player)) {
      this._receive(engine, player);
      return;
    }

    // ── 3. 전환 국면 덮어쓰기 ──────────────────────────────
    if (this.transition.decide(engine, player)) return;

    // ── 4. 임무별 행동 ─────────────────────────────────────
    if (this.defence.decide(engine, player)) return;
    if (this.offBall.decide(engine, player)) return;

    // 임무가 없으면 제자리를 지킨다
    player.setDecision(Action.MOVE, player.anchor, {
      urgency: 0.4, source: 'ANCHOR',
    });
  }

  // ──────────────────────────────────────────────────────────
  // 온볼 판단
  // ──────────────────────────────────────────────────────────

  /**
   * 볼을 가진 선수의 판단 — 패스 / 드리블 / 버티기.
   *
   * 동료가 있다고 바로 패스하지 않고, 공간이 있다고 무작정 몰지 않는다.
   * 각 선택의 효용을 비교하고, 정한 뒤에는 잠시 유지한다.
   */
  _decideOnBall(engine, player, dt) {
    const memory = player.brainMemory;
    const tactics = player.team.tactics;
    const tempoFactor = 1.4 - tactics.tempo * 0.8; // 0.6(빠름) ~ 1.4(느림)

    // 커밋 중이면 이전 판단을 이어간다
    memory.onBallCommit = Math.max(0, (memory.onBallCommit ?? 0) - dt);
    if (memory.onBallCommit > 0 && memory.onBallAction) {
      this._applyOnBallAction(engine, player, memory.onBallAction, memory.onBallPass, memory.onBallShot);
      return;
    }

    // 계획은 주기적으로만 갱신한다 (역산·궤적 시뮬레이션 비용)
    memory.planTimer = Math.max(0, (memory.planTimer ?? 0) - dt);
    if (memory.planTimer <= 0 || !memory.passOption) {
      memory.passOption = this.passPlanner.plan(engine, player);
      memory.shotOption = player.role === Role.GK
        ? null
        : this.shotPlanner.plan(engine, player);
      memory.planTimer = PLAN_INTERVAL * tempoFactor;
    }

    const passOption = memory.passOption;
    const passUtility = passOption ? passOption.utility : -Infinity;
    const carryUtility = this._carryUtility(engine, player);

    // ── 버티는 시간과 압박에 따라 패스 문턱을 낮춘다 ────────
    // 이것이 없으면 "좋은 선택지가 없다 → 계속 버틴다"가 반복되어
    // 캐리어와 압박자가 서로 붙잡힌 채 경기가 멈춘다.
    const opponents = player.team.opponent?.players ?? [];
    const pressure = pressureAt(player.position, opponents);
    memory.holdTimer = (memory.holdTimer ?? 0) + dt;

    const holdPatience = HOLD_PATIENCE * (1.7 - tactics.tempo * 1.4); // 0.42~2.38초
    const urgency = clamp01(
      smoothstep(holdPatience, holdPatience * 2.2, memory.holdTimer) * 0.6 +
      pressure * 0.6
    );
    const floor = PASS_UTILITY_FLOOR - urgency * 1.5;

    // ── 슛 ─────────────────────────────────────────────────
    // 슛은 패스·드리블과 같은 척도로 비교하되, 문턱을 둬서
    // "좋은 기회일 때만" 나온다. 문턱이 없으면 슛이 남발된다
    // (Section 31: 슛은 패스보다 훨씬 드물어야 한다)
    const shotOption = memory.shotOption;
    const shotUtility = shotOption ? shotOption.utility : -Infinity;

    let action;
    if (shotOption && shotUtility >= SHOT_UTILITY_FLOOR &&
        shotUtility >= passUtility && shotUtility >= carryUtility) {
      action = Action.SHOOT;
    } else if (passOption && passUtility >= floor && passUtility >= carryUtility) {
      action = Action.PASS;
    } else if (carryUtility > 0) {
      action = Action.CARRY;
    } else {
      // 마땅한 선택지가 없으면 볼을 지키며 시간을 번다
      action = Action.SHIELD;
    }

    memory.onBallAction = action;
    memory.onBallPass = action === Action.PASS ? passOption : null;
    memory.onBallShot = action === Action.SHOOT ? shotOption : null;
    memory.onBallCommit = ON_BALL_COMMIT * (1.3 - tactics.tempo * 0.6); // 0.196~0.364초
    // 볼을 내보내기로 했으면 버틴 시간을 초기화한다
    if (action === Action.PASS || action === Action.SHOOT) memory.holdTimer = 0;

    this._applyOnBallAction(engine, player, action, memory.onBallPass, memory.onBallShot);
  }

  /** 결정된 온볼 행동을 decision에 반영한다 */
  _applyOnBallAction(engine, player, action, passOption, shotOption = null) {
    switch (action) {
      case Action.SHOOT:
        if (!shotOption) {
          player.setDecision(Action.SHIELD, player.position, { urgency: 0.4 });
          return;
        }
        player.setDecision(Action.SHOOT, shotOption.aimPoint, {
          payload: shotOption,
          urgency: 1,
          source: `SHOOT_${shotOption.type}`,
        });
        return;

      case Action.PASS:
        if (!passOption) {
          player.setDecision(Action.SHIELD, player.position, { urgency: 0.4 });
          return;
        }
        player.setDecision(Action.PASS, passOption.targetPosition, {
          payload: passOption,
          urgency: 0.6,
          source: `PASS_${passOption.type}`,
        });
        return;

      case Action.CARRY: {
        const target = this._carryTarget(engine, player);
        player.setDecision(Action.CARRY, target, {
          sprint: true,
          urgency: 0.9,
          source: 'CARRY',
        });
        return;
      }

      case Action.SHIELD:
      default: {
        // 상대 반대편으로 몸을 돌려 볼을 지킨다
        const opponents = player.team.opponent?.players ?? [];
        const { player: nearest } = nearestOpponentTo(player.position, opponents);
        const away = nearest
          ? player.position.sub(nearest.position)
          : new Vector2D(-player.team.attackingDirection, 0);
        const target = Pitch.clampInside(
          player.position.add(away.length() > 0.1 ? away.normalize().scale(2.0) : away),
          1.0
        );
        player.setDecision(Action.SHIELD, target, {
          urgency: 0.35, source: 'SHIELD',
        });
        return;
      }
    }
  }

  /**
   * 드리블 효용 — 앞이 열려 있고, 압박이 낮고, 능력이 받쳐줄 때 높다.
   *
   * 패스 효용과 같은 척도로 비교되어야 하므로 크기를 맞춰 둔다.
   */
  _carryUtility(engine, player) {
    const dir = player.team.attackingDirection;
    const opponents = player.team.opponent?.players ?? [];
    const skill = player.attributes.norm('dribbling');
    const pressure = pressureAt(player.position, opponents);

    // 전방 8m 지점의 여유 공간
    const ahead = player.position.add(new Vector2D(dir, 0).scale(8));
    const space = nearestOpponentTo(ahead, opponents).distance;

    let utility =
      smoothstep(3, 14, space) * 0.85 +
      skill * 0.45 -
      pressure * 1.10;

    // 자기 진영 깊은 곳에서 드리블하다 뺏기면 치명적이다
    const nx = teamNX(player.position.x, dir);
    utility -= (1 - smoothstep(0.15, 0.42, nx)) * 0.55;

    // 팀 지시: 직선적 공격 성향이면 몰고 가는 것을 더 높게 친다
    utility += (player.team.tactics.attackDirectness - 0.5) * 0.30;

    return utility;
  }

  /** 드리블 진행 방향 — 상대 골문 쪽의 가장 열린 통로 */
  _carryTarget(engine, player) {
    const dir = player.team.attackingDirection;
    const opponents = player.team.opponent?.players ?? [];
    const goal = new Vector2D(dir === 1 ? Pitch.LENGTH : 0, Pitch.WIDTH / 2);

    const toGoal = goal.sub(player.position);
    const baseAngle = toGoal.length() > 0.5
      ? toGoal.angle()
      : (dir === 1 ? 0 : Math.PI);

    let best = null;
    let bestScore = -Infinity;
    for (const spread of [-0.55, -0.28, 0, 0.28, 0.55]) {
      const point = Pitch.clampInside(
        player.position.add(Vector2D.fromAngle(baseAngle + spread, 12)),
        2.0
      );
      const space = nearestOpponentTo(point, opponents).distance;
      // 골문에 가까워질수록, 상대가 멀수록 좋다
      const progress = -point.sub(goal).length() / Pitch.LENGTH;
      const score = smoothstep(2, 12, space) * 1.0 + progress * 0.8;
      if (score > bestScore) {
        bestScore = score;
        best = point;
      }
    }
    return best ?? goal;
  }

  // ──────────────────────────────────────────────────────────
  // 패스 수신
  // ──────────────────────────────────────────────────────────

  /** 나에게 오는 패스가 있는가 */
  _isIncomingPassTarget(engine, player) {
    const ball = engine.ball;
    if (engine.possession?.state !== PossessionState.PASS_IN_FLIGHT) return false;
    return ball.passTargetPlayer === player;
  }

  /**
   * 패스 마중 — 볼이 도착할 지점으로 간다.
   *
   * 볼의 현재 위치가 아니라 실제 물리로 예측한 도착 지점을 향한다.
   * 목표 지점이 정해져 있으면(스루패스) 그곳으로 달린다.
   */
  _receive(engine, player) {
    const ball = engine.ball;

    // 패스를 찬 쪽이 의도한 도착 지점이 최우선 기준이다
    let target = ball.passTargetPos ? ball.passTargetPos.clone() : null;

    if (!target && engine.physics) {
      target = engine.physics.predictStop(ball).position;
    }
    if (!target) target = ball.position.clone();

    const gap = player.position.sub(target).length();
    // 볼보다 먼저 도착해 기다릴 수 있으면 여유 있게, 늦으면 전력으로
    const ballTime = engine.physics
      ? Math.max(0.1, engine.physics.predictStop(ball).time)
      : 1;
    const myTime = timeToReach(player, target);
    const late = myTime > ballTime;

    player.setDecision(Action.MOVE, Pitch.clampInside(target, 0.8), {
      sprint: late || gap > 8,
      urgency: late ? 1 : clamp01(0.55 + smoothstep(1, 10, gap) * 0.35),
      source: 'RECEIVE',
    });
  }
}