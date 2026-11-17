// Game modes are presets over a small set of rule switches. The lobby host can
// pick a preset and then tweak a few of the switches (VP target, dice, robber).

export const DEFAULT_RULES = {
  vpToWin: 10,
  productionMultiplier: 1,
  robber: true,
  startHand: null, // null | { wood, brick, ... } | 'random6'
  bankRatio: 4,
  portAnyRatio: 3,
  portResRatio: 2,
  balancedDice: false,
  discardLimit: 7,
};

export const MODES = {
  classic: {
    name: 'Classic',
    icon: '🏝️',
    desc: 'Standard rules. First to 10 victory points wins.',
    rules: {},
  },
  quick: {
    name: 'Quick Start',
    icon: '⚡',
    desc: '7 victory points to win, and everyone starts with a hand of resources.',
    rules: { vpToWin: 7, startHand: { wood: 3, brick: 3, sheep: 2, wheat: 2, ore: 0 } },
  },
  rush: {
    name: 'Resource Rush',
    icon: '💰',
    desc: 'Every hex pays double and you need 12 points. Big builds, fast turns.',
    rules: { vpToWin: 12, productionMultiplier: 2 },
  },
  peaceful: {
    name: 'Peaceful Isles',
    icon: '🕊️',
    desc: 'No robber and no stealing. A pure building race.',
    rules: { robber: false },
  },
  merchant: {
    name: "Merchant's Dream",
    icon: '⚖️',
    desc: '3:1 bank trades, 2:1 on any harbor, random starting hand, 12 points.',
    rules: { vpToWin: 12, bankRatio: 3, portAnyRatio: 2, startHand: 'random6' },
  },
  fair: {
    name: 'Fair Dice',
    icon: '🎲',
    desc: 'Dice come from a shuffled deck of all 36 rolls, so luck evens out.',
    rules: { balancedDice: true },
  },
};

export function resolveRules(modeId, overrides = {}) {
  const mode = MODES[modeId] || MODES.classic;
  const rules = { ...DEFAULT_RULES, ...mode.rules };
  const vp = Number(overrides.vpToWin);
  if (Number.isFinite(vp) && vp >= 5 && vp <= 20) rules.vpToWin = Math.round(vp);
  if (typeof overrides.balancedDice === 'boolean') rules.balancedDice = overrides.balancedDice;
  if (typeof overrides.robber === 'boolean') rules.robber = overrides.robber;
  return rules;
}
