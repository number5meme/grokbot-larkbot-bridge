'use strict';
// Lark long connection (event subscription over WebSocket, outbound only) built on the official SDK's WSClient,
// with the same anti-disconnect hardening as the other bridges:
//  - the SDK pings the server, reconnects by itself after a close, and (pingTimeout) terminates a socket that
//    stops answering pings, so half-open sockets are detected;
//  - wake-up: a wall-clock jump or frozen timers (host suspend, VM pause; see clock.js) drop the client at once and
//    open a fresh connection, because sockets often stay ESTABLISHED after a resume but never deliver again;
//  - watchdog: if the client was not connected for notConnectedMs, or no pong arrived for staleMs, the whole client
//    is replaced (new WSClient, new endpoint, new socket);
//  - a terminal SDK error (retries exhausted) restarts the client with exponential backoff; a non-retryable
//    endpoint refusal (credentials, long connection not enabled) becomes fatal after `fatalAfter` attempts in a row.
// Event handlers must return quickly (Lark redelivers events that are not acknowledged within about 3 s), so
// onMessage only queues the event.
const { performance } = require('node:perf_hooks');
const { Backoff } = require('./backoff');
const { ClockJumpDetector } = require('./clock');
const { makeSdkLogger } = require('./lark-api');

const EVENT = 'im.message.receive_v1';

function sdkFactories(cfg, logFn, onSignal) {
  const lark = require('@larksuiteoapi/node-sdk');
  const logger = makeSdkLogger(logFn, { secrets: [cfg.appSecret], onSignal });
  return {
    createDispatcher: (handlers) => new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.warn, logger }).register(handlers),
    createClient: (hooks) => new lark.WSClient({ appId: cfg.appId, appSecret: cfg.appSecret, domain: cfg.domain,
      loggerLevel: lark.LoggerLevel.trace, logger, autoReconnect: true, handshakeTimeoutMs: 20_000, wsConfig: { pingTimeout: 30 },
      source: 'grokbot-larkbot-bridge', ...hooks }),
  };
}

class LongConnection {
  /**
   * cfg: { appId, appSecret, domain }; onMessage(event) is called for each im.message.receive_v1 event.
   * onState(s): STARTING | RUNNING | RECONNECTING | <fatal status>; onAlive(): proof of life; onWake(reason, driftMs);
   * onFatal(status, why). factories (tests): { createDispatcher(handlers), createClient(hooks) }.
   */
  constructor({ cfg, onMessage, logFn = () => {}, onState = () => {}, onAlive = () => {}, onWake = () => {}, onFatal = () => {},
    factories, mono = () => performance.now(), backoff, staleMs = 10 * 60_000, notConnectedMs = 5 * 60_000,
    watchdogEveryMs = 15_000, fatalAfter = 3, clockOpts = {} }) {
    Object.assign(this, { cfg, onMessage, logFn, onState, onAlive, onWake, onFatal, mono, staleMs, notConnectedMs, watchdogEveryMs, fatalAfter, clockOpts });
    this.backoff = backoff || new Backoff({ baseMs: 5000, maxMs: 5 * 60_000 });
    this.factories = factories || sdkFactories(cfg, logFn, (sig) => this.signal(sig));
    this.client = null; this.generation = 0; this.stopped = false; this.everConnected = false; this.fatal = null; this.lastError = '';
    this.lastSignal = 0; this.lastConnected = 0; this.restartTimer = null; this.refusals = 0; this.state = 'idle';
  }

  signal(kind) {
    const t = this.mono();
    this.lastSignal = t;
    if (kind === 'connected') this.markConnected();
    this.onAlive();
  }

  markConnected() {
    this.everConnected = true; this.lastConnected = this.mono(); this.lastSignal = this.lastConnected; this.refusals = 0;
    this.backoff.reset();
    if (this.state !== 'RUNNING') { this.state = 'RUNNING'; this.onState('RUNNING'); }
    this.onAlive();
  }

