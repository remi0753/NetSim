/* NetSim device: router — routed NIC per port, static routing, ACL */
(function (root) {
  const NetSim = root.NetSim;

  class Router extends NetSim.Device {
    constructor(net, name, portCount) {
      super(net, name);
      this.stack = new NetSim.NetworkStack(this, { forwarding: true });
      this.acls = new Map();   // number -> rules[]
      this.stack.aclCheck = (dir, iface, pkt) => {
        const num = dir === 'in' ? iface.aclIn : iface.aclOut;
        if (num == null) return true;
        return NetSim.acl.evaluate(this.acls.get(num), pkt);
      };
      this.stack.getAcl = (num) => this.acls.get(num);   // NAT rule matching by ACL number
      this.stack.nat = new NetSim.Nat(this.stack);
      const n = portCount || 4;
      for (let i = 0; i < n; i++) {
        const port = this.addPort(`GigabitEthernet0/${i}`, {
          shortName: `Gi0/${i}`, mac: NetSim.genMac(),
        });
        port.adminUp = false;   // routers ship with interfaces shutdown
        const iface = this.stack.addInterface(port.name, port.mac, {
          send: (frame) => { if (port.link) port.link.transmit(port, frame); },
          isUp: () => port.isUp(),
        });
        port.l3iface = iface;
      }
      this.ospf = new NetSim.Ospf(this, this.stack);
      new NetSim.IosCli(this, { l2: false, l3: true, svi: false, acl: true, ospf: true, vrrp: true, helper: true, nat: true });
    }

    receiveFrame(port, frame) {
      if (!port.isUp()) return;
      if (frame.vlan != null) return;   // no subinterfaces in this model
      const isMulticastMac = frame.dst.startsWith('01:00:5e');
      const vrrp = port.l3iface.vrrp;
      const isActiveVrrp = vrrp && vrrp.state === 'master' && frame.dst === vrrp.vmac;
      // A hub repeats every bit to every attached router, but an actual router
      // NIC only admits frames addressed to itself (plus broadcast/multicast
      // and an active VRRP virtual MAC).
      if (frame.dst !== port.mac && frame.dst !== NetSim.BROADCAST_MAC &&
          !isMulticastMac && !isActiveVrrp) return;
      this.stack.onFrame(port.l3iface, frame);
    }

    getPrompt() { return this.cli ? this.cli.prompt() : this.name + '>'; }
    exec(line) { if (this.cli) this.cli.exec(line); }

    serializeConfig() {
      return {
        ports: this.ports.map(p => ({
          name: p.name, adminUp: p.adminUp, description: p.description,
          ip: p.l3iface.ip, maskLen: p.l3iface.maskLen,
          aclIn: p.l3iface.aclIn, aclOut: p.l3iface.aclOut,
          ospfCost: p.l3iface.ospfCost, helperAddr: p.l3iface.helperAddr,
          natRole: p.l3iface.natRole || null,
          vrrp: p.l3iface.vrrp ? {
            gid: p.l3iface.vrrp.gid, vip: p.l3iface.vrrp.vip, priority: p.l3iface.vrrp.priority,
          } : null,
        })),
        routes: this.stack.staticRoutes.map(r => ({ network: r.network, len: r.len, nexthop: r.nexthop })),
        acls: [...this.acls].map(([num, rules]) => ({ num, rules })),
        nat: this.stack.nat.serialize(),
        ospf: this.ospf.serialize(),
      };
    }
    applyConfig(cfg) {
      if (!cfg) return;
      for (const pc of cfg.ports || []) {
        const p = this.getPort(pc.name);
        if (!p) continue;
        p.adminUp = pc.adminUp === true;
        p.description = pc.description || '';
        if (pc.ip) p.l3iface.setIp(pc.ip, pc.maskLen);
        p.l3iface.aclIn = pc.aclIn != null ? pc.aclIn : null;
        p.l3iface.aclOut = pc.aclOut != null ? pc.aclOut : null;
        p.l3iface.ospfCost = pc.ospfCost || 1;
        p.l3iface.helperAddr = pc.helperAddr || null;
        p.l3iface.natRole = pc.natRole || null;
        if (pc.vrrp) this.stack.configureVrrp(p.l3iface, pc.vrrp.gid, pc.vrrp.vip, pc.vrrp.priority);
      }
      for (const r of cfg.routes || []) this.stack.addStaticRoute(r.network, r.len, r.nexthop);
      for (const a of cfg.acls || []) this.acls.set(a.num, a.rules);
      if (cfg.nat) this.stack.nat.applyConfig(cfg.nat);
      if (cfg.ospf) this.ospf.applyConfig(cfg.ospf);
    }
  }
  Router.TYPE = 'router';

  NetSim.Router = Router;
})(typeof window !== 'undefined' ? window : globalThis);
