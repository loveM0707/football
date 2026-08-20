import { Vector2D } from '../../entities/Vector2D.js';
import { solveGroundPass, solveLoftedPass, verifySolution } from '../ball/PassSolver.js';

/**
 * 검증 도구 (Section 34·35).
 *
 * ⚠ 목표는 "미리 정한 완벽한 숫자"가 아니라 "명백히 깨진 분포를 잡아내는 것"이다.
 *   여기서 하드코딩하는 값들(오버슛 허용치, 구조적 부등식)은 물리·규칙에서
 *   나오는 하한/상한이지, 팀이 정확히 몇 번 패스해야 한다는 목표가 아니다.
 */

/** Section 34 오버슛 허용치 (m) */
export const OVERSHOOT_LIMIT = 1.5;
export const CLOSEST_APPROACH_LIMIT = 1.0;

/**
 * 패스 클래스별 궤적 정확도를 검증한다 (Section 34).
 *
 * 각 클래스에서 여러 거리·방향 조합을 만들어 실제 물리 궤적을 확인하고,
 * 목표를 크게 벗어나는 경우를 PASS_TRAJECTORY_FAILURE로 보고한다.
 *
 * @param {number} dt 고정 스텝
 * @returns {{total:number, failures:Array<object>}}
 */
export function validatePassTrajectories(dt) {
  const failures = [];
  let total = 0;

  const classes = [
    { name: 'SHORT', distances: [5, 8, 12], mustLoft: false },
    { name: 'MEDIUM', distances: [15, 20, 25], mustLoft: false },
    { name: 'LONG', distances: [30, 40, 50], mustLoft: true },
    { name: 'THROUGH', distances: [15, 25, 35], mustLoft: false },
  ];
  const angles = [0, Math.PI / 3, Math.PI * 0.9, -Math.PI / 2];

  for (const cls of classes) {
    for (const distance of cls.distances) {
      for (const angle of angles) {
        total++;
        const from = new Vector2D(40, 34);
        const to = from.add(Vector2D.fromAngle(angle, distance));

        const solution = cls.mustLoft
          ? solveLoftedPass(from, to, { dt })
          : solveGroundPass(from, to, { dt, arrivalSpeed: cls.name === 'THROUGH' ? 4.5 : 3.5 });

        if (!solution) {
          failures.push({
            class: cls.name, distance, angle, reason: 'NO_SOLUTION',
          });
          continue;
        }

        const v = verifySolution(from, to, solution, dt);
        if (v.closestDistance > CLOSEST_APPROACH_LIMIT || Math.abs(v.overshoot) > OVERSHOOT_LIMIT) {
          failures.push({
            class: cls.name, distance, angle,
            reason: 'PASS_TRAJECTORY_FAILURE',
            closestDistance: Number(v.closestDistance.toFixed(2)),
            overshoot: Number(v.overshoot.toFixed(2)),
          });
        }
      }
    }
  }

  return { total, failures };
}

/**
 * 경기 통계 리포트에서 구조적으로 명백히 깨진 분포를 찾는다 (Section 35).
 *
 * 정해진 목표 수치와 비교하지 않는다. 대신 물리·규칙에서 반드시 성립해야
 * 하는 부등식·범위를 검사한다: 슛은 패스보다 적어야 하고, 득점은 슛보다
 * 적어야 하며, 평균 패스 거리가 피치 대각선을 넘을 수 없는 식이다.
 *
 * @param {object} summary MatchStatistics.summary() 결과
 * @returns {string[]} 경고 목록 (비어 있으면 이상 없음)
 */
export function checkRealismReport(summary) {
  const warnings = [];
  const PITCH_DIAGONAL = 124.8; // √(105² + 68²)

  for (const side of ['home', 'away']) {
    const s = summary[side];
    const label = side === 'home' ? '홈' : '원정';

    // Section 31: 슛은 패스보다 훨씬 적어야 한다
    if (s.passesAttempted > 0 && s.shots > s.passesAttempted) {
      warnings.push(`${label}: 슛(${s.shots})이 패스(${s.passesAttempted})보다 많음`);
    }
    // 득점은 슛보다 많을 수 없다
    if (s.goals > s.shots) {
      warnings.push(`${label}: 득점(${s.goals})이 슛(${s.shots})보다 많음`);
    }
    // 유효슈팅은 전체 슛을 넘을 수 없다
    if (s.shotsOnTarget > s.shots) {
      warnings.push(`${label}: 유효슈팅(${s.shotsOnTarget})이 전체 슛(${s.shots})보다 많음`);
    }
    // 평균 패스 거리가 물리적으로 불가능한 범위
    if (s.avgPassLength > PITCH_DIAGONAL) {
      warnings.push(`${label}: 평균 패스 거리(${s.avgPassLength}m)가 피치 대각선을 초과`);
    }
    if (s.passesAttempted > 5 && s.avgPassLength < 2) {
      warnings.push(`${label}: 평균 패스 거리(${s.avgPassLength}m)가 비현실적으로 짧음`);
    }
    // 팀 길이가 피치 길이를 넘을 수 없다
    if (s.avgTeamLength > 105) {
      warnings.push(`${label}: 평균 팀 길이(${s.avgTeamLength}m)가 피치 길이를 초과`);
    }
    // 드리블 성공은 시도를 넘을 수 없다
    if (s.dribblesWon > s.dribbleContests) {
      warnings.push(`${label}: 드리블 성공(${s.dribblesWon})이 시도(${s.dribbleContests})보다 많음`);
    }
    // 휴리스틱 경고 — 목표 수치가 아니라 "명백히 치우침"을 잡기 위한 느슨한 상한이다.
    // 실제 축구의 롱패스(30m 초과) 비율은 대개 10~25% 수준이며, 직선적인
    // 팀도 35%를 크게 넘기지 않는다. 이 상한을 넘으면 패스 판단이
    // 전진 거리를 과대평가하고 있다는 신호로 본다 (Section 31).
    if (s.passesAttempted > 20 && s.longPassPct > 40) {
      warnings.push(`${label}: 롱패스 비율(${s.longPassPct}%)이 비정상적으로 높음 — ` +
        `패스 효용이 전진 거리를 과대평가하는지 점검 필요`);
    }
  }

  // 점유율 합이 100%에서 크게 벗어나면 집계 오류
  const possSum = summary.home.possessionPct + summary.away.possessionPct;
  if (Math.abs(possSum - 100) > 2) {
    warnings.push(`점유율 합이 100%가 아님 (${possSum}%)`);
  }

  return warnings;
}

/**
 * 두 엔진 스냅샷 해시가 일치하는지 확인한다 (Section 32·R).
 * @param {MatchEngine} a
 * @param {MatchEngine} b
 */
export function checkDeterminism(a, b) {
  return a.hash() === b.hash();
}
