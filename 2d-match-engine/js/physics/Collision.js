import { Pitch } from '../entities/Pitch.js';

const PLAYER_RADIUS = 0.35; // 겹침 판정용 반경(미터)

export const Collision = {
  BALL_CONTROL_RADIUS: 1.15,

  /** 선수끼리 겹치면 서로 밀어내 자연스러운 몸싸움/간격을 만든다 */
  resolvePlayerOverlap(players) {
    const minDist = PLAYER_RADIUS * 2;
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const a = players[i];
        const b = players[j];
        const delta = b.position.sub(a.position);
        const dist = delta.length();
        if (dist > 1e-6 && dist < minDist) {
          const overlap = (minDist - dist) / 2;
          const push = delta.normalize().scale(overlap);
          a.position = a.position.sub(push);
          b.position = b.position.add(push);
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
