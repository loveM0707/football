import { Vector2D } from '../../entities/Vector2D.js';
import { clamp01 } from '../core/Coords.js';
import { PossessionPhase } from '../entities/Team.js';
import { BallFlight } from '../entities/Ball.js';
import {
  resolveFirstTouch, TouchResult, CONTROL_RADIUS, CONTROL_MAX_HEIGHT,
} from './FirstTouch.js';

/**
 * 소유 상태 (Section 12).
 *
 * "ball.owner가 있느냐"만으로 소유를 판정하면, 패스가 발을 떠나는 순간
 * 소유자가 사라져 팀이 즉시 수비 모드로 전환된다. 정상적인 패스 한 번마다
 * 팀 전체가 공격↔수비를 뒤집는 것이 구 엔진의 큰 결함이었다.
 *
 * 그래서 "볼이 누구 발에 있는가"와 "어느 팀이 소유 국면인가"를 분리한다.
 */
export const PossessionState = {
  NONE: 'NONE',                     // 인플레이 아님
  DEFINITE: 'DEFINITE',             // 한 선수가 확실히 소유
  CONTESTED: 'CONTESTED',           // 양 팀 선수가 볼을 두고 경합
  LOOSE: 'LOOSE',                   // 아무도 통제하지 못하는 볼
  PASS_IN_FLIGHT: 'PASS_IN_FLIGHT', // 패스 비행 중 — 소유팀은 여전히 공격 국면
  SHOT_IN_FLIGHT: 'SHOT_IN_FLIGHT', // 슛 비행 중
};

/** 이 거리 안에 상대가 있으면 경합으로 본다 (m) */
const CONTEST_RADIUS = 2.2;

/** 압박 계산 반경 (m) */
const PRESSURE_RADIUS = 9;

/**
 * 캐리어가 볼에 대한 지배력을 유지할 수 있는 최대 거리 (m).
 *
 * 볼이 발에 붙어 있지 않으므로(터치 사이클), 드리블 중에는 볼이
 * 몇 미터 앞서 굴러가는 것이 정상이다. "발밑에 없으면 소유 상실"로
 * 판정하면 드리블 자체가 불가능해진다.
 */
const CARRY_CONTROL_DISTANCE = 5.0;

/**
 * 상대가 캐리어보다 이만큼 더 볼에 가까우면 지배력을 잃는다 (m).
 * 밀어놓은 볼에 상대가 먼저 접근하면 더 이상 내 볼이 아니다.
 */
const CARRY_CONTEST_ADVANTAGE = 0.6;

/**
 * 터치 직후 재터치를 막는 시간 (초).
 * 이것이 없으면 한 스텝마다 터치 판정이 반복되어 볼이 진동한다.
 */
const TOUCH_COOLDOWN = 0.28;

/**
 * 소유 모델 — 소유 상태를 판정하는 유일한 주체.
 *
 * MatchEngine 파이프라인의 3단계. 팀 전술·판단 계층은 여기서 정해진
 * 소유 상태만 읽고, 각자 다시 판정하지 않는다.
 */
export class PossessionModel {
  constructor() {
    this.state = PossessionState.NONE;
    /** 현재 소유 국면의 주체 팀 (LOOSE면 null) */
    this.team = null;
    /** 볼을 발밑에 둔 선수 (없으면 null) */
    this.player = null;
    /** 마지막으로 확실히 소유했던 팀 — 루즈볼 중 전환 판정의 기준 */
    this.lastDefiniteTeam = null;
    /** 직전 스텝의 소유팀 — 전환 감지용 */
    this._previousTeam = null;
  }

  reset() {
    this.state = PossessionState.NONE;
    this.team = null;
    this.player = null;
    this.lastDefiniteTeam = null;
    this._previousTeam = null;
  }

