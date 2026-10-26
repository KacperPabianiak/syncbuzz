/* SyncBuzz: a buzzer where the order is decided by when each press happened,
   not by whose internet is faster.

   - The operator's browser hosts the room and is the reference clock.
   - Players connect straight to it over WebRTC (PeerJS). The public PeerJS
     server is only used to introduce the browsers to each other.
   - Every player keeps measuring the difference between their clock and the
     host's, and stamps each press with the host-clock time it happened.
   - GO is scheduled in the future on the host clock, so every button unlocks
     at the same real moment no matter how slow each connection is. */
(() => {
  'use strict';

  // ------------------------------------------------------------ constants
  const PREFIX = 'syncbuzz';
  const PROTO = 1;
  const CODE_ALPHA = '23456789abcdefghjkmnpqrstuvwxyz';
  const CODE_LEN = 10;
  const ID_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const MAX_PLAYERS = 30;
  const MAX_FROM_PLAYER = 1024; // longest message (chars) a player may send
  const MAX_FROM_HOST = 65536;
  const NAME_MAX = 20;
  const SYNC_WINDOW = 30000; // clock samples older than this are dropped
  const DRIFT = 1e-4; // allowed drift between two computer clocks (100 ppm)
  const TIMER_RES = 1; // browsers round performance.now(); allow 1 ms
  const GRACE_MIN = 1000;
  const GRACE_MAX = 3000;
  const MIN_LEAD = 600; // GO is always at least this far in the future
  // Presses closer than this get a "very close" tag. Sync is usually good to a
  // few ms; the hard worst case (half the round trip) is shown in tooltips.
  const CLOSE_MS = 10;
  // Clock pings: frequent, so jittery connections still get enough clean
  // samples. A faster burst right after connecting gets sync ready quickly.
  const PING_EVERY = 500;
  const PING_BURST = 20;
  const PING_BURST_EVERY = 100;
  const HOST_PING_EVERY = 2000;
  const HOST_SILENCE = 12000; // host drops a player it hasn't heard from for this long
  const PLAYER_SILENCE = 9000; // player reconnects if the host is silent this long

  // ------------------------------------------------------------ helpers
  const $ = (id) => document.getElementById(id);
  const now = () => performance.now();
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  const int = (x) => (Number.isInteger(x) ? x : null);
  const str = (x, max) => (typeof x === 'string' ? x.slice(0, max) : '');
  const validToken = (t) => typeof t === 'string' && /^[A-Za-z0-9]{16,40}$/.test(t);

  function randFrom(alpha, n) {
    const buf = new Uint32Array(n);
    crypto.getRandomValues(buf);
    let s = '';
    for (let i = 0; i < n; i++) s += alpha[buf[i] % alpha.length];
    return s;
  }

  const store = {
    get(area, key) {
      try {
        const v = window[`${area}Storage`].getItem(key);
        return v ? JSON.parse(v) : null;
      } catch {
        return null;
      }
    },
    set(area, key, val) {
      try {
        window[`${area}Storage`].setItem(key, JSON.stringify(val));
      } catch {
        /* storage unavailable (private mode etc.): the app still works */
      }
    },
    del(area, key) {
      try {
        window[`${area}Storage`].removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };

  // Names are shown with textContent only, but still strip control and
  // direction-override characters so nobody can garble the list.
  function cleanName(s) {
    const t = String(s ?? '')
      .normalize('NFKC')
      .replace(/[\p{Cc}\p{Co}\u2028\u2029]|(?!\u200d)\p{Cf}/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
    return Array.from(t).slice(0, NAME_MAX).join('').trim();
  }

  function parseCode(s) {
    let t = String(s ?? '').trim();
    const m = t.match(/[#&?]join=([^&\s]+)/i);
    if (m) {
      try {
        t = decodeURIComponent(m[1]);
      } catch {
        t = m[1];
      }
    }
    const c = t.toLowerCase().replace(/[\s-]/g, '');
    return c.length === CODE_LEN && [...c].every((ch) => CODE_ALPHA.includes(ch)) ? c : null;
  }
  const fmtCode = (c) => `${c.slice(0, 5)}-${c.slice(5)}`;
  const hostPeerId = (code) => `${PREFIX}-${code}`;

  const fmtTime = (ms) => (ms == null ? '' : `+${(Math.max(0, ms) / 1000).toFixed(3)} s`);
  function fmtGap(ms) {
    if (ms == null) return '';
    if (ms < 10) return `+${ms.toFixed(1)} ms`;
    if (ms < 1000) return `+${Math.round(ms)} ms`;
    return `+${(ms / 1000).toFixed(2)} s`;
  }
  const fmtMs = (ms) => (ms == null ? '–' : `${Math.round(ms)} ms`);

  // Small DOM builder. Text always goes in as text nodes, never as HTML.
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      e.append(kid instanceof Node ? kid : String(kid));
    }
    return e;
  }
  function setText(el, v) {
    if (el.textContent !== v) el.textContent = v;
  }
  function setClass(el, v) {
    if (el.className !== v) el.className = v;
  }

  // Test helper: "#join=CODE&lag=800&jitter=100" adds fake network delay to
  // this tab (half each way, plus random jitter). Shown as a badge when on.
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const LAG = clamp(Number(params.get('lag')) || 0, 0, 10000);
  const JITTER = clamp(Number(params.get('jitter')) || 0, 0, 5000);
  // Like a real connection, delayed messages still arrive in order.
  const lagQueue = { out: 0, in: 0 };
  function withLag(fn, dir) {
    if (!(LAG || JITTER)) {
      fn();
      return;
    }
    const at = Math.max(lagQueue[dir], now() + LAG / 2 + Math.random() * JITTER);
    lagQueue[dir] = at;
    setTimeout(fn, at - now());
  }

  function setHash(core) {
    const extra = new URLSearchParams();
    if (LAG) extra.set('lag', String(LAG));
    if (JITTER) extra.set('jitter', String(JITTER));
    const tail = extra.toString();
    const hash = `#${core}${tail ? `&${tail}` : ''}`;
    try {
      history.replaceState(null, '', hash);
    } catch {
      location.hash = hash;
    }
  }

  function goHome() {
    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch {
      location.hash = '';
    }
    location.reload();
  }

  // The press time is taken from the input event itself (when the OS saw the
  // click/tap/key), not from when our code got around to handling it.
  function eventTime(ev) {
    const n = now();
    const ts = ev && typeof ev.timeStamp === 'number' ? ev.timeStamp : NaN;
    return ts > 0 && ts <= n + 1 && n - ts < 1000 ? Math.min(ts, n) : n;
  }

  // ------------------------------------------------------------ clock sync
  // One ping gives a guaranteed range for (host clock − my clock):
  //   [hostTime − receivedAt, hostTime − sentAt]
  // because the host read its clock somewhere between send and receive.
  // The true offset lies inside every range, so recent ranges are intersected:
  // the middle is the estimate and half the width is a hard error bound
  // (widened a little for timer rounding and for clock drift over time).
  class ClockSync {
    constructor() {
      this.reset();
    }
    reset() {
      this.samples = [];
      this.offset = null;
      this.unc = null;
      this.minRtt = null;
    }
    get ready() {
      return this.offset !== null && this.samples.length >= 5;
    }
    add(t0, th, t1) {
      const rtt = t1 - t0;
      if (!(rtt >= 0 && rtt < 10000) || !Number.isFinite(th)) return;
      this.samples.push({ lo: th - t1, hi: th - t0, at: t1, rtt });
      while (this.samples.length > 1 && (t1 - this.samples[0].at > SYNC_WINDOW || this.samples.length > 120)) {
        this.samples.shift();
      }
      for (;;) {
        let lo = -Infinity;
        let hi = Infinity;
        for (const s of this.samples) {
          const w = TIMER_RES + (t1 - s.at) * DRIFT;
          lo = Math.max(lo, s.lo - w);
          hi = Math.min(hi, s.hi + w);
        }
        if (lo <= hi) {
          this.offset = (lo + hi) / 2;
          this.unc = (hi - lo) / 2;
          break;
        }
        this.samples.shift(); // ranges disagree: a clock jumped, forget the oldest
      }
      this.minRtt = Math.min(...this.samples.map((s) => s.rtt));
    }
    toHost(t) {
      return t + this.offset;
    }
  }

  // ------------------------------------------------------------ PeerJS wrapper
  // Keeps one Peer alive: recreates it if it dies before opening, and
  // reconnects to the PeerJS server if that link drops later (open data
  // connections keep working while it does).
  class PeerKeeper {
    constructor(idFn, opts) {
      this.idFn = idFn;
      this.o = opts;
      this.tries = 0;
      this.stopped = false;
      this.timer = null;
      this.create();
    }
    status(s) {
      this.state = s;
      if (this.o.onStatus) this.o.onStatus(s);
    }
    create() {
      if (this.stopped) return;
      this.opened = false;
      let peer;
      try {
        peer = new Peer(this.idFn(), { debug: 0 });
      } catch {
        this.status('reconnecting');
        this.later(() => this.create());
        return;
      }
      this.peer = peer;
      this.status('connecting');
      peer.on('open', () => {
        if (this.peer !== peer || this.stopped) return;
        this.opened = true;
        this.tries = 0;
        this.status('online');
        if (this.o.onOpen) this.o.onOpen();
      });
      peer.on('connection', (c) => {
        if (this.peer !== peer || this.stopped || !this.o.onConnection) {
          try {
            c.close();
          } catch {
            /* ignore */
          }
          return;
        }
        this.o.onConnection(c);
      });
      peer.on('disconnected', () => {
        if (this.peer !== peer || this.stopped || peer.destroyed) return;
        this.status('reconnecting');
        this.later(() => {
          if (this.peer !== peer || peer.destroyed || !peer.disconnected) return;
          try {
            peer.reconnect();
          } catch {
            this.recreate();
          }
        });
      });
      peer.on('error', (err) => {
        if (this.peer !== peer || this.stopped) return;
        const type = err && err.type;
        const verdict = this.o.onError ? this.o.onError(type, this.opened) : null;
        if (verdict === 'stop') {
          this.stop();
          return;
        }
        // Errors before the first "open" destroy the Peer: build a new one.
        if (peer.destroyed) {
          this.status('reconnecting');
          this.later(() => this.create());
        }
      });
    }
    later(fn) {
      clearTimeout(this.timer);
      const delay = Math.min(10000, 1500 * 2 ** Math.min(this.tries, 3));
      this.tries++;
      this.timer = setTimeout(() => {
        if (!this.stopped) fn();
      }, delay);
    }
    recreate() {
      try {
        this.peer.destroy();
      } catch {
        /* ignore */
      }
      this.create();
    }
    stop() {
      this.stopped = true;
      clearTimeout(this.timer);
      try {
        this.peer.destroy();
      } catch {
        /* ignore */
      }
    }
  }

  // ------------------------------------------------------------ app state
  let MODE = 'home'; // 'home' | 'host' | 'player' | 'msg'
  let earlyUntil = 0;
  let armedKey = null; // two-step confirm buttons: which one is armed
  let armedTimer = null;

  function defaultSettings() {
    return { countdown: 3, show: 'count', hostPlays: true, locked: false };
  }
  function sanitizeSettings(s) {
    const out = defaultSettings();
    if (s && typeof s === 'object') {
      if ([0, 1, 2, 3, 5].includes(s.countdown)) out.countdown = s.countdown;
      if (['none', 'count', 'names'].includes(s.show)) out.show = s.show;
      if (typeof s.hostPlays === 'boolean') out.hostPlays = s.hostPlays;
      if (typeof s.locked === 'boolean') out.locked = s.locked;
    }
    return out;
  }

  // =================================================================== HOST
  const H = {
    code: '',
    name: '',
    epoch: randFrom(ID_ALPHA, 12), // changes on every page load of the host
    keeper: null,
    status: 'connecting',
    claimTries: 0,
    me: null,
    players: new Map(), // token -> player
    banned: new Set(),
    conns: new Set(),
    settings: defaultSettings(),
    round: null,
    seq: 0,
    finalizeTimer: null,
  };

  function idleRound(n) {
    return {
      n,
      phase: 'idle',
      goAt: null,
      endAt: null,
      finalizeAt: null,
      participants: new Set(),
      presses: new Map(),
      results: [],
      missing: [],
      wrong: new Set(),
      late: [],
    };
  }

  function newPublicId() {
    for (;;) {
      const id = randFrom(ID_ALPHA, 8);
      if (![...H.players.values()].some((p) => p.id === id)) return id;
    }
  }
  function newPlayer(token, name, id) {
    return { id: id || newPublicId(), token, name, online: false, conn: null, rtts: [], isHost: false };
  }
  function playerById(id) {
    if (id === 'host') return H.me;
    for (const p of H.players.values()) if (p.id === id) return p;
    return null;
  }
  function isOnline(id) {
    if (id === 'host') return H.settings.hostPlays;
    const p = playerById(id);
    return !!(p && p.online);
  }

  function uniqueName(base, self) {
    const taken = new Set(
      [H.me, ...H.players.values()].filter((p) => p && p !== self).map((p) => p.name.toLowerCase()),
    );
    if (!taken.has(base.toLowerCase())) return base;
    const stem = Array.from(base).slice(0, NAME_MAX - 3).join('');
    for (let i = 2; i < 100; i++) {
      const n = `${stem} ${i}`;
      if (!taken.has(n.toLowerCase())) return n;
    }
    return `${stem} ${randFrom(ID_ALPHA, 3)}`;
  }

  // Ping stats the host measured itself (players can't fake these lower).
  function pStats(p) {
    if (!p || p.isHost || !p.rtts.length) return { ping: null, min: null, hi: null };
    const r = p.rtts;
    const sorted = [...r].sort((a, b) => a - b);
    return { ping: sorted[Math.floor(sorted.length / 2)], min: sorted[0], hi: Math.max(...r.slice(-5)) };
  }
  // Worst-case clock error for a player: half their best round trip.
  function uncOf(p) {
    if (!p || p.isHost) return 0.5;
    const st = pStats(p);
    return st.min == null ? 50 : st.min / 2 + TIMER_RES;
  }
  function maxRttHi() {
    let m = 0;
    for (const p of H.players.values()) {
      if (!p.online) continue;
      const st = pStats(p);
      m = Math.max(m, st.hi ?? 300);
    }
    return m;
  }

  function createRoom(name) {
    const saved = { code: randFrom(CODE_ALPHA, CODE_LEN), name, settings: defaultSettings() };
    store.set('session', 'syncbuzz.host', saved);
    store.set('local', 'syncbuzz.name', name);
    startHost(saved);
  }

  function startHost(saved) {
    MODE = 'host';
    H.code = saved.code;
    H.name = cleanName(saved.name) || 'Operator';
    H.me = { id: 'host', token: null, name: H.name, isHost: true, online: true, conn: null, rtts: [] };
    H.settings = sanitizeSettings(saved.settings);
    H.banned = new Set(Array.isArray(saved.banned) ? saved.banned.filter(validToken) : []);
    H.players = new Map();
    for (const sp of Array.isArray(saved.players) ? saved.players : []) {
      if (!sp || !validToken(sp.token) || H.players.size >= MAX_PLAYERS || H.banned.has(sp.token)) continue;
      const id = typeof sp.id === 'string' && /^[A-Za-z0-9]{8}$/.test(sp.id) ? sp.id : null;
      H.players.set(sp.token, newPlayer(sp.token, cleanName(sp.name) || 'Player', id));
    }
    H.round = idleRound(int(saved.roundN) ?? 0);
    const sr = saved.results;
    if (sr && int(sr.n) === H.round.n && Array.isArray(sr.rows)) {
      const R = H.round;
      R.phase = 'results';
      R.results = sr.rows.slice(0, 64).map((r) => ({
        id: str(r.id, 16),
        name: cleanName(r.name) || '?',
        ms: num(r.ms),
        gap: num(r.gap),
        close: !!r.close,
        flags: Array.isArray(r.flags) ? r.flags.filter((f) => typeof f === 'string').slice(0, 4) : [],
      }));
      R.missing = Array.isArray(sr.missing) ? sr.missing.map((n) => cleanName(n)).filter(Boolean) : [];
      R.wrong = new Set(Array.isArray(sr.wrong) ? sr.wrong.map((x) => str(x, 16)) : []);
      R.late = Array.isArray(sr.late) ? sr.late.map((n) => cleanName(n)).filter(Boolean) : [];
    }
    setHash(`host=${H.code}`);
    saveHost();
    showScreen('game');
    H.keeper = new PeerKeeper(() => hostPeerId(H.code), {
      onOpen: () => {
        H.claimTries = 0;
      },
      onConnection: hostOnConnection,
      onStatus: (s) => {
        H.status = s;
        renderTop();
      },
      onError: hostPeerError,
    });
    setInterval(hostTick, 1000);
    window.addEventListener('beforeunload', (e) => {
      if ([...H.players.values()].some((p) => p.online)) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
    renderAll();
  }

  function hostPeerError(type, opened) {
    if (type === 'unavailable-id' && !opened) {
      // Usually our own previous page load still holding the code for a
      // moment. If it persists, the room is open somewhere else.
      H.claimTries++;
      if (H.claimTries > 6) {
        showMessage(
          'This room is already open',
          'It looks like this room is open in another tab or browser. Close it there, or create a new room.',
        );
        return 'stop';
      }
      H.status = 'claiming';
      renderTop();
    } else if (type === 'browser-incompatible') {
      showMessage('Browser not supported', 'This browser does not support WebRTC. Try a current Chrome, Edge, Firefox or Safari.');
      return 'stop';
    }
    return null;
  }

  function saveHost() {
    const R = H.round;
    store.set('session', 'syncbuzz.host', {
      code: H.code,
      name: H.name,
      settings: H.settings,
      players: [...H.players.values()].map((p) => ({ token: p.token, id: p.id, name: p.name })),
      banned: [...H.banned],
      roundN: R.n,
      results:
        R.phase === 'results'
          ? { n: R.n, rows: R.results, missing: R.missing, wrong: [...R.wrong], late: R.late }
          : null,
    });
  }

  function hostSend(c, obj) {
    try {
      if (c.conn.open) c.conn.send(JSON.stringify(obj));
    } catch {
      /* connection is going away; the close handler cleans up */
    }
  }

  function hostOnConnection(conn) {
    // Only our own message format is accepted: raw strings we parse ourselves.
    if (conn.serialization !== 'raw' || H.conns.size >= MAX_PLAYERS + 10) {
      try {
        conn.close();
      } catch {
        /* ignore */
      }
      return;
    }
    const c = {
      conn,
      player: null,
      bucket: 40,
      bucketAt: now(),
      strikes: 0,
      lastRx: now(),
      lastHp: 0,
      hpN: 0,
      hpSent: new Map(),
      closing: false,
      closed: false,
    };
    H.conns.add(c);
    const helloTimer = setTimeout(() => {
      if (!c.player) dropConn(c);
    }, 15000);
    conn.on('open', () => {
      c.lastRx = now();
    });
    conn.on('data', (d) => hostOnData(c, d));
    conn.on('close', () => {
      clearTimeout(helloTimer);
      hostConnClosed(c);
    });
    conn.on('error', () => {});
  }

  function dropConn(c) {
    try {
      c.conn.close();
    } catch {
      /* ignore */
    }
    hostConnClosed(c);
  }
  function bye(c, reason) {
    if (c.closing) return;
    hostSend(c, { type: 'bye', reason });
    c.closing = true;
    setTimeout(() => dropConn(c), 400);
  }
  function strike(c) {
    if (++c.strikes > 20) dropConn(c);
  }

  function hostConnClosed(c) {
    if (c.closed) return;
    c.closed = true;
    H.conns.delete(c);
    const p = c.player;
    if (p && p.conn === c) {
      p.conn = null;
      p.online = false;
      hostCheckAllPressed();
      broadcast();
    }
  }

  // Everything a player sends is untrusted: check type, size, rate and shape.
  function hostOnData(c, data) {
    const tr = now();
    c.lastRx = tr;
    if (c.closed || c.closing) return;
    if (typeof data !== 'string' || data.length > MAX_FROM_PLAYER) return strike(c);
    c.bucket = Math.min(40, c.bucket + (tr - c.bucketAt) * 0.02); // ~20 msgs/s sustained
    c.bucketAt = tr;
    if (c.bucket < 1) return strike(c);
    c.bucket -= 1;
    let m;
    try {
      m = JSON.parse(data);
    } catch {
      return strike(c);
    }
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.type !== 'string') return strike(c);
    if (m.type === 'hello') return hostHello(c, m);
    if (!c.player) return strike(c);
    switch (m.type) {
      case 'ping': {
        const n = int(m.n);
        if (n == null) return strike(c);
        hostSend(c, { type: 'pong', n, h: tr });
        return undefined;
      }
      case 'hq': {
        const n = int(m.n);
        const sent = n == null ? undefined : c.hpSent.get(n);
        if (sent == null) return undefined;
        c.hpSent.delete(n);
        const p = c.player;
        p.rtts.push(tr - sent);
        if (p.rtts.length > 15) p.rtts.shift();
        return undefined;
      }
      case 'press':
        return hostPress(c.player, m.round, m.t, c);
      case 'sync':
        hostSend(c, playerView(c.player));
        return undefined;
      case 'leave':
        return hostPlayerLeft(c);
      default:
        return strike(c);
    }
  }

  function hostHello(c, m) {
    if (c.player) return strike(c);
    if (m.v !== PROTO) return bye(c, 'version');
    if (!validToken(m.token)) return bye(c, 'bad');
    const token = m.token;
    if (H.banned.has(token)) return bye(c, 'kicked');
    let p = H.players.get(token);
    if (!p) {
      if (H.settings.locked) return bye(c, 'locked');
      if (H.players.size >= MAX_PLAYERS) return bye(c, 'full');
      p = newPlayer(token, '', null);
      H.players.set(token, p);
    }
    p.name = uniqueName(cleanName(m.name) || 'Player', p);
    if (p.conn && p.conn !== c) {
      const old = p.conn;
      p.conn = null;
      bye(old, 'replaced'); // same player opened the room in another tab
    }
    p.conn = c;
    p.online = true;
    c.player = p;
    hostSend(c, { type: 'welcome', v: PROTO, you: p.id, name: p.name, epoch: H.epoch });
    const R = H.round;
    if (R.phase === 'live') R.participants.add(p.id); // joined mid-round: may still play
    broadcast();
    return undefined;
  }

  function hostPlayerLeft(c) {
    const p = c.player;
    if (p) {
      H.players.delete(p.token);
      removeFromRound(p.id);
      p.conn = null;
    }
    dropConn(c);
    hostCheckAllPressed();
    broadcast();
  }

  function removeFromRound(id) {
    const R = H.round;
    if (R.phase === 'live' || R.phase === 'finalizing') {
      R.participants.delete(id);
      R.presses.delete(id);
    }
  }

  function hostTick() {
    const t = now();
    for (const c of H.conns) {
      if (!c.player || c.closing) continue;
      if (t - c.lastRx > HOST_SILENCE) {
        dropConn(c);
        continue;
      }
      if (t - c.lastHp >= HOST_PING_EVERY) {
        c.lastHp = t;
        const n = ++c.hpN;
        c.hpSent.set(n, t);
        if (c.hpSent.size > 10) c.hpSent.delete(c.hpSent.keys().next().value);
        hostSend(c, { type: 'hp', n });
      }
    }
    renderPlayers();
  }

  // ---- round flow
  function onlineParticipantIds() {
    const ids = [...H.players.values()].filter((p) => p.online).map((p) => p.id);
    if (H.settings.hostPlays) ids.unshift('host');
    return ids;
  }

  function hostStartRound() {
    const R = H.round;
    if (R.phase === 'live' || R.phase === 'finalizing') return;
    clearTimeout(H.finalizeTimer);
    const t = now();
    const lead = Math.max(H.settings.countdown * 1000, MIN_LEAD, Math.min(2500, maxRttHi() * 1.5 + 200));
    H.round = idleRound(R.n + 1);
    Object.assign(H.round, {
      phase: 'live',
      goAt: t + lead,
      participants: new Set(onlineParticipantIds()),
    });
    broadcast();
  }

  function hostEndRound() {
    const R = H.round;
    if (R.phase !== 'live') return;
    const t = now();
    if (t < R.goAt) {
      // Ended during the countdown: just cancel the round.
      H.round = idleRound(R.n);
      broadcast();
      return;
    }
    R.endAt = t;
    R.phase = 'finalizing';
    // Wait long enough for presses that happened before End to arrive.
    const grace = clamp(maxRttHi() * 1.5 + 500, GRACE_MIN, GRACE_MAX);
    R.finalizeAt = t + grace;
    clearTimeout(H.finalizeTimer);
    H.finalizeTimer = setTimeout(hostFinalize, grace);
    broadcast();
    hostCheckAllPressed();
  }

  function hostCheckAllPressed() {
    const R = H.round;
    if (R.phase !== 'live' && R.phase !== 'finalizing') return;
    if (now() < R.goAt) return;
    const ids = [...R.participants];
    if (!ids.length) return;
    const waiting = ids.filter((id) => !R.presses.has(id));
    if (!waiting.length) {
      hostFinalize();
      return;
    }
    // Only disconnected players are left: end with the usual grace period,
    // so a press they made just before dropping can still arrive.
    if (R.phase === 'live' && R.presses.size > 0 && waiting.every((id) => !isOnline(id))) hostEndRound();
  }

  function hostFinalize() {
    const R = H.round;
    if (R.phase !== 'live' && R.phase !== 'finalizing') return;
    clearTimeout(H.finalizeTimer);
    if (R.endAt == null) R.endAt = now();
    R.phase = 'results';
    computeResults();
    broadcast();
  }

  function hostReset() {
    clearTimeout(H.finalizeTimer);
    H.round = idleRound(H.round.n);
    broadcast();
  }

  function hostPress(p, round, t, c) {
    const R = H.round;
    const arr = now();
    const ack = (ok, reason, extra) => {
      if (c) hostSend(c, { type: 'ack', round: int(round), ok, reason, ...extra });
    };
    if (int(round) !== R.n || R.phase === 'idle') return ack(false, 'over');
    if (num(t) == null) return ack(false, 'bad');
    if (R.presses.has(p.id)) return ack(true, 'dup', { ms: R.presses.get(p.id).t - R.goAt });
    if (t < R.goAt) return ack(false, 'early');
    if (R.endAt != null && t >= R.endAt) return ack(false, 'late');
    if (!R.participants.has(p.id)) {
      if (R.phase !== 'live') return ack(false, 'over');
      R.participants.add(p.id);
    }
    // Sanity checks on the claimed time. A press can't have happened after it
    // arrived; and one that claims to be much older than this player's ping
    // explains gets flagged for the operator.
    const flags = [];
    let tt = t;
    if (tt > arr) {
      if (tt - arr > 20) flags.push('future');
      tt = arr;
    }
    if (!p.isHost) {
      const st = pStats(p);
      if (arr - tt > Math.max(400, 3 * (st.hi ?? 300))) flags.push('slow');
    }
    if (R.phase === 'results') flags.push('late');
    R.presses.set(p.id, { t: tt, arr, flags, name: p.name });
    ack(true, 'ok', { ms: tt - R.goAt });
    if (R.phase === 'results') {
      // Arrived after the results went up (e.g. the player's connection
      // dropped right after pressing). Still counts; everyone is told.
      R.late.push(p.name);
      computeResults();
      broadcast();
      return undefined;
    }
    broadcast();
    hostCheckAllPressed();
    return undefined;
  }

  function computeResults() {
    const R = H.round;
    const list = [...R.presses].map(([id, e]) => ({ id, ...e })).sort((a, b) => a.t - b.t || a.arr - b.arr);
    R.results = list.map((e, i) => {
      const prev = list[i - 1];
      const gap = prev ? e.t - prev.t : null;
      return {
        id: e.id,
        name: e.name,
        ms: e.t - R.goAt,
        gap,
        close: prev ? gap < CLOSE_MS : false,
        flags: e.flags,
      };
    });
    R.missing = [...R.participants]
      .filter((id) => !R.presses.has(id))
      .map((id) => playerById(id))
      .filter(Boolean)
      .map((p) => p.name);
  }

  function hostToggleWrong(id) {
    const R = H.round;
    if (R.phase !== 'results') return;
    if (R.wrong.has(id)) R.wrong.delete(id);
    else R.wrong.add(id);
    broadcast();
  }

  function hostKick(p) {
    H.banned.add(p.token);
    H.players.delete(p.token);
    removeFromRound(p.id);
    if (p.conn) bye(p.conn, 'kicked');
    p.conn = null;
    p.online = false;
    hostCheckAllPressed();
    broadcast();
  }
  function hostForget(p) {
    H.players.delete(p.token);
    removeFromRound(p.id);
    hostCheckAllPressed();
    broadcast();
  }

  function hostCloseRoom() {
    for (const c of H.conns) hostSend(c, { type: 'bye', reason: 'closed' });
    store.del('session', 'syncbuzz.host');
    setTimeout(() => {
      if (H.keeper) H.keeper.stop();
      H.players.clear(); // lets the page close without the "leave site?" prompt
      goHome();
    }, 300);
  }

  function hostBuzz(ev) {
    const R = H.round;
    if (!H.settings.hostPlays || R.phase !== 'live' || R.presses.has('host')) return;
    const t = eventTime(ev);
    if (t < R.goAt) {
      flashEarly();
      return;
    }
    hostPress(H.me, R.n, t, null);
  }

  // What one player is allowed to see.
  function playerView(p) {
    const R = H.round;
    const show = H.settings.show;
    const inRound = R.phase === 'live' || R.phase === 'finalizing';
    const reveal = R.phase === 'results' || (inRound && show === 'names');
    const mine = R.presses.get(p.id);
    return {
      type: 'state',
      seq: H.seq,
      epoch: H.epoch,
      round: R.n,
      phase: R.phase,
      goAt: R.goAt,
      endAt: R.endAt,
      finalizeAt: R.finalizeAt,
      show,
      players: [H.me, ...H.players.values()].map((x) => ({
        id: x.id,
        name: x.name,
        online: x.isHost ? true : x.online,
        host: !!x.isHost,
        plays: x.isHost ? H.settings.hostPlays : true,
        pressed: reveal && R.presses.has(x.id),
      })),
      count: inRound && show !== 'none' ? { pressed: R.presses.size, total: R.participants.size } : null,
      participant: inRound ? R.participants.has(p.id) : true,
      you: mine ? { ms: mine.t - R.goAt } : null,
      results:
        R.phase === 'results'
          ? R.results.map((r) => ({
              id: r.id,
              name: r.name,
              ms: r.ms,
              gap: r.gap,
              close: r.close,
              late: r.flags.includes('late'),
              wrong: R.wrong.has(r.id),
            }))
          : null,
      missing: R.phase === 'results' ? R.missing : null,
      late: R.phase === 'results' ? R.late : null,
    };
  }

  function broadcast() {
    H.seq++;
    for (const p of H.players.values()) {
      if (p.conn && !p.conn.closing) hostSend(p.conn, playerView(p));
    }
    saveHost();
    renderAll();
  }

  // ================================================================= PLAYER
  const P = {
    code: '',
    name: '',
    token: '',
    keeper: null,
    conn: null,
    connOpened: false,
    welcomed: false,
    connMsg: 'Connecting to the room…',
    lastRx: 0,
    tries: 0,
    retryTimer: null,
    clock: new ClockSync(),
    epoch: null,
    myId: null,
    state: null,
    lastSeq: -1,
    pingN: 0,
    pingsSent: new Map(),
    pingTimer: null,
    burst: 0,
    press: null, // { round, th, epoch, status: 'queued'|'sent'|'ok'|'rejected', reason, ms }
    stopped: false,
  };

  function startPlayer(code, name) {
    MODE = 'player';
    P.code = code;
    P.name = name;
    const saved = store.get('session', 'syncbuzz.player');
    P.token = saved && saved.code === code && validToken(saved.token) ? saved.token : randFrom(ID_ALPHA, 24);
    store.set('session', 'syncbuzz.player', { code, name, token: P.token, joined: true });
    store.set('local', 'syncbuzz.name', name);
    setHash(`join=${code}`);
    showScreen('game');
    P.keeper = new PeerKeeper(() => `${PREFIX}-${code}-${randFrom(ID_ALPHA, 16)}`, {
      onOpen: playerConnect,
      onStatus: () => renderTop(),
      onError: playerPeerError,
    });
    setInterval(playerTick, 500);
    renderAll();
  }

  function playerPeerError(type) {
    if (type === 'peer-unavailable') {
      const msg = 'Room not found. Is the operator’s page open? Retrying…';
      P.connMsg = msg;
      if (P.conn && !P.connOpened) dropPlayerConn(msg);
    } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(type)) {
      P.connMsg = 'Can’t reach the connection server. Retrying…';
    } else if (type === 'browser-incompatible') {
      showMessage('Browser not supported', 'This browser does not support WebRTC. Try a current Chrome, Edge, Firefox or Safari.');
      return 'stop';
    }
    renderAll();
    return null;
  }

  function playerConnect() {
    if (P.stopped || P.conn) return;
    const peer = P.keeper && P.keeper.peer;
    if (!peer || peer.destroyed || peer.disconnected || !P.keeper.opened) return; // onOpen calls us again
    let conn;
    try {
      conn = peer.connect(hostPeerId(P.code), { serialization: 'raw', reliable: true });
    } catch {
      conn = null;
    }
    if (!conn) {
      scheduleReconnect();
      return;
    }
    P.conn = conn;
    P.connOpened = false;
    const openTimer = setTimeout(() => {
      if (P.conn === conn && !P.connOpened) dropPlayerConn('Couldn’t reach the operator. Retrying…');
    }, 15000);
    conn.on('open', () => {
      if (P.conn !== conn) return;
      clearTimeout(openTimer);
      P.connOpened = true;
      P.lastRx = now();
      playerSend({ type: 'hello', v: PROTO, token: P.token, name: P.name });
    });
    conn.on('data', (d) => {
      if (P.conn !== conn) return;
      withLag(() => {
        if (P.conn === conn) playerOnData(d);
      }, 'in');
    });
    conn.on('close', () => {
      clearTimeout(openTimer);
      if (P.conn === conn) {
        P.conn = null;
        onPlayerDisconnected();
      }
    });
    conn.on('error', () => {});
  }

  function dropPlayerConn(msg) {
    const c = P.conn;
    P.conn = null;
    try {
      if (c) c.close();
    } catch {
      /* ignore */
    }
    onPlayerDisconnected(msg);
  }

  function onPlayerDisconnected(msg) {
    P.connOpened = false;
    P.welcomed = false;
    clearTimeout(P.pingTimer);
    if (P.stopped) return;
    if (msg) P.connMsg = msg;
    else if (P.everWelcomed) P.connMsg = 'Connection lost. Reconnecting…';
    scheduleReconnect();
    renderAll();
  }

  function scheduleReconnect() {
    clearTimeout(P.retryTimer);
    const delay = Math.min(5000, 1000 + 700 * P.tries++);
    P.retryTimer = setTimeout(playerConnect, delay);
  }

  function playerSend(obj) {
    const c = P.conn;
    if (!c || !P.connOpened) return false;
    const s = JSON.stringify(obj);
    withLag(() => {
      try {
        if (c.open) c.send(s);
      } catch {
        /* closing */
      }
    }, 'out');
    return true;
  }

  function playerTick() {
    if (P.welcomed && now() - P.lastRx > PLAYER_SILENCE) dropPlayerConn('Lost contact with the operator. Reconnecting…');
    // Safety net: ask for the current state if it somehow never arrived.
    if (P.welcomed && !P.state && now() - P.welcomedAt > 3000 && now() - (P.syncAskedAt || 0) > 3000) {
      P.syncAskedAt = now();
      playerSend({ type: 'sync' });
    }
    renderTop();
  }

  function playerOnData(data) {
    const tr = now();
    P.lastRx = tr;
    if (typeof data !== 'string' || data.length > MAX_FROM_HOST) return;
    let m;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return;
    switch (m.type) {
      case 'welcome':
        playerWelcome(m);
        break;
      case 'pong': {
        const n = int(m.n);
        const t0 = n == null ? undefined : P.pingsSent.get(n);
        if (t0 == null || num(m.h) == null) return;
        P.pingsSent.delete(n);
        const wasReady = P.clock.ready;
        P.clock.add(t0, m.h, tr);
        if (P.clock.ready !== wasReady) renderAll();
        else renderTop();
        break;
      }
      case 'hp':
        if (int(m.n) != null) playerSend({ type: 'hq', n: m.n });
        break;
      case 'state':
        playerState(m);
        break;
      case 'ack':
        playerAck(m);
        break;
      case 'bye':
        playerBye(str(m.reason, 20));
        break;
      default:
        break;
    }
  }

  function playerWelcome(m) {
    if (typeof m.epoch !== 'string') return;
    if (P.epoch !== m.epoch) {
      // The operator's page was reloaded: its clock restarted.
      P.clock.reset();
      P.epoch = m.epoch;
      P.lastSeq = -1;
      P.state = null;
      if (P.press && P.press.epoch !== m.epoch) P.press = null;
    }
    P.myId = str(m.you, 16);
    P.name = cleanName(m.name) || P.name;
    P.welcomed = true;
    P.welcomedAt = now();
    P.everWelcomed = true;
    P.tries = 0;
    P.connMsg = '';
    P.burst = PING_BURST;
    clearTimeout(P.pingTimer);
    pingLoop();
    if (P.press && (P.press.status === 'queued' || P.press.status === 'sent')) sendPress();
    renderAll();
  }

  function pingLoop() {
    if (!P.welcomed) return;
    const n = ++P.pingN;
    P.pingsSent.set(n, now());
    if (P.pingsSent.size > 40) P.pingsSent.delete(P.pingsSent.keys().next().value);
    playerSend({ type: 'ping', n });
    let delay = PING_EVERY;
    if (P.burst > 0) {
      P.burst--;
      delay = PING_BURST_EVERY;
    }
    P.pingTimer = setTimeout(pingLoop, delay);
  }

  function normState(m) {
    const names = (a) => (Array.isArray(a) ? a.slice(0, 64).map((n) => cleanName(n) || '?') : []);
    return {
      round: int(m.round) ?? 0,
      phase: ['idle', 'live', 'finalizing', 'results'].includes(m.phase) ? m.phase : 'idle',
      goAt: num(m.goAt),
      endAt: num(m.endAt),
      finalizeAt: num(m.finalizeAt),
      show: ['none', 'count', 'names'].includes(m.show) ? m.show : 'count',
      players: Array.isArray(m.players)
        ? m.players.slice(0, 64).filter((x) => x && typeof x === 'object').map((x) => ({
            id: str(x.id, 16),
            name: cleanName(x.name) || '?',
            online: !!x.online,
            host: !!x.host,
            plays: x.plays !== false,
            pressed: !!x.pressed,
          }))
        : [],
      count:
        m.count && typeof m.count === 'object'
          ? { pressed: int(m.count.pressed) ?? 0, total: int(m.count.total) ?? 0 }
          : null,
      participant: !!m.participant,
      you: m.you && typeof m.you === 'object' && num(m.you.ms) != null ? { ms: m.you.ms } : null,
      results: Array.isArray(m.results)
        ? m.results.slice(0, 64).filter((r) => r && typeof r === 'object').map((r) => ({
            id: str(r.id, 16),
            name: cleanName(r.name) || '?',
            ms: num(r.ms),
            gap: num(r.gap),
            close: !!r.close,
            late: !!r.late,
            wrong: !!r.wrong,
          }))
        : null,
      missing: names(m.missing),
      late: names(m.late),
    };
  }

  function playerState(m) {
    if (m.epoch !== P.epoch) return;
    const seq = int(m.seq);
    if (seq == null || seq <= P.lastSeq) return; // out-of-order update
    P.lastSeq = seq;
    const s = normState(m);
    P.state = s;
    if (P.press && (P.press.round !== s.round || s.phase === 'idle')) P.press = null;
    if (!P.press && s.you && s.phase !== 'idle') P.press = { round: s.round, th: null, epoch: P.epoch, status: 'ok', ms: s.you.ms };
    renderAll();
  }

  function playerAck(m) {
    const pr = P.press;
    if (!pr || int(m.round) !== pr.round) return;
    if (m.ok) {
      pr.status = 'ok';
      if (num(m.ms) != null) pr.ms = m.ms;
    } else if (m.reason === 'early') {
      P.press = null;
      flashEarly();
    } else {
      pr.status = 'rejected';
      pr.reason = str(m.reason, 12);
    }
    renderAll();
  }

  function playerBye(reason) {
    const texts = {
      kicked: ['You were removed', 'The operator removed you from this room.'],
      locked: ['The room is locked', 'The operator isn’t letting new players in right now. Ask them to unlock the room.'],
      full: ['The room is full', `This room already has ${MAX_PLAYERS} players.`],
      version: ['Different version', 'Your page is a different version from the operator’s. Ask them for a fresh invite link.'],
      replaced: ['Opened somewhere else', 'You joined this room from another tab or window, so this one was disconnected.'],
      closed: ['The room was closed', 'The operator closed the room.'],
      bad: ['Couldn’t join', 'Something went wrong while joining. Try the invite link again.'],
    };
    const [title, text] = texts[reason] || ['Disconnected', 'The operator ended the connection.'];
    P.stopped = true;
    clearTimeout(P.retryTimer);
    clearTimeout(P.pingTimer);
    store.del('session', 'syncbuzz.player');
    if (P.keeper) P.keeper.stop();
    showMessage(title, text);
  }

  function playerBuzz(ev) {
    const s = P.state;
    if (!s || s.phase !== 'live' || !P.clock.ready || !P.welcomed) return;
    if (P.press && P.press.round === s.round) return;
    const th = P.clock.toHost(eventTime(ev));
    if (th < s.goAt) {
      flashEarly();
      return;
    }
    P.press = { round: s.round, th, epoch: P.epoch, status: 'queued', ms: th - s.goAt };
    sendPress();
    renderAll();
  }

  function sendPress() {
    const pr = P.press;
    if (!pr || pr.th == null) return;
    if (playerSend({ type: 'press', round: pr.round, t: pr.th }) && pr.status === 'queued') pr.status = 'sent';
  }

  function playerLeave() {
    playerSend({ type: 'leave' });
    P.stopped = true;
    store.del('session', 'syncbuzz.player');
    setTimeout(() => {
      if (P.keeper) P.keeper.stop();
      goHome();
    }, 300);
  }

  // ===================================================================== UI
  let loopStarted = false;
  function showScreen(name) {
    $('screenHome').hidden = name !== 'home';
    $('screenGame').hidden = name !== 'game';
    $('screenMsg').hidden = name !== 'msg';
    if (name === 'game' && !loopStarted) {
      loopStarted = true;
      requestAnimationFrame(uiLoop);
    }
  }

  function showMessage(title, text) {
    MODE = 'msg';
    $('msgTitle').textContent = title;
    $('msgText').textContent = text;
    $('topStatus').hidden = true;
    $('roomBadge').hidden = true;
    $('btnLeave').hidden = true;
    showScreen('msg');
  }

  function showHome(code) {
    MODE = 'home';
    const name = cleanName(store.get('local', 'syncbuzz.name') || '');
    $('hostName').value = name;
    $('joinName').value = name;
    if (code) {
      // Arrived through an invite link: only show the join form.
      $('formHost').hidden = true;
      document.querySelector('.cards').classList.add('single');
      $('homeTitle').textContent = 'You’re invited';
      $('homeLead').textContent = 'Enter your name to join the game.';
      $('joinTitle').textContent = `Join room ${fmtCode(code)}`;
      $('joinLead').hidden = true;
      $('joinCodeField').hidden = true;
      $('joinCode').value = code;
    }
    showScreen('home');
    if (LAG || JITTER) renderTop();
  }

  function flashEarly() {
    earlyUntil = now() + 700;
    const st = $('stage');
    st.classList.remove('is-early');
    void st.offsetWidth; // restart the shake animation
    st.classList.add('is-early');
  }

  function buzz(ev) {
    if (MODE === 'host') hostBuzz(ev);
    else if (MODE === 'player') playerBuzz(ev);
  }

  function arm(key, fn) {
    if (armedKey === key) {
      armedKey = null;
      clearTimeout(armedTimer);
      fn();
      return;
    }
    armedKey = key;
    clearTimeout(armedTimer);
    armedTimer = setTimeout(() => {
      armedKey = null;
      renderAll();
    }, 3000);
    renderAll();
  }

  function inviteLink() {
    const base = location.href.split('#')[0];
    return `${base}#join=${H.code}`;
  }

  function copyInvite() {
    const link = inviteLink();
    const done = () => {
      $('btnCopy').textContent = 'Copied';
      setTimeout(() => {
        $('btnCopy').textContent = 'Copy';
      }, 1500);
    };
    const fallback = () => {
      const inp = $('inviteLink');
      inp.focus();
      inp.select();
      try {
        if (document.execCommand('copy')) done();
      } catch {
        /* the link stays selected so it can be copied by hand */
      }
    };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(link).then(done, fallback);
    else fallback();
  }

  // ---- view models
  function stageModel() {
    const t = now();
    if (MODE === 'host') {
      const R = H.round;
      const mine = R.presses.get('host');
      const inRound = R.phase === 'live' || R.phase === 'finalizing';
      return {
        t,
        connected: true,
        ready: true,
        phase: R.phase,
        goAt: R.goAt,
        plays: H.settings.hostPlays,
        participant: inRound ? R.participants.has('host') : H.settings.hostPlays,
        press: mine ? { status: 'ok', ms: mine.t - R.goAt } : null,
        count: inRound ? { pressed: R.presses.size, total: R.participants.size } : null,
      };
    }
    const s = P.state;
    const off = P.clock.offset ?? 0;
    const pr = P.press && s && P.press.round === s.round ? P.press : null;
    return {
      t,
      connected: P.welcomed && !!s,
      ready: P.clock.ready,
      phase: s ? s.phase : null,
      goAt: s && s.goAt != null ? s.goAt - off : null,
      plays: true,
      participant: s ? s.participant : false,
      press: pr,
      count: s ? s.count : null,
    };
  }

  const REJECT_TEXT = {
    late: 'Too late: the round had already ended.',
    over: 'That round is already over.',
    bad: 'Something went wrong with that press.',
  };

  function stageView(m) {
    if (MODE === 'player' && !m.connected) return { face: '…', cls: 'is-off', title: P.connMsg || 'Connecting…', sub: '' };
    if (MODE === 'player' && !m.ready) return { face: '…', cls: 'is-off', title: 'Syncing clocks…', sub: '' };
    const watch = !m.plays;
    if (m.phase === 'idle') {
      return {
        face: 'WAIT',
        cls: 'is-off',
        title: watch ? 'You’re not playing' : 'Waiting for the next round',
        sub: MODE === 'host' ? 'Press Start round when everyone is ready.' : 'The operator will start it.',
      };
    }
    if (m.phase === 'live' && m.goAt != null && m.t < m.goAt) {
      return { face: String(Math.max(1, Math.ceil((m.goAt - m.t) / 1000))), cls: `is-count${watch ? ' is-watch' : ''}`, title: 'Get ready…', sub: '' };
    }
    if (m.press) {
      const pr = m.press;
      if (pr.status === 'rejected') return { face: '✕', cls: 'is-bad', title: 'Press not counted', sub: REJECT_TEXT[pr.reason] || '' };
      let sub = 'Counted. Waiting for the others…';
      if (pr.status === 'queued') sub = 'Offline: it will be sent as soon as you’re back.';
      else if (pr.status === 'sent') sub = 'Sending…';
      else if (m.phase === 'finalizing') sub = 'Counted. Collecting the last presses…';
      return { face: '✓', cls: 'is-done', title: `You pressed at ${fmtTime(pr.ms)}`, sub };
    }
    if (m.phase === 'finalizing') return { face: '…', cls: 'is-off', title: 'Round over', sub: 'Collecting the last presses…' };
    if (watch) return { face: 'LIVE', cls: 'is-live is-watch', title: 'Round is live', sub: 'You’re not playing this round.' };
    if (!m.participant) return { face: 'WAIT', cls: 'is-off', title: 'This round is already running', sub: 'You can play from the next round.' };
    return { face: 'PRESS', cls: 'is-live', title: 'GO!', sub: 'Click, tap or press Space' };
  }

  function renderStage() {
    if (MODE !== 'host' && MODE !== 'player') return;
    const m = stageModel();
    const v = stageView(m);
    const early = m.t < earlyUntil;
    setText($('stageTitle'), v.title);
    setText($('stageSub'), early ? 'Too early! Wait for GO.' : v.sub);
    setText($('buzzFace'), v.face);
    setClass($('buzz'), `buzz ${v.cls}`);
    if (!early && $('stage').classList.contains('is-early')) $('stage').classList.remove('is-early');
    let prog = '';
    if ((m.phase === 'live' && m.goAt != null && m.t >= m.goAt) || m.phase === 'finalizing') {
      if (m.count) prog = `${m.count.pressed} of ${m.count.total} pressed`;
    }
    setText($('stageProgress'), prog);
    if (MODE === 'host') {
      const R = H.round;
      const counting = R.phase === 'live' && m.t < R.goAt;
      setText($('btnEnd'), counting ? 'Cancel' : 'End round');
    }
  }

  function renderTop() {
    const lag = $('lagBadge');
    lag.hidden = !(LAG || JITTER);
    if (LAG || JITTER) lag.textContent = `Test lag ${LAG} ms${JITTER ? ` ±${JITTER}` : ''}`;
    if (MODE !== 'host' && MODE !== 'player') return;
    const badge = $('roomBadge');
    badge.hidden = false;
    badge.textContent = `Room ${fmtCode(MODE === 'host' ? H.code : P.code)}`;
    const leave = $('btnLeave');
    leave.hidden = MODE !== 'player';
    setText(leave, armedKey === 'leave' ? 'Click again to leave' : 'Leave room');
    leave.classList.toggle('armed', armedKey === 'leave');
    const box = $('topStatus');
    box.hidden = false;
    let cls = 'warn';
    let text = '';
    let tip = '';
    if (MODE === 'host') {
      const s = H.status;
      if (s === 'online') {
        cls = 'good';
        text = 'Room open';
      } else if (s === 'claiming') text = 'Opening room…';
      else if (s === 'reconnecting' && H.keeper && H.keeper.opened) text = 'Connection server lost: new players can’t join until it’s back';
      else text = 'Opening room…';
    } else if (P.welcomed) {
      cls = 'good';
      const c = P.clock;
      text = c.ready ? `Connected · ping ${fmtMs(c.minRtt)} · clock synced` : 'Connected · syncing clocks…';
      tip = c.ready
        ? `Clock sync: usually accurate to a few ms. Guaranteed worst case ±${fmtMs(c.unc)} (half your best round trip), only reached on very lopsided connections.`
        : '';
    } else {
      text = P.connMsg || 'Connecting…';
    }
    setClass(box, `status ${cls}`);
    setText($('topStatusText'), text);
    if (box.title !== tip) box.title = tip;
  }

  function resultsData() {
    if (MODE === 'host') {
      const R = H.round;
      if (R.phase !== 'results') return null;
      return {
        n: R.n,
        rows: R.results.map((r) => ({
          ...r,
          late: r.flags.includes('late'),
          wrong: R.wrong.has(r.id),
          warn: r.flags.filter((f) => f === 'slow' || f === 'future'),
        })),
        missing: R.missing,
        late: R.late,
        myId: 'host',
      };
    }
    const s = P.state;
    if (!s || s.phase !== 'results' || !s.results || !P.welcomed) return null;
    return { n: s.round, rows: s.results.map((r) => ({ ...r, warn: [] })), missing: s.missing, late: s.late, myId: P.myId };
  }

  const WARN_TEXT = {
    slow: 'This press arrived much later than this player’s ping explains. It may have been delayed, or its time may be faked.',
    future: 'This press was stamped later than it arrived, so its clock sync was off. It was moved to its arrival time.',
  };

  function renderResults() {
    const d = resultsData();
    const card = $('resultsCard');
    if (!d) {
      card.hidden = true;
      $('stage').hidden = false;
      return;
    }
    card.hidden = false;
    $('stage').hidden = true;
    setText($('resultsTitle'), `Round ${d.n}`);
    setText($('resultsMeta'), 'Order of presses');
    const banner = $('resultsBanner');
    banner.hidden = !d.late.length;
    if (d.late.length) {
      banner.textContent = `Order updated: a press from ${d.late.join(', ')} arrived after the results went up. It's placed by its actual time.`;
    }
    const currentIdx = d.rows.findIndex((r) => !r.wrong);
    const isHost = MODE === 'host';
    const list = $('resultsList');
    list.replaceChildren(
      ...d.rows.map((r, i) => {
        const tags = [];
        if (i === currentIdx && d.rows.length > 1) tags.push(h('span', { class: 'pill pill-accent', text: 'guessing now' }));
        if (r.wrong) tags.push(h('span', { class: 'pill pill-bad', text: 'wrong' }));
        if (r.close) {
          tags.push(
            h('span', {
              class: 'pill',
              text: '≈ very close',
              title: `Less than ${CLOSE_MS} ms apart. That's about as fine as clock sync can reliably tell, so treat it as a near tie.`,
            }),
          );
        }
        if (r.late) tags.push(h('span', { class: 'pill pill-warn', text: 'arrived late' }));
        for (const w of r.warn) tags.push(h('span', { class: 'pill pill-warn', text: '⚠ check timing', title: WARN_TEXT[w] }));
        const row = h(
          'li',
          {
            class: `rank-row${i === currentIdx && d.rows.length > 1 ? ' current' : ''}${r.wrong ? ' wrong' : ''}${isHost ? ' clickable' : ''}`,
            title: isHost ? (r.wrong ? 'Click to unmark' : 'Click to mark as a wrong guess') : null,
            tabindex: isHost ? '0' : null,
            role: isHost ? 'button' : null,
          },
          h('span', { class: 'rank-num', text: String(i + 1) }),
          h('span', { class: 'rank-name' }, r.name, r.id === d.myId ? h('span', { class: 'pill', text: 'you' }) : null),
          h('span', { class: 'rank-time', text: fmtTime(r.ms) }),
          h('span', { class: 'rank-meta' }, tags),
          h('span', { class: 'rank-gap', text: r.gap == null ? 'first' : fmtGap(r.gap) }),
        );
        if (isHost) {
          row.addEventListener('click', () => hostToggleWrong(r.id));
          row.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              hostToggleWrong(r.id);
            }
          });
        }
        return row;
      }),
    );
    $('resultsEmpty').hidden = d.rows.length > 0;
    const miss = $('resultsMissing');
    miss.hidden = !d.missing.length;
    miss.textContent = d.missing.length ? `Didn't press: ${d.missing.join(', ')}` : '';
    setText(
      $('resultsHint'),
      isHost
        ? 'Click a name to mark a wrong guess; the next person in line is highlighted. Results stay up until you press Reset or start the next round.'
        : 'Waiting for the operator to start the next round.',
    );
  }

  function renderOp() {
    const panel = $('opPanel');
    panel.hidden = MODE !== 'host';
    if (MODE !== 'host') return;
    const R = H.round;
    const s = H.settings;
    $('btnStart').disabled = R.phase === 'live' || R.phase === 'finalizing';
    $('btnStart').textContent = R.phase === 'results' ? 'Next round' : 'Start round';
    $('btnEnd').disabled = R.phase !== 'live';
    $('btnReset').disabled = R.phase === 'idle';
    const hints = {
      idle: 'Press Start round when everyone is ready.',
      live: 'The round ends by itself once everyone has pressed, or press End round.',
      finalizing: 'Waiting a moment for presses that are still on their way…',
      results: 'Results stay up until you press Reset or Next round.',
    };
    setText($('opHint'), hints[R.phase] || '');
    const link = inviteLink();
    if ($('inviteLink').value !== link) $('inviteLink').value = link;
    setText($('roomCode'), fmtCode(H.code));
    const note = $('inviteNote');
    const local = location.protocol === 'file:';
    note.hidden = !local;
    if (local) {
      note.textContent =
        'This page is opened from a file, so the link only works on this computer. Send friends the SyncBuzz file and the room code, or put the file online (for example GitHub Pages) to get a link that works for everyone.';
    }
    $('setCountdown').value = String(s.countdown);
    $('setShow').value = s.show;
    $('setHostPlays').checked = s.hostPlays;
    $('setLocked').checked = s.locked;
    const close = $('btnClose');
    close.textContent = armedKey === 'close' ? 'Click again to close' : 'Close room';
    close.classList.toggle('armed', armedKey === 'close');
  }

  function renderPlayers() {
    if (MODE !== 'host' && MODE !== 'player') return;
    const list = $('playersList');
    const rows = [];
    let online = 0;
    let total = 0;
    if (MODE === 'host') {
      const R = H.round;
      const showPressed = R.phase !== 'idle';
      const all = [H.me, ...H.players.values()];
      for (const p of all) {
        total++;
        if (p.online) online++;
        const st = pStats(p);
        let meta;
        if (p.isHost) meta = H.settings.hostPlays ? 'you · reference clock' : 'you · not playing';
        else if (!p.online) meta = 'offline';
        else meta = st.ping == null ? 'measuring ping…' : `ping ${fmtMs(st.ping)}`;
        const pressed = showPressed && R.presses.has(p.id);
        let action = null;
        if (!p.isHost) {
          const key = `kick:${p.id}`;
          const armed = armedKey === key;
          action = h('button', {
            class: `btn btn-small btn-ghost danger${armed ? ' armed' : ''}`,
            type: 'button',
            text: armed ? 'Sure?' : p.online ? 'Kick' : 'Remove',
            title: p.online ? 'Remove this player and block them from rejoining' : 'Remove from the list',
            onclick: () => arm(key, () => (p.online ? hostKick(p) : hostForget(p))),
          });
        }
        rows.push(
          h(
            'li',
            null,
            h('span', { class: `dot${p.online ? ' on' : ''}` }),
            h(
              'span',
              { class: 'p-main' },
              h('span', { class: 'p-name' }, p.name, p.isHost ? h('span', { class: 'pill', text: 'operator' }) : null),
              h('span', {
                class: 'p-meta',
                text: meta,
                title:
                  p.isHost || st.min == null
                    ? null
                    : `Clock sync worst case ±${fmtMs(uncOf(p))} (half the best round trip). Usually a few ms.`,
              }),
            ),
            pressed ? h('span', { class: 'p-check', text: '✓', title: 'Pressed this round' }) : null,
            action,
          ),
        );
      }
    } else {
      const s = P.state;
      for (const p of s ? s.players : []) {
        total++;
        if (p.online) online++;
        let meta = p.online ? '' : 'offline';
        if (p.host) meta = p.plays ? 'operator' : 'operator · not playing';
        rows.push(
          h(
            'li',
            null,
            h('span', { class: `dot${p.online ? ' on' : ''}` }),
            h(
              'span',
              { class: 'p-main' },
              h('span', { class: 'p-name' }, p.name, p.id === P.myId ? h('span', { class: 'pill', text: 'you' }) : null),
              meta ? h('span', { class: 'p-meta', text: meta }) : null,
            ),
            p.pressed ? h('span', { class: 'p-check', text: '✓', title: 'Pressed this round' }) : null,
          ),
        );
      }
      if (!s) rows.push(h('li', { class: 'empty', text: 'Not connected yet.' }));
    }
    if (MODE === 'host' && total === 1) rows.push(h('li', { class: 'empty', text: 'Nobody else yet. Send the invite link.' }));
    // Only touch the DOM when something changed, so a button isn't replaced
    // between mouse-down and mouse-up (that would swallow the click).
    const sig = rows.map((r) => r.outerHTML).join('');
    if (list.dataset.sig !== sig) {
      list.dataset.sig = sig;
      list.replaceChildren(...rows);
    }
    setText($('playersTitle'), `Players · ${online} online`);
  }

  function renderAll() {
    renderTop();
    renderStage();
    renderResults();
    renderOp();
    renderPlayers();
  }

  function uiLoop() {
    try {
      renderStage();
    } catch (e) {
      console.error(e);
    }
    requestAnimationFrame(uiLoop);
  }

  // ---- input
  function onKey(e) {
    if (MODE !== 'host' && MODE !== 'player') return;
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code !== 'Space' && e.key !== ' ' && e.key !== 'Enter') return;
    const t = e.target;
    const buzzEl = $('buzz');
    if (t !== buzzEl && t instanceof Element && t.closest('input, select, textarea, button, summary, a, [role="button"]')) return;
    e.preventDefault();
    buzz(e);
  }

  function wireUi() {
    $('formHost').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = cleanName($('hostName').value);
      if (!name) {
        $('hostName').focus();
        return;
      }
      createRoom(name);
    });
    $('formJoin').addEventListener('submit', (e) => {
      e.preventDefault();
      const code = parseCode($('joinCode').value);
      const name = cleanName($('joinName').value);
      const err = $('joinError');
      if (!code) {
        err.hidden = false;
        err.textContent = 'That room code doesn’t look right. It has 10 letters and digits, like abcde-23456.';
        $('joinCode').focus();
        return;
      }
      err.hidden = true;
      if (!name) {
        $('joinName').focus();
        return;
      }
      startPlayer(code, name);
    });
    const b = $('buzz');
    b.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      buzz(e);
    });
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('keydown', onKey);
    const opButton = (id, fn) =>
      $(id).addEventListener('click', (e) => {
        e.currentTarget.blur(); // so Space goes to the buzzer, not this button
        fn();
      });
    opButton('btnStart', hostStartRound);
    opButton('btnEnd', hostEndRound);
    opButton('btnReset', hostReset);
    opButton('btnCopy', copyInvite);
    opButton('btnClose', () => arm('close', hostCloseRoom));
    opButton('btnLeave', () => arm('leave', playerLeave));
    $('setCountdown').addEventListener('change', (e) => {
      H.settings = sanitizeSettings({ ...H.settings, countdown: Number(e.target.value) });
      broadcast();
    });
    $('setShow').addEventListener('change', (e) => {
      H.settings = sanitizeSettings({ ...H.settings, show: e.target.value });
      broadcast();
    });
    $('setHostPlays').addEventListener('change', (e) => {
      H.settings.hostPlays = e.target.checked;
      const R = H.round;
      if (R.phase === 'live') {
        if (H.settings.hostPlays) R.participants.add('host');
        else if (!R.presses.has('host')) R.participants.delete('host');
      }
      broadcast();
      hostCheckAllPressed();
    });
    $('setLocked').addEventListener('change', (e) => {
      H.settings.locked = e.target.checked;
      broadcast();
    });
    $('inviteLink').addEventListener('focus', (e) => e.target.select());
    $('msgBtn').addEventListener('click', goHome);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) renderAll();
    });
  }

  // Read-only snapshot for testing from the browser console.
  window.syncbuzzDebug = () => ({
    mode: MODE,
    timeOrigin: performance.timeOrigin,
    now: now(),
    offset: P.clock.offset,
    unc: P.clock.unc,
    minRtt: P.clock.minRtt,
    samples: P.clock.samples.length,
    round: MODE === 'host' ? { n: H.round.n, phase: H.round.phase, goAt: H.round.goAt } : P.state && { n: P.state.round, phase: P.state.phase },
    results: MODE === 'host' ? H.round.results : P.state && P.state.results,
  });

  // ---- boot
  function boot() {
    wireUi();
    if (typeof Peer !== 'function') {
      showMessage('Something is missing', 'The connection library didn’t load. Try reloading the page.');
      return;
    }
    const hostCode = parseCode(params.get('host'));
    const joinCode = parseCode(params.get('join'));
    if (hostCode) {
      const saved = store.get('session', 'syncbuzz.host');
      if (saved && saved.code === hostCode) {
        startHost(saved);
        return;
      }
      showHome(hostCode); // someone else's host link: offer to join instead
      return;
    }
    if (joinCode) {
      const saved = store.get('session', 'syncbuzz.player');
      if (saved && saved.code === joinCode && saved.joined && cleanName(saved.name)) {
        startPlayer(joinCode, cleanName(saved.name));
        return;
      }
      showHome(joinCode);
      return;
    }
    showHome(null);
  }

  boot();
})();
