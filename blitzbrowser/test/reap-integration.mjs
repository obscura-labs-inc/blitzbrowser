// End-to-end proof of the idle-based reaper against a RUNNING BlitzBrowser.
//
// It speaks the real client protocol: a plain WebSocket to `/` is the CDP
// endpoint (the server wraps each text frame into a tunnel CDP message), so this
// launches a real pooled Chrome exactly like Ferrum does — no extra deps.
//
// Three assertions, covering the full reaper contract:
//   A. An actively-driven session (CDP commands flowing) survives the reaper.
//   B. A connected-but-quiet client that is still responsive (answering the
//      server's WebSocket pings) survives — this is the captcha case: the client
//      is blocked 30-90s on a solver API, sending no CDP, but is not gone.
//   C. An unresponsive / half-open client (no CDP, not answering pings) IS
//      reaped once it passes max_age.
//
// When the reaper closes an instance it tears down the tunnel, which closes our
// client WebSocket — that close is the observable signal.
//
// Run against local docker-compose:
//   BLITZ_API_KEY=asd npm run test:reap
// Run against the prod scraper box (from the box, over a forward/tunnel):
//   BLITZ_WS=ws://127.0.0.1:9999 BLITZ_HTTP=http://127.0.0.1:9999 npm run test:reap
import { WebSocket } from 'ws';

const WS_BASE = process.env.BLITZ_WS || 'ws://127.0.0.1:9999';
const HTTP_BASE = process.env.BLITZ_HTTP || 'http://127.0.0.1:9999';
const API_KEY = process.env.BLITZ_API_KEY || '';

// The server pings clients every 3s, so a pong-kept-alive instance refreshes at
// most every ~3s. max_age must sit comfortably above that for the pong signal to
// hold (case B).
const MAX_AGE = 6;        // idle threshold we reap against (seconds)
const DRIVE_MS = 12_000;  // how long case A drives the active session
const SEND_EVERY = 750;   // client CDP command cadence (< MAX_AGE)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wsUrl = () => `${WS_BASE}/${API_KEY ? `?apiKey=${encodeURIComponent(API_KEY)}` : ''}`;

async function reap(maxAge) {
  const res = await fetch(`${HTTP_BASE}/browser-pool/stale?max_age=${maxAge}`, {
    method: 'DELETE',
    headers: API_KEY ? { 'x-api-key': API_KEY } : {},
  });
  if (!res.ok) throw new Error(`DELETE /stale returned ${res.status}`);
  return res.json(); // { closed: string[], count: number }
}

// Open a client and wait until Chrome's CDP is actually flowing (a command gets
// a response), so we never start reaping while the browser is still launching.
// autoPong:false simulates an unresponsive/half-open client (never answers the
// server's pings), used to prove the leak path in case C.
function connectDriven({ autoPong = true } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(), { autoPong });
    const state = { ws, closed: false, closeCode: null, ready: false };
    let msgId = 0;

    const readyTimer = setTimeout(() => reject(new Error('browser never became CDP-ready within 20s')), 20_000);

    ws.on('open', () => ws.send(JSON.stringify({ id: ++msgId, method: 'Browser.getVersion' })));
    ws.on('message', () => {
      if (!state.ready) {
        state.ready = true;
        clearTimeout(readyTimer);
        resolve(state);
      }
    });
    ws.on('close', (code) => { state.closed = true; state.closeCode = code; });
    ws.on('error', (err) => { if (!state.ready) { clearTimeout(readyTimer); reject(err); } });

    state.send = () => { try { ws.send(JSON.stringify({ id: ++msgId, method: 'Browser.getVersion' })); } catch { /* closed */ } };
  });
}

async function testActiveSurvives() {
  console.log(`\n[A] active session survives reaper (max_age=${MAX_AGE}s, drive=${DRIVE_MS / 1000}s)`);
  const c = await connectDriven();
  console.log('    browser ready, driving CDP + hammering DELETE /stale...');

  const deadline = Date.now() + DRIVE_MS;
  let reaps = 0;
  while (Date.now() < deadline) {
    c.send();
    await reap(MAX_AGE);
    reaps++;
    if (c.closed) throw new Error(`FAIL[A]: active session was reaped (ws close ${c.closeCode}) after ${reaps} passes`);
    await sleep(SEND_EVERY);
  }
  console.log(`    PASS[A]: survived ${reaps} reaper passes while actively driven`);
  c.ws.close();
  await sleep(500);
}

async function testResponsiveIdleSurvives() {
  const holdMs = (MAX_AGE + 3) * 1000;
  console.log(`\n[B] connected-but-quiet + responsive survives (captcha wait, hold=${holdMs / 1000}s > max_age)`);
  const c = await connectDriven(); // autoPong on: answers server pings, sends no CDP
  console.log('    browser ready; sending NO CDP, staying responsive, hammering DELETE /stale...');

  const deadline = Date.now() + holdMs;
  let reaps = 0;
  while (Date.now() < deadline) {
    await reap(MAX_AGE);
    reaps++;
    if (c.closed) throw new Error(`FAIL[B]: responsive idle session was reaped (ws close ${c.closeCode}) after ${reaps} passes`);
    await sleep(1000);
  }
  console.log(`    PASS[B]: survived ${reaps} reaper passes on pong liveness alone (no CDP traffic)`);
  c.ws.close();
  await sleep(500);
}

async function testUnresponsiveReaped() {
  console.log(`\n[C] unresponsive / half-open client IS reaped (max_age=${MAX_AGE}s)`);
  const c = await connectDriven({ autoPong: false }); // never answers pings, sends no CDP
  console.log('    browser ready; going fully silent (no CDP, no pong) to accrue idle time...');

  await sleep((MAX_AGE + 2) * 1000);
  if (c.closed) throw new Error(`FAIL[C]: instance closed before we reaped it (code ${c.closeCode})`);

  const { count } = await reap(MAX_AGE);
  await sleep(1000); // let the close propagate to our socket

  if (count < 1) throw new Error('FAIL[C]: reaper closed 0 instances, expected the idle one');
  if (!c.closed) throw new Error('FAIL[C]: idle instance was not reaped (our ws still open)');
  console.log(`    PASS[C]: idle instance reaped (closed count=${count}, ws close ${c.closeCode})`);
}

(async () => {
  console.log(`Target ws=${WS_BASE} http=${HTTP_BASE} auth=${API_KEY ? 'on' : 'off'}`);
  try {
    await testActiveSurvives();
    await testResponsiveIdleSurvives();
    await testUnresponsiveReaped();
    console.log('\nALL PASS — active + responsive-idle sessions survive, unresponsive instances reaped.');
    process.exit(0);
  } catch (e) {
    console.error(`\n${e.message}`);
    process.exit(1);
  }
})();
