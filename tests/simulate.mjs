// Plays full bot-vs-bot games on every map and mode and checks invariants.
// Run:  node tests/simulate.mjs [gamesPerCombo]

import { createGame, applyAction, geoOf, RES, total, totalVP, longestRoadFor } from '../js/engine/game.js';
import { pendingBot, chooseAction } from '../js/engine/bot.js';
import { MAPS } from '../js/engine/maps.js';
import { MODES } from '../js/engine/modes.js';

const perCombo = Number(process.argv[2] || 2);
let games = 0, finished = 0, totalActions = 0;
const problems = [];

function check(s, label) {
  const geo = geoOf(s);
  for (const [i, p] of s.players.entries()) {
    for (const r of RES) if (p.res[r] < 0 || !Number.isInteger(p.res[r])) throw new Error(`${label}: negative/invalid ${r} for P${i}`);
    const roads = Object.values(s.roads).filter((o) => o === i).length;
    const sett = Object.values(s.buildings).filter((b) => b.p === i && b.type === 'settlement').length;
    const city = Object.values(s.buildings).filter((b) => b.p === i && b.type === 'city').length;
    if (roads + p.left.road !== 15) throw new Error(`${label}: road pieces mismatch`);
    if (sett + city + p.left.settlement !== 5 + city) throw new Error(`${label}: settlement pieces mismatch P${i}`);
    if (city + p.left.city !== 4) throw new Error(`${label}: city pieces mismatch P${i}`);
  }
  for (const v of Object.keys(s.buildings)) {
    for (const a of geo.vertices[v].adj) if (s.buildings[a]) throw new Error(`${label}: distance rule broken`);
  }
}

for (const [mapId, map] of Object.entries(MAPS)) {
  for (const modeId of Object.keys(MODES)) {
    for (let g = 0; g < perCombo; g++) {
      const nPlayers = Math.min(map.max, Math.max(map.min, 2 + ((g + modeId.length) % 5)));
      const players = Array.from({ length: nPlayers }, (_, i) => ({ uid: 'b' + i, name: 'Bot' + i, bot: true }));
      const label = `${mapId}/${modeId}/${nPlayers}p/#${g}`;
      let s = createGame({ players, mapId, modeId, seed: 1000 + g * 7 + nPlayers });
      games++;
      let n = 0;
      while (s.phase !== 'ended' && n < 8000) {
        const b = pendingBot(s);
        if (b == null) { problems.push(`${label}: stuck, nobody to act in phase ${s.phase}`); break; }
        const act = chooseAction(s, b);
        if (!act) { problems.push(`${label}: bot returned no action in phase ${s.phase}`); break; }
        const r = applyAction(s, act);
        if (!r.ok) { problems.push(`${label}: bot action rejected (${r.error}) ${JSON.stringify(act)} in ${s.phase}`); break; }
        s = r.state;
        n++;
        if (n % 50 === 0) check(s, label);
      }
      check(s, label);
      totalActions += n;
      if (s.phase === 'ended') {
        finished++;
        const w = s.winner;
        if (totalVP(s, w) < s.config.rules.vpToWin) problems.push(`${label}: winner below target`);
        for (let i = 0; i < s.players.length; i++) void longestRoadFor(s, i);
      } else if (n >= 8000) {
        problems.push(`${label}: no winner after ${n} actions (turn ${s.turnNo}, VPs ${s.players.map((_, i) => totalVP(s, i)).join('/')})`);
      }
    }
  }
}

console.log(`games: ${games}, finished: ${finished}, avg actions: ${Math.round(totalActions / games)}`);
if (problems.length) {
  console.log('PROBLEMS:\n' + problems.join('\n'));
  process.exit(1);
}
console.log('OK — all simulated games completed without rule violations.');
void total;
