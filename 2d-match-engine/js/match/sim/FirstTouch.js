import { Vector2D } from '../../entities/Vector2D.js';
import { clamp01, angleDiff } from '../core/Coords.js';

/**
 * 퍼스트 터치 — 날아온 볼을 처리하는 순간의 결과를 결정한다.
 *
 * 볼이 선수에게 닿는다고 자동으로 발밑에 붙지 않는다.
 * 실력·볼 속도·높이·들어오는 각도·압박이 함께 작용해 결과가 갈리고,
 * 나쁜 터치는 루즈볼을 만들어 자연스러운 소유권 다툼을 낳는다.
 *
 * 이것이 통계(패스 성공률·턴오버)를 억지로 맞추지 않고도
 * 현실적인 분포를 만들어내는 주된 장치다.
 */

/** 퍼스트 터치 결과 */
export const TouchResult = {
  GOOD_CONTROL: 'GOOD_CONTROL',   // 발밑에 완전히 죽인다
  TOUCH_FORWARD: 'TOUCH_FORWARD', // 진행 방향으로 밀어놓는다 (여전히 내 볼)
  TOUCH_SIDE: 'TOUCH_SIDE',       // 압박을 피해 옆으로 뺀다
  LOOSE_CONTROL: 'LOOSE_CONTROL', // 크게 튄다 — 경합 상황
  BAD_TOUCH: 'BAD_TOUCH',         // 완전히 놓친다 — 턴오버 가능성 높음
};

/** 볼에 손이 닿는 수평 거리 (m) */
export const CONTROL_RADIUS = 1.15;

/** 발로 처리할 수 있는 최대 볼 높이 (m). 이보다 높으면 헤딩 영역이다. */
export const CONTROL_MAX_HEIGHT = 1.0;

/**
 * 퍼스트 터치 난이도를 계산한다. 0(쉬움) ~ 1(매우 어려움)
 *
 * @param {Player} player 처리하는 선수
 * @param {Ball} ball
 * @param {number} pressure 0~1, 근접 상대에 의한 압박
 */
function touchDifficulty(player, ball, pressure) {
  // 선수 기준 상대 속도 — 같은 방향으로 달리며 받으면 훨씬 쉽다
  const relativeVelocity = ball.velocity.sub(player.velocity);
  const relativeSpeed = relativeVelocity.length();

  // 4 m/s 이하는 부담이 없고, 22 m/s는 매우 어렵다
  const speedTerm = clamp01((relativeSpeed - 4) / 18) * 0.55;

  // 뜬 볼일수록 어렵다
  const heightTerm = clamp01(ball.height / CONTROL_MAX_HEIGHT) * 0.25;

  // 등 뒤에서 들어오는 볼은 몸을 틀어야 해서 어렵다
  let angleTerm = 0;
  if (relativeSpeed > 0.5) {
    // 볼이 날아오는 방향 (선수 → 볼이 온 쪽)
    const incoming = relativeVelocity.normalize().scale(-1).angle();
    const offset = Math.abs(angleDiff(incoming, player.facingAngle));
    // 정면(0) 0 ~ 등 뒤(π) 최대
    angleTerm = (offset / Math.PI) * 0.20;
  }

  const pressureTerm = clamp01(pressure) * 0.25;

  return clamp01(speedTerm + heightTerm + angleTerm + pressureTerm);
}

/**
 * 퍼스트 터치를 해결한다.
 *
 * @param {object} params
 * @param {Player} params.player 볼을 처리하는 선수
 * @param {Ball} params.ball
 * @param {number} params.pressure 0~1 압박 정도
 * @param {Rng} params.rng 터치 전용 난수 스트림
 * @param {Vector2D|null} params.intendedDirection 선수가 볼을 놓고 싶은 방향
 * @returns {{
 *   result:string, quality:number, retained:boolean,
 *   ballVelocity:Vector2D, ballVerticalVelocity:number
 * }}
 */
export function resolveFirstTouch({ player, ball, pressure = 0, rng, intendedDirection = null }) {
  const a = player.attributes;

  // 볼 다루는 능력 — 퍼스트 터치가 주도하고 드리블·민첩성·균형이 보조한다
  const skill =
    a.norm('firstTouch') * 0.45 +
    a.norm('dribbling') * 0.25 +
    a.norm('agility') * 0.18 +
    a.norm('balance') * 0.12;

  const difficulty = touchDifficulty(player, ball, pressure);

  // 난수는 결과를 뒤집는 주역이 아니라 불확실성의 폭이다 (Section 49)
  const noise = rng.gaussian(0, 0.09, 2.5);
  const quality = clamp01(skill - difficulty + 0.30 + noise);

  // 놓고 싶은 방향이 없으면 진행 방향을 기준으로 한다
  const forward = intendedDirection
    ? intendedDirection.normalize()
    : Vector2D.fromAngle(player.facingAngle);

  // 볼이 갖고 있던 운동량 일부는 터치 후에도 남는다
  const incomingSpeed = ball.velocity.length();

  if (quality >= 0.70) {
    // 완전히 죽인다 — 발밑에 붙는다
    return {
      result: TouchResult.GOOD_CONTROL,
      quality,
      retained: true,
      ballVelocity: Vector2D.zero(),
      ballVerticalVelocity: 0,
    };
  }

  if (quality >= 0.50) {
    // 진행 방향으로 살짝 밀어놓는다 — 흐름을 끊지 않는 좋은 터치
    const push = 1.4 + quality * 1.6;
    return {
      result: TouchResult.TOUCH_FORWARD,
      quality,
      retained: true,
      ballVelocity: forward.scale(push),
      ballVerticalVelocity: 0,
    };
  }

  if (quality >= 0.32) {
    // 압박을 피해 옆으로 뺀다. 어느 쪽으로 빠지는지는 난수가 아니라
    // 압박을 덜 받는 쪽(= 몸이 향한 방향 기준 바깥쪽)으로 정한다.
    const side = rng.sign();
    const lateral = forward.rotate((Math.PI / 2) * side);
    const push = 2.0 + incomingSpeed * 0.10;
    return {
      result: TouchResult.TOUCH_SIDE,
      quality,
      retained: true,
      ballVelocity: lateral.scale(push * 0.7).add(forward.scale(push * 0.4)),
      ballVerticalVelocity: 0,
    };
  }

  if (quality >= 0.16) {
    // 크게 튄다 — 아직 아무의 볼도 아니다
    const deflect = forward.rotate(rng.range(-1.1, 1.1));
    const push = 3.2 + incomingSpeed * 0.22;
    return {
      result: TouchResult.LOOSE_CONTROL,
      quality,
      retained: false,
      ballVelocity: deflect.scale(push),
      ballVerticalVelocity: incomingSpeed > 12 ? 1.2 : 0,
    };
  }

  // 완전히 놓친다 — 볼이 원래 속도를 상당히 유지한 채 튀어나간다
  const deflect = incomingSpeed > 0.5
    ? ball.velocity.normalize().rotate(rng.range(-0.9, 0.9))
    : forward.rotate(rng.range(-Math.PI, Math.PI));
  const push = Math.max(4.0, incomingSpeed * 0.55);
  return {
    result: TouchResult.BAD_TOUCH,
    quality,
    retained: false,
    ballVelocity: deflect.scale(push),
    ballVerticalVelocity: incomingSpeed > 14 ? 1.8 : 0,
  };
}
