import { Vector2D } from '../../entities/Vector2D.js';
import { Pitch } from '../../entities/Pitch.js';
import {
  clamp, teamNX, toTeamY, fromTeamSpace, ownPenaltyBox, opponentGoalLineX, inRect,
} from '../core/Coords.js';
import { Phase } from '../core/MatchState.js';
import { Role } from '../tactics/RoleModel.js';
import { BallFlight } from '../entities/Ball.js';
import { Action } from '../entities/Player.js';
import { solveGroundPass, solveLoftedPass } from '../ball/PassSolver.js';

/**
 * 재개 배치와 실행 (Law 8·13~17).
 *
 * ⚠ 출처 고지: IFAB 공식 문서에 접근할 수 없는 환경이므로
 *   널리 통용되는 표준 규칙에 근거해 구현했다. 거리 규정(9.15m 등)은
 *   표준값을 사용했고, 원문 대조가 필요한 세부는 단순화했다.
 *
 * ⚠ 재개 위치는 여기서만 만든다.
 *   "모두 포메이션 위치로 리셋"하지 않는다. 재개 종류마다
 *   키커·상대 거리·아군 배치·상대 형태를 따로 계산한다 (Section 38).
 */

/** 프리킥·코너킥에서 상대가 떨어져야 하는 거리 (m) */
const FREE_KICK_DISTANCE = 9.15;

/** 스로인에서 상대가 떨어져야 하는 거리 (m) */
const THROW_IN_DISTANCE = 2.0;

/** 재개 준비에 쓰는 최대 시간 (초) — 넘으면 그대로 진행한다 */
const SETUP_TIMEOUT = 4.0;

/** 키커가 볼에 이만큼 접근하면 찰 준비가 된 것으로 본다 (m) */
const KICKER_READY_DISTANCE = 1.0;

/** 이 비율의 선수가 제 위치에 오면 진행한다 */
const READY_FRACTION = 0.7;

export class RestartEngine {
  /**
   * @param {number} dt 고정 스텝
   */
  constructor(dt) {
    this.dt = dt;
  }

  /**
   * 재개를 설정한다 — 볼 위치, 키커, 모든 선수의 배치 목표를 정한다.
   *
   * @param {MatchEngine} engine
   * @param {object} restart { type, team, position, reason }
   */
  setup(engine, restart) {
    const ball = engine.ball;
    ball.placeAt(restart.position);
    ball.clearFlight();

    restart.kicker = this._pickKicker(engine, restart);
    restart.elapsed = 0;
    restart.executed = false;

    this._positionPlayers(engine, restart);
  }

  /**
   * 재개 준비 진행. 준비가 끝나면 볼을 인플레이로 만든다.
   *
   * @param {MatchEngine} engine
   * @param {number} dt
   * @returns {boolean} 실행했으면 true
   */
  update(engine, dt) {
    const restart = engine.state.restart;
    if (!restart || restart.executed) return false;

    restart.elapsed += dt;

    // 배치 목표를 계속 갱신한다 (선수들이 이동하는 동안 유지)
    this._positionPlayers(engine, restart);

    if (this._isReady(engine, restart) || restart.elapsed >= SETUP_TIMEOUT) {
      this._execute(engine, restart);
      return true;
    }
    return false;
  }

  // ──────────────────────────────────────────────────────────
  // 키커 선정
  // ──────────────────────────────────────────────────────────

  /** 재개 종류에 맞는 키커를 고른다 */
  _pickKicker(engine, restart) {
    const team = restart.team;
    const candidates = team.players.filter((p) => p.role !== Role.GK);

    switch (restart.type) {
      case 'GOAL_KICK':
        // 골킥은 골키퍼가 찬다
        return team.goalkeeper ?? candidates[0];

      case 'PENALTY': {
        // 마무리 능력이 가장 좋은 선수
        return candidates.reduce((best, p) =>
          p.attributes.finishing > best.attributes.finishing ? p : best
        );
      }

      case 'CORNER_KICK': {
        // 크로스가 좋은 측면 선수
        const wide = candidates.filter((p) => Math.abs(p.slot?.channel ?? 0) > 0.5);
        const pool = wide.length > 0 ? wide : candidates;
        return pool.reduce((best, p) =>
          p.attributes.crossing > best.attributes.crossing ? p : best
        );
      }

      default: {
        // 볼에서 가장 가까운 선수 (동점이면 id 순으로 결정론 보장)
        return candidates.reduce((best, p) => {
          const dp = p.position.sub(restart.position).length();
          const db = best.position.sub(restart.position).length();
          if (dp < db) return p;
          if (dp === db && p.id < best.id) return p;
          return best;
        });
      }
    }
  }

