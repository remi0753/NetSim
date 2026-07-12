/* NetSim device: L1 repeater hub — floods every frame to all other ports */
(function (root) {
  const NetSim = root.NetSim;

  class Hub extends NetSim.Device {
    constructor(net, name) {
      super(net, name);
      for (let i = 1; i <= 6; i++) this.addPort(`Port${i}`, { shortName: `P${i}` });
    }
    receiveFrame(port, frame) {
      for (const p of this.ports) {
        if (p !== port && p.link && p.isUp()) p.link.transmit(p, frame);
      }
    }
    getPrompt() { return `${this.name} (hub)`; }
    exec(line) { this.out(NetSim.t('hub.noConfig')); }
  }
  Hub.TYPE = 'hub';

  NetSim.Hub = Hub;
})(typeof window !== 'undefined' ? window : globalThis);