  /**
   * @param {MatchEngine} engine
   * @param {number} dt
   */
  update(engine, dt) {
    const ball = engine.ball;

    // 터치 쿨다운 감소
    for (const p of engine.allPlayers) {
      if (p.touchCooldown > 0) p.touchCooldown = Math.max(0, p.touchCooldown - dt);
    }

    if (!engine.state.isBallInPlay) {
      this.state = PossessionState.NONE;
      this.team = null;
      this._syncCarrierFlags(engine);
      return;
    }

    // ── 1. 캐리어 지배력 확인 ──────────────────────────────
    if (ball.carrier) {
      const carrier = ball.carrier;
      const distance = carrier.position.sub(ball.position).length();

      // 너무 멀어지면 통제를 벗어난 것이다 (터치가 과했거나 볼만 굴러갔다)
      let lost = distance > CARRY_CONTROL_DISTANCE;

      // 상대가 볼에 더 가까우면 더 이상 내 볼이 아니다
      if (!lost) {
        const opponents = carrier.team.opponent?.players ?? [];
        for (const o of opponents) {
          const od = o.position.sub(ball.position).length();
          if (od < distance - CARRY_CONTEST_ADVANTAGE) { lost = true; break; }
        }
      }

      if (lost) ball.carrier = null;
    }

    // ── 2. 볼 통제 시도 (퍼스트 터치) ──────────────────────
    if (!ball.carrier) {
      this._attemptControl(engine, dt);
    }

    // ── 3. 소유 상태 판정 ──────────────────────────────────
    this._classify(engine);

    // ── 4. 팀 국면 갱신 ────────────────────────────────────
    this._updateTeamPhases(engine, dt);

    this._syncCarrierFlags(engine);
  }

  /**
   * 볼 근처 선수들의 통제 시도를 처리한다.
   *
   * 후보 순서는 거리순 → 동점이면 id순으로 정렬해 결정론을 보장한다.
   */
  _attemptControl(engine, dt) {
    const ball = engine.ball;

    // 발로 닿을 수 있는 높이가 아니면 아무도 통제할 수 없다
    if (ball.height > CONTROL_MAX_HEIGHT) return;

    const candidates = [];
    for (const player of engine.allPlayers) {
      if (player.touchCooldown > 0) continue;
      const distance = player.position.sub(ball.position).length();
      if (distance <= CONTROL_RADIUS) {
        candidates.push({ player, distance });
      }
    }
    if (candidates.length === 0) return;

    candidates.sort((a, b) =>
      a.distance - b.distance || (a.player.id < b.player.id ? -1 : 1)
    );

    const { player } = candidates[0];
    const pressure = this._pressureOn(player, engine);

    // 방금 이 선수가 찬 볼이면(패스 직후) 자기 볼을 다시 잡지 않는다
    if (ball.kicker === player && ball.flight !== BallFlight.NONE) {
      const sinceKick = engine.time - ball.flightStartTime;
      if (sinceKick < 0.35) return;
    }

    const touch = resolveFirstTouch({
      player,
      ball,
      pressure,
      rng: engine.rng.touch,
      intendedDirection: this._preferredTouchDirection(player, engine),
    });

    player.touchCooldown = TOUCH_COOLDOWN;
    ball.registerTouch(player, engine.time);
    ball.clearFlight();

    ball.velocity = touch.ballVelocity;
    ball.verticalVelocity = touch.ballVerticalVelocity;
    if (touch.ballVerticalVelocity === 0) ball.height = 0;

    // ⚠ 볼을 선수 위치로 옮기지 않는다.
    //   통제에 성공했다는 것은 "볼을 죽였다"는 뜻이지 발에 붙었다는 뜻이 아니다.
    //   볼은 멈춘 자리(선수 반경 1.15m 안)에 그대로 있고,
    //   이후 드리블 터치가 앞으로 밀어낸다.
    ball.carrier = touch.retained ? player : null;

    engine.eventBus.emit('firstTouch', {
      player,
      team: player.team,
      result: touch.result,
      quality: touch.quality,
      retained: touch.retained,
    });
  }

  /**
   * 터치로 볼을 놓고 싶은 방향.
   * 판단 계층이 목표를 정해뒀으면 그쪽, 아니면 공격 방향.
   */
  _preferredTouchDirection(player, engine) {
    const target = player.decision?.target;
    if (target) {
      const toTarget = target.sub(player.position);
      if (toTarget.length() > 0.5) return toTarget;
    }
    return new Vector2D(player.team.attackingDirection, 0);
  }