  // ──────────────────────────────────────────────────────────
  // 배치
  // ──────────────────────────────────────────────────────────

  /**
   * 모든 선수의 배치 목표(anchor)를 정한다.
   *
   * DecisionEngine은 인플레이가 아닐 때 anchor로 이동하므로,
   * 여기서 anchor만 바꾸면 배치가 자동으로 진행된다.
   */
  _positionPlayers(engine, restart) {
    const kickingTeam = restart.team;
    const defendingTeam = kickingTeam.opponent;
    const ballPos = restart.position;

    // 키커는 볼 옆에 선다
    if (restart.kicker) {
      const approach = this._kickerApproach(restart);
      restart.kicker.anchor = Pitch.clampInside(ballPos.add(approach), 0.3);
    }

    // 상대는 규정 거리를 지킨다
    const keepOut = this._keepOutDistance(restart.type);
    for (const player of defendingTeam.players) {
      player.anchor = this._legalDefensivePosition(engine, player, restart, keepOut);
    }

    // 같은 팀은 재개 종류에 맞게 배치한다
    for (const player of kickingTeam.players) {
      if (player === restart.kicker) continue;
      player.anchor = this._attackingRestartPosition(engine, player, restart);
    }
  }

  /** 키커가 볼에 접근하는 방향 */
  _kickerApproach(restart) {
    const dir = restart.team.attackingDirection;
    switch (restart.type) {
      case 'THROW_IN': {
        // 터치라인 바깥에서 던진다
        const outward = restart.position.y < Pitch.WIDTH / 2 ? -1 : 1;
        return new Vector2D(0, outward * 0.8);
      }
      case 'GOAL_KICK':
      case 'PENALTY':
        return new Vector2D(-dir * 1.2, 0);
      default:
        // 뒤에서 다가와 찬다
        return new Vector2D(-dir * 1.1, 0);
    }
  }

  /** 재개 종류별 상대 유지 거리 */
  _keepOutDistance(type) {
    if (type === 'THROW_IN') return THROW_IN_DISTANCE;
    if (type === 'KICKOFF') return Pitch.CENTER_CIRCLE_RADIUS;
    return FREE_KICK_DISTANCE;
  }

  /**
   * 수비 측 선수의 합법 위치.
   *
   * 규정 거리 안에 있으면 볼 반대 방향으로 밀어낸다.
   * 골킥은 페널티 지역 밖, 킥오프는 자기 진영으로 추가 제약이 붙는다.
   */
  _legalDefensivePosition(engine, player, restart, keepOut) {
    const dir = player.team.attackingDirection;
    // 기본은 팀 형태가 준 위치 (없으면 현재 위치)
    let target = player.anchor ?? player.position.clone();

    // 킥오프: 자기 진영에 있어야 한다
    if (restart.type === 'KICKOFF') {
      const nx = teamNX(target.x, dir);
      if (nx > 0.5) {
        target = fromTeamSpace(
          new Vector2D(Pitch.LENGTH * 0.46, toTeamY(target.y, dir)),
          dir
        );
      }
    }

    // 골킥: 상대는 페널티 지역 밖에 있어야 한다
    if (restart.type === 'GOAL_KICK') {
      const box = ownPenaltyBox(restart.team.attackingDirection);
      if (inRect(target, box)) {
        const outX = restart.team.attackingDirection === 1
          ? box.x + box.w + 1.5
          : box.x - 1.5;
        target = new Vector2D(outX, target.y);
      }
    }

    // 규정 거리 확보
    const toPlayer = target.sub(restart.position);
    const distance = toPlayer.length();
    if (distance < keepOut) {
      const away = distance > 0.1
        ? toPlayer.normalize()
        : new Vector2D(-restart.team.attackingDirection, 0);
      target = restart.position.add(away.scale(keepOut + 0.4));
    }

    return Pitch.clampInside(target, 0.5);
  }

