import { Pitch } from '../../entities/Pitch.js';
import { teamNX } from '../core/Coords.js';
import { Role } from '../tactics/RoleModel.js';
import { BallFlight } from '../entities/Ball.js';

/**
 * 오프사이드 (Law 11).
 *
 * ⚠ 출처에 관한 고지
 *   이 환경에서는 IFAB 공식 문서에 접근할 수 없어(네트워크 정책상 차단),
 *   아래 구현은 널리 통용되는 표준 경기규칙에 근거한다.
 *   원문과 대조하지 못한 세부(레벨 판정의 정확한 신체 부위 기준,
 *   "명백한 플레이 방해"의 구체적 요건 등)는 단순화했음을 명시한다.
 *
 * ── 핵심 원칙 ────────────────────────────────────────────────
 * "오프사이드 위치에 있는 것" 자체는 반칙이 아니다.
 * 반칙은 그 선수가 플레이에 관여했을 때 비로소 성립한다.
 *
 * 그래서 두 단계로 나눈다:
 *   1) 볼을 찬 순간 — 누가 오프사이드 위치였는지 스냅샷을 남긴다
 *   2) 그 선수가 볼에 관여한 순간 — 반칙으로 판정한다
 *
 * 골킥·스로인·코너킥에서 직접 받은 경우는 오프사이드가 되지 않는다.
 */

/**
 * 오프사이드가 적용되지 않는 재개로부터의 직접 수신.
 * (Law 11: 골킥·스로인·코너킥에서 직접 볼을 받은 경우 예외)
 */
const EXEMPT_FLIGHTS = new Set([
  BallFlight.THROW_IN,
]);

/**
 * 한 선수가 지금 오프사이드 "위치"에 있는가.
 *
 * 조건 (모두 만족해야 한다):
 *   · 상대 진영에 있다
 *   · 볼보다 상대 골라인에 가깝다
 *   · 뒤에서 두 번째 상대 선수보다 상대 골라인에 가깝다
 *
 * 같은 선상(레벨)이면 오프사이드가 아니다.
 *
 * @param {Player} player 판정 대상 (공격 측)
 * @param {Ball} ball
 * @param {Team} opponentTeam
 * @param {number} [tolerance] 레벨 판정 허용 오차 (m)
 */
export function isInOffsidePosition(player, ball, opponentTeam, tolerance = 0.12) {
  if (player.role === Role.GK) return false;

  const dir = player.team.attackingDirection;
  const playerX = teamNX(player.position.x, dir) * Pitch.LENGTH;

  // 자기 진영에 있으면 오프사이드가 아니다
  if (playerX <= Pitch.LENGTH / 2 + tolerance) return false;

  // 볼보다 앞서 있어야 한다
  const ballX = teamNX(ball.position.x, dir) * Pitch.LENGTH;
  if (playerX <= ballX + tolerance) return false;

  // 뒤에서 두 번째 상대보다 앞서 있어야 한다
  const secondLast = secondLastOpponentX(opponentTeam, dir);
  if (secondLast === null) return false;
  return playerX > secondLast + tolerance;
}

/**
 * 뒤에서 두 번째 상대 선수의 위치 (공격 팀 상대 좌표 기준).
 * 보통 골키퍼가 최후방이므로 실질적으로는 최종 수비 라인이다.
 *
 * @param {Team} opponentTeam 수비하는 팀
 * @param {number} dir 공격 팀의 공격 방향
 * @returns {number|null}
 */
export function secondLastOpponentX(opponentTeam, dir) {
  const depths = opponentTeam.players
    .map((o) => teamNX(o.position.x, dir) * Pitch.LENGTH)
    // 공격 팀 기준으로 "골라인에 가까운" 순 = 값이 큰 순
    .sort((a, b) => b - a);
  if (depths.length < 2) return null;
  return depths[1];
}

/**
 * 볼이 차인 순간의 오프사이드 스냅샷을 만든다.
 *
 * @param {Player} kicker 볼을 찬 선수
 * @param {Ball} ball
 * @returns {{team:Team, kicker:Player, players:Set<Player>, exempt:boolean}}
 */
export function captureOffsideSnapshot(kicker, ball) {
  const team = kicker.team;
  const opponentTeam = team.opponent;
  const players = new Set();

  if (opponentTeam) {
    for (const mate of team.players) {
      if (mate === kicker) continue;
      if (isInOffsidePosition(mate, ball, opponentTeam)) {
        players.add(mate);
      }
    }
  }

  return {
    team,
    kicker,
    players,
    // 예외 재개에서 직접 받은 경우 오프사이드를 적용하지 않는다
    exempt: EXEMPT_FLIGHTS.has(ball.flight),
  };
}

/**
 * 볼에 관여한 선수가 오프사이드 반칙인지 판정한다.
 *
 * @param {object|null} snapshot captureOffsideSnapshot 결과
 * @param {Player} involvedPlayer 볼에 관여한 선수
 * @returns {boolean}
 */
export function isOffsideOffence(snapshot, involvedPlayer) {
  if (!snapshot) return false;
  if (snapshot.exempt) return false;
  // 찬 선수 자신은 대상이 아니다
  if (involvedPlayer === snapshot.kicker) return false;
  // 상대 팀 선수가 만졌으면 오프사이드가 아니다 (수비 측 관여)
  if (involvedPlayer.team !== snapshot.team) return false;
  return snapshot.players.has(involvedPlayer);
}

/**
 * 재개에서 오프사이드 예외인지 판단한다.
 * 골킥·코너킥·스로인은 직접 수신 시 오프사이드가 성립하지 않는다.
 *
 * @param {string} restartType
 */
export function isOffsideExemptRestart(restartType) {
  return restartType === 'GOAL_KICK' ||
         restartType === 'CORNER_KICK' ||
         restartType === 'THROW_IN';
}
