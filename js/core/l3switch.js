/* NetSim device: L3 switch — L2 switching + SVI (interface vlan) routing + ACL */
(function (root) {
  const NetSim = root.NetSim;
  const BC = NetSim.BROADCAST_MAC;

  class L3Switch extends NetSim.L2Switch {
    constructor(net, name, portCount) {
      super(net, name, portCount || 8);
      this.stack = new NetSim.NetworkStack(this, { forwarding: true });
      this.svis = new Map();   // vlanId -> L3Interface
      this.acls = new Map();
      this.vxlanMacTable = new Map(); // "vni|mac" -> remote VTEP IP
      this.stack.aclCheck = (dir, iface, pkt) => {
        const num = dir === 'in' ? iface.aclIn : iface.aclOut;
        if (num == null) return true;
        return NetSim.acl.evaluate(this.acls.get(num), pkt);
      };
      this.ospf = new NetSim.Ospf(this, this.stack);
    }
    cliCaps() { return { l2: true, l3: true, svi: true, acl: true, ospf: true, vrrp: true, helper: true, lacp: true, nat: false, vxlan: true }; }

    createSvi(vlanId) {
      if (this.svis.has(vlanId)) return this.svis.get(vlanId);
      if (!this.vlanActive(vlanId)) this.addVlan(vlanId);
      const iface = this.stack.addInterface(`Vlan${vlanId}`, this.baseMac, {
        send: (frame) => this._sviSend(vlanId, frame),
        isUp: () => this._sviUp(vlanId),
      });
      iface.vlanId = vlanId;
      this.svis.set(vlanId, iface);
      return iface;
    }
    removeSvi(vlanId) {
      const iface = this.svis.get(vlanId);
      if (!iface) return;
      this.stack.removeInterface(iface);
      this.svis.delete(vlanId);
    }

    /* SVI is up when the VLAN exists and at least one port carrying it is up */
    _sviUp(vlanId) {
      if (!this.vlanActive(vlanId)) return false;
      return this.ports.some(p => {
        if (!p.isUp()) return false;
        const c = this.cfg(p);
        return c.mode === 'access' ? c.accessVlan === vlanId : this.trunkAllows(c, vlanId);
      });
    }

    /* CPU-originated frame injected into the VLAN */
    _sviSend(vlanId, frame) {
      if (frame.dst !== BC) {
        const outPort = this.lookup(vlanId, frame.dst);
        if (outPort) {
          const member = this._resolveEgressPort(outPort, frame);
          if (member) this.egress(member, vlanId, frame);
          return;
        }
      }
      const seen = new Set();
      for (const p of this.ports) {
        const key = this.logicalKey(p);
        if (seen.has(key)) continue;
        seen.add(key);
        const member = this._resolveEgressPort(p, frame);
        if (member) this.egress(member, vlanId, frame);
      }
      this._vxlanEncapsulate(vlanId, frame);
    }

    cpuOwnsMac(mac) { return mac === this.baseMac; }

    deliverToCpu(port, vlan, frame) {
      const iface = this.svis.get(vlan);
      if (!iface) return;
      const vrrpMac = iface.vrrp && frame.dst === iface.vrrp.vmac;
      if (frame.dst !== this.baseMac && frame.dst !== BC &&
          !frame.dst.startsWith('01:00:5e') && !vrrpMac) return;
      this.stack.onFrame(iface, frame);
    }

    receiveFrame(port, frame) {
      if (!port.isUp()) return;
      const vlan = this.ingressVlan(port, frame);
      if (vlan == null || !this.isStpForwarding(port, vlan)) return;
      this.learn(vlan, frame.src, port);
      this.l2Forward(port, vlan, frame);
      this.deliverToCpu(port, vlan, frame);
      this._vxlanEncapsulate(vlan, frame);
    }
    _vxlanEncapsulate(vlan, frame) {
      const vx = this.stack.vxlan;
      if (!vx || vx.vlanId !== vlan) return;
      if (this.cpuOwnsMac(frame.dst)) return;
      const remote = frame.dst === BC ? null : this.vxlanMacTable.get(`${vx.vni}|${frame.dst}`);
      if (!remote && frame.dst !== BC && this.lookup(vlan, frame.dst)) return; // locally attached
      const peers = remote ? [remote] : vx.peers.map(p => p.vtep);
      const inner = NetSim.clone(frame);
      inner.vlan = null; // VLAN is represented by the VNI at the VTEP boundary
      const source = this.stack.getIface(vx.sourceInterface);
      for (const vtep of peers) if (!source || source.ip !== vtep) this.stack.sendVxlan(vtep, inner);
    }
    receiveVxlanFrame(vni, frame, remoteVtep) {
      const vx = this.stack.vxlan;
      if (!vx || vx.vni !== vni || !frame || frame.l2 !== 'eth') return;
      const vlan = vx.vlanId;
      this.vxlanMacTable.set(`${vni}|${frame.src}`, remoteVtep);
      if (!this.cpuOwnsMac(frame.dst)) {
        const outPort = this.lookup(vlan, frame.dst);
        if (outPort) {
          const member = this._resolveEgressPort(outPort, frame);
          if (member) this.egress(member, vlan, frame);
        } else {
          const seen = new Set();
          for (const p of this.ports) {
            const key = this.logicalKey(p);
            if (seen.has(key)) continue;
            seen.add(key);
            const member = this._resolveEgressPort(p, frame);
            if (member) this.egress(member, vlan, frame);
          }
        }
      }
      this.deliverToCpu(null, vlan, frame);
    }

    serializeConfig() {
      const cfg = super.serializeConfig();
      cfg.svis = [...this.svis].map(([vlanId, iface]) => ({
        vlanId, ip: iface.ip, maskLen: iface.maskLen, aclIn: iface.aclIn, aclOut: iface.aclOut,
        ospfCost: iface.ospfCost, helperAddr: iface.helperAddr,
        vrrp: iface.vrrp ? { gid: iface.vrrp.gid, vip: iface.vrrp.vip, priority: iface.vrrp.priority } : null,
      }));
      cfg.routes = this.stack.staticRoutes.map(r => ({ network: r.network, len: r.len, nexthop: r.nexthop }));
      cfg.acls = [...this.acls].map(([num, rules]) => ({ num, rules }));
      cfg.vxlan = this.stack.vxlan ? {
        vni: this.stack.vxlan.vni,
        vlanId: this.stack.vxlan.vlanId,
        sourceInterface: this.stack.vxlan.sourceInterface,
        peers: this.stack.vxlan.peers.map(p => ({ vtep: p.vtep })),
      } : null;
      cfg.ospf = this.ospf.serialize();
      return cfg;
    }
    applyConfig(cfg) {
      super.applyConfig(cfg);
      if (!cfg) return;
      for (const s of cfg.svis || []) {
        const iface = this.createSvi(s.vlanId);
        if (s.ip) iface.setIp(s.ip, s.maskLen);
        iface.aclIn = s.aclIn != null ? s.aclIn : null;
        iface.aclOut = s.aclOut != null ? s.aclOut : null;
        iface.ospfCost = s.ospfCost || 1;
        iface.helperAddr = s.helperAddr || null;
        if (s.vrrp) this.stack.configureVrrp(iface, s.vrrp.gid, s.vrrp.vip, s.vrrp.priority);
      }
      for (const r of cfg.routes || []) this.stack.addStaticRoute(r.network, r.len, r.nexthop);
      for (const a of cfg.acls || []) this.acls.set(a.num, a.rules);
      if (cfg.vxlan && cfg.vxlan.vlanId != null) this.stack.configureVxlan(cfg.vxlan.vni, cfg.vxlan.vlanId, cfg.vxlan.sourceInterface, cfg.vxlan.peers);
      if (cfg.ospf) this.ospf.applyConfig(cfg.ospf);
    }
  }
  L3Switch.TYPE = 'l3switch';

  NetSim.L3Switch = L3Switch;
})(typeof window !== 'undefined' ? window : globalThis);
