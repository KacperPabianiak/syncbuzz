# SyncBuzz

A fair buzzer for guessing games. The order is decided by when each press
actually happened, not by whose internet is faster.

**Play it here: https://kacperpabianiak.github.io/syncbuzz/**

Everything is in one file (`syncbuzz.html`, also published as `index.html`).
Open it in a browser. Nothing to install.

## How to play

1. The operator opens `syncbuzz.html`, enters a name and clicks **Create room**.
2. The operator sends friends the invite link (or the room code).
3. Friends open the link, type a name and click **Join**.
4. The operator clicks **Start round**. After a synced 3-2-1 countdown, everyone's
   button unlocks at the same moment.
5. Players press (click, tap or Space). The round ends by itself once everyone
   has pressed, or when the operator clicks **End round**.
6. The order shows for everyone and stays up until the operator clicks **Reset**
   or **Next round**. The operator can click a name to mark a wrong guess, which
   highlights the next person in line.

Operator settings: countdown length, what players see during a round (nothing,
how many pressed, who pressed), whether the operator plays too, and locking the
room. The operator can kick players.

## Sharing the page

- **Easiest:** put `syncbuzz.html` on any static host (for example GitHub Pages)
  and share the link. The invite link then works for everyone.
- **Without hosting:** send friends the file. Everyone opens it from disk, and
  friends join by pasting the room code.

## How the timing works

- The operator's browser is the reference clock. Each player's page keeps
  pinging it and works out the difference between the two clocks. Every ping
  gives a guaranteed range for that difference, and the page narrows it down
  using many pings. In tests it was accurate to within a few ms on normal
  connections (about 10 ms with a 1.3 s ping and heavy jitter).
- A press is stamped with the moment the browser registered the click, tap or
  key, converted to the operator's clock. The stamp, not the arrival time,
  decides the order.
- GO is scheduled a few seconds ahead on the operator's clock, so every button
  unlocks at the same real moment.
- After **End round**, the page waits a moment (1 to 3 s, depending on the
  slowest ping) for presses made before End that are still on their way.

## Safety

- It's a web page running in the browser's sandbox. Nothing is installed, no
  ports are opened and nothing keeps running after the tab closes.
- Players connect directly to the operator's browser over WebRTC, which is
  always encrypted. The free public PeerJS server (`0.peerjs.com`) is only used
  to introduce the browsers to each other. If a direct connection isn't
  possible, PeerJS's public relay passes the traffic along, and it stays
  encrypted.
- The PeerJS library is bundled inside the file. A strict Content-Security-Policy
  only allows the page's own code and connections to the PeerJS server.
- Room codes are random (about 50 bits). The operator sees everyone who joins
  and can kick or lock the room.
- Everything a player sends is checked: size, rate, format and plausibility of
  timestamps. Names are shown as plain text only.
- Limits:
  - A player who edits the page's code could fake a small head start, since the
    game trusts each player's clock. Presses whose timing doesn't fit that
    player's ping get a ⚠ for the operator.
  - Like most peer-to-peer games, the operator and players can see each other's
    IP addresses.

## Files

- `syncbuzz.html`: the app (built file, the only one you need)
- `index.html`: the same file, so the GitHub Pages address opens the app
- `src/`: source (`app.js`, `style.css`, `template.html`)
- `vendor/`: PeerJS 1.5.5 (MIT license)
- `build.mjs`: rebuilds `syncbuzz.html` from `src/` (`node build.mjs`)
- `tests/`: automated browser tests (see below)

## Testing

Add `&lag=800&jitter=100` to a player's link to simulate a slow connection in
that tab (a badge shows when it's on).

The automated tests start Chrome with an operator and three players at
different lags, check the order against the true press times, and try reloads,
kicking, locking and junk messages:

```bash
cd tests && npm install && npm test
```

They expect `syncbuzz.html` served at `http://localhost:8765/` (for example
`python -m http.server 8765` in this folder) and Chrome at its default Windows
path.
