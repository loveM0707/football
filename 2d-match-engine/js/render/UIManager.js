const PHASE_LABELS = {
  KICKOFF: '킥오프 준비',
  IN_PLAY: '경기 중',
  THROW_IN: '스로인 준비',
  CORNER_KICK: '코너킥 준비',
  GOAL_KICK: '골킥 준비',
  FREE_KICK: '프리킥 준비',
  GOAL_SCORED: '득점!',
  HALF_TIME: '하프타임',
  FULL_TIME: '경기 종료',
};

const RESTART_LABELS = {
  KICKOFF: '킥오프',
  THROW_IN: '스로인',
  CORNER: '코너킥',
  GOAL_KICK: '골킥',
  FREE_KICK: '프리킥',
};

/** Canvas 밖 HTML/CSS 기반 UI(스코어보드, 시계, 이벤트 로그)를 갱신하는 역할만 담당한다 */
export class UIManager {
  constructor({ eventBus, homeTeam, awayTeam }) {
    this.homeTeam = homeTeam;
    this.awayTeam = awayTeam;

    this.el = {
      clock: document.getElementById('clock'),
      scoreHome: document.getElementById('scoreHome'),
      scoreAway: document.getElementById('scoreAway'),
      nameHome: document.getElementById('teamNameHome'),
      nameAway: document.getElementById('teamNameAway'),
      phase: document.getElementById('phaseIndicator'),
      possessionHome: document.getElementById('possessionHome'),
      possessionAway: document.getElementById('possessionAway'),
      log: document.getElementById('eventLog'),
    };

    this.el.nameHome.textContent = homeTeam.name;
    this.el.nameAway.textContent = awayTeam.name;

    eventBus.on('goal', (e) => this._log(`⚽ 골! ${e.team.name}`));
    eventBus.on('shot', (e) => this._log(`슈팅 - ${e.by.name} (${e.team.name})`));
    eventBus.on('save', (e) =>
      this._log(e.held ? `🧤 선방! ${e.gk.name}` : `🧤 쳐내기 - ${e.gk.name}`)
    );
    eventBus.on('restart', (e) => this._log(`${RESTART_LABELS[e.type] ?? e.type} - ${e.team.name}`));
    eventBus.on('foul', (e) => this._log(`🟨 파울! 프리킥 - ${e.team.name}`));
    eventBus.on('tackle', (e) => this._log(`태클 성공 - ${e.winner.name}${e.loose ? ' (루즈볼)' : ''}`));
    eventBus.on('interception', (e) => this._log(`✂️ 가로채기 - ${e.player.name}`));
    eventBus.on('block', (e) => this._log(`🛡️ 블로킹 - ${e.player.name}`));
    eventBus.on('halftime', () => this._log('--- 전반 종료 ---'));
    eventBus.on('fulltime', (e) => this._log(`--- 경기 종료 ${e.score.home} : ${e.score.away} ---`));
  }

  _log(message) {
    const div = document.createElement('div');
    div.className = 'log-entry';
    div.textContent = message;
    this.el.log.prepend(div);
    while (this.el.log.children.length > 40) {
      this.el.log.removeChild(this.el.log.lastChild);
    }
  }

  update(matchState) {
    const minute = Math.min(matchState.displayMinute, 90);
    const mm = String(minute).padStart(2, '0');
    const ss = String(matchState.displaySecond).padStart(2, '0');
    this.el.clock.textContent = `${mm}:${ss}`;

    this.el.scoreHome.textContent = matchState.score.home;
    this.el.scoreAway.textContent = matchState.score.away;
    this.el.phase.textContent = PHASE_LABELS[matchState.phase] ?? matchState.phase;

    const totalPossession = this.homeTeam.possessionSeconds + this.awayTeam.possessionSeconds;
    const homePct = totalPossession > 0 ? Math.round((this.homeTeam.possessionSeconds / totalPossession) * 100) : 50;
    this.el.possessionHome.style.width = `${homePct}%`;
    this.el.possessionAway.style.width = `${100 - homePct}%`;
    this.el.possessionHome.textContent = `${homePct}%`;
    this.el.possessionAway.textContent = `${100 - homePct}%`;
  }
}