  /**
   * 공격 측(키커 팀) 선수의 재개 위치.
   *
   * 재개 종류마다 의미 있는 배치가 다르다.
   * 코너킥이면 박스로 모이고, 골킥이면 받을 각도를 벌린다.
   */
  _attackingRestartPosition(engine, player, restart) {
    const dir = restart.team.attackingDirection;
    const base = player.anchor ?? player.position.clone();

    switch (restart.type) {
      case 'CORNER_KICK': {
        // 최전방·중앙 선수는 박스 안으로 쇄도한다
        const goalX = opponentGoalLineX(dir);
        const isTargetMan =
          player.role === Role.ST || player.role === Role.CB ||
          player.role === Role.AM || player.role === Role.WINGER;
        if (!isTargetMan) return Pitch.clampInside(base, 1.0);

        // 골문 앞 여러 지점에 흩어 세운다 (id 기반이라 결정론적)
        const spread = (player.number % 5) - 2; // -2 ~ +2
        return Pitch.clampInside(
          new Vector2D(
            goalX - dir * (Pitch.GOAL_BOX_LENGTH + 2 + Math.abs(spread) * 2.5),
            Pitch.WIDTH / 2 + spread * 3.2
          ),
          1.0
        );
      }

      case 'GOAL_KICK': {
        // 짧게 받을 수 있도록 박스 밖에서 폭을 넓힌다
        const box = ownPenaltyBox(dir);
        if (inRect(base, box)) {
          const outX = dir === 1 ? box.x + box.w + 2.5 : box.x - 2.5;
          return Pitch.clampInside(new Vector2D(outX, base.y), 1.0);
        }
        return Pitch.clampInside(base, 1.0);
      }

      case 'KICKOFF': {
        // 자기 진영에 있어야 한다
        const nx = teamNX(base.x, dir);
        if (nx > 0.5) {
          return fromTeamSpace(
            new Vector2D(Pitch.LENGTH * 0.46, toTeamY(base.y, dir)),
            dir
          );
        }
        return Pitch.clampInside(base, 1.0);
      }

      case 'PENALTY': {
        // 키커 외에는 페널티 지역 밖, 볼보다 뒤
        const box = ownPenaltyBox(restart.team.opponent.attackingDirection);
        const outX = dir === 1
          ? Math.min(base.x, restart.position.x - FREE_KICK_DISTANCE - 1)
          : Math.max(base.x, restart.position.x + FREE_KICK_DISTANCE + 1);
        return Pitch.clampInside(new Vector2D(outX, base.y), 1.0);
      }

      default:
        return Pitch.clampInside(base, 1.0);
    }
  }

  // ──────────────────────────────────────────────────────────
  // 준비 판정과 실행
  // ──────────────────────────────────────────────────────────

  /** 선수들이 충분히 자리를 잡았는가 */
  _isReady(engine, restart) {
    const kicker = restart.kicker;
    if (!kicker) return true;

    // 키커가 볼 옆에 와 있어야 한다
    if (kicker.position.sub(restart.position).length() > KICKER_READY_DISTANCE + 0.6) {
      return false;
    }

    // 상대가 규정 거리를 지키고 있어야 한다
    const keepOut = this._keepOutDistance(restart.type);
    for (const opponent of restart.team.opponent.players) {
      if (opponent.position.sub(restart.position).length() < keepOut - 0.8) {
        return false;
      }
    }

    // 나머지 선수 대부분이 자기 자리에 왔는가
    const all = engine.allPlayers;
    const settled = all.filter(
      (p) => p.anchor && p.position.sub(p.anchor).length() < 4.0
    ).length;
    return settled / all.length >= READY_FRACTION;
  }

