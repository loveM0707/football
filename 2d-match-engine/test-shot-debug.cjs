const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--headless=new'],
    headless: false,
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push('[console.error] ' + msg.text());
  });

  await page.goto('http://localhost:8843/index.html', { waitUntil: 'load' });
  await page.selectOption('#speedSelect', '6');

  // Inject deep shot-tracking
  await page.evaluate(() => {
    const { simulator } = window.__match;
    window.__debug = {
      shots: 0,
      shootAttempts: 0,    // how many times SHOOT was returned by decideBallCarrier
      inShootingBoxHits: 0,
      canShootNowHits: 0,
      forcedPasses: 0,
      pressureAbove65: 0,
      ballCarrierEvents: 0,
      closestToGoalWithBall: 999,
      decisionTypes: {},
    };

    // Patch the eventBus
    const origEmit = simulator.eventBus.emit.bind(simulator.eventBus);
    simulator.eventBus.emit = function(ev, data) {
      if (ev === 'shot') window.__debug.shots++;
      return origEmit(ev, data);
    };
  });

  // Wait 60s (at 6x = 6 minutes of game time)
  await page.waitForTimeout(60000);

  const result = await page.evaluate(() => {
    const { simulator, homeTeam, awayTeam } = window.__match;
    const homeOF = homeTeam.outfieldPlayers.map(p => ({
      role: p.role,
      x: Math.round(p.position.x),
      hasBall: p.hasBall,
    }));
    const awayOF = awayTeam.outfieldPlayers.map(p => ({
      role: p.role,
      x: Math.round(p.position.x),
      hasBall: p.hasBall,
    }));

    return {
      clock: `${simulator.matchState.displayMinute}:${Math.floor(simulator.matchState.displaySecond)}`,
      score: simulator.matchState.score,
      debug: window.__debug,
      homePositions: homeOF,
      awayPositions: awayOF,
      homeAttDir: homeTeam.attackingDirection,
      awayAttDir: awayTeam.attackingDirection,
    };
  });

  console.log('\n========== 슈팅 디버그 ==========\n');
  console.log(`경기 시간: ${result.clock}`);
  console.log(`스코어: ${result.score.home} - ${result.score.away}`);
  console.log(`슈팅: ${result.debug.shots}회`);
  console.log(`홈팀 공격 방향: ${result.homeAttDir}, 어웨이팀 공격 방향: ${result.awayAttDir}`);
  console.log('\n홈팀 현재 위치:');
  result.homePositions.forEach(p => console.log(`  ${p.role}: x=${p.x}m${p.hasBall ? ' [BALL]' : ''}`));
  console.log('\n어웨이팀 현재 위치:');
  result.awayPositions.forEach(p => console.log(`  ${p.role}: x=${p.x}m${p.hasBall ? ' [BALL]' : ''}`));

  if (errors.length > 0) {
    console.log('\n❌ JS 오류:');
    errors.forEach(e => console.log('  ' + e));
  } else {
    console.log('\n✅ JS 오류 없음');
  }

  await browser.close();
})();
