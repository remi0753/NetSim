/* NetSim core: NAT / PAT (Cisco IOS-style "inside source" NAT).
 * Attached to a router's NetworkStack as stack.nat and driven from the
 * forwarding path (stack.js):
 *   inside  -> outside : rewrite the SOURCE      (inside-local  -> inside-global)
 *   outside -> inside  : rewrite the DESTINATION (inside-global -> inside-local)
 *
 * Supports:
 *   - static 1:1 NAT         ip nat inside source static <local> <global>
 *   - dynamic PAT (overload) ip nat inside source list <acl> interface <if> overload
 *
 * For TCP/UDP the L4 port is the demux key; for ICMP echo the ICMP id plays
 * that role (rewritten out and restored on the reply), exactly as PAT does. */
(function (root) {
  const NetSim = root.NetSim;

  const PAT_PORT_BASE = 1024;   // dynamic global ports start here (leave <1024 for the device itself)

  class Nat {
    constructor(stack) {
      this.stack = stack;
      this.statics = [];    // [{localIp, globalIp}]
      this.dynRules = [];   // [{aclNum, ifname, overload:true}]
      this.entries = [];    // active dynamic translations
    }

    /* ---------------- configuration ---------------- */
    addStatic(localIp, globalIp) {
      if (!this.statics.some(s => s.localIp === localIp && s.globalIp === globalIp)) {
        this.statics.push({ localIp, globalIp });
      }
    }
    removeStatic(localIp, globalIp) {
      this.statics = this.statics.filter(s => !(s.localIp === localIp && s.globalIp === globalIp));
    }
    addDynamic(aclNum, ifname, overload) {
      this.removeDynamic(aclNum, ifname);
      this.dynRules.push({ aclNum, ifname, overload: overload !== false });
    }
    removeDynamic(aclNum, ifname) {
      const n = String(ifname).toLowerCase();
      this.dynRules = this.dynRules.filter(r => !(r.aclNum === aclNum && r.ifname.toLowerCase() === n));
    }
    configured() { return this.statics.length > 0 || this.dynRules.length > 0; }
    clearDynamic() { this.entries = []; }
    /* proxy-ARP: the router answers for a static inside-global address sitting on
     * the outside subnet (a real router does this so the WAN can reach it). */
    answersArpFor(ip) { return this.statics.some(s => s.globalIp === ip); }

    /* ---------------- helpers ---------------- */
    /* the L4 identifier used as a NAT demux key ('src' or 'dst' side) */
    _port(pkt, which) {
      const p = pkt.payload;
      if (pkt.proto === 'tcp' || pkt.proto === 'udp') return which === 'src' ? p.srcPort : p.dstPort;
      if (pkt.proto === 'icmp' && p && (p.type === 'echo-request' || p.type === 'echo-reply')) return p.id;
      return null;
    }
    _setPort(pkt, which, val) {
      if (val == null) return;
      const p = pkt.payload;
      if (pkt.proto === 'tcp' || pkt.proto === 'udp') {
        if (which === 'src') p.srcPort = val; else p.dstPort = val;
      } else if (pkt.proto === 'icmp' && p) {
        p.id = val;   // ICMP has a single identifier shared by request/reply
      }
    }
    _ruleMatch(rule, pkt) {
      const acl = this.stack.getAcl ? this.stack.getAcl(rule.aclNum) : null;
      return NetSim.acl.evaluate(acl, pkt);
    }
    _ruleGlobalIp(rule) {
      const ifc = this.stack.getIface(rule.ifname);
      return ifc && ifc.ip ? ifc.ip : null;
    }
    /* keep the original source port if it is free, else pick the next unused one */
    _pickPort(proto, globalIp, preferred) {
      const used = new Set(this.entries.filter(e => e.proto === proto &&
        e.globalIp === globalIp && e.globalPort != null).map(e => e.globalPort));
      if (preferred != null && preferred >= PAT_PORT_BASE && !used.has(preferred)) return preferred;
      let p = PAT_PORT_BASE;
      while (used.has(p)) p++;
      return p;
    }

    /* ---------------- inside -> outside (rewrite source) ---------------- */
    translateOutbound(pkt) {
      const src = pkt.src;
      // static 1:1 takes precedence
      const st = this.statics.find(s => s.localIp === src);
      if (st) { pkt.src = st.globalIp; return; }
      // dynamic PAT (overload)
      for (const rule of this.dynRules) {
        if (!this._ruleMatch(rule, pkt)) continue;
        const globalIp = this._ruleGlobalIp(rule);
        if (!globalIp) continue;
        const localPort = this._port(pkt, 'src');
        const e = this._allocate(pkt.proto, src, localPort, globalIp);
        e.outIp = pkt.dst; e.outPort = this._port(pkt, 'dst'); e.ts = this.stack.sim.time;
        pkt.src = globalIp;
        this._setPort(pkt, 'src', e.globalPort);
        return;
      }
    }
    _allocate(proto, localIp, localPort, globalIp) {
      let e = this.entries.find(x => x.proto === proto &&
        x.localIp === localIp && x.localPort === localPort && x.globalIp === globalIp);
      if (e) return e;
      const globalPort = localPort == null ? null : this._pickPort(proto, globalIp, localPort);
      e = { proto, localIp, localPort, globalIp, globalPort, outIp: null, outPort: null, ts: this.stack.sim.time };
      this.entries.push(e);
      const l = localPort != null ? `${localIp}:${localPort}` : localIp;
      const g = globalPort != null ? `${globalIp}:${globalPort}` : globalIp;
      this.stack.sim.note('nat', NetSim.t('net.nat.created', this.stack.hostname(), l, g, proto));
      return e;
    }

    /* ---------------- outside -> inside (rewrite destination) ----------------
     * returns true when the packet was translated (and must be forwarded). */
    translateInbound(pkt) {
      const dst = pkt.dst, dport = this._port(pkt, 'dst');
      // return traffic for an active dynamic translation
      const e = this.entries.find(x => x.proto === pkt.proto &&
        x.globalIp === dst && (x.globalPort == null || x.globalPort === dport));
      if (e) {
        pkt.dst = e.localIp;
        this._setPort(pkt, 'dst', e.localPort);
        e.ts = this.stack.sim.time;
        return true;
      }
      // static 1:1 mapping (inbound to the inside-global address)
      const st = this.statics.find(s => s.globalIp === dst);
      if (st) { pkt.dst = st.localIp; return true; }
      return false;
    }

    /* ---------------- show ip nat translations ---------------- */
    rows() {
      const out = [];
      for (const s of this.statics) {
        out.push({ proto: '---', globalIp: s.globalIp, globalPort: null,
          localIp: s.localIp, localPort: null, outIp: null, outPort: null, static: true });
      }
      for (const e of this.entries) {
        out.push({ proto: e.proto, globalIp: e.globalIp, globalPort: e.globalPort,
          localIp: e.localIp, localPort: e.localPort, outIp: e.outIp, outPort: e.outPort, static: false });
      }
      return out;
    }

    serialize() {
      return {
        statics: this.statics.map(s => ({ localIp: s.localIp, globalIp: s.globalIp })),
        dynamic: this.dynRules.map(r => ({ aclNum: r.aclNum, ifname: r.ifname, overload: r.overload })),
      };
    }
    applyConfig(cfg) {
      if (!cfg) return;
      for (const s of cfg.statics || []) this.addStatic(s.localIp, s.globalIp);
      for (const r of cfg.dynamic || []) this.addDynamic(r.aclNum, r.ifname, r.overload);
    }
  }

  NetSim.Nat = Nat;
})(typeof window !== 'undefined' ? window : globalThis);
