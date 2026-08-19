import { Vector2D } from '../../entities/Vector2D.js';
import { clamp, clamp01, smoothstep } from '../core/Coords.js';
import { Action } from '../entities/Player.js';
import { BallFlight } from '../entities/Ball.js';
import { pressureOn } from '../ai/Estimates.js';
import { DribblePlanner, TOUCH_INTERVAL } from '../ai/DribblePlanner.js';
import {
  resolveTackle, DuelOutcome, TACKLE_RANGE, TACKLE_RECOVERY, BEATEN_DURATION,
} from '../ai/DuelResolver.js';

/**
 * 행동 실행 — 선수가 볼을 차는 유일한 지점.
 *
 * ⚠ 권한 규칙
 *   ball.kick()을 호출하는 코드는 이 파일뿐이다.
 *   판단 계층(PassPlanner 등)은 "무엇을 하고 싶은가"만 계산하고,
 *   실제 접촉은 여기서 능력치 오차를 얹어 실행한다.
 *
 * 이 분리 덕분에 "계획한 궤적"과 "실제 궤적"의 차이가 한 곳에만 존재한다.
 */

/** 킥 후 같은 선수가 볼을 다시 만지지 못하는 시간 (초) */
const KICK_COOLDOWN = 0.4;

export class ActionSystem {
  /**
   * @param {number} dt 고정 스텝
   */
  constructor(dt) {
    this.dt = dt;
    this.dribble = new DribblePlanner(dt);
  }

  /**
   * @param {MatchEngine} engine
   * @param {number} dt
   */
  update(engine, dt) {
    if (!engine.state.isBallInPlay) return;

    // 태클 회복·제쳐짐 타이머 감소
    for (const p of engine.allPlayers) {
      if (p.tackleRecovery > 0) p.tackleRecovery = Math.max(0, p.tackleRecovery - dt);
      if (p.beatenTimer > 0) p.beatenTimer = Math.max(0, p.beatenTimer - dt);
    }

    // 실행 순서를 고정해 결정론을 보장한다.
    // 수비 행동(태클)을 먼저 처리해, 같은 스텝에 뺏긴 선수가
    // 패스를 실행하는 모순을 막는다.
    const players = engine.allPlayers;
    for (const player of players) {
      if (player.decision.action === Action.TACKLE) {
        this._executeTackle(engine, player);
      }
    }
    for (const player of players) {
      this._executeBallAction(engine, player);
    }
  }

  /** 볼을 가진 선수의 행동 (패스·드리블 터치) */
  _executeBallAction(engine, player) {
    const ball = engine.ball;
    if (ball.carrier !== player) return;
    if (player.touchCooldown > 0) return;

    switch (player.decision.action) {
      case Action.PASS:
        this._executePass(engine, player);
        break;
      case Action.CARRY:
        this._executeDribbleTouch(engine, player);
        break;
      default:
        break;
    }
  }

  // ──────────────────────────────────────────────────────────
  // 패스 실행
  // ──────────────────────────────────────────────────────────

  /**
   * 계획된 패스를 실행한다. 계획 자체는 PassPlanner가 이미 만들었고,
   * 여기서는 능력치·압박에 따른 오차만 얹는다.
   */
  _executePass(engine, passer) {
    const option = passer.decision.payload;
    if (!option?.solution) return;

    const ball = engine.ball;
    const rng = engine.rng.pass;

    const { angleError, powerError } = this._kickError(passer, option, rng);

    const velocity = option.solution.velocity
      .rotate(angleError)
      .scale(powerError);
    const verticalVelocity = option.solution.verticalVelocity * powerError;

    ball.kick(velocity, verticalVelocity, {
      kicker: passer,
      flight: this._flightFor(option),
      target: option.receiver,
      targetPos: option.targetPosition,
      time: engine.time,
    });

    passer.touchCooldown = KICK_COOLDOWN;
    passer.decision.action = Action.MOVE;
    passer.decision.payload = null;

    engine.eventBus.emit('pass', {
      from: passer,
      to: option.receiver,
      team: passer.team,
      type: option.type,
      lofted: option.lofted,
      distance: option.distance,
      targetPos: option.targetPosition,
    });
  }

  /**
   * 킥 오차 — 능력치와 압박에서 나온다.
   *
   * 오차는 작아야 한다. 크게 흔들면 "가끔 이상한 방향으로 차는" 엔진이 된다.
   * 70 수준의 선수가 평상시 ±1.7° 정도, 강한 압박에서 ±3° 정도가 되게 잡는다.
   */
  _kickError(passer, option, rng) {
    const isLong = option.distance > 30;
    const skill = isLong
      ? passer.attributes.norm('longPassing')
      : passer.attributes.norm('passing');
    const composure = passer.attributes.norm('decisionMaking');

    const pressure = pressureOn(passer);

    // 기본 각도 표준편차 (rad)
    let sd = 0.052 - skill * 0.032;
    // 압박이 심하면 정확도가 떨어진다 (침착성이 일부 상쇄)
    sd *= 1 + pressure * (1.0 - composure * 0.45);
    // 거리가 멀수록 오차가 누적된다
    sd *= 1 + option.distance / 110;
    // 체력 저하
    sd *= 1 + (1 - passer.energy) * 0.35;

    return {
      angleError: rng.gaussian(0, sd, 2.5),
      powerError: 1 + rng.gaussian(0, 0.030 + (1 - skill) * 0.030, 2.5),
    };
  }

