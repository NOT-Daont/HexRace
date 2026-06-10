// Socket wrapper: connection, clock sync against server timestamps, and a
// tiny pub/sub so game + UI modules can subscribe to server messages.

import { io } from 'socket.io-client';

class Net {
  constructor() {
    this.socket = io({ transports: ['websocket'], autoConnect: true });
    this.room = null;          // latest room state
    this.you = null;           // my private slice of room state
    this.myId = null;
    this.clockOffset = 0;      // serverTime - clientTime (smoothed)
    this.listeners = new Map();

    this.socket.on('room', (st) => {
      this.room = st;
      this.you = st.you;
      this.syncClock(st.now);
      this.emitLocal('room', st);
    });
    this.socket.on('snap', (sn) => { this.syncClock(sn.t); this.emitLocal('snap', sn); });
    this.socket.on('evt', (e) => this.emitLocal('evt', e));
    this.socket.on('toast', (t) => this.emitLocal('toast', t));
    this.socket.on('disconnect', () => this.emitLocal('dropped'));
  }

  syncClock(serverNow) {
    const sample = serverNow - Date.now();
    this.clockOffset = this.clockOffset === 0 ? sample : this.clockOffset * 0.9 + sample * 0.1;
  }

  serverNow() { return Date.now() + this.clockOffset; }

  join(name) {
    return new Promise((resolve) => {
      this.socket.emit('join', { name }, (res) => {
        if (res?.ok) this.myId = res.id;
        resolve(res ?? { error: 'No response from server.' });
      });
    });
  }

  brew(ingredients) {
    return new Promise((resolve) =>
      this.socket.emit('cauldron:brew', { ingredients }, resolve));
  }

  send(event, payload) { this.socket.emit(event, payload); }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event).delete(fn);
  }

  emitLocal(event, data) {
    for (const fn of this.listeners.get(event) ?? []) fn(data);
  }
}

export const net = new Net();
