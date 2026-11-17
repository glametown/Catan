# ⬡ Isles & Islands

A Catan-style game of trade, build and settle that runs entirely in the browser — no build step, no server to run.
Play **offline against bots**, or sign in with **Google** and play **online lobbies** with friends.

## Features

- **7 maps** — Classic (19 hexes), Grand Island (30), Blossom (13), Delta (triangle), Hourglass, Crater Lake (ring with a sea lake) and *Wild Lands* (a brand-new random coastline every game). Any map shape works because the board graph is derived from hex coordinates.
- **6 game modes** — Classic, Quick Start, Resource Rush, Peaceful Isles (no robber), Merchant's Dream (better trade ratios) and Fair Dice (shuffled 36-roll deck). The host can fine-tune victory points, fair dice and robber on top of any mode.
- **2–6 players**, humans and bots mixed freely. Hosts can add bots to a lobby, and replace an absent human with a bot mid-game.
- Full rules: setup snake-draft, dice and production, robber / discard / steal, roads, settlements, cities, development cards (Knight, Road Building, Year of Plenty, Monopoly, Victory Point), Longest Road, Largest Army, harbors, bank trades and player-to-player trades.
- Google sign-in, public lobby browser, private lobbies by 5-letter code, live lobby settings.
- Responsive UI (desktop and phone).

## Run it

It's a static site using ES modules, so serve the folder over HTTP:

```bash
python3 -m http.server 8000     # or: npx serve .
# open http://localhost:8000
```

Offline play works immediately. Online play needs the Firebase setup below.

## Enable online play (≈5 minutes)

Online play uses Firebase (free Spark plan is plenty): **Authentication** for Google sign-in and **Firestore** for lobbies and game sync.

1. Go to the [Firebase console](https://console.firebase.google.com) → **Add project**.
2. **Build → Authentication → Get started → Sign-in method → Google → Enable.**
3. **Authentication → Settings → Authorized domains** → add the domain you host on (e.g. `glametown.github.io`). `localhost` is already allowed.
4. **Build → Firestore Database → Create database** (production mode).
5. In Firestore open the **Rules** tab and paste the contents of [`firestore.rules`](firestore.rules), then **Publish**.
6. **Project settings → Your apps → Web (`</>`)** → register an app and copy the `firebaseConfig` values into [`js/config.js`](js/config.js).
7. Commit and deploy. Those values are not secrets — the rules and authorised domains are what protect the project.

### Deploy on GitHub Pages

Repo → **Settings → Pages → Deploy from a branch → `main` / root**. The game will be live at `https://<user>.github.io/<repo>/`.

## How online play works

Firestore is used as a simple message bus; the **lobby host's browser is the referee**.

```
players ──(action)──▶ lobbies/{id}/actions ──▶ host browser ──(rules engine validates)──▶ lobbies/{id}/state ──▶ everyone
```

- The host runs the same rules engine as offline play (`js/engine/game.js`), validates every action, drives bots, and publishes the new state.
- Players only ever send *requests* (roll, build here, offer this trade…). The host stamps each request with the sender's verified identity, so nobody can act as someone else or out of turn.
- If the host refreshes the page they can use **Rejoin last game**: the state lives in Firestore, so the game resumes where it was.

**Known limitations** (deliberate trade-offs to avoid running a server):

- The host's tab has to stay open for the game to progress. If the host disappears, the others wait.
- Game state includes every player's hand, so someone technically inclined could peek at it in the browser's network tools. Fine for friends; not suitable for competitive/ranked play. Moving the referee into a Cloud Function would fix this.

## Project layout

```
index.html, css/style.css
js/config.js            Firebase keys (fill in)
js/engine/              pure game logic — no DOM, runs in Node too
  geometry.js           hex grid → vertices / edges graph
  maps.js               map layouts, terrain / number / harbor generation
  modes.js              game-mode presets and rule switches
  game.js               rules engine: createGame(), applyAction()
  bot.js                heuristic computer players
js/net/host.js          authoritative game host (offline + online)
js/net/online.js        Firebase Auth + Firestore lobby / sync layer
js/ui/                  board renderer and screens
firestore.rules         security rules for the database
tests/simulate.mjs      plays full bot-vs-bot games on every map × mode
```

## Tests

```bash
npm test      # or: node tests/simulate.mjs 3
```

Plays complete games on every map/mode combination (2–6 players) and asserts the rules hold: no negative hands, the distance rule is never broken, piece counts always add up, and every game finishes with a legitimate winner.

## Adding your own map or mode

- **Map:** add an entry to `MAPS` in `js/engine/maps.js` with a `coords()` function returning axial `[q, r]` hex coordinates. Terrain, number tokens and harbors are generated automatically.
- **Mode:** add a preset to `MODES` in `js/engine/modes.js` using the switches in `DEFAULT_RULES` (victory points, production multiplier, robber on/off, starting hand, trade ratios, fair dice, discard limit).

*Unofficial fan project, not affiliated with or endorsed by the makers of CATAN®.*
