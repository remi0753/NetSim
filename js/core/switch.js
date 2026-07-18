/* NetSim device: L2 switch — MAC learning, flooding, 802.1Q VLAN (access/trunk) */
(function (root) {
  const NetSim = root.NetSim;
  const BC = NetSim.BROADCAST_MAC;
  const MAC_AGE = 300000;
  const STP_PRIORITY_DEFAULT = 32768;

  class L2Switch extends NetSim.Device {
    constructor(net, name, portCount) {
      super(net, name);
      this.baseMac = NetSim.genMac();
      this.stpPriority = STP_PRIORITY_DEFAULT;
      this.stpMode = 'rapid-pvst';
      this.stpRootId = null;
      this.stpRootCost = 0;
      this.stpRootPort = null;
      this.stpVlanRoots = new Map();
      this.vlans = new Map([[1, { name: 'default' }]]);
      this.macTable = new Map();   // "vlan|mac" -> {port, ts}
      this.portCfg = new Map();    // port.id -> {mode, accessVlan, allowed:'all'|number[], nativeVlan}
      const n = portCount || 8;
      for (let i = 1; i <= n; i++) {
        const p = this.addPort(`GigabitEthernet0/${i}`, { shortName: `Gi0/${i}` });
        this.portCfg.set(p.id, { mode: 'access', accessVlan: 1, allowed: 'all', nativeVlan: 1, channel: null });
      }
      new NetSim.IosCli(this, this.cliCaps());
    }
    cliCaps() { return { l2: true, l3: false, svi: false, acl: false, lacp: true }; }
    cfg(port) { return this.portCfg.get(port.id); }
    stpBridgeId() { return `${String(this.stpPriority).padStart(5, '0')}.${this.baseMac.replace(/:/g, '')}`; }
    stpPortId(port) { return this.ports.indexOf(port) + 1; }
    // `disabled` is a snapshot state from the last tree calculation.  A
    // directly configured interface can come up before it emits a topology
    // change (sample builders do this), and it must not be treated as blocked.
    isStpForwarding(port, vlan) {
      const entry = this.stpMode === 'rapid-pvst' && vlan != null
        ? port.stpVlans && port.stpVlans.get(vlan)
        : port.stpCommon;
      return !entry || entry.state !== 'blocking';
    }

    addVlan(id, name) {
      if (!this.vlans.has(id)) this.vlans.set(id, { name: name || `VLAN${String(id).padStart(4, '0')}` });
      else if (name) this.vlans.get(id).name = name;
    }
    removeVlan(id) {
      if (id === 1) return;
      this.vlans.delete(id);
    }
    vlanActive(id) { return this.vlans.has(id); }

    /* which VLAN does an ingress frame belong to? null = drop */
    ingressVlan(port, frame) {
      const c = this.cfg(port);
      if (c.mode === 'access') {
        if (frame.vlan != null && frame.vlan !== c.accessVlan) return null; // tagged mismatch on access port
        return this.vlanActive(c.accessVlan) ? c.accessVlan : null;
      }
      // trunk
      const vlan = frame.vlan != null ? frame.vlan : c.nativeVlan;
      if (!this.trunkAllows(c, vlan)) return null;
      return this.vlanActive(vlan) ? vlan : null;
    }
    trunkAllows(c, vlan) {
      return c.allowed === 'all' || c.allowed.includes(vlan);
    }

    /* send frame out of a port in a vlan, applying tagging rules; false if filtered */
    egress(port, vlan, frame) {
      if (!port.link || !port.isUp() || !this.isStpForwarding(port, vlan)) return false;
      const c = this.cfg(port);
      const out = NetSim.clone(frame);
      if (c.mode === 'access') {
        if (c.accessVlan !== vlan) return false;
        out.vlan = null;
      } else {
        if (!this.trunkAllows(c, vlan)) return false;
        out.vlan = vlan === c.nativeVlan ? null : vlan;
      }
      port.link.transmit(port, out);
      return true;
    }

    /* ---- static port-channel (no LACP negotiation is simulated) ---- */
    channelMembers(n) {
      return this.ports.filter(p => this.cfg(p).channel === n);
    }
    /* logical forwarding identity: channel members share one */
    logicalKey(port) {
      const c = this.cfg(port);
      return c.channel != null ? 'ch' + c.channel : port.id;
    }
    _frameHash(frame) {
      let s = frame.src + '|' + frame.dst;
      if (frame.type === 'ipv4') {
        const ip = frame.payload;
        s += '|' + ip.src + '|' + ip.dst;
        const l4 = ip.payload;
        if ((ip.proto === 'tcp' || ip.proto === 'udp') && l4) s += '|' + l4.srcPort + '|' + l4.dstPort;
      }
      return NetSim.hashStr(s);
    }
    /* resolve a logical destination (port or channel) to the member carrying this frame */
    _resolveEgressPort(port, frame) {
      const c = this.cfg(port);
      if (c.channel == null) return port;
      const members = this.channelMembers(c.channel).filter(p => p.isUp());
      if (!members.length) return null;
      return members[this._frameHash(frame) % members.length];
    }

    learn(vlan, mac, port) {
      if (mac === BC) return;
      this.macTable.set(`${vlan}|${mac}`, { port, channel: this.cfg(port).channel, ts: this.sim.time });
    }
    /* returns a representative learned port (channel-aware) or null */
    lookup(vlan, mac) {
      const e = this.macTable.get(`${vlan}|${mac}`);
      if (!e) return null;
      const stale = this.sim.time - e.ts > MAC_AGE ||
        (e.channel == null ? !e.port.link : this.channelMembers(e.channel).every(p => !p.isUp()));
      if (stale) {
        this.macTable.delete(`${vlan}|${mac}`);
        return null;
      }
      if (e.channel != null) {
        const member = this.channelMembers(e.channel).find(p => p.isUp());
        return member || null;
      }
      return e.port;
    }
    clearMacTable() { this.macTable.clear(); }
    macRows() {
      const rows = [];
      for (const [key, e] of this.macTable) {
        if (this.sim.time - e.ts > MAC_AGE) continue;
        const [vlan, mac] = key.split('|');
        rows.push({ vlan: Number(vlan), mac, port: e.channel != null ? 'Po' + e.channel : e.port.shortName });
      }
      rows.sort((a, b) => a.vlan - b.vlan || a.mac.localeCompare(b.mac));
      return rows;
    }

    receiveFrame(port, frame) {
      if (!port.isUp()) return;
      const vlan = this.ingressVlan(port, frame);
      if (vlan == null) return;
      if (!this.isStpForwarding(port, vlan)) return;
      this.learn(vlan, frame.src, port);
      this.l2Forward(port, vlan, frame);
      this.deliverToCpu(port, vlan, frame);   // hook for L3 switch SVIs
    }

    l2Forward(inPort, vlan, frame) {
      const inKey = this.logicalKey(inPort);
      if (frame.dst !== BC) {
        if (this.cpuOwnsMac && this.cpuOwnsMac(frame.dst)) return;  // destined to the switch itself
        const outPort = this.lookup(vlan, frame.dst);
        if (outPort) {
          if (this.logicalKey(outPort) !== inKey) {
            const member = this._resolveEgressPort(outPort, frame);
            if (member) this.egress(member, vlan, frame);
          }
          return;
        }
      }
      // flood (broadcast / unknown unicast) — one copy per logical port
      const seen = new Set([inKey]);
      for (const p of this.ports) {
        const key = this.logicalKey(p);
        if (seen.has(key)) continue;
        seen.add(key);
        const member = this._resolveEgressPort(p, frame);
        if (member) this.egress(member, vlan, frame);
      }
    }

    /* overridden by L3 switch */
    deliverToCpu(port, vlan, frame) {}
    cpuOwnsMac(mac) { return false; }

    getPrompt() { return this.cli ? this.cli.prompt() : this.name + '>'; }
    exec(line) { if (this.cli) this.cli.exec(line); }

    serializeConfig() {
      return {
        stpPriority: this.stpPriority,
        stpMode: this.stpMode,
        vlans: [...this.vlans].map(([id, v]) => ({ id, name: v.name })),
        ports: this.ports.map(p => {
          const c = this.cfg(p);
          return {
            name: p.name, adminUp: p.adminUp, description: p.description,
            mode: c.mode, accessVlan: c.accessVlan,
            allowed: c.allowed === 'all' ? 'all' : c.allowed.slice(), nativeVlan: c.nativeVlan,
            channel: c.channel,
          };
        }),
      };
    }
    applyConfig(cfg) {
      if (!cfg) return;
      if (cfg.stpPriority != null) this.stpPriority = cfg.stpPriority;
      if (cfg.stpMode === 'rstp' || cfg.stpMode === 'rapid-pvst') this.stpMode = cfg.stpMode;
      for (const v of cfg.vlans || []) this.addVlan(v.id, v.name);
      for (const pc of cfg.ports || []) {
        const p = this.getPort(pc.name);
        if (!p) continue;
        p.adminUp = pc.adminUp !== false;
        p.description = pc.description || '';
        const c = this.cfg(p);
        c.mode = pc.mode || 'access';
        c.accessVlan = pc.accessVlan || 1;
        c.allowed = pc.allowed === 'all' || pc.allowed == null ? 'all' : pc.allowed.slice();
        c.nativeVlan = pc.nativeVlan || 1;
        c.channel = pc.channel != null ? pc.channel : null;
      }
      if (this.net.recomputeStp) this.net.recomputeStp();
    }
  }
  L2Switch.TYPE = 'switch';

  NetSim.L2Switch = L2Switch;
})(typeof window !== 'undefined' ? window : globalThis);
