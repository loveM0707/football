import { Pitch } from '../entities/Pitch.js';

const PLAYER_RADIUS = 0.45; // 겹침 판정용 반경(미터)

export const Collision = {
  PLAYER_RADIUS,
  PLAYER_CONTACT_RADIUS: PLAYER_RADIUS * 2 + 0.15,
  BALL_CONTROL_RADIUS: 1.15,

  /** 선수끼리 겹치면 서로 밀어내 자연스러운 몸싸움/간격을 만든다. Strength/피지컬에 따라 밀리는 비율을 차등 적용 */
  resolvePlayerOverlap(players) {
    const minDist = PLAYER_RADIUS * 2;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < players.length; i++) {
        for (let j = i + 1; j < players.length; j++) {
          const a = players[i];
          const b = players[j];
          const delta = b.position.sub(a.position);
          const dist = delta.length();
          if (dist > 1e-6 && dist < minDist) {
            const overlap = minDist - dist;
            const normal = delta.scale(1 / dist);

            // 피지컬/몸싸움 스탯 및 볼 소유 실딩에 따른 밀림 가중치 계산
            const strA = (a.attributes?.strength ?? a.attributes?.power ?? 70) + (a.hasBall ? 10 : 0);
            const strB = (b.attributes?.strength ?? b.attributes?.power ?? 70) + (b.hasBall ? 10 : 0);
            const totalStr = strA + strB;

            // 더 힘이 약한 선수가 더 많이 밀려남
            const pushA = overlap * (strB / totalStr);
            const pushB = overlap * (strA / totalStr);

            a.position = a.position.sub(normal.scale(pushA));
            b.position = b.position.add(normal.scale(pushB));
          }
        }
      }
    }
  },

  clampPlayersToPitch(players) {
    players.forEach((p) => {
      p.position = Pitch.clampInside(p.position, PLAYER_RADIUS);
    });
  },

  playersWithinRadiusOfBall(players, ball, radius) {
    return players
      .map((p) => ({ player: p, distance: p.position.sub(ball.position).length() }))
      .filter((e) => e.distance < radius)
      .sort((a, b) => a.distance - b.distance)
      .map((e) => e.player);
  },
};

