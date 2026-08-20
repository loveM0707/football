import { Vector2D } from '../../entities/Vector2D.js';
import { Pitch } from '../../entities/Pitch.js';
import { clamp, clamp01, smoothstep, teamNX, toTeamY, fromTeamSpace } from '../core/Coords.js';
import { Line } from './RoleModel.js';
import { lineSpacing } from './Formation.js';

/**
 * 팀 형태 계산.
 *
 * 포메이션의 절대 좌표를 쓰지 않는다. 매 틱 팀 상태(소유 국면·볼 위치·
 * 전술 지시)에서 라인 높이·팀 길이·팀 폭을 먼저 구하고, 각 선수의
 * 기대 위치(anchor)는 "자기 라인 + 자기 채널"의 상대 관계로 유도한다.
 *
 * ⚠ 계산은 전부 팀 상대 좌표에서 한다 (전진 = 항상 +x).
 *   마지막에 한 번만 월드 좌표로 변환한다. 이렇게 하면 홈/원정,
 *   전·후반 진영 교대에 관계없이 같은 전술 코드가 동작한다.
 *
 * ⚠ 팀당 한 번만 계산해 team.shape에 캐시한다.
 *   선수마다 따로 계산하면 같은 틱 안에서 서로 다른 팀 형태를 보게 되어
 *   모순된 위치로 흩어진다.
 */

/** 골키퍼를 제외한 라인이 가질 수 있는 팀 상대 nx 범위 */
const MIN_LINE_NX = 0.055;
const MAX_LINE_NX = 0.62;

/** 터치라인에서 최소한 띄우는 거리 (m) */
const SIDELINE_MARGIN = 2.5;

/**
 * 팀 형태를 계산한다.
 *
 * @param {Team} team
 * @param {Ball} ball
 * @param {object} [opts]
 * @param {boolean} [opts.ballLoose] 루즈볼 상황인가
 * @returns {object} 형태 정보 + 선수별 anchor
 */
export function computeTeamShape(team, ball, { ballLoose = false } = {}) {
  const dir = team.attackingDirection;
  const tactics = team.tactics;
  const attacking = team.isAttacking;

  // ── 볼 위치를 팀 상대 좌표로 ────────────────────────────
  const ballNX = clamp01(teamNX(ball.position.x, dir));
  const ballTeamY = toTeamY(ball.position.y, dir);

  // ── 1. 최후방 라인 높이 ─────────────────────────────────
  const backLineNX = computeBackLine(tactics, ballNX, attacking, ballLoose);

  // ── 2. 팀 길이 (최후방 ~ 최전방) ────────────────────────
  // 공격 시에는 길어지고 수비 시에는 압축된다
  let teamLength = tactics.targetTeamLength;
  if (attacking) teamLength *= 1.18;
  // 자기 골문 근처에서는 라인을 더 좁혀 공간을 준다
  teamLength *= 1 - smoothstep(0.30, 0.06, backLineNX) * 0.18;
  const lengthNX = teamLength / Pitch.LENGTH;

  // 최전방 라인이 상대 골라인을 넘지 않도록 제한
  const attackLineNX = Math.min(backLineNX + lengthNX, 0.96);
  const midFraction = lineSpacing(team.formationName, Line.MID);
  const midLineNX = backLineNX + (attackLineNX - backLineNX) * midFraction;

  // ── 3. 팀 폭 ────────────────────────────────────────────
  let teamWidth = tactics.targetTeamWidth;
  if (!attacking) {
    // 수비 시에는 중앙을 지키기 위해 폭을 좁힌다
    teamWidth *= 0.72 - tactics.compactness * 0.10;
  }
  teamWidth = clamp(teamWidth, 20, Pitch.WIDTH - SIDELINE_MARGIN * 2);
  const halfWidth = teamWidth / 2;

  // ── 4. 볼 사이드 이동량 ─────────────────────────────────
  // 수비할 때는 팀 전체가 볼 쪽으로 크게 미끄러지고,
  // 공격할 때는 폭을 유지해야 하므로 적게 움직인다.
  const slideFactor = attacking ? 0.14 : 0.34;
  const ballOffsetY = ballTeamY - Pitch.WIDTH / 2;

  // ── 5. 선수별 기대 위치 ─────────────────────────────────
  const anchors = new Map();
  for (const player of team.players) {
    const slot = player.slot;
    if (!slot) continue;

    if (slot.line === Line.GK) {
      anchors.set(player, goalkeeperAnchor(team, ball, backLineNX));
      continue;
    }

    // 라인 선택
    let lineNX;
    if (slot.line === Line.BACK) lineNX = backLineNX;
    else if (slot.line === Line.MID) lineNX = midLineNX;
    else lineNX = attackLineNX;

    // 팀 상대 x = 라인 위치 + 슬롯 고유 깊이 조정
    const teamX = clamp(
      lineNX * Pitch.LENGTH + slot.depth,
      2.5,
      Pitch.LENGTH - 2.5
    );

    // 팀 상대 y = 채널 위치 + 볼 사이드 이동
    // 약측(볼 반대쪽) 선수는 덜 따라간다 — 전원이 볼 쪽으로 몰리면
    // 반대편이 완전히 비어 스위치 한 번에 무너진다 (Section 11)
    const baseY = Pitch.WIDTH / 2 + slot.channel * halfWidth;
    const onBallSide = slot.channel * ballOffsetY > 0;
    const slideWeight = onBallSide ? 1.0 : 0.42;
    const teamY = clamp(
      baseY + ballOffsetY * slideFactor * slideWeight,
      SIDELINE_MARGIN,
      Pitch.WIDTH - SIDELINE_MARGIN
    );

    anchors.set(player, fromTeamSpace(new Vector2D(teamX, teamY), dir));
  }

  return {
    ballNX,
    ballTeamY,
    backLineNX,
    midLineNX,
    attackLineNX,
    teamLength,
    teamWidth,
    attacking,
    anchors,
    /** 월드 좌표 기준 최후방 라인 x — 오프사이드·수비 판단에 쓴다 */
    backLineX: fromTeamSpace(new Vector2D(backLineNX * Pitch.LENGTH, 0), dir).x,
  };
}

