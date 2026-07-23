/* NetSim core: discrete-event simulator with a continuously advancing clock.
 * The UI advances the clock from requestAnimationFrame; tests call advance(). */
(function (root) {
  const NetSim = root.NetSim;

  /* binary min-heap keyed by (t, seq) — O(log n) schedule/pop for large topologies */
  class EventHeap {
    constructor() { this.a = []; }
    get size() { return this.a.length; }
    _less(i, j) {
      const x = this.a[i], y = this.a[j];
      return x.t < y.t || (x.t === y.t && x.seq < y.seq);
    }
    _swap(i, j) { const t = this.a[i]; this.a[i] = this.a[j]; this.a[j] = t; }
    push(ev) {
      const a = this.a;
      a.push(ev);
      let i = a.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!this._less(i, p)) break;
        this._swap(i, p);
        i = p;
      }
    }
    peek() { return this.a[0]; }
    pop() {
      const a = this.a;
      const top = a[0];
      const last = a.pop();
      if (a.length) {
        a[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < a.length && this._less(l, m)) m = l;
          if (r < a.length && this._less(r, m)) m = r;
          if (m === i) break;
          this._swap(i, m);
          i = m;
        }
      }
      return top;
    }
  }

  class Simulator extends NetSim.Emitter {
    constructor() {
      super();
      this.time = 0;              // simulated milliseconds
      this.speed = 1;
      this.running = true;
      this._heap = new EventHeap();
      this._eseq = 0;
      this.transmissions = [];    // in-flight frames, for animation
      this.captureTransmissions = true;
      // Global lower bound for actual one-way link propagation. Individual
      // links may specify a higher latency; 0 uses link values unchanged.
      this.baseLatencyMs = 0;
      // Compatibility fallback for callers that do not have a Link instance.
      // Actual links carry their own propagation delay and bandwidth settings.
      this.linkDelay = 1;
    }

    schedule(delay, fn) {
      const ev = { t: this.time + Math.max(0, delay), seq: this._eseq++, fn, cancelled: false };
      this._heap.push(ev);
      return ev;
    }
    cancel(ev) { if (ev) ev.cancelled = true; }

    /* advance the simulated clock by dt ms and fire due events */
    advance(dt) {
      const target = this.time + dt;
      while (this._heap.size && this._heap.peek().t <= target) {
        const ev = this._heap.pop();
        if (ev.cancelled) continue;
        this.time = Math.max(this.time, ev.t);
        try { ev.fn(); } catch (e) { this.emit('error', e); if (typeof console !== 'undefined') console.error(e); }
      }
      this.time = target;
      // drop finished transmissions
      if (this.transmissions.length) {
        this.transmissions = this.transmissions.filter(tx => tx.tEnd > this.time);
      }
    }

    /* called by the UI loop with real elapsed ms */
    tick(realDt) {
      if (!this.running) return;
      this.advance(realDt * this.speed);
    }

    /* register an in-flight frame (animation + packet log) */
    addTransmission(link, fromPort, frame, timing) {
      if (!this.captureTransmissions) return null;
      timing = timing || {};
      const tStart = timing.tStart == null ? this.time : timing.tStart;
      const tArrival = timing.tEnd == null ? tStart + this.linkDelay : timing.tEnd;
      const tx = {
        id: NetSim.nextId('tx'),
        link, fromPort, frame,
        tStart, tEnd: Math.max(tStart + 0.001, tArrival),
        tArrival,
        bytes: timing.bytes || null,
        packets: timing.packets || 1,
        serializationMs: timing.serializationMs || 0,
        propagationMs: timing.propagationMs == null ? this.linkDelay : timing.propagationMs,
      };
      this.transmissions.push(tx);
      this.emit('frame', tx);
      return tx;
    }

    /* system event lines (loop guard, ACL deny, errors...) */
    note(kind, msg) { this.emit('note', { time: this.time, kind, msg }); }
  }

  NetSim.Simulator = Simulator;
})(typeof window !== 'undefined' ? window : globalThis);