  /** 패스 종류를 볼 비행 종류로 변환한다 */
  _flightFor(option) {
    if (option.type === 'CROSS') return BallFlight.CROSS;
    if (option.type === 'THROUGH') return BallFlight.THROUGH;
    return BallFlight.PASS;
  }

  // ──────────────────────────────────────────────────────────
  // 드리블 터치
  // ──────────────────────────────────────────────────────────

  /**
   * 드리블 터치를 실행한다.
   *
   * 볼을 발에 붙이는 것이 아니라, 앞으로 밀어놓고 따라가는 동작이다.
   * 터치 후에도 캐리어 지위는 유지된다 (근처에 상대가 없는 한).
   */
  _executeDribbleTouch(engine, carrier) {
    const plan = this.dribble.plan(engine, carrier, carrier.decision.target);
    if (!plan.needsTouch || !plan.touchVelocity) return;

    const ball = engine.ball;
    const rng = engine.rng.touch;

    // 터치 오차 — 드리블 능력이 낮을수록 볼이 원하는 곳에 안 간다
    const skill = carrier.attributes.norm('dribbling');
    const sd = 0.11 - skill * 0.07;
    const angleError = rng.gaussian(0, sd, 2.5);
    const powerError = 1 + rng.gaussian(0, 0.09 - skill * 0.05, 2.5);

    const velocity = plan.touchVelocity.rotate(angleError).scale(powerError);

    ball.kick(velocity, 0, {
      kicker: carrier,
      flight: BallFlight.DRIBBLE_TOUCH,
      time: engine.time,
    });

    // 터치해도 여전히 이 선수가 몰고 있다.
    // (소유 상실 여부는 PossessionModel이 거리·경합으로 판정한다)
    ball.carrier = carrier;
    carrier.touchCooldown = TOUCH_INTERVAL;

    engine.eventBus.emit('dribbleTouch', {
      player: carrier,
      team: carrier.team,
      distance: plan.touchDistance,
    });
  }

  // ──────────────────────────────────────────────────────────
  // 태클
  // ──────────────────────────────────────────────────────────

  /** 태클 시도를 실행한다 */
  _executeTackle(engine, tackler) {
    const ball = engine.ball;
    const carrier = ball.carrier;

    // 대상이 없거나, 같은 팀이거나, 회복 중이면 시도하지 않는다
    if (!carrier || carrier.team === tackler.team) return;
    if (tackler.tackleRecovery > 0) return;

    const distance = tackler.position.sub(carrier.position).length();
    if (distance > TACKLE_RANGE) return;

    const result = resolveTackle({
      tackler, carrier, ball, rng: engine.rng.duel,
    });

    tackler.tackleRecovery = TACKLE_RECOVERY;
    tackler.decision.action = Action.MOVE;

    switch (result.outcome) {
      case DuelOutcome.WIN_CLEAN:
        ball.registerTouch(tackler, engine.time);
        ball.velocity = Vector2D.zero();
        ball.verticalVelocity = 0;
        ball.clearFlight();
        ball.carrier = tackler;
        carrier.beatenTimer = 0;
        engine.eventBus.emit('tackle', {
          winner: tackler, loser: carrier, loose: false,
        });
        break;

      case DuelOutcome.WIN_LOOSE:
        ball.registerTouch(tackler, engine.time);
        ball.kick(result.ballVelocity, 0, {
          kicker: tackler, flight: BallFlight.NONE, time: engine.time,
        });
        ball.carrier = null;
        engine.eventBus.emit('tackle', {
          winner: tackler, loser: carrier, loose: true,
        });
        break;

      case DuelOutcome.FOUL:
        // 규칙 판정은 RulesEngine이 한다. 여기서는 사건만 알린다.
        engine.eventBus.emit('foulCommitted', {
          offender: tackler,
          victim: carrier,
          position: carrier.position.clone(),
          team: tackler.team,
        });
        break;

      case DuelOutcome.FAIL:
      default:
        // 제쳐짐 — 잠시 따라붙지 못한다
        tackler.beatenTimer = BEATEN_DURATION;
        engine.eventBus.emit('tackleFailed', {
          tackler, carrier,
        });
        break;
    }
  }
}
