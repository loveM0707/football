import { Vector2D } from '../entities/Vector2D.js';
import { Pitch } from '../entities/Pitch.js';

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ═══════════════════════════════════════════════════════════════
// 보로노이 근사 — 하프스페이스 빈 공간 탐색 (Grid Sampling)
//
// 공격 3분의 1 영역에서 미리 정의한 샘플 포인트(하프스페이스 핵심 좌표)를
// 평가해, 상대+아군 선수로부터 가장 멀리 떨어진(가장 비어 있는) 지점을 반환한다.
// 정식 보로노이 다이어그램 대신 O(n×k) 그리드 샘플링으로 성능을 확보한다.
// ═══════════════════════════════════════════════════════════════
const HALF_SPACE_COLS = 4;
const HALF_SPACE_ROWS = 4;

function findBestOpenSpace(player, team, opponentTeam, ball, attackDir) {
  const goalX = attackDir === 1 ? Pitch.LENGTH : 0;
  const thirdLine = attackDir === 1 ? Pitch.LENGTH * 0.55 : Pitch.LENGTH * 0.45;
  const xMin = attackDir === 1 ? thirdLine : 4;
  const xMax = attackDir === 1 ? Pitch.LENGTH - 6 : thirdLine;
  const yMin = 6;
  const yMax = Pitch.WIDTH - 6;

  const allPlayers = [...team.players, ...opponentTeam.players].filter(
    p => p !== player && p.role !== 'GK'
  );

  let bestPoint = null;
  let bestScore = -Infinity;
  const dx = (xMax - xMin) / HALF_SPACE_COLS;
  const dy = (yMax - yMin) / HALF_SPACE_ROWS;

  for (let i = 0; i <= HALF_SPACE_COLS; i++) {
    for (let j = 0; j <= HALF_SPACE_ROWS; j++) {
      const px = xMin + dx * i;
      const py = yMin + dy * j;
      const pt = new Vector2D(px, py);

      let minDistOpp = Infinity;
      let minDistTeam = Infinity;
      for (const p of allPlayers) {
        const d = p.position.sub(pt).length();
        if (p.team === opponentTeam) { if (d < minDistOpp) minDistOpp = d; }
        else { if (d < minDistTeam) minDistTeam = d; }
      }

      const distToGoal = Math.abs(px - goalX);
      const goalProximity = Math.max(0, 1 - distToGoal / 50);
      const distFromPlayer = pt.sub(player.position).length();
      const reachable = distFromPlayer < 30 ? 1 : 0;
      const distFromBall = pt.sub(ball.position).length();
      const notTooClose = distFromBall > 8 ? 1 : 0.4;

      const score = minDistOpp * 2.0 + minDistTeam * 0.6 + goalProximity * 8 + reachable * 3 + notTooClose * 2;
      if (score > bestScore) {
        bestScore = score;
        bestPoint = pt;
      }
    }
  }
  return bestPoint;
}

// ═══════════════════════════════════════════════════════════════
// Stage 1: 포지션별 행동 성향 가중치 (Role Weights)
// penetration: 전방 침투 우선도
// support    : 패스 길 확보 우선도
// safety     : 포메이션 유지 우선도
// width      : 측면 너비 확보 우선도
// ═══════════════════════════════════════════════════════════════
const ROLE_WEIGHTS = {
  GK: { penetration: 0.00, support: 0.00, safety: 1.00, width: 0.00 },
  CB: { penetration: 0.04, support: 0.20, safety: 0.95, width: 0.10 },
  LB: { penetration: 0.18, support: 0.38, safety: 0.65, width: 0.88 },
  RB: { penetration: 0.18, support: 0.38, safety: 0.65, width: 0.88 },
  CM: { penetration: 0.32, support: 0.90, safety: 0.40, width: 0.22 },
  LM: { penetration: 0.78, support: 0.55, safety: 0.12, width: 0.92 },
  RM: { penetration: 0.78, support: 0.55, safety: 0.12, width: 0.92 },
  ST: { penetration: 0.92, support: 0.42, safety: 0.08, width: 0.28 },
};

// ═══════════════════════════════════════════════════════════════
// Stage 2: Raycasting — 패스 길 차단 여부 + 이탈 오프셋 계산
//
// 공 소유자(ballCarrier) → 이 선수(player) 사이에 Ray를 그어
// 상대 수비수가 반경 2.1m 이내에 걸리면 차단(blocked=true).
// 이탈 벡터: Ray 수직 방향으로 수비수 반대쪽으로 3.5~5m 이동.
// ═══════════════════════════════════════════════════════════════
function checkPassLane(player, ballCarrier, opponents) {
  const from = ballCarrier.position;
  const to   = player.position;
  const ray  = to.sub(from);
  const len  = ray.length();
  if (len < 0.5) return { blocked: false };

  const dir = ray.normalize();

  for (const opp of opponents) {
    if (opp.role === 'GK') continue;
    const toOpp = opp.position.sub(from);
    const t     = clamp(toOpp.dot(dir), 0, len);
    const proj  = from.add(dir.scale(t));
    const perpDist = opp.position.sub(proj).length();

    if (perpDist < 2.1 && t > len * 0.1 && t < len * 0.9) {
      // 차단 수비수 발견 — Ray 수직 방향 이탈 벡터
      const perp   = new Vector2D(-dir.y, dir.x);
      const sign   = opp.position.sub(player.position).dot(perp) > 0 ? -1 : 1;
      return {
        blocked: true,
        escapeOffset: perp.scale(sign * (3.5 + Math.random() * 1.5)),
        blocker: opp,
      };
    }
  }
  return { blocked: false };
}

