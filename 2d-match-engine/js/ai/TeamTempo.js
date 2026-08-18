import { Pitch } from '../entities/Pitch.js';

/**
 * ═══════════════════════════════════════════════════════════════
 * 팀 템포(완급 조절) 상태 기계
 *
 * 실제 축구는 90분 내내 같은 속도로 진행되지 않는다. 볼을 되찾은 직후에는
 * 상대 대형이 무너져 있으므로 빠르게 밀어붙이고(TRANSITION), 자기 진영에서
 * 빌드업할 때는 천천히 볼을 돌리며 상대를 끌어낸다(BUILD_UP). 중원에서는
 * 탐색하고(PROBE), 파이널 서드에 들어가면 다시 가속한다(ATTACK).
 *
 * 이 모듈은 팀 단위로 국면(phase)과 긴급도(urgency, 0~1)를 산출한다.
 * urgency는 PlayerBrain에서 다음 항목에 곱해져 "완급"을 만든다.
 *   - 판단 주기(decisionCooldown): 낮을수록 길게 고민한다
 *   - 볼 보유 최소 시간(tMin) / 컨트롤 시간(controlTimer)
 *   - 패스 유틸리티 / 드리블 속도
 * ═══════════════════════════════════════════════════════════════
 */

export const TempoPhase = {
  TRANSITION: 'TRANSITION', // 볼 탈취 직후 — 상대 대형이 무너진 역습 창
  BUILD_UP: 'BUILD_UP',     // 자기 진영 빌드업 — 느리게 순환
  PROBE: 'PROBE',           // 중원 — 탐색, 중간 템포
  ATTACK: 'ATTACK',         // 파이널 서드 — 가속
  DEFEND: 'DEFEND',         // 비소유 — 수비 블록
};

/** 볼을 되찾은 뒤 역습 창이 열려 있는 시간(초) */
const TRANSITION_WINDOW = 3.5;

/** 국면별 목표 긴급도 */
const PHASE_URGENCY = {
  [TempoPhase.TRANSITION]: 0.95,
  [TempoPhase.BUILD_UP]: 0.24,
  [TempoPhase.PROBE]: 0.48,
  [TempoPhase.ATTACK]: 0.82,
  [TempoPhase.DEFEND]: 0.55,
};

function ensureState(team) {
  if (!team.tempo) {
    team.tempo = {
      phase: TempoPhase.PROBE,
      urgency: 0.5,
      possessionTimer: 0,
      transitionTimer: 0,
      hadPossession: false,
      // 팀마다 기질이 조금씩 달라 기계적으로 보이지 않게 한다 (0.88~1.12)
      bias: 0.88 + Math.random() * 0.24,
    };
  }
  return team.tempo;
}

/**
 * 상대 대형이 무너져 있는지 — 볼보다 뒤(자기 골문 쪽)에 남은 상대 수비수 수로 판정.
 * 역습 가치가 있는지(빠르게 밀어붙일지)의 근거가 된다.
 */
function opponentsBehindBall(team, opponentTeam, ball) {
  const attackDir = team.attackingDirection;
  let count = 0;
  for (const o of opponentTeam.players) {
    if (o.role === 'GK') continue;
    // 상대 골문 방향으로 볼보다 앞서 있는(=수비에 복귀한) 상대 수
    if ((o.position.x - ball.position.x) * attackDir > 0) count++;
  }
  return count;
}

/**
 * 매 틱 팀의 국면/긴급도를 갱신한다. MatchSimulator가 의사결정 루프 앞에서 호출한다.
 */
export function updateTeamTempo(team, opponentTeam, ball, dt) {
  const st = ensureState(team);

  const inPossession = ball.owner
    ? ball.owner.team === team
    : ball.lastTouchedTeam === team;

  // ── 소유 전환 감지: 볼을 되찾은 순간 역습 창을 연다 ──
  if (inPossession && !st.hadPossession) {
    st.possessionTimer = 0;
    // 상대가 앞으로 나와 있을수록(뒤에 남은 수비가 적을수록) 역습 가치가 크다
    const behind = opponentsBehindBall(team, opponentTeam, ball);
    st.transitionTimer = behind <= 5 ? TRANSITION_WINDOW : TRANSITION_WINDOW * 0.4;
  }
  st.hadPossession = inPossession;

  st.transitionTimer = Math.max(0, st.transitionTimer - dt);
  st.possessionTimer = inPossession ? st.possessionTimer + dt : 0;

  // ── 국면 판정 ────────────────────────────────────────────────
  const attackDir = team.attackingDirection;
  const goalX = attackDir === 1 ? Pitch.LENGTH : 0;
  const distToGoal = Math.abs(ball.position.x - goalX);

  let phase;
  if (!inPossession) {
    phase = TempoPhase.DEFEND;
  } else if (st.transitionTimer > 0) {
    phase = TempoPhase.TRANSITION;
  } else if (distToGoal < Pitch.LENGTH * 0.32) {
    phase = TempoPhase.ATTACK;
  } else if (distToGoal > Pitch.LENGTH * 0.66) {
    phase = TempoPhase.BUILD_UP;
  } else {
    phase = TempoPhase.PROBE;
  }
  st.phase = phase;

  // ── 긴급도: 목표값으로 서서히 수렴시켜 급변을 막는다 ─────────
  // 감독이 지시한 패스 템포(느림~빠름)를 배율로 반영한다 (0.72~1.28)
  const tempoMul = team.tactics?.tempoUrgencyMultiplier ?? 1.0;
  let targetUrgency = (PHASE_URGENCY[phase] ?? 0.5) * st.bias * tempoMul;

  // 오래 소유할수록 조금씩 조급해진다 (무한 볼돌리기 방지, 최대 +0.18)
  if (inPossession) {
    targetUrgency += Math.min(0.18, st.possessionTimer * 0.012);
  }

  // 지고 있고 후반이면 템포를 올린다 (경기 상황 반응)
  const opponentScore = opponentTeam.score ?? 0;
  if ((team.score ?? 0) < opponentScore) targetUrgency += 0.12;

  targetUrgency = Math.max(0.15, Math.min(1, targetUrgency));

  // 1차 지연(저역통과): 국면이 바뀌어도 템포가 순간이동하지 않는다
  const k = Math.min(1, dt * 1.6);
  st.urgency = st.urgency + (targetUrgency - st.urgency) * k;

  return st;
}

/** 안전 조회 — 아직 초기화되지 않았으면 중립값(0.5) */
export function teamUrgency(team) {
  return team?.tempo?.urgency ?? 0.5;
}

export function teamPhase(team) {
  return team?.tempo?.phase ?? TempoPhase.PROBE;
}