/**
 * 최후방 라인 높이 (팀 상대 nx).
 *
 * 볼이 앞에 있으면 라인을 올려 공간을 압축하고, 볼이 내려오면 함께 내려간다.
 * 다만 라인이 볼보다 앞설 수는 없다 — 수비는 볼과 골문 사이에 있어야 한다.
 */
function computeBackLine(tactics, ballNX, attacking, ballLoose) {
  let desired;

  if (attacking) {
    // 공격 중에는 볼을 따라 전진해 팀을 압축한다 (레스트 디펜스)
    desired = 0.20 + ballNX * 0.32 + tactics.mentalityScalar * 0.03;
  } else {
    // 수비 중에는 지시된 블록 높이를 기준으로 볼 위치에 반응한다
    desired = tactics.blockHeightNX + (ballNX - 0.5) * 0.30;
    // 라인은 볼보다 뒤에 있어야 한다
    desired = Math.min(desired, ballNX - 0.03);
  }

  // 루즈볼이면 아직 국면이 확정되지 않았으므로 중간값을 쓴다
  if (ballLoose) {
    const neutral = tactics.blockHeightNX + (ballNX - 0.5) * 0.22;
    desired = (desired + neutral) / 2;
  }

  return clamp(desired, MIN_LINE_NX, MAX_LINE_NX);
}

/**
 * 골키퍼 기대 위치.
 *
 * 볼이 멀면 골라인 근처, 볼이 다가오면 각을 좁히러 나오고,
 * 수비 라인이 높으면 스위퍼처럼 함께 올라온다.
 * 세부 판단(캐치·펀칭·1대1)은 GoalkeeperAI가 담당한다 (PHASE 12).
 */
function goalkeeperAnchor(team, ball, backLineNX) {
  const dir = team.attackingDirection;
  const goalX = dir === 1 ? 0 : Pitch.LENGTH;
  const ballNXValue = clamp01(teamNX(ball.position.x, dir));

  // 볼이 가까울수록(nx가 작을수록) 앞으로 나온다
  const approach = smoothstep(0.55, 0.10, ballNXValue); // 0 = 멀다, 1 = 코앞
  // 수비 라인이 높으면 스위퍼 범위를 넓힌다
  const sweeper = smoothstep(0.25, 0.55, backLineNX) * 6.5;
  const outDistance = 1.2 + approach * 4.5 + sweeper;

  const x = goalX + dir * outDistance;

  // 볼의 y 위치를 따라가되 골문 폭 근처로 제한한다
  const [goalTop, goalBottom] = Pitch.goalYRange();
  const centerY = Pitch.WIDTH / 2;
  const y = clamp(
    centerY + (ball.position.y - centerY) * 0.35,
    goalTop - 3.5,
    goalBottom + 3.5
  );

  return new Vector2D(x, y);
}