// ═══════════════════════════════════════════════════════════════
// Stage 3: 수비 뒷공간 침투 런 (Penetration Run)
//
// 조건:
//   - 공 소유자 주변 압박 < 2명
//   - 상대 최후방 수비수 뒤에 6m 이상 공간 존재
// 목표: 수비 라인 갭 Y좌표로, 최후방 수비수 뒤 8~14m 지점.
// ═══════════════════════════════════════════════════════════════
function tryPenetrationRun(player, opponentTeam, ballCarrier, attackDir) {
  // ① 공 소유자 압박 수준 확인 (근접 압박 2명 이상이면 침투 취소)
  const pressure = opponentTeam.players.filter(
    o => o.role !== 'GK' && o.position.sub(ballCarrier.position).length() < 4.5
  ).length;
  if (pressure >= 2) return null;

  // ② 공 소유자가 상대 골문 방향을 바라보고 있어야 침투 가능 (±90도 이내)
  const toGoalAngle = attackDir === 1 ? 0 : Math.PI;
  const facingAngle = ballCarrier.facingAngle ?? 0;
  const angleDiff = Math.abs(((facingAngle - toGoalAngle + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
  if (angleDiff > Math.PI * 0.5) return null;

  // ③ 압박 점수가 낮을 때만 침투 (볼 소유자 brainMemory에 저장된 최신 값 활용)
  //    단, 공이 상대 3분의 1에 있으면 파이널 서드 연결을 위해
  //    압박이 높아도 뒷공간 침투를 유지한다.
  const carrierPressureScore = ballCarrier.brainMemory?.pressureScore ?? 0;
  const goalX = attackDir === 1 ? Pitch.LENGTH : 0;
  const ballInAttThird = Math.abs(ballCarrier.position.x - goalX) < Pitch.LENGTH * 0.38;
  if (carrierPressureScore > (ballInAttThird ? 45 : 32)) return null;

  const oppOutfield = opponentTeam.players.filter(p => p.role !== 'GK');
  if (oppOutfield.length === 0) return null;

  // 상대 최후방 수비수의 X 좌표 (공격 방향에서 가장 전진한 수비수)
  const lastDefX = attackDir === 1
    ? Math.max(...oppOutfield.map(p => p.position.x))
    : Math.min(...oppOutfield.map(p => p.position.x));

  // 골대까지 충분한 공간이 있는지 확인
  const distToGoal = attackDir === 1 ? Pitch.LENGTH - lastDefX : lastDefX;
  if (distToGoal < 6) return null;

  // 수비 라인 근처 선수들의 Y 좌표에서 갭(빈 공간) 탐색
  const nearLine = oppOutfield
    .filter(p => {
      const dx = attackDir === 1 ? p.position.x - lastDefX : lastDefX - p.position.x;
      return dx >= 0 && dx < 14;
    })
    .sort((a, b) => a.position.y - b.position.y);

  const mem = player.brainMemory;
  if (!mem.penRunVariant || Math.random() < 0.008) mem.penRunVariant = Math.random();

  // 갭(빈 공간) 탐색: 가장 큰 갭 하나만 고르면 동시에 침투하는 여러 동료가
  // 전부 같은 지점을 목표로 삼아 경로가 교차·중첩된다. 상위 2개 갭 중
  // 각자의 현재 Y 위치와 더 가까운 쪽을 선택해 자연스럽게 서로 다른
  // 침투 경로로 분산시킨다.
  let gapY = Pitch.WIDTH * 0.5 + (mem.penRunVariant - 0.5) * 16;
  if (nearLine.length >= 2) {
    const gaps = [];
    for (let i = 0; i < nearLine.length - 1; i++) {
      gaps.push({
        size: nearLine[i + 1].position.y - nearLine[i].position.y,
        y: (nearLine[i].position.y + nearLine[i + 1].position.y) * 0.5,
      });
    }
    gaps.sort((a, b) => b.size - a.size);
    const topGaps = gaps.slice(0, 2);
    if (topGaps.length > 0) {
      gapY = topGaps.reduce((best, g) =>
        Math.abs(g.y - player.position.y) < Math.abs(best.y - player.position.y) ? g : best
      ).y;
    }
  }

  // 침투 목표: 최후방 수비수 뒤 8~14m, 갭 Y 좌표
  const depth = 8 + mem.penRunVariant * 6;
  const penX  = clamp(
    lastDefX + attackDir * depth,
    attackDir === 1 ? 22 : 4,
    attackDir === 1 ? Pitch.LENGTH - 4 : Pitch.LENGTH - 22
  );

  return {
    target: new Vector2D(penX, clamp(gapY, 4, Pitch.WIDTH - 4)),
    sprint: true,
  };
}

// ═══════════════════════════════════════════════════════════════
// Stage 4: 측면 너비 확보 (Width Creation)
//
// LM/LB → 위쪽 터치라인(Y가 작은 쪽)으로 당김
// RM/RB → 아래쪽 터치라인(Y가 큰 쪽)으로 당김
// ═══════════════════════════════════════════════════════════════
function applyWidthCreation(target, role, ball, team) {
  const isLeft  = role === 'LM' || role === 'LB';
  const isRight = role === 'RM' || role === 'RB';
  // 공격 너비 계수: 전술 설정에 따라 너비를 확장한다 (기본 1.0)
  const widthMul = team?.tactics?.widthMultiplier ?? 1.0;
  // 공이 측면에 있으면 같은 쪽 선수를 터치라인 극단으로 강제 배치
  const ballOnLeftFlank  = ball && ball.position.y < Pitch.WIDTH * 0.30;
  const ballOnRightFlank = ball && ball.position.y > Pitch.WIDTH * 0.70;

  if (isLeft) {
    const edgeY = (ballOnLeftFlank && role === 'LM')
      ? Pitch.WIDTH * 0.03 : Pitch.WIDTH * (0.10 - 0.03 * widthMul);
    const blend = ((ballOnLeftFlank && role === 'LB') ? 0.70 : 0.58) * clamp(widthMul, 0.7, 1.3);
    return new Vector2D(target.x, target.y * (1 - clamp(blend, 0, 1)) + edgeY * clamp(blend, 0, 1));
  }
  if (isRight) {
    const edgeY = (ballOnRightFlank && role === 'RM')
      ? Pitch.WIDTH * 0.97 : Pitch.WIDTH * (0.90 + 0.03 * widthMul);
    const blend = ((ballOnRightFlank && role === 'RB') ? 0.70 : 0.58) * clamp(widthMul, 0.7, 1.3);
    return new Vector2D(target.x, target.y * (1 - clamp(blend, 0, 1)) + edgeY * clamp(blend, 0, 1));
  }
  return target;
}

// ═══════════════════════════════════════════════════════════════
// Stage 4b: 박스 쇄도 (Box Crashing)
//
// 측면 선수가 상대 진영 깊숙이 공을 잡으면(크로스 타이밍),
// ST → 니어 포스트, 반대편 윙어 → 파 포스트, CM → 페널티 스팟으로
// 스프린트하여 크로스 수신 대형을 갖춘다.
// ═══════════════════════════════════════════════════════════════
function getBoxCrashTarget(player, ballCarrier, team, attackDir) {
  if (!ballCarrier) return null;
  const carrierRole = ballCarrier.role;
  const goalX = attackDir === 1 ? Pitch.LENGTH : 0;
  const goalHint = new Vector2D(goalX, Pitch.WIDTH / 2);
  const carrierDistGL = Math.abs(ballCarrier.position.x - goalX);
  const carrierOnFlank = ballCarrier.position.y < Pitch.WIDTH * 0.35 ||
                         ballCarrier.position.y > Pitch.WIDTH * 0.65;
  // 측면 돌파 플래그: 윙어가 터치라인을 타고 길게 드리블 중이면
  // 페널티박스 도달 전부터 크로스 대비 침투를 시작한다.
  const breakthrough = ballCarrier.brainMemory?.flankBreakthrough ?? false;

  // 이동 방향 판정: 돌파 중이거나, 측면을 따라 골 방향으로 진행 중이거나,
  // 크로스 존(페널티박스+10m)까지 도달한 경우 — 크로스 직전까지 박스 침투를 유지
  const movingToGoal = breakthrough ||
    ((ballCarrier.velocity?.x ?? 0) * attackDir > 0.3) ||
    carrierDistGL < Pitch.PENALTY_BOX_LENGTH + 10;

  // 측면 선수(LM/RM/LB/RB)뿐 아니라 박스 근처 깊은 중앙 보유자도 박스 쇄도를 유발한다 —
  // 파이널 서드에서 ST가 박스 안에 머물며 패스/슛 수신 대형을 갖추게 한다.
  // CM뿐 아니라 안쪽으로 꺾어 들어온 윙어(LM/RM)도 포함하고, 쇄도 시작 거리를
  // 넓혀(+8m → +14m) 컷백·스루패스 수신 대형을 일찍 갖춘다.
  const isFlankCarrier = carrierRole === 'LM' || carrierRole === 'RM' ||
                          carrierRole === 'LB' || carrierRole === 'RB';
  const isDeepCentral = (carrierRole === 'CM' || carrierRole === 'LM' || carrierRole === 'RM') &&
                        carrierDistGL < Pitch.PENALTY_BOX_LENGTH + 14;
  // 보유자가 상대 진영(골문 하프라인 이내)에서 골 방향으로 드리블 중이면
  // 전방 선수(ST/CM/반대편 윙어)는 드리블 계열·깊이와 무관하게 박스 쇄도 대형을
  // 갖춘다 — 스루패스·컷백 등 전방 침투 패스를 받을 준비를 한다.
  const carrierInAttHalf = carrierDistGL < Pitch.LENGTH * 0.5;
  const carrierDribblingFwd = movingToGoal && carrierInAttHalf;
  if (!isFlankCarrier && !isDeepCentral && !carrierDribblingFwd) return null;
  if (!movingToGoal) return null;
  // 순수 측면 돌파(크로스 준비)가 아니라 안쪽으로 꺾은 경우는 isDeepCentral이 이미
  // 흡수하므로, 터치라인을 타고 가는 윙어만 측면 조건을 추가로 확인한다.
  if (isFlankCarrier && !carrierOnFlank && !isDeepCentral) return null;

  // 크래시 존: 보유자가 상대 진영에서 드리블 중이면 상대 진영 어디서든 쇄도하고,
  // 돌파 중이면 페널티박스+30m(상대 진영 측면 진입 시점)부터, 일반 드리블이면
  // 페널티박스+16m부터 ST/CM이 박스로 쇄도한다. 중앙 보유자는 +18m부터 쇄도를
  // 시작해 박스 도달 타이밍을 앞당긴다.
  const zoneDist = carrierDribblingFwd
    ? Pitch.LENGTH
    : breakthrough
      ? Pitch.PENALTY_BOX_LENGTH + 30
      : isDeepCentral
        ? Pitch.PENALTY_BOX_LENGTH + 18
        : Pitch.PENALTY_BOX_LENGTH + 16;
  if (carrierDistGL > zoneDist) return null;

  const isCarrierTopSide = ballCarrier.position.y < Pitch.WIDTH / 2;
  const [topY, bottomY] = Pitch.goalYRange();
  const nearPostY = isCarrierTopSide ? topY - 1 : bottomY + 1;
  const farPostY  = isCarrierTopSide ? bottomY + 2 : topY - 2;

  // ── 레인 랭킹 분배 ───────────────────────────────────────────
  // 박스 쇄도 참가자(ST·LM·RM·CM)를 골문과 가까운 순서(동률은 역할 우선순위)로
  // 정렬한 뒤, 각자 "니어 포스트 → 파 포스트 → 페널티 스팟 → 박스 아크" 레인을
  // 배정한다. 투톱(4-4-2)이거나 윙어가 중앙으로 드리블해 공격수 수가 늘어도
  // 같은편끼리 한 지점에 겹치지 않고 박스 전역에 분산되어 패스 수신 옵션이 된다.
  const ROLE_CRASH_PRIORITY = { ST: 0, LM: 1, RM: 1, CM: 2 };
  const contenders = team.players.filter((p) =>
    p.role !== 'GK' && p !== ballCarrier &&
    (p.role === 'ST' || p.role === 'LM' || p.role === 'RM' || p.role === 'CM')
  );
  const order = contenders.slice().sort((a, b) => {
    const pa = ROLE_CRASH_PRIORITY[a.role] ?? 3;
    const pb = ROLE_CRASH_PRIORITY[b.role] ?? 3;
    if (pa !== pb) return pa - pb;
    return a.position.sub(goalHint).length() - b.position.sub(goalHint).length();
  });
  let idx = order.indexOf(player);
  if (idx < 0 || idx > 3) return null; // 4명까지만 박스 진입, 나머지는 밖에서 대기

  // ── 레인 고정 (Sticky Lane) ─────────────────────────────────
  // 위 정렬은 매 틱 "골문까지의 거리"로 순위를 다시 매기므로, 나란히 쇄도하는
  // 두 선수의 순위가 계속 뒤바뀐다. 그때마다 니어/파 포스트 목표가 서로
  // 맞바뀌어 두 선수가 상대의 목표를 향해 X자로 교차하며 겹쳐 버렸다.
  // 한 번 잡은 레인을 쇄도가 끝날 때까지 유지해 교차 자체를 없앤다.
  // 레인이 겹치면 정렬 순위가 앞선 선수에게 우선권을 준다.
  const mem = player.brainMemory;
  if ((mem.crashLaneTick ?? 0) > 0 && Number.isInteger(mem.crashLane)) {
    const conflict = order.some((p, i) =>
      p !== player && i < idx &&
      (p.brainMemory?.crashLaneTick ?? 0) > 0 &&
      p.brainMemory?.crashLane === mem.crashLane
    );
    if (!conflict) idx = mem.crashLane;
  }
  mem.crashLane = idx;
  mem.crashLaneTick = 1.2; // 초 단위, decidePlayerIntent에서 매 틱 감산

  const goalXForLane = goalX;
  if (idx === 0) {
    // 최전방 ST → 니어 포스트
    return new Vector2D(goalXForLane - attackDir * 3, nearPostY);
  }
  if (idx === 1) {
    // 두 번째 ST(또는 윙어) → 파 포스트
    return new Vector2D(goalXForLane - attackDir * 5, farPostY);
  }
  if (idx === 2) {
    // 세 번째 → 페널티 스팟 위쪽(또는 아래쪽) — 포스트 라인과 X·Y 모두 이격
    const spotY = isCarrierTopSide ? Pitch.WIDTH * 0.38 : Pitch.WIDTH * 0.62;
    return new Vector2D(
      goalXForLane - attackDir * Pitch.PENALTY_SPOT_DIST,
      spotY
    );
  }
  // 네 번째(뒤늦은 CM 등) → 박스 아크 반대편 — 포스트·스팟과 겹치지 않게 분산
  const arcY = isCarrierTopSide ? Pitch.WIDTH * 0.62 : Pitch.WIDTH * 0.38;
  return new Vector2D(
    goalXForLane - attackDir * (Pitch.PENALTY_BOX_LENGTH - 4),
    arcY
  );
}

// ═══════════════════════════════════════════════════════════════
// 풀백/윙백 오버래핑 (Overlap Run)
//
// 같은 측면의 동료(윙어·중앙 미드필더)가 상대 진영에서 볼을 잡으면 그 측면의
// 풀백이 볼 소유자를 "바깥으로 추월"해 터치라인을 타고 올라간다. 수비수는
// 안쪽 윙어와 바깥 풀백 중 하나를 선택해야 하므로 2대1 상황이 만들어진다.
//
// 조건:
//   - 풀백(LB/RB)이 자기 쪽 측면에 있고
//   - 같은 측면 동료가 볼을 소유한 채 하프라인을 넘었으며
//   - 풀백이 아직 소유자보다 뒤에 있고(추월할 여지가 있음)
//   - 뒤에 최소한의 잔류 수비(CB 2명)가 남아 있다
// ═══════════════════════════════════════════════════════════════
function tryOverlapRun(player, team, ballCarrier, attackDir) {
  const role = player.role;
  if (role !== 'LB' && role !== 'RB') return null;
  if (!ballCarrier || ballCarrier === player || ballCarrier.team !== team) return null;

  const isLeft = role === 'LB';
  const flankY = isLeft ? Pitch.WIDTH * 0.08 : Pitch.WIDTH * 0.92;

  // 같은 측면에서 볼이 진행 중인가
  // 같은 측면 판정 완화(0.42/0.58 → 0.50): 중앙 미드필더가 반대편 하프스페이스
  // 에서 볼을 잡아도 그 쪽 풀백이 올라갈 수 있게 한다.
  const carrierOnMySide = isLeft
    ? ballCarrier.position.y < Pitch.WIDTH * 0.50
    : ballCarrier.position.y > Pitch.WIDTH * 0.50;
  if (!carrierOnMySide) return null;

  // 소유자가 자기 진영 3분의 1만 벗어나면 오버래핑을 시작한다.
  // (기존 하프라인 기준 0.44는 너무 늦어 풀백이 사실상 올라가지 못했다)
  const carrierAdvance = attackDir === 1
    ? ballCarrier.position.x - Pitch.LENGTH * 0.32
    : Pitch.LENGTH * 0.68 - ballCarrier.position.x;
  if (carrierAdvance < 0) return null;

  // 소유자보다 크게 앞서 있지만 않으면 추월 런을 이어간다 (-4 → -12로 완화:
  // 한 번 올라간 풀백이 곧바로 오버래핑을 취소하고 되돌아가지 않게 한다)
  const behindBy = (ballCarrier.position.x - player.position.x) * attackDir;
  if (behindBy < -12) return null;

  // 잔류 수비(rest defense): 뒤에 CB가 최소 1명 + 반대편 풀백/CM 커버가 있으면
  // 올라간다. CB 2명을 모두 요구하면 빌드업 중에는 조건이 거의 성립하지 않았다.
  const restDefenders = team.players.filter((p) =>
    (p.role === 'CB' || p.role === 'CM') &&
    (p.position.x - ballCarrier.position.x) * attackDir < 0
  ).length;
  if (restDefenders < 2) return null;

  // 양쪽 풀백이 동시에 올라가지 않게 한다 — 반대편이 이미 오버래핑 중이면 대기
  const otherBack = team.players.find((p) =>
    p !== player && (p.role === 'LB' || p.role === 'RB') &&
    p.brainMemory?.offBallBehavior === 'OVERLAPPING'
  );
  if (otherBack && !carrierOnMySide) return null;

  // 소유자를 8~14m 추월한 터치라인 지점
  const aheadX = ballCarrier.position.x + attackDir * (8 + Math.random() * 6);
  const goalLineX = attackDir === 1 ? Pitch.LENGTH : 0;
  // 골라인까지 몰고 가지 않도록 6m 여유를 둔다
  const cappedX = attackDir === 1
    ? Math.min(aheadX, goalLineX - 6)
    : Math.max(aheadX, goalLineX + 6);

  return new Vector2D(cappedX, flankY);
}

// ═══════════════════════════════════════════════════════════════
// 잔류 수비 커버 (Rest Defense / Covering Back)
//
// 풀백이 오버래핑으로 전진하면 그 측면 뒤가 비어 역습에 노출된다.
// 가장 가까운 중앙 미드필더 1명이 비워진 풀백 구역으로 내려와 균형을 잡는다
// (이른바 "3+2 잔류 수비"). 미드필더의 유기적 수비 가담.
// ═══════════════════════════════════════════════════════════════
function tryCoverBack(player, team, attackDir) {
  if (player.role !== 'CM') return null;

  // 이번(또는 직전) 틱에 오버래핑 중인 풀백 찾기
  const overlappers = team.players.filter((p) =>
    (p.role === 'LB' || p.role === 'RB') &&
    p.brainMemory?.offBallBehavior === 'OVERLAPPING'
  );
  if (overlappers.length === 0) return null;

  // 여러 명이 올라갔으면 가장 깊이 전진한 쪽을 먼저 커버한다
  const target = overlappers.reduce((a, b) =>
    (b.position.x - a.position.x) * attackDir > 0 ? b : a
  );

  // 커버 담당은 그 자리에 가장 가까운 CM 1명
  const mids = team.players
    .filter((p) => p.role === 'CM')
    .sort((a, b) =>
      a.position.sub(target.basePosition ?? target.position).length() -
      b.position.sub(target.basePosition ?? target.position).length()
    );
  if (mids[0] !== player) return null;

  const vacated = target.basePosition ?? target.position;
  // 비워진 풀백 자리보다 살짝 안쪽/뒤에 서서 하프스페이스를 함께 막는다
  const coverY = vacated.y + (vacated.y < Pitch.WIDTH / 2 ? 5 : -5);
  return new Vector2D(vacated.x - attackDir * 2, clamp(coverY, 5, Pitch.WIDTH - 5));
}

// ═══════════════════════════════════════════════════════════════
// Stage 5: 오프사이드 방지 (Offside Trap Avoidance)
//
// 공이 소유자 발에 있는 동안(아직 패스 전) X 좌표를 클램프.
// 상대 최후방 수비수보다 0.35m 뒤에 머문다.
// ═══════════════════════════════════════════════════════════════
function applyOffsideClamping(target, opponentTeam, attackDir) {
  const oppOutfield = opponentTeam.players.filter(p => p.role !== 'GK');
  if (oppOutfield.length === 0) return target;

  if (attackDir === 1) {
    const lastDefX = Math.max(...oppOutfield.map(p => p.position.x));
    return new Vector2D(Math.min(target.x, lastDefX - 0.35), target.y);
  } else {
    const lastDefX = Math.min(...oppOutfield.map(p => p.position.x));
    return new Vector2D(Math.max(target.x, lastDefX + 0.35), target.y);
  }
}

// ═══════════════════════════════════════════════════════════════
// 메인 함수: 6단계 오프 더 볼 공격 포지셔닝
//
// baseTarget: FormationPositioning 5단계 파이프라인 결과
// 반환값: 정제된 목표 좌표 (Vector2D)
// 부수효과: player.brainMemory에 offBallBehavior, offBallSprint 저장
// ═══════════════════════════════════════════════════════════════
export function computeOffBallAttack({ player, team, opponentTeam, ball, baseTarget }) {
  const role        = player.role;
  const mem         = player.brainMemory;
  const attackDir   = team.attackingDirection;
  const ballCarrier = ball.owner;

  if (role === 'GK') {
    mem.offBallBehavior = null;
    mem.offBallSprint   = false;
    return baseTarget.clone();
  }

  const w = ROLE_WEIGHTS[role] ?? { penetration: 0.3, support: 0.5, safety: 0.5, width: 0.3 };
  let target   = baseTarget.clone();
  let sprint   = false;
  let behavior = null;

  // ── Stage 2: 패스 길 레이캐스팅 ─────────────────────────────
  if (ballCarrier?.team === team && opponentTeam && w.support >= 0.4) {
    const lane = checkPassLane(player, ballCarrier, opponentTeam.players);
    if (lane.blocked) {
      target   = target.add(lane.escapeOffset);
      behavior = 'SEEKING_SUPPORT';
    }
  }

  // ── Stage 2a-1: 풀백 오버래핑 (측면 2대1 만들기) ────────────
  // 같은 측면 동료가 상대 진영에서 볼을 잡으면 풀백이 바깥으로 추월해 올라간다.
  if (ballCarrier?.team === team && opponentTeam) {
    const overlap = tryOverlapRun(player, team, ballCarrier, attackDir);
    if (overlap) {
      target = overlap;
      sprint = true;
      behavior = 'OVERLAPPING';
    }
  }

  // ── Stage 2a-2: 잔류 수비 커버 (미드필더의 수비 균형 유지) ──
  // 풀백이 올라가면 CM 한 명이 그 자리를 메워 역습 노출을 막는다.
  if (!behavior && ballCarrier?.team === team) {
    const cover = tryCoverBack(player, team, attackDir);
    if (cover) {
      target = cover;
      sprint = false;
      behavior = 'COVERING_BACK';
    }
  }

  // ── Stage 2b: 박스 쇄도 (크로스 대비 침투) — 최우선 ────────
  // 측면 선수가 상대 진영 깊은 측면에서 공을 진행(돌파/크로스 직전)하면,
  // ST→니어 포스트, 반대편 윙어→파 포스트, CM→페널티 스팟으로 스프린트한다.
  // 침투 런보다 먼저 평가해, 크로스 시점에 동료가 박스 안에 있게 한다.
  // 오버래핑·잔류 수비 커버는 박스 쇄도보다 우선한다(포지션 균형 유지)
  if (ballCarrier?.team === team && opponentTeam &&
      behavior !== 'OVERLAPPING' && behavior !== 'COVERING_BACK') {
    const crashTarget = getBoxCrashTarget(player, ballCarrier, team, attackDir);
    if (crashTarget) {
      target   = crashTarget;
      sprint   = true;
      behavior = 'BOX_CRASHING';
    }
  }

  // ── Stage 2c: 전방 드리블 연계 서포트·침투 팬 (OPP_RUN) ─────
  // 공 보유 동료가 상대 최전방(박스 근처)에서 드리블 중이면 근처 동료를
  // 드리블러 주변 "레인(채널)"으로 펼쳐 서포트·침투시킨다. 과거에는 모든
  // 동료를 단일 지점으로 보내 겹침이 발생했으므로, 거리 순 랭크로 좌우
  // 측면·중앙·깊은 측면 레인에 각각 배분해 실제 축구처럼 간격을 유지한다.
  // 가까운 2명은 측면 서포트(크루즈), 나머지는 전방·측면으로 스프린트 침투.
  if (!behavior && ballCarrier?.hasBall && ballCarrier.team === team && opponentTeam && role !== 'GK' && role !== 'CB') {
    const frontGoalX = attackDir === 1 ? Pitch.LENGTH : 0;
    const carrierFrontDist = Math.abs(ballCarrier.position.x - frontGoalX);
    // 최전방 드리블: 보유자가 파이널 서드 ~ 박스 근처에서 공을 진행
    if (carrierFrontDist < 30) {
      const qualifiers = team.players
        .filter(p => p !== ballCarrier && p.role !== 'GK' && p.role !== 'CB' &&
                     p.position.sub(ballCarrier.position).length() < 24)
        .sort((a, b) =>
          a.position.sub(ballCarrier.position).length() -
          b.position.sub(ballCarrier.position).length()
        )
        .slice(0, 5);
      let idx = qualifiers.indexOf(player);
      // ── 레인 고정 (Sticky Lane) ────────────────────────────────
      // qualifiers는 매 틱 "볼 소유자까지의 거리"로 다시 정렬되므로, 두 선수가
      // 나란히 뛰면 순위가 계속 뒤바뀌어 LANE_Y(좌/우) 배정이 서로 맞바뀌고
      // 그 결과 두 선수의 침투 경로가 X자로 교차해 버렸다. 박스 쇄도(crashLane)와
      // 동일한 방식으로 한 번 잡은 레인을 유지해 교차를 없앤다.
      if (idx >= 0 && (mem.oppRunLaneTick ?? 0) > 0 && Number.isInteger(mem.oppRunLane)) {
        const conflict = qualifiers.some((p, i) =>
          p !== player && i < idx &&
          (p.brainMemory?.oppRunLaneTick ?? 0) > 0 &&
          p.brainMemory?.oppRunLane === mem.oppRunLane
        );
        if (!conflict) idx = mem.oppRunLane;
      }
      if (idx >= 0) {
        mem.oppRunLane = idx;
        mem.oppRunLaneTick = 1.0;
        // 레인 배분: [왼쪽 측면, 오른쪽 측면, 중앙, 깊은 왼쪽, 깊은 오른쪽]
        // Y 간격 확대: 6→12, 10→18로 전방 동료 간 겹침 방지
        const LANE_Y = [-12, 12, 0, -18, 18];
        const LANE_DIST = [8, 8, 13, 12, 12];
        const dist  = LANE_DIST[idx] ?? 12;
        const laneY = LANE_Y[idx] ?? 0;
        const supportPt = new Vector2D(
          ballCarrier.position.x + attackDir * dist,
          clamp(ballCarrier.position.y + laneY, 5, Pitch.WIDTH - 5)
        );
        target   = new Vector2D(clamp(supportPt.x, 14, Pitch.LENGTH - 14), supportPt.y);
        sprint   = idx >= 2; // 근접 서포트는 크루즈, 전방 침투는 스프린트
        behavior = 'OPP_RUN';
      }
    }
  }

  // ── Stage 3: 침투 런 ────────────────────────────────────────
  // (박스 쇄도가 아래 Stage 3b에서 먼저 처리됨 — 측면 돌파 중에는
  //  침투 런보다 크로스 대비 박스 진입을 우선한다.)
  if (w.penetration >= 0.7 && ballCarrier?.team === team && opponentTeam) {
    // 고침투 역할(ST, LM, RM): 항상 침투 런 시도
    const pen = tryPenetrationRun(player, opponentTeam, ballCarrier, attackDir);
    if (pen) {
      target   = pen.target;
      sprint   = pen.sprint;
      behavior = 'PENETRATING';
    }
  } else if (w.penetration >= 0.25 && !behavior && ballCarrier?.team === team && opponentTeam) {
    // 중간 역할(CM, LB, RB): 확률적으로 제한적 침투
    const pen = tryPenetrationRun(player, opponentTeam, ballCarrier, attackDir);
    if (pen && Math.random() < w.penetration * 0.55) {
      target   = Vector2D.lerp(target, pen.target, 0.38);
      behavior = 'SUPPORTING';
    }
  }

  // ── 파이널 서드 체크인 (Check-in): 최전방 공격수가 밀착 마크를 받으면
  //    볼 쪽으로 짧게 내려와 숏패스 옵션이 되고 수비수를 끌어내 박스 공간을 연다.
  //    박스 안에서는 쇄도를 유지하기 위해 적용하지 않는다.
  if (!behavior && ballCarrier?.team === team && opponentTeam && w.penetration >= 0.25) {
    const goalX = attackDir === 1 ? Pitch.LENGTH : 0;
    const distToGoal = Math.abs(player.position.x - goalX);
    const ballInFinalThird = Math.abs(ballCarrier.position.x - goalX) < Pitch.PENALTY_BOX_LENGTH + 20;
    if (ballInFinalThird && distToGoal > Pitch.PENALTY_BOX_LENGTH - 4) {
      const nearestOppDist = opponentTeam.players.reduce(
        (m, o) => (o.role === 'GK' ? m : Math.min(m, o.position.sub(player.position).length())),
        Infinity
      );
      if (nearestOppDist < 5) {
        const distToCarrier = player.position.sub(ballCarrier.position).length();
        if (distToCarrier < 22 && distToCarrier > 6) {
          const dir = ballCarrier.position.sub(player.position).normalize();
          const checkPt = player.position.add(dir.scale(7));
          target   = Vector2D.lerp(target, checkPt, 0.55);
          sprint   = false;
          behavior = 'SUPPORTING';
        }
      }
    }
  }

  // ── 패스 수신자 서포트 (2, 3단계 미해당 시) ─────────────────
  if (!behavior && ball.passTargetPlayer?.team === team && player !== ball.passTargetPlayer) {
    const recv = ball.passTargetPlayer;
    const d    = player.position.sub(recv.position).length();
    if (d < 20 && d > 2.5) {
      const ang  = recv.position.sub(player.position).angle() + (Math.random() - 0.5) * 0.8;
      const supp = recv.position.add(Vector2D.fromAngle(ang).scale(4 + Math.random() * 2));
      target   = Vector2D.lerp(target, supp, 0.3);
      behavior = 'SUPPORTING';
    }
  }

  // ── Overlap Run: ST가 오래 볼을 잡고 있으면 미드필더·측면 선수 오버래핑 ────
  // ST가 패스/슈팅 없이 오래 소유(2초 이상) + 압박을 받고 있으면,
  // 가까운 CM·LM·RM·LB·RB 2명이 ST를 지나쳐(오버래핑) 전방·측면으로 뛰어
  // 패스 수신 루트를 만들어 준다.
  if (!behavior && ballCarrier?.team === team && ballCarrier.role === 'ST' && opponentTeam) {
    const carrierHold = ballCarrier.brainMemory?.possessionTimer ?? 0;
    const carrierPressure = ballCarrier.brainMemory?.pressureScore ?? 0;
    if (carrierHold > 2.0 && carrierPressure > 15) {
      const OVERLAP_ROLES = ['CM', 'LM', 'RM', 'LB', 'RB'];
      if (OVERLAP_ROLES.includes(role)) {
        const ranked = team.players
          .filter(p => p !== ballCarrier && OVERLAP_ROLES.includes(p.role))
          .sort((a, b) =>
            a.position.sub(ballCarrier.position).length() -
            b.position.sub(ballCarrier.position).length()
          );
        const idx = ranked.indexOf(player);
        if (idx >= 0 && idx < 2) {
          // ST보다 전방 9~12m, 자신의 측면(CM은 베이스 기준 좌우로 이격) 지점
          const aheadX = ballCarrier.position.x + attackDir * (9 + idx * 3);
          let flankY;
          if (role === 'LM' || role === 'LB') flankY = Pitch.WIDTH * 0.12;
          else if (role === 'RM' || role === 'RB') flankY = Pitch.WIDTH * 0.88;
          else {
            const baseY = player.basePosition ? player.basePosition.y : Pitch.WIDTH / 2;
            flankY = baseY + (idx === 0 ? -1 : 1) * 9;
          }
          target   = new Vector2D(aheadX, clamp(flankY, 5, Pitch.WIDTH - 5));
          sprint   = true;
          behavior = 'OVERLAPPING';
        }
      }
    }
  }

  // ── Ball Attraction: 공 소유자 고립/빌드업 시 미드필더 2명 접근 ────
  // 수비수(CB/LB/RB)가 공을 빼앗았으면(빌드업) 미드필더가 가까이 와서
  // 패스를 받을 준비를 한다. 그 외에는 고립 상태(nearCount <= 1)일 때만 접근.
  if (!behavior && ballCarrier?.team === team && opponentTeam) {
    const ISOLATION_R = 12;
    const nearCount = team.players.filter(
      p => p !== ballCarrier && p.role !== 'GK' &&
           p.position.sub(ballCarrier.position).length() < ISOLATION_R
    ).length;

    const ATTRACTOR_ROLES = ['CM', 'LM', 'RM', 'LB', 'RB'];
    const carrierIsDefender = ballCarrier.role === 'CB' || ballCarrier.role === 'LB' || ballCarrier.role === 'RB';
    const MAX_NEAR = carrierIsDefender ? 3 : 1;
    if (nearCount <= MAX_NEAR && ATTRACTOR_ROLES.includes(role)) {
      const distToCarrier = player.position.sub(ballCarrier.position).length();
      if (distToCarrier > 10 && distToCarrier < 35) {
        // 가까운 순이 아니라 중원(CM) 우선 → 써포트 우선순위가 미드필더에게 돌아간다
        const rolePriority = { CM: 0, LM: 1, RM: 1, LB: 2, RB: 2 };
        const ranked = team.players
          .filter(p => p !== ballCarrier && ATTRACTOR_ROLES.includes(p.role))
          .sort((a, b) => {
            const pa = (rolePriority[a.role] ?? 2) - (rolePriority[b.role] ?? 2);
            if (pa !== 0) return pa;
            return a.position.sub(ballCarrier.position).length() -
                   b.position.sub(ballCarrier.position).length();
          });
        if (ranked.indexOf(player) < 2) {
          // 공 소유자로부터 8m 거리 지점을 접근 목표로 설정
          const dir       = ballCarrier.position.sub(player.position).normalize();
          const attractPt = ballCarrier.position.sub(dir.scale(8));
          target   = Vector2D.lerp(target, attractPt, 0.55);
          behavior = 'SUPPORTING';
        }
      }
    }
  }

  // ── 빈 공간 탐색 (Voronoi 근사): 행동 미지정 + 공격적 역할 ────
  if (!behavior && opponentTeam && ballCarrier?.team === team && w.support >= 0.4) {
    const openSpace = findBestOpenSpace(player, team, opponentTeam, ball, attackDir);
    if (openSpace) {
      const distToOpen = player.position.sub(openSpace).length();
      if (distToOpen > 5 && distToOpen < 28) {
        const blend = w.safety < 0.5 ? 0.45 : 0.2;
        target = Vector2D.lerp(target, openSpace, blend);
        behavior = 'SPACE_FINDING';
      }
    }
  }

  // ── 동료 간 역제곱 척력 (k/r²) ─────────────────────────────
  if (ballCarrier?.team === team) {
    // 전방 공격수(ST/LM/RM)는 파이널 서드에서 더 강하게 서로 밀어낸다
    const isForward = role === 'ST' || role === 'LM' || role === 'RM';
    const goalX = attackDir === 1 ? Pitch.LENGTH : 0;
    const distToGoal = Math.abs(player.position.x - goalX);
    const inFinalThird = distToGoal < Pitch.LENGTH * 0.38;
    
    const TEAM_REPULSION_K = isForward && inFinalThird ? 6.0 : 3.5;
    const TEAM_REPULSION_R = isForward && inFinalThird ? 10.0 : 7.0;
    let rep = Vector2D.zero();
    for (const mate of team.players) {
      if (mate === player || mate.role === 'GK') continue;
      const diff = target.sub(mate.position);
      const r = diff.length();
      if (r > 0.5 && r < TEAM_REPULSION_R) {
        rep = rep.add(diff.normalize().scale(Math.min(TEAM_REPULSION_K / (r * r), 3.0)));
      }
    }
    target = target.add(rep);
  }

  // ── 동료 목표지점 이격 (Target-Space Separation) ────────────
  // 선수 간 척력은 "내 목표"와 "동료 현재 위치" 사이에서만 작동하므로,
  // 두 공격수가 서로 다른 멀리 떨어진 목표로 달려갈 때는 주행 중 계속
  // 나란히 붙어 겹침이 생긴다. 동료가 이번 틱 따라갈 목표(offBallTarget)와
  // 내 목표가 가까우면 서로 밀어내 간격을 지킨다.
  // 박스 쇄도 중에도 목표 겹침 방지 적용 (니어/파 포스트 등 레인 분배가 있지만 안전장치)
  if (ballCarrier?.team === team) {
    const TARGET_GAP = 8.5; // 6.0 → 8.5로 확대해 전방 동료 간 최소 이격 확보
    let rep2 = Vector2D.zero();
    for (const mate of team.players) {
      if (mate === player || mate.role === 'GK') continue;
      const mateTgt = mate.brainMemory?.offBallTarget;
      if (!mateTgt) continue;
      const diff = target.sub(mateTgt);
      const r = diff.length();
      if (r > 0.3 && r < TARGET_GAP) {
        const strength = (TARGET_GAP - r) / TARGET_GAP;
        rep2 = rep2.add(diff.normalize().scale(strength * 7.0)); // 5.0 → 7.0 강화
      }
    }
    if (rep2.length() > 0.01) target = target.add(rep2);
  }

  // ── Stage 4: 측면 너비 확보 (가변 너비 계수 적용) ───────────
  if (w.width >= 0.8 && behavior !== 'PENETRATING' && behavior !== 'BOX_CRASHING' &&
      behavior !== 'OPP_RUN' && behavior !== 'OVERLAPPING') {
    target = applyWidthCreation(target, role, ball, team);
  }

  // ── Winger Forward Flank Push (LM/RM 공격 시 전방 측면으로 전진) ──
  // 공격 국면에서 측면 공격수를 전방 측면 포지션으로 강제 올린다.
  // 단, 박스 쇄도(크로스 대비) 중에는 파 포스트 침투를 유지한다.
  if ((role === 'LM' || role === 'RM') && ballCarrier?.team === team && behavior !== 'BOX_CRASHING' && behavior !== 'OPP_RUN') {
    // 공격 방향 지시(측면~중앙)에 따라 윙어의 터치라인 밀착도를 조절한다.
    // 측면(0): 터치라인에 바짝(바이어스 0.90), 중앙(1): 하프스페이스로 좁혀
    // 인버티드 윙어처럼 안쪽에서 플레이(바이어스 0.35)한다.
    const dirTactic = team.tactics?.attackDirectness ?? 0.5;
    const wideBias = 0.90 - dirTactic * 0.55;
    const flankY = role === 'LM'
      ? Pitch.WIDTH * (0.12 + dirTactic * 0.16)
      : Pitch.WIDTH * (0.88 - dirTactic * 0.16);
    target = new Vector2D(target.x, target.y * (1 - wideBias) + flankY * wideBias);
    // X: 공격 방향으로 전진 제한치를 넘어 올린다. 4-4-2 공격 시에는 4-2-4로
    // 전환해 측면 미드필더를 최전방(ST 라인 근처 70%)까지 가담시킨다.
    const frontNormX = team.formationName === '4-4-2' ? 0.70 : 0.58;
    if (attackDir === 1) {
      target = new Vector2D(Math.max(target.x, Pitch.LENGTH * frontNormX), target.y);
    } else {
      target = new Vector2D(Math.min(target.x, Pitch.LENGTH * (1 - frontNormX)), target.y);
    }
    behavior = behavior || 'FLANKING';
  }

  // ── 전방 드리블 연계 서포트 폴백 (복귀 방지) ──────────────
  // 동료가 전방으로 드리블 중인데 아직 행동이 배정되지 않은 공격/중원 선수는
  // '복귀'(기본 위치로 물러남)하지 않고 드리블러 전방 8~14m 지점으로 띄워서
  // 전방 지원(SUPPORTING)을 유지한다. 전방 공격수(ST/LM/RM)는 멀리 있어도
  // 드리블러 전방으로 밀어 붙여 최전방 압박·수신 대형을 유지한다.
  // (수비수는 라인 유지를 위해 제외)
  if (!behavior && ballCarrier?.team === team && ballCarrier.hasBall &&
      role !== 'GK' && role !== 'CB' && role !== 'LB' && role !== 'RB' && opponentTeam) {
    const frontGoalX = attackDir === 1 ? Pitch.LENGTH : 0;
    const carrierFrontDist = Math.abs(ballCarrier.position.x - frontGoalX);
    const carrierDist = player.position.sub(ballCarrier.position).length();
    const isForwardRole = role === 'ST' || role === 'LM' || role === 'RM';
    // 전방 드리블 국면: 보유자가 상대 진영(골문 45m 이내)에서 드리블 중
    const dribblingForward = carrierFrontDist < 45;
    const withinSupport = carrierDist < 32 && carrierDist > 5;
    // 전방 공격수는 거리와 무관하게 전방 유지, 그 외 중원은 32m 이내일 때만
    if (dribblingForward && (isForwardRole || withinSupport)) {
      // 전방 공격수: 드리블러 앞 10~14m로 띄우되, 전부 같은 지점으로 모이지 않도록
      // 역할·본인 기본 위치 기준 Y 레인으로 분산한다(투톱 ST는 서로 다른 레인).
      // ST: 자기 basePosition.y 기준 (4-4-2 상·하 ST가 분리) / LM·RM: 측면.
      const baseY = player.basePosition ? player.basePosition.y : Pitch.WIDTH / 2;
      const roleLaneY = role === 'LM' ? Pitch.WIDTH * 0.14
        : role === 'RM' ? Pitch.WIDTH * 0.86
        : role === 'ST' ? clamp(baseY, Pitch.WIDTH * 0.20, Pitch.WIDTH * 0.80)
        : (role === 'CM' ? clamp(baseY, Pitch.WIDTH * 0.25, Pitch.WIDTH * 0.75) : Pitch.WIDTH / 2);
      const aheadX = ballCarrier.position.x + attackDir * (10 + Math.random() * 4);
      const supportPoint = isForwardRole
        ? new Vector2D(aheadX, clamp(roleLaneY, 5, Pitch.WIDTH - 5))
        : ballCarrier.position.sub(
            player.position.sub(ballCarrier.position).normalize().scale(10 + Math.random() * 4)
          );
      target = Vector2D.lerp(target, supportPoint, isForwardRole ? 0.35 : 0.45);
      sprint = false;
      behavior = 'SUPPORTING';
    }
  }

  // ── Ball Carrier Repulsion: 공 소유자와 최소 8m 거리 유지 ──
  if (ballCarrier && ballCarrier !== player && ballCarrier.team === team) {
    const isForward = role === 'ST' || role === 'LM' || role === 'RM';
    const goalX = attackDir === 1 ? Pitch.LENGTH : 0;
    const distToGoal = Math.abs(player.position.x - goalX);
    const inFinalThird = distToGoal < Pitch.LENGTH * 0.38;
    // 전방 공격수는 파이널 서드에서 볼 소유자로부터 더 멀리 떨어져 공간 확보.
    // 박스 쇄도 중에도(레인이 배정돼 있어도) 드리블러에게 달라붙지 않도록
    // 최소 이격을 적용한다 — 드리블러 옆에 붙어 겹치는 현상 방지.
    const MIN_DIST_FROM_CARRIER = behavior === 'BOX_CRASHING'
      ? 6.5
      : (isForward && inFinalThird) ? 13 : 9;
    const toCarrier = target.sub(ballCarrier.position);
    const dist = toCarrier.length();
    if (dist < MIN_DIST_FROM_CARRIER && dist > 0.01) {
      const pushStr = (MIN_DIST_FROM_CARRIER - dist) / MIN_DIST_FROM_CARRIER;
      const pushDir = toCarrier.normalize();
      target = target.add(pushDir.scale(pushStr * MIN_DIST_FROM_CARRIER * 0.8));
    }
  }

  // ── 전방 공격수 전용 이격 패스 (파이널 서드 겹침 방지) ───────────
  // ST/LM/RM이 파이널 서드에 있으면 서로 최소 7m 이상 떨어지도록 강제 조정
  const isForwardRole = role === 'ST' || role === 'LM' || role === 'RM';
  const goalX = attackDir === 1 ? Pitch.LENGTH : 0;
  const distToGoal = Math.abs(player.position.x - goalX);
  const inFinalThird = distToGoal < Pitch.LENGTH * 0.38;
  
  if (isForwardRole && ballCarrier?.team === team) {
    // 파이널 서드로 한정하지 않는다 — 중앙으로 모여드는 과정에서 이미 겹치기
    // 시작하므로, 상대 진영 전체에서 전방 동료 간 최소 간격을 강제한다.
    const MIN_FORWARD_GAP = 9.5;
    let forwardRep = Vector2D.zero();
    for (const mate of team.players) {
      if (mate === player || mate.role === 'GK') continue;
      if (mate.role !== 'ST' && mate.role !== 'LM' && mate.role !== 'RM') continue;
      
      const diff = target.sub(mate.brainMemory?.offBallTarget ?? mate.position);
      const r = diff.length();
      if (r > 0.5 && r < MIN_FORWARD_GAP) {
        const strength = (MIN_FORWARD_GAP - r) / MIN_FORWARD_GAP;
        forwardRep = forwardRep.add(diff.normalize().scale(strength * 8.5));
      }
    }
    if (forwardRep.length() > 0.01) {
      target = target.add(forwardRep);
      // 이격 후 다시 피치 내부 클램프
      target = Pitch.clampInside(target, 1.2);
    }
  }

  // ── Stage 5: 오프사이드 방지 ────────────────────────────────
  if (ball.owner && opponentTeam) {
    target = applyOffsideClamping(target, opponentTeam, attackDir);
  }

  // ── Stage 6: 상태 저장 (렌더링용) ───────────────────────────
  mem.offBallBehavior = behavior;
  mem.offBallSprint   = sprint;
  mem.offBallTarget   = target.clone();
  // 공격 국면에서는 수비 상태(커버/마크/수비/압박) 표시를 남기지 않는다.
  // 이전 수비 단계에서 기록된 defendBehavior가 공격 중에도 남아
  // 미드필더·공격수가 "커버/마크/수비"로 보이는 것을 방지한다.
  // (수비 전환 시 decideDefensiveOffBall이 다시 수비 상태를 기록함)
  mem.defendBehavior  = null;
  mem.pressTarget     = null;
  mem.markTarget      = null;

  return Pitch.clampInside(target, 1.2);
}
