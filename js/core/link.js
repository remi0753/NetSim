/* NetSim core: ports and links (L1) */
(function (root) {
  const NetSim = root.NetSim;

  const DEFAULTS = Object.freeze({
    bandwidthMbps: 1000,
    latencyMs: 1,
    jitterMs: 0,
    queueLimitPackets: 64,
  });

  function finiteInRange(value, fallback, min, max) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  }

  const utf8Encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

  function dataBytes(data) {
    if (data == null) return 0;
    const s = typeof data === 'string' ? data : JSON.stringify(data);
    if (utf8Encoder) return utf8Encoder.encode(s).length;
    return unescape(encodeURIComponent(s)).length;
  }

  /* Approximate on-wire bytes, including Ethernet overhead and inter-frame gap. */
  function frameBytes(frame) {
    let payload = 28; // ARP-sized fallback
    if (frame && frame.type === 'ipv4' && frame.payload) {
      const ip = frame.payload, l4 = ip.payload || {};
      if (ip.proto === 'tcp') payload = 20 + 20 + dataBytes(l4.data);
      else if (ip.proto === 'udp') payload = 20 + 8 + dataBytes(l4.data);
      else if (ip.proto === 'icmp') payload = 20 + 8 + (Number(l4.size) || dataBytes(l4));
      else payload = 20 + dataBytes(l4);
    }
    const ethernet = 14 + (frame && frame.vlan != null ? 4 : 0) + payload + 4;
    return Math.max(64, ethernet) + 20; // preamble/SFD + inter-frame gap
  }

  class Port {
    constructor(device, name, opts) {
      opts = opts || {};
      this.id = NetSim.nextId('port');
      this.device = device;
      this.name = name;
      this.shortName = opts.shortName || name;
      this.mac = opts.mac || null;       // NIC-style ports own a MAC
      this.adminUp = true;               // "no shutdown"
      this.description = '';
      this.link = null;
    }
    get connected() { return this.link !== null; }
    /* operational status: needs cable + both ends administratively up */
    isUp() {
      if (!this.adminUp || !this.link) return false;
      return this.link.other(this).adminUp;
    }
    other() { return this.link ? this.link.other(this) : null; }
    statusText() {
      if (!this.link) return 'notconnect';
      if (!this.adminUp) return 'disabled';
      if (!this.link.other(this).adminUp) return 'down';
      if (this.stpState === 'blocking') return 'blocking';
      return 'connected';
    }
  }

  class Link {
    constructor(sim, portA, portB, opts) {
      this.id = NetSim.nextId('link');
      this.sim = sim;
      this.a = portA;
      this.b = portB;
      this._directions = new Map();
      this.droppedFrames = 0;
      this.configure(opts);
      portA.link = this;
      portB.link = this;
    }
    other(port) { return port === this.a ? this.b : this.a; }
    isUp() { return this.a.adminUp && this.b.adminUp; }

    configure(opts) {
      opts = opts || {};
      this.bandwidthMbps = finiteInRange(opts.bandwidthMbps, DEFAULTS.bandwidthMbps, 0.001, 1000000);
      this.latencyMs = finiteInRange(opts.latencyMs, DEFAULTS.latencyMs, 0, 600000);
      this.jitterMs = finiteInRange(opts.jitterMs, DEFAULTS.jitterMs, 0, 600000);
      this.queueLimitPackets = Math.floor(finiteInRange(
        opts.queueLimitPackets, DEFAULTS.queueLimitPackets, 0, 1000000));
    }
    settings() {
      return {
        bandwidthMbps: this.bandwidthMbps,
        latencyMs: this.latencyMs,
        jitterMs: this.jitterMs,
        queueLimitPackets: this.queueLimitPackets,
      };
    }
    _direction(fromPort) {
      let state = this._directions.get(fromPort.id);
      if (!state) {
        state = { busyUntil: 0, waitingStarts: [] };
        this._directions.set(fromPort.id, state);
      }
      return state;
    }
    _pruneQueue(state, now) {
      let count = 0;
      while (count < state.waitingStarts.length && state.waitingStarts[count] <= now + 1e-9) count++;
      if (count) state.waitingStarts.splice(0, count);
    }
    queueDepth(fromPort) {
      const state = this._direction(fromPort);
      this._pruneQueue(state, this.sim.time);
      return state.waitingStarts.length;
    }
    _sampleLatency() {
      const linkLatency = this.jitterMs
        ? Math.max(0, this.latencyMs + (Math.random() * 2 - 1) * this.jitterMs)
        : this.latencyMs;
      return Math.max(Number(this.sim.baseLatencyMs) || 0, linkLatency);
    }

    /* Full-duplex, per-direction FIFO with serialization and propagation delay. */
    transmit(fromPort, frame) {
      if (!this.isUp()) return;
      const toPort = this.other(fromPort);
      const copy = NetSim.clone(frame);
      copy.hops = (copy.hops || 0) + 1;
      if (copy.hops > 64) {
        this.sim.note('loop', NetSim.t('net.loop.detected', fromPort.device.name));
        return;
      }
      const now = this.sim.time;
      const bytes = frameBytes(copy);
      const serializationMs = Math.max(0.001, bytes * 8 / (this.bandwidthMbps * 1000));
      const state = this._direction(fromPort);
      this._pruneQueue(state, now);
      const tStart = Math.max(now, state.busyUntil);
      const waits = tStart > now + 1e-9;
      if (waits && state.waitingStarts.length >= this.queueLimitPackets) {
        this.droppedFrames++;
        this.sim.note('queue-drop', NetSim.t('net.link.queueDrop',
          fromPort.device.name, fromPort.shortName, this.queueLimitPackets));
        return;
      }
      if (waits) state.waitingStarts.push(tStart);
      const tSerialized = tStart + serializationMs;
      const propagationMs = this._sampleLatency();
      const tArrival = tSerialized + propagationMs;
      state.busyUntil = tSerialized;

      // Register animation metadata immediately. Canvas hides future-starting
      // entries, avoiding one simulator event per queued frame.
      this.sim.addTransmission(this, fromPort, copy, {
        tStart, tEnd: tArrival, bytes, serializationMs, propagationMs,
      });
      this.sim.schedule(tArrival - now, () => {
        if (fromPort.link !== this) return;   // cable was unplugged mid-flight
        if (!this.isUp()) return;
        toPort.device.receiveFrame(toPort, copy);
      });
    }
    destroy() {
      this.a.link = null;
      this.b.link = null;
    }
  }

  NetSim.Port = Port;
  NetSim.Link = Link;
  NetSim.Link.DEFAULTS = DEFAULTS;
  NetSim.frameBytes = frameBytes;
})(typeof window !== 'undefined' ? window : globalThis);
