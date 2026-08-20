const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--headless=new'],
    headless: false,
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto('http://localhost:8843/index.html', { waitUntil: 'load' });

  // 정지 후 즉시 상태 확인
  const snapshot = await page.evaluate(() => {
    const { homeTeam, awayTeam, simulator } = window.__match;

    return {
      homeAttackDir: homeTeam.attackingDirection,
      awayAttackDir: awayTeam.attackingDirection,
      homePlayers: homeTeam.players.map(p => ({
        role: p.role,
        pos: { x: Math.round(p.position.x), y: Math.round(p.position.y) },
        basePos: { x: Math.round(p.basePosition.x), y: Math.round(p.basePosition.y) },
        hasBall: p.hasBall,
      })),
      awayPlayers: awayTeam.players.map(p => ({
        role: p.role,
        pos: { x: Math.round(p.position.x), y: Math.round(p.position.y) },
        basePos: { x: Math.round(p.basePosition.x), y: Math.round(p.basePosition.y) },
        hasBall: p.hasBall,
      })),
      ball: { x: Math.round(simulator.ball.position.x), y: Math.round(simulator.ball.position.y) },
      phase: simulator.matchState.phase,
    };
  });

  console.log('=== 초기 상태 ===');
  console.log(`홈팀 공격 방향: ${snapshot.homeAttackDir} (1=오른쪽, -1=왼쪽)`);
  console.log(`어웨이팀 공격 방향: ${snapshot.awayAttackDir}`);
  console.log(`공 위치: ${JSON.stringify(snapshot.ball)}`);
  console.log(`경기 페이즈: ${snapshot.phase}`);
  console.log('\n=== 홈팀 선수 위치 ===');
  snapshot.homePlayers.forEach(p => {
    console.log(`  ${p.role}: pos ${JSON.stringify(p.pos)}, base ${JSON.stringify(p.basePos)}${p.hasBall ? ' ← 공소유' : ''}`);
  });
  console.log('\n=== 어웨이팀 선수 위치 ===');
  snapshot.awayPlayers.forEach(p => {
    console.log(`  ${p.role}: pos ${JSON.stringify(p.pos)}, base ${JSON.stringify(p.basePos)}${p.hasBall ? ' ← 공소유' : ''}`);
  });

  // 5초 후 실제 플레이 중 상태 확인
  await page.selectOption('#speedSelect', '6');
  await page.waitForTimeout(5000);

  const snapshot2 = await page.evaluate(() => {
    const { homeTeam, awayTeam, simulator } = window.__match;
    return {
      homePlayers: homeTeam.players.map(p => ({
        role: p.role,
        pos: { x: Math.round(p.position.x), y: Math.round(p.position.y) },
        hasBall: p.hasBall,
        state: p.state,
      })),
      ball: { x: Math.round(simulator.ball.position.x), y: Math.round(simulator.ball.position.y) },
      phase: simulator.matchState.phase,
      owner: simulator.ball.owner ? simulator.ball.owner.role : 'none',
      ownerTeam: simulator.ball.owner ? simulator.ball.owner.team.name : 'none',
    };
  });

  console.log('\n=== 5초 후 실시간 상태 ===');
  console.log(`공 위치: ${JSON.stringify(snapshot2.ball)}, 소유: ${snapshot2.owner} (${snapshot2.ownerTeam})`);
  console.log('홈팀 위치:');
  snapshot2.homePlayers.forEach(p => {
    const forward = p.pos.x > 52 ? '→ 상대 진영' : '← 자기 진영';
    console.log(`  ${p.role}: x=${p.pos.x} ${forward}${p.hasBall ? ' *** 공소유' : ''}`);
  });

  await browser.close();
})();
