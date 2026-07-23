/* NetSim core: ports and links (L1) */
(function (root) {
  const NetSim = root.NetSim;

  const DEFAULTS = Object.freeze({
    bandwidthMbps: 1000,
    latencyMs: 1,
    jitterMs: 0,
    queueLimitPackets: 64,
  });
  const TRAFFIC_BUCKET_MS = 10;
  const TRAFFIC_HISTORY_MS = 60000;
  const FORWARDING_TYPES = new Set(['hub', 'switch', 'router', 'l3switch']);

  function finiteInRange(value, fallback, min, max) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  }

  const utf8Encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

  function dataBytes(data) {
    if (data == null) return 0;
    if (data && typeof data === 'object' &&
        Number.isSafeInteger(data.__netsimBytes) && data.__netsimBytes >= 0) {
      return data.__netsimBytes;
    }
    const s = typeof data === 'string' ? data : JSON.stringify(data);
    if (utf8Encoder) return utf8Encoder.encode(s).length;
    return unescape(encodeURIComponent(s)).length;
  }

  function framePackets(frame) {
    if (!frame || frame.type !== 'ipv4' || !frame.payload) return 1;
    const ip = frame.payload, l4 = ip.payload || {};
    if (ip.proto === 'tcp') {
      const virtual = l4.data && l4.data.__netsimSegments;
      if (Number.isSafeInteger(virtual) && virtual > 0) return virtual;
      if (Number.isSafeInteger(l4.__netsimPackets) && l4.__netsimPackets > 0) {
        return l4.__netsimPackets;
      }
    }
    return 1;
  }

  /* Approximate on-wire bytes, including Ethernet overhead and inter-frame gap. */
  function frameBytes(frame) {
    let payload = 28; // ARP-sized fallback
    if (frame && frame.type === 'ipv4' && frame.payload) {
      const ip = frame.payload, l4 = ip.payload || {};
      if (ip.proto === 'tcp') {
        const packets = framePackets(frame);
        const bytes = dataBytes(l4.data);
        if (packets > 1) {
          // One event can stand for a group of physical TCP packets. Each
          // packet still consumes its Ethernet/IP/TCP overhead on the wire.
          const perPacketOverhead = 78 + (frame.vlan != null ? 4 : 0);
          return bytes ? bytes + packets * perPacketOverhead : packets * (84 +
            (frame.vlan != null ? 4 : 0));
        }
        payload = 20 + 20 + bytes;
      }
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
        state = {
          busyUntil: 0,
          queueEntries: [],
          totalBytes: 0,
          transmissions: [],
        };
        this._directions.set(fromPort.id, state);
      }
      return state;
    }
    _pruneQueue(state, now) {
      let count = 0;
      while (count < state.queueEntries.length &&
             state.queueEntries[count].tEnd <= now + 1e-9) count++;
      if (count) state.queueEntries.splice(0, count);
    }
    _queueDepth(state, now) {
      this._pruneQueue(state, now);
      let depth = 0;
      for (const entry of state.queueEntries) {
        if (now < entry.tStart) {
          depth += entry.packets;
          continue;
        }
        const remaining = Math.ceil((entry.tEnd - now) / entry.perPacketMs) - 1;
        depth += Math.max(0, Math.min(entry.packets, remaining));
      }
      return depth;
    }
    queueDepth(fromPort) {
      const state = this._direction(fromPort);
      return this._queueDepth(state, this.sim.time);
    }
    _directionTraffic(fromPort, windowMs) {
      const state = this._direction(fromPort);
      const now = this.sim.time;
      const since = now - windowMs;
      let prune = 0;
      while (prune < state.transmissions.length &&
             state.transmissions[prune].tEnd <= since) prune++;
      if (prune) state.transmissions.splice(0, prune);

      let bytes = 0;
      for (const tx of state.transmissions) {
        const overlap = Math.max(0, Math.min(now, tx.tEnd) - Math.max(since, tx.tStart));
        if (overlap > 0) bytes += tx.bytes * overlap / (tx.tEnd - tx.tStart);
      }
      const rateMbps = bytes * 8 / (windowMs * 1000);
      return {
        fromPort,
        toPort: this.other(fromPort),
        bytes,
        totalBytes: state.totalBytes,
        rateMbps,
        utilizationPct: Math.min(100, rateMbps / this.bandwidthMbps * 100),
      };
    }
    _recordTraffic(state, tStart, tEnd, bytes) {
      const duration = Math.max(0.001, tEnd - tStart);
      const first = Math.floor(tStart / TRAFFIC_BUCKET_MS) * TRAFFIC_BUCKET_MS;
      const last = Math.floor(Math.max(tStart, tEnd - 1e-9) /
        TRAFFIC_BUCKET_MS) * TRAFFIC_BUCKET_MS;
      for (let bucket = first; bucket <= last; bucket += TRAFFIC_BUCKET_MS) {
        const overlap = Math.max(0,
          Math.min(tEnd, bucket + TRAFFIC_BUCKET_MS) - Math.max(tStart, bucket));
        if (!overlap) continue;
        const bucketBytes = bytes * overlap / duration;
        const tail = state.transmissions[state.transmissions.length - 1];
        if (tail && tail.tStart === bucket) tail.bytes += bucketBytes;
        else state.transmissions.push({
          tStart: bucket,
          tEnd: bucket + TRAFFIC_BUCKET_MS,
          bytes: bucketBytes,
        });
      }
      const cutoff = this.sim.time - TRAFFIC_HISTORY_MS;
      let prune = 0;
      while (prune < state.transmissions.length &&
             state.transmissions[prune].tEnd <= cutoff) prune++;
      if (prune) state.transmissions.splice(0, prune);
    }
    trafficStats(windowMs) {
      const window = finiteInRange(windowMs, 1000, 100, 60000);
      const directions = [
        this._directionTraffic(this.a, window),
        this._directionTraffic(this.b, window),
      ];
      return {
        windowMs: window,
        bandwidthMbps: this.bandwidthMbps,
        directions,
        totalBytes: directions[0].totalBytes + directions[1].totalBytes,
      };
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
      const packets = framePackets(copy);
      const serializationMs = Math.max(0.001, bytes * 8 / (this.bandwidthMbps * 1000));
      const state = this._direction(fromPort);
      const queueDepth = this._queueDepth(state, now);
      const tStart = Math.max(now, state.busyUntil);
      const waits = tStart > now + 1e-9;
      // Aggregated iperf traffic arrives as a packet train. Admit the train
      // when the FIFO still has space and allow at most one train of bounded
      // overshoot; requiring room for the whole group would turn a single
      // queued ACK into an artificial 64-packet tail drop.
      if (waits && queueDepth >= this.queueLimitPackets) {
        this.droppedFrames += packets;
        this.sim.note('queue-drop', NetSim.t('net.link.queueDrop',
          fromPort.device.name, fromPort.shortName, this.queueLimitPackets));
        return;
      }
      const tSerialized = tStart + serializationMs;
      if (waits || packets > 1) {
        state.queueEntries.push({
          tStart,
          tEnd: tSerialized,
          packets,
          perPacketMs: serializationMs / packets,
        });
      }
      const propagationMs = this._sampleLatency();
      const tArrival = tSerialized + propagationMs;
      const firstArrival = tStart + serializationMs / packets + propagationMs;
      // A group represents a train of ordinary packets, not one giant frame.
      // Forwarding devices can start relaying when the first packet arrives,
      // which pipelines the train across equal-speed hops. End hosts receive
      // the aggregate only after its final packet has arrived.
      const deliveryAt = packets > 1 && FORWARDING_TYPES.has(toPort.device.type)
        ? firstArrival : tArrival;
      state.busyUntil = tSerialized;
      state.totalBytes += bytes;
      this._recordTraffic(state, tStart, tSerialized, bytes);

      // Register animation metadata immediately. Canvas hides future-starting
      // entries, avoiding one simulator event per queued frame.
      this.sim.addTransmission(this, fromPort, copy, {
        tStart, tEnd: tArrival, bytes, packets, serializationMs, propagationMs,
      });
      this.sim.schedule(deliveryAt - now, () => {
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
  NetSim.framePackets = framePackets;
})(typeof window !== 'undefined' ? window : globalThis);
