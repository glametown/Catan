// GameHost: owns the authoritative game state. In offline play it is the local
// tab; in online play it is the lobby host's tab. It validates every action with
// the rules engine, drives bot players, and notifies listeners of new states.

import { applyAction } from '../engine/game.js';
import { pendingBot, chooseAction } from '../engine/bot.js';

// Actions a remote (non-host) client is allowed to send.
export const CLIENT_ACTIONS = new Set([
  'roll', 'discard', 'moveRobber', 'buildSettlement', 'buildRoad', 'buildCity', 'buyDev',
  'playKnight', 'playRoadBuilding', 'playYearOfPlenty', 'playMonopoly', 'bankTrade',
  'offerTrade', 'acceptTrade', 'declineTrade', 'confirmTrade', 'cancelTrade', 'endTurn',
]);

export class GameHost {
  constructor(state, { onState, onReject, botDelay = 750 }) {
    this.state = state;
    this.onState = onState;
    this.onReject = onReject || (() => {});
    this.botDelay = botDelay;
    this.timer = null;
    this.stopped = false;
    this.emit();
    this.schedule();
  }

  emit() { this.onState(this.state); }

  submit(action) {
    if (this.stopped) return { ok: false, error: 'Game closed.' };
    const r = applyAction(this.state, action);
    if (r.ok) {
      this.state = r.state;
      this.emit();
      this.schedule();
    }
    return r;
  }

  // Message from a remote player identified by their auth uid.
  submitFrom(uid, action) {
    const p = this.state.players.findIndex((pl) => pl.uid === uid && !pl.bot);
    if (p < 0 || !action || !CLIENT_ACTIONS.has(action.type)) return { ok: false, error: 'Not allowed.' };
    const r = this.submit({ ...action, p });
    if (!r.ok) this.onReject(uid, r.error);
    return r;
  }

  // Let a bot take over a human seat (e.g. someone left or went AFK).
  botify(index) {
    const s = structuredClone(this.state);
    const pl = s.players[index];
    if (!pl || pl.bot) return;
    pl.bot = true;
    pl.name = pl.name + ' (bot)';
    s.rev++;
    this.state = s;
    this.emit();
    this.schedule();
  }

  schedule() {
    if (this.timer || this.stopped) return;
    if (pendingBot(this.state) == null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const s = this.state;
      const b = pendingBot(s);
      if (b != null) {
        const act = chooseAction(s, b);
        const r = act ? applyAction(s, act) : { ok: false, error: 'no action' };
        if (r.ok) { this.state = r.state; this.emit(); }
        else console.warn('Bot action rejected:', r.error, act);
      }
      this.schedule();
    }, this.botDelay);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }
}
