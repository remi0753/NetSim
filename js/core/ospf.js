/* NetSim core: simplified OSPF — hello adjacency, LSA flooding, Dijkstra SPF with ECMP.
 * Model: each router-LSA lists the router's attached subnets; SPF runs over a
 * bipartite graph (router nodes <-> subnet nodes), so DR election/network-LSAs
 * are not needed. Timers are sized for the visual link delay. */
(function (root) {
  const NetSim = root.NetSim;
  const IP = NetSim.ip;
  const pdu = NetSim.pdu;

  const OSPF_IP = '224.0.0.5', OSPF_MAC = '01:00:5e:00:00:05';
  const HELLO = 5000, DEAD = 20000, REFRESH = 25000, MAXAGE = 80000, SPF_DELAY = 300;

  function wildcardMatch(ip, net, wild) {
    const a = IP.toInt(ip), n = IP.toInt(net), w = IP.toInt(wild);
    if (a === null || n === null || w === null) return false;
    return (((a ^ n) & ~w) >>> 0) === 0;
  }

  class Ospf {
    constructor(device, stack) {
      this.device = device;
      this.stack = stack;
      this.sim = device.sim;
      this.enabled = false;
      this.processId = null;
      this.routerId = null;
      this.manualRouterId = null;
      this.networks = [];        // {net, wild, area}
      this.passive = new Set();  // lower-cased interface names
      this.neighbors = new Map();// routerId -> {routerId, ip, ifname, iface, lastSeen, twoWay}
      this.lsdb = new Map();     // routerId -> {lsa:{routerId, seq, nets:[{network,len,cost}]}, ts}
      this.seq = 0;
      this._spfPending = false;
      this._lastKey = null;
      this._lastOrig = -Infinity;
      stack.mcastHandlers.set(OSPF_IP, (iface, pkt) => this.onPacket(iface, pkt));
    }

    start(pid) {
      this.processId = pid;
      if (this.enabled) return;
      this.enabled = true;
      this.sim.schedule(200 + Math.floor(Math.random() * 400), () => this._tick());
    }
    stop() {
      this.enabled = false;
      this.processId = null;
      this.neighbors.clear();
      this.lsdb.clear();
      this.stack.setDynRoutes('ospf', []);
    }

    _pickRouterId() {
      if (this.manualRouterId) return this.manualRouterId;
      let best = null;
      for (const i of this.stack.ifaces) {
        if (i.ip && (!best || IP.toInt(i.ip) > IP.toInt(best))) best = i.ip;
      }
      return best;
    }
    ifaceEnabled(iface) {
      if (!iface.ip) return false;
      return this.networks.some(n => wildcardMatch(iface.ip, n.net, n.wild));
    }
    isPassive(iface) { return this.passive.has(iface.name.toLowerCase()); }
    activeIfaces() {
      return this.stack.ifaces.filter(i => i.isUp() && this.ifaceEnabled(i));
    }

    /* periodic: hellos, dead-neighbor detection, LSA refresh & aging */
    _tick() {
      if (!this.enabled) return;
      this.routerId = this._pickRouterId();
      if (this.routerId) {
        for (const iface of this.activeIfaces()) {
          if (this.isPassive(iface)) continue;
          const seen = [...this.neighbors.values()]
            .filter(n => n.ifname === iface.name).map(n => n.routerId);
          this._send(iface, { type: 'hello', routerId: this.routerId, seen });
        }
        for (const [rid, n] of [...this.neighbors]) {
          const gone = this.sim.time - n.lastSeen > DEAD ||
            !n.iface.isUp() || !this.ifaceEnabled(n.iface) || this.isPassive(n.iface);
          if (gone) {
            this.neighbors.delete(rid);
            this.sim.note('ospf', NetSim.t('net.ospf.neighborDown', this.device.name, rid));
            this._purge(rid);
            this._scheduleSpf();
          }
        }
        const key = this._linksKey();
        if (key !== this._lastKey || this.sim.time - this._lastOrig > REFRESH) this._originate();
        let aged = false;
        for (const [rid, e] of [...this.lsdb]) {
          if (rid !== this.routerId && this.sim.time - e.ts > MAXAGE) {
            this.lsdb.delete(rid);
            aged = true;
          }
        }
        if (aged) this._scheduleSpf();
      }
      this.sim.schedule(HELLO, () => this._tick());
    }

    _linksKey() {
      return this.activeIfaces()
        .map(i => `${i.name}=${i.ip}/${i.maskLen}@${i.ospfCost || 1}`).join(',');
    }
    _send(iface, payload) {
      const pkt = pdu.ipv4(iface.ip, OSPF_IP, 'ospf', payload);
      pkt.ttl = 1;
      iface.send(pdu.eth(iface.mac, OSPF_MAC, 'ipv4', pkt));
    }

    _originate() {
      this._lastKey = this._linksKey();
      this._lastOrig = this.sim.time;
      this.seq++;
      const nets = this.activeIfaces().map(i => ({
        network: IP.networkOf(i.ip, i.maskLen), len: i.maskLen, cost: i.ospfCost || 1,
      }));
      const lsa = { routerId: this.routerId, seq: this.seq, nets };
      this.lsdb.set(this.routerId, { lsa, ts: this.sim.time });
      this._flood([lsa], null);
      this._scheduleSpf();
    }
    _flood(lsas, exceptIface) {
      for (const iface of this.activeIfaces()) {
        if (iface === exceptIface || this.isPassive(iface)) continue;
        this._send(iface, { type: 'lsu', lsas });
      }
    }
    _purge(rid, exceptIface) {
      const e = this.lsdb.get(rid);
      const seq = e ? e.lsa.seq : 0;
      this.lsdb.delete(rid);
      for (const iface of this.activeIfaces()) {
        if (iface === exceptIface || this.isPassive(iface)) continue;
        this._send(iface, { type: 'purge', routerId: rid, seq });
      }
    }

    onPacket(iface, pkt) {
      if (!this.enabled || !this.routerId) return;
      if (!this.ifaceEnabled(iface) || this.isPassive(iface)) return;
      const p = pkt.payload;
      if (p.type === 'hello') {
        if (p.routerId === this.routerId) return;
        let n = this.neighbors.get(p.routerId);
        const isNew = !n;
        if (!n) {
          n = { routerId: p.routerId, ip: pkt.src, ifname: iface.name, iface, lastSeen: 0, twoWay: false };
          this.neighbors.set(p.routerId, n);
        }
        n.lastSeen = this.sim.time;
        n.ip = pkt.src;
        n.ifname = iface.name;
        n.iface = iface;
        n.twoWay = p.seen.includes(this.routerId);
        if (isNew) {
          this.sim.note('ospf', NetSim.t('net.ospf.neighborUp', this.device.name, p.routerId, iface.name));
          // immediate hello back + full LSDB exchange (DBD/LSR simplified away)
          const seen = [...this.neighbors.values()]
            .filter(x => x.ifname === iface.name).map(x => x.routerId);
          this._send(iface, { type: 'hello', routerId: this.routerId, seen });
          const all = [...this.lsdb.values()].map(e => e.lsa);
          if (all.length) this._send(iface, { type: 'lsu', lsas: all });
          this._originate();
        }
      } else if (p.type === 'lsu') {
        const fresh = [];
        for (const lsa of p.lsas) {
          if (lsa.routerId === this.routerId) {
            if (lsa.seq >= this.seq) { this.seq = lsa.seq; this._originate(); }
            continue;
          }
          const cur = this.lsdb.get(lsa.routerId);
          if (!cur || lsa.seq > cur.lsa.seq) {
            this.lsdb.set(lsa.routerId, { lsa, ts: this.sim.time });
            fresh.push(lsa);
          } else {
            cur.ts = this.sim.time;   // refresh age
          }
        }
        if (fresh.length) {
          this._flood(fresh, iface);
          this._scheduleSpf();
        }
      } else if (p.type === 'purge') {
        if (p.routerId === this.routerId) {
          // we are alive — reassert with a higher sequence number
          if (p.seq >= this.seq) this.seq = p.seq;
          this._originate();
          return;
        }
        const cur = this.lsdb.get(p.routerId);
        if (cur && cur.lsa.seq <= p.seq) {
          this._purge(p.routerId, iface);
          this._scheduleSpf();
        }
      }
    }

    _scheduleSpf() {
      if (this._spfPending) return;
      this._spfPending = true;
      this.sim.schedule(SPF_DELAY, () => {
        this._spfPending = false;
        this._runSpf();
      });
    }

    /* Dijkstra over router/subnet bipartite graph, tracking ECMP first hops */
    _runSpf() {
      if (!this.enabled || !this.routerId) {
        this.stack.setDynRoutes('ospf', []);
        return;
      }
      const edges = new Map();
      const addEdge = (a, b, c) => {
        if (!edges.has(a)) edges.set(a, []);
        edges.get(a).push({ to: b, cost: c });
      };
      for (const { lsa } of this.lsdb.values()) {
        const rn = 'R:' + lsa.routerId;
        for (const net of lsa.nets) {
          const nn = 'N:' + net.network + '/' + net.len;
          addEdge(rn, nn, net.cost || 1);
          addEdge(nn, rn, 0);
        }
      }
      const src = 'R:' + this.routerId;
      const dist = new Map([[src, 0]]);
      const firstHops = new Map([[src, new Set()]]);   // empty set = still local
      const visited = new Set();
      const hopsVia = (u, to) => {
        if (u === src) return new Set();
        const fhu = firstHops.get(u) || new Set();
        if (fhu.size === 0 && to.startsWith('R:')) return new Set([to.slice(2)]);
        return new Set(fhu);
      };
      for (;;) {
        let u = null, du = Infinity;
        for (const [node, d] of dist) {
          if (!visited.has(node) && d < du) { u = node; du = d; }
        }
        if (u === null) break;
        visited.add(u);
        for (const e of edges.get(u) || []) {
          const nd = du + e.cost;
          const cur = dist.get(e.to);
          if (cur === undefined || nd < cur) {
            dist.set(e.to, nd);
            firstHops.set(e.to, hopsVia(u, e.to));
          } else if (nd === cur) {
            const tgt = firstHops.get(e.to);
            for (const x of hopsVia(u, e.to)) tgt.add(x);
          }
        }
      }
      const routes = [];
      for (const [node, d] of dist) {
        if (!node.startsWith('N:')) continue;
        const [network, lenS] = node.slice(2).split('/');
        const len = Number(lenS);
        const connected = this.stack.ifaces.some(i => i.ip && i.isUp() &&
          i.maskLen === len && IP.networkOf(i.ip, i.maskLen) === network);
        if (connected) continue;
        const fh = firstHops.get(node);
        if (!fh || fh.size === 0) continue;
        const nexthops = [];
        for (const rid of fh) {
          const n = this.neighbors.get(rid);
          if (n && n.twoWay) nexthops.push(n.ip);
        }
        if (nexthops.length) routes.push({ network, len, nexthops: nexthops.sort(), metric: d });
      }
      this.stack.setDynRoutes('ospf', routes);
    }

    /* ---------- persistence ---------- */
    serialize() {
      if (!this.enabled) return null;
      return {
        pid: this.processId,
        routerId: this.manualRouterId,
        networks: this.networks.slice(),
        passive: [...this.passive],
      };
    }
    applyConfig(cfg) {
      if (!cfg) return;
      this.manualRouterId = cfg.routerId || null;
      this.networks = (cfg.networks || []).slice();
      this.passive = new Set(cfg.passive || []);
      this.start(cfg.pid || 1);
    }
  }

  NetSim.Ospf = Ospf;
})(typeof window !== 'undefined' ? window : globalThis);