  /**
   * 재개 실행 — 키커가 볼을 플레이한다.
   *
   * 볼 접촉이므로 실제로는 ActionSystem을 거치는 것이 원칙이지만,
   * 재개는 규칙이 정한 특수 상황이라 여기서 직접 실행하고
   * 그 사실을 명시한다.
   */
  _execute(engine, restart) {
    const kicker = restart.kicker;
    restart.executed = true;

    if (!kicker) {
      engine.setPhase(Phase.IN_PLAY, null);
      return;
    }

    const target = this._restartTarget(engine, restart, kicker);
    const flight = restart.type === 'THROW_IN'
      ? BallFlight.THROW_IN
      : restart.type === 'CORNER_KICK'
        ? BallFlight.CROSS
        : BallFlight.PASS;

    const solution = this._solveRestartKick(restart, kicker, target);
    if (solution) {
      engine.ball.kick(solution.velocity, solution.verticalVelocity, {
        kicker,
        flight,
        targetPos: target,
        time: engine.time,
      });
    }

    kicker.touchCooldown = 0.4;
    engine.eventBus.emit('restart', {
      type: restart.type,
      team: restart.team,
      kicker,
      position: restart.position.clone(),
    });

    engine.setPhase(Phase.IN_PLAY, null);
  }

  /** 재개 킥의 목표 지점 */
  _restartTarget(engine, restart, kicker) {
    const dir = restart.team.attackingDirection;

    if (restart.type === 'CORNER_KICK') {
      // 골문 앞 위험 지역으로 올린다
      const goalX = opponentGoalLineX(dir);
      return new Vector2D(goalX - dir * (Pitch.GOAL_BOX_LENGTH + 3), Pitch.WIDTH / 2);
    }

    if (restart.type === 'PENALTY') {
      const goalX = opponentGoalLineX(dir);
      const [top, bottom] = Pitch.goalYRange();
      // 구석을 노린다 (키커 번호로 좌우를 갈라 결정론 유지)
      const side = kicker.number % 2 === 0 ? 1 : -1;
      return new Vector2D(goalX, Pitch.WIDTH / 2 + side * (bottom - top) * 0.33);
    }

    // 그 외에는 가장 가까운 동료 중 앞쪽에 있는 선수.
    // ⚠ anchor(재개 배치 목표)를 기준으로 고른다. 현재 위치를 쓰면
    //   선수들이 아직 자리를 잡지 않았을 때 엉뚱한 곳에 있는 선수를
    //   골라 이상한 방향으로 공을 차게 된다.
    const mates = restart.team.players.filter((p) => p !== kicker);
    let best = null;
    let bestScore = -Infinity;
    for (const mate of mates) {
      const pos = mate.anchor ?? mate.position;
      const distance = pos.sub(restart.position).length();
      if (distance < 4 || distance > 40) continue;
      const progress = teamNX(pos.x, dir) - teamNX(restart.position.x, dir);
      const score = progress * 2 - distance / 60;
      if (score > bestScore) {
        bestScore = score;
        best = mate;
      }
    }

    if (best) return (best.anchor ?? best.position).clone();
    // 받을 사람이 없으면 전방으로 걷어낸다
    return Pitch.clampInside(
      restart.position.add(new Vector2D(dir * 25, 0)),
      2.0
    );
  }

  /** 재개 킥의 물리 해 — 일반 패스와 같은 솔버를 쓴다 */
  _solveRestartKick(restart, kicker, target) {
    const from = restart.position;
    const options = { dt: this.dt, arrivalSpeed: 5.5 };

    if (restart.type === 'CORNER_KICK') {
      return solveLoftedPass(from, target, {
        dt: this.dt, minApex: 4.0, preferredFlightTime: 1.6,
      }) ?? solveGroundPass(from, target, options);
    }

    if (restart.type === 'PENALTY') {
      // 페널티는 강하게 낮은 궤도로
      const solution = solveGroundPass(from, target, { dt: this.dt, arrivalSpeed: 18 });
      return solution;
    }

    if (restart.type === 'GOAL_KICK') {
      const distance = target.sub(from).length();
      if (distance > 30) {
        return solveLoftedPass(from, target, { dt: this.dt }) ??
               solveGroundPass(from, target, options);
      }
    }

    const ground = solveGroundPass(from, target, options);
    if (ground && ground.feasible) return ground;
    return solveLoftedPass(from, target, { dt: this.dt }) ?? ground;
  }
}