  /**
   * 근접 상대에 의한 압박 정도 0~1.
   * 가까울수록 급격히 커지도록 거리의 역수를 쓴다.
   */
  _pressureOn(player, engine) {
    const opponents = player.team.opponent?.players ?? [];
    let pressure = 0;
    for (const o of opponents) {
      const d = o.position.sub(player.position).length();
      if (d >= PRESSURE_RADIUS) continue;
      pressure += (1 - d / PRESSURE_RADIUS) ** 2;
    }
    return clamp01(pressure);
  }

  /** 현재 소유 상태를 분류한다 */
  _classify(engine) {
    const ball = engine.ball;

    // 발밑에 있으면 확실한 소유. 다만 상대가 밀착하면 경합으로 본다.
    if (ball.carrier) {
      this.player = ball.carrier;
      this.team = ball.carrier.team;
      this.lastDefiniteTeam = this.team;

      const opponents = ball.carrier.team.opponent?.players ?? [];
      const contested = opponents.some(
        (o) => o.position.sub(ball.position).length() <= CONTEST_RADIUS
      );
      this.state = contested ? PossessionState.CONTESTED : PossessionState.DEFINITE;
      return;
    }

    this.player = null;

    // 비행 중인 볼 — 찬 팀이 소유 국면을 유지한다.
    // 이것이 "패스할 때마다 수비로 전환"을 막는 핵심 규칙이다.
    if (ball.speed > 0.5 || ball.isAirborne) {
      const kickerTeam = ball.kicker?.team ?? null;

      if (ball.flight === BallFlight.SHOT) {
        this.state = PossessionState.SHOT_IN_FLIGHT;
        this.team = kickerTeam;
        return;
      }

      const isPass =
        ball.flight === BallFlight.PASS ||
        ball.flight === BallFlight.CROSS ||
        ball.flight === BallFlight.THROUGH ||
        ball.flight === BallFlight.THROW_IN ||
        ball.flight === BallFlight.GK_DISTRIBUTION;

      if (isPass && kickerTeam) {
        this.state = PossessionState.PASS_IN_FLIGHT;
        this.team = kickerTeam;
        return;
      }
    }

    // 그 외에는 루즈볼. 소유팀은 없지만 마지막 소유팀 정보는 유지한다.
    this.state = PossessionState.LOOSE;
    this.team = null;
  }

  /**
   * 팀 소유 국면을 갱신한다.
   *
   * 소유팀이 바뀐 순간에만 전환 국면을 부여하고,
   * 전환 국면의 만료는 Team.advancePhase가 처리한다.
   */
  _updateTeamPhases(engine, dt) {
    const current = this.team;

    // 루즈볼 동안에는 국면을 유지한다.
    // (볼이 잠깐 뜬 것만으로 팀 전체 행동이 뒤집히면 안 된다)
    if (current === null) {
      this._previousTeam = current;
      return;
    }

    if (this._previousTeam !== current) {
      const opponent = current.opponent;
      // 직전에 상대가 소유하고 있었다면 진짜 턴오버 — 양 팀 모두 전환
      if (this._previousTeam === opponent) {
        current.setPhase(PossessionPhase.TRANSITION_ATTACK);
        opponent.setPhase(PossessionPhase.TRANSITION_DEFENCE);
        engine.eventBus.emit('turnover', { winner: current, loser: opponent });
      } else {
        // 루즈볼에서 회수한 경우 — 이미 전환 중일 수 있으므로 유지
        if (!current.isAttacking) current.setPhase(PossessionPhase.TRANSITION_ATTACK);
        if (opponent && !opponent.isDefending) {
          opponent.setPhase(PossessionPhase.TRANSITION_DEFENCE);
        }
      }
      this._previousTeam = current;
    }

    // 점유 시간 적립 (점유율 표시용)
    current.possessionSeconds += dt;
  }

  /** 렌더러가 읽는 hasBall 플래그를 실제 캐리어와 동기화한다 */
  _syncCarrierFlags(engine) {
    const carrier = engine.ball.carrier;
    for (const p of engine.allPlayers) {
      p.hasBall = p === carrier;
    }
  }

  /** 결정론 검증용 요약 */
  snapshot() {
    return {
      state: this.state,
      team: this.team?.side ?? null,
      player: this.player?.id ?? null,
    };
  }
}
