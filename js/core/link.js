/* NetSim core: ports and links (L1) */
(function (root) {
  const NetSim = root.NetSim;

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
      return 'connected';
    }
  }

  class Link {
    constructor(sim, portA, portB) {
      this.id = NetSim.nextId('link');
      this.sim = sim;
      this.a = portA;
      this.b = portB;
      portA.link = this;
      portB.link = this;
    }
    other(port) { return port === this.a ? this.b : this.a; }
    isUp() { return this.a.adminUp && this.b.adminUp; }

    /* send a frame from one end; delivered to the other end after linkDelay */
    transmit(fromPort, frame) {
      if (!this.isUp()) return;
      const toPort = this.other(fromPort);
      const copy = NetSim.clone(frame);
      copy.hops = (copy.hops || 0) + 1;
      if (copy.hops > 64) {
        this.sim.note('loop', NetSim.t('net.loop.detected', fromPort.device.name));
        return;
      }
      this.sim.addTransmission(this, fromPort, copy);
      this.sim.schedule(this.sim.linkDelay, () => {
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
})(typeof window !== 'undefined' ? window : globalThis);
