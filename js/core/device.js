/* NetSim core: device base class */
(function (root) {
  const NetSim = root.NetSim;

  class Device extends NetSim.Emitter {
    constructor(net, name) {
      super();
      this.id = NetSim.nextId('dev');
      this.net = net;
      this.sim = net.sim;
      this.name = name;
      this.x = 0; this.y = 0;
      this.ports = [];
    }
    get type() { return this.constructor.TYPE; }

    addPort(name, opts) {
      const p = new NetSim.Port(this, name, opts);
      this.ports.push(p);
      return p;
    }
    getPort(name) {
      const n = String(name).toLowerCase();
      return this.ports.find(p =>
        p.name.toLowerCase() === n || p.shortName.toLowerCase() === n) || null;
    }
    freePorts() { return this.ports.filter(p => !p.link); }

    /* override in subclasses */
    receiveFrame(port, frame) {}

    /* console output — terminals subscribe to 'output' */
    out(line) { this.emit('output', line == null ? '' : String(line)); }
    /* execute one console command line; override */
    exec(line) { this.out('% not supported'); }
    getPrompt() { return this.name + '>'; }

    /* notify UI that config changed */
    changed() {
      // A physical/admin state change can alter the active spanning tree.
      // Keeping this here also covers router/host-side link shutdowns.
      if (this.net.recomputeStp) this.net.recomputeStp();
      this.emit('changed'); this.net.emit('changed');
    }

    destroy() {
      for (const p of this.ports) {
        if (p.link) this.net.removeLink(p.link);
      }
    }

    /* persistence -- subclasses extend */
    serialize() {
      return {
        id: this.id, type: this.type, name: this.name, x: this.x, y: this.y,
        portCount: this.ports.length, config: this.serializeConfig(),
      };
    }
    serializeConfig() { return {}; }
    applyConfig(cfg) {}
  }

  NetSim.Device = Device;
})(typeof window !== 'undefined' ? window : globalThis);