  start() {
    this.stopped = false;
    this.onState('STARTING'); this.state = 'STARTING';
    this.dispatcher = this.factories.createDispatcher({ [EVENT]: (data) => { try { this.onMessage(data); } catch (e) { this.logFn(`event handler error: ${e && e.message}`); } } });
    this.open('start');
    this.clock = new ClockJumpDetector({ ...this.clockOpts, onJump: (drift) => this.wake(drift) }).start();
    this.watchdog = setInterval(() => this.tick(), this.watchdogEveryMs);
    this.watchdog.unref?.();
    return this;
  }

  open(reason) {
    const gen = ++this.generation;
    this.lastConnected = this.mono(); // grace period for the first connection
    const guard = (fn) => (...a) => { if (gen === this.generation && !this.stopped) fn(...a); };
    this.client = this.factories.createClient({
      onReady: guard(() => { this.logFn(`long connection ready (${reason})`); this.markConnected(); }),
      onReconnected: guard(() => { this.logFn('long connection reconnected'); this.markConnected(); }),
      onReconnecting: guard(() => { this.state = 'RECONNECTING'; this.onState('RECONNECTING'); this.logFn('long connection reconnecting'); }),
      onError: guard((e) => this.terminal(e)),
    });
    this.client.start({ eventDispatcher: this.dispatcher });
  }

  terminal(e) {
    const msg = String((e && e.message) || e || 'error').slice(0, 200);
    this.lastError = msg;
    const refused = /pullConnectConfig failed/.test(msg);
    this.logFn(`long connection error: ${msg}`);
    if (refused) {
      this.refusals++;
      if (this.refusals >= this.fatalAfter) {
        this.fatal = 'LONG_CONNECTION_REJECTED';
        this.stop();
        this.onState(this.fatal);
        this.onFatal(this.fatal, msg);
        return;
      }
    }
    this.scheduleRestart('error');
  }

  scheduleRestart(reason, delayMs = this.backoff.next()) {
    if (this.stopped) return;
    this.closeClient();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.state = 'RECONNECTING'; this.onState('RECONNECTING');
    this.logFn(`long connection restart (${reason}) in ${Math.round(delayMs / 1000)}s`);
    this.restartTimer = setTimeout(() => { this.restartTimer = null; if (!this.stopped) this.open(reason); }, delayMs);
    this.restartTimer.unref?.();
  }

  closeClient() {
    this.generation++;
    const c = this.client; this.client = null;
    if (c) { try { c.close({ force: true }); } catch { /* ignore */ } }
  }

  /** Host woke up (or the clock jumped): drop everything and reconnect right away. */
  wake(driftMs) {
    if (this.stopped) return;
    this.logFn(`clock jump ${Math.round(driftMs / 1000)}s: host suspend/resume or clock change, reconnecting now`);
    this.backoff.reset();
    try { this.onWake('clock_jump', driftMs); } catch { /* ignore */ }
    this.scheduleRestart('wake', 0);
  }

  /** Watchdog tick (exposed for tests). */
  tick() {
    if (this.stopped || !this.client) return;
    let st = 'idle';
    try { st = (this.client.getConnectionStatus && this.client.getConnectionStatus().state) || 'idle'; } catch { /* ignore */ }
    const t = this.mono();
    if (st === 'connected') {
      if (this.lastSignal && t - this.lastSignal > this.staleMs) { this.logFn(`watchdog: no pong for ${Math.round((t - this.lastSignal) / 1000)}s, replacing the client`); this.scheduleRestart('stale', 0); return; }
      this.lastConnected = t;
      this.onAlive();
      return;
    }
    if (st === 'failed') return; // onError handles it
    if (t - this.lastConnected > this.notConnectedMs) {
      this.logFn(`watchdog: not connected for ${Math.round((t - this.lastConnected) / 1000)}s (state ${st}), replacing the client`);
      this.scheduleRestart('watchdog');
    }
  }

  status() {
    let state = this.state;
    try { if (this.client && this.client.getConnectionStatus) state = this.client.getConnectionStatus().state; } catch { /* ignore */ }
    return { state, everConnected: this.everConnected, fatal: this.fatal, lastError: this.lastError };
  }

  stop() {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.clock) this.clock.stop();
    this.closeClient();
  }
}

module.exports = { LongConnection, EVENT };
