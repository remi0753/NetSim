/* NetSim core: simplified multi-area OSPF — hello adjacency, area-scoped LSA
 * flooding, ABR summaries, and Dijkstra SPF with ECMP.  Router LSAs list
 * attached subnets; SPF uses router <-> subnet pseudo-nodes, so DR election
 * and network-LSAs are intentionally out of scope. */
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
      // Area is part of both identities: an ABR may peer with the same RID in
      // more than one area, and a router has one Router-LSA per area.
      this.neighbors = new Map();// "area|routerId" -> {routerId, area, ...}
      this.lsdb = new Map();     // "area|routerId" -> {lsa:{routerId,area,seq,nets}, ts}
      this.seq = 0;
      this._spfPending = false;
      this._reorigPending = false;
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
    ifaceArea(iface) {
      if (!iface.ip) return null;
      const n = this.networks.find(x => wildcardMatch(iface.ip, x.net, x.wild));
      return n ? n.area : null;
    }
    ifaceEnabled(iface) { return this.ifaceArea(iface) !== null; }
    isPassive(iface) { return this.passive.has(iface.name.toLowerCase()); }
    activeIfaces() { return this.stack.ifaces.filter(i => i.isUp() && this.ifaceEnabled(i)); }
    activeAreas() { return [...new Set(this.activeIfaces().map(i => this.ifaceArea(i)))]; }
    _areaIfaces(area) { return this.activeIfaces().filter(i => this.ifaceArea(i) === area); }
    _neighborKey(area, rid) { return `${area}|${rid}`; }
    _lsaKey(area, rid) { return `${area}|${rid}`; }
    _areaLsas(area) { return [...this.lsdb.values()].map(e => e.lsa).filter(lsa => lsa.area === area); }
    _isAbr() {
      const areas = this.activeAreas();
      return areas.includes(0) && areas.length > 1;
    }

    /* periodic: hellos, dead-neighbor detection, LSA refresh & aging */
    _tick() {
      if (!this.enabled) return;
      this.routerId = this._pickRouterId();
      if (this.routerId) {
        for (const iface of this.activeIfaces()) {
          if (this.isPassive(iface)) continue;
          const area = this.ifaceArea(iface);
          const seen = [...this.neighbors.values()]
            .filter(n => n.ifname === iface.name && n.area === area).map(n => n.routerId);
          this._send(iface, { type: 'hello', area, routerId: this.routerId, seen });
        }
        for (const [key, n] of [...this.neighbors]) {
          const gone = this.sim.time - n.lastSeen > DEAD || !n.iface.isUp() ||
            this.ifaceArea(n.iface) !== n.area || this.isPassive(n.iface);
          if (gone) {
            this.neighbors.delete(key);
            this.sim.note('ospf', NetSim.t('net.ospf.neighborDown', this.device.name, n.routerId));
            this._purge(n.routerId, n.area);
            this._scheduleSpf();
          }
        }
        const key = this._linksKey();
        if (key !== this._lastKey || this.sim.time - this._lastOrig > REFRESH) this._originate();
        let aged = false;
        for (const [key, e] of [...this.lsdb]) {
          if (e.lsa.routerId !== this.routerId && this.sim.time - e.ts > MAXAGE) {
            this.lsdb.delete(key);
            aged = true;
          }
        }
        if (aged) { this._scheduleSpf(); if (this._isAbr()) this._scheduleReoriginate(); }
      }
      this.sim.schedule(HELLO, () => this._tick());
    }

    _linksKey() {
      return this.activeIfaces()
        .map(i => `${i.name}=${i.ip}/${i.maskLen}@${i.ospfCost || 1}:area${this.ifaceArea(i)}`).join(',');
    }
    _send(iface, payload) {
      const pkt = pdu.ipv4(iface.ip, OSPF_IP, 'ospf', payload);
      pkt.ttl = 1;
      iface.send(pdu.eth(iface.mac, OSPF_MAC, 'ipv4', pkt));
    }
    _mergeNets(nets) {
      const byPrefix = new Map();
      for (const net of nets) {
        const key = `${net.network}/${net.len}`;
        const prior = byPrefix.get(key);
        if (!prior || net.cost < prior.cost) byPrefix.set(key, net);
      }
      return [...byPrefix.values()];
    }
    _summaryNetsForBackbone() {
      const nets = [];
      for (const { lsa } of this.lsdb.values()) {
        if (lsa.area === 0) continue;
        for (const net of lsa.nets) {
          // Only advertise routes native to the non-backbone area.  This keeps
          // summaries from being reflected indefinitely between ABRs.
          if (net.scope !== 'intra') continue;
          nets.push({ network: net.network, len: net.len, cost: net.cost || 1,
            scope: 'inter', sourceArea: net.sourceArea == null ? lsa.area : net.sourceArea });
        }
      }
      return this._mergeNets(nets);
    }
    _summaryNetsFromBackbone(targetArea) {
      const nets = [];
      for (const lsa of this._areaLsas(0)) {
        for (const net of lsa.nets) {
          const sourceArea = net.sourceArea == null ? lsa.area : net.sourceArea;
          if (net.scope === 'inter' && sourceArea === targetArea) continue;
          nets.push({ network: net.network, len: net.len, cost: net.cost || 1,
            scope: 'inter', sourceArea });
        }
      }
      return this._mergeNets(nets);
    }
    _originate() {
      this._lastKey = this._linksKey();
      this._lastOrig = this.sim.time;
      for (const area of this.activeAreas()) {
        const nets = this._areaIfaces(area).map(i => ({
          network: IP.networkOf(i.ip, i.maskLen), len: i.maskLen, cost: i.ospfCost || 1,
          scope: 'intra', sourceArea: area,
        }));
        if (this._isAbr()) {
          if (area === 0) nets.push(...this._summaryNetsForBackbone());
          else nets.push(...this._summaryNetsFromBackbone(area));
        }
        const lsa = { routerId: this.routerId, area, seq: ++this.seq, nets: this._mergeNets(nets) };
        this.lsdb.set(this._lsaKey(area, this.routerId), { lsa, ts: this.sim.time });
        this._flood([lsa], null, area);
      }
      this._scheduleSpf();
    }
    _flood(lsas, exceptIface, area) {
      for (const iface of this._areaIfaces(area)) {
        if (iface === exceptIface || this.isPassive(iface)) continue;
        this._send(iface, { type: 'lsu', area, lsas });
      }
    }
    _purge(rid, area, exceptIface) {
      const key = this._lsaKey(area, rid), e = this.lsdb.get(key);
      const seq = e ? e.lsa.seq : 0;
      this.lsdb.delete(key);
      for (const iface of this._areaIfaces(area)) {
        if (iface === exceptIface || this.isPassive(iface)) continue;
        this._send(iface, { type: 'purge', area, routerId: rid, seq });
      }
    }

    onPacket(iface, pkt) {
      if (!this.enabled || !this.routerId || !this.ifaceEnabled(iface) || this.isPassive(iface)) return;
      const p = pkt.payload, area = this.ifaceArea(iface);
      // Different-area routers may share an Ethernet segment but must never
      // form an adjacency or exchange their area's LSDB.
      if (p.area !== area) return;
      if (p.type === 'hello') {
        if (p.routerId === this.routerId) return;
        const key = this._neighborKey(area, p.routerId);
        let n = this.neighbors.get(key);
        const isNew = !n;
        if (!n) {
          n = { routerId: p.routerId, area, ip: pkt.src, ifname: iface.name, iface, lastSeen: 0, twoWay: false };
          this.neighbors.set(key, n);
        }
        n.lastSeen = this.sim.time;
        n.ip = pkt.src;
        n.ifname = iface.name;
        n.iface = iface;
        n.twoWay = p.seen.includes(this.routerId);
        if (isNew) {
          this.sim.note('ospf', NetSim.t('net.ospf.neighborUp', this.device.name, p.routerId, this.stack.displayIface(iface)));
          const seen = [...this.neighbors.values()]
            .filter(x => x.ifname === iface.name && x.area === area).map(x => x.routerId);
          this._send(iface, { type: 'hello', area, routerId: this.routerId, seen });
          const all = this._areaLsas(area);
          if (all.length) this._send(iface, { type: 'lsu', area, lsas: all });
          this._originate();
        }
      } else if (p.type === 'lsu') {
        const fresh = [];
        for (const lsa of p.lsas || []) {
          if (lsa.area !== area) continue;
          if (lsa.routerId === this.routerId) {
            if (lsa.seq >= this.seq) { this.seq = lsa.seq; this._originate(); }
            continue;
          }
          const key = this._lsaKey(area, lsa.routerId), cur = this.lsdb.get(key);
          if (!cur || lsa.seq > cur.lsa.seq) {
            this.lsdb.set(key, { lsa, ts: this.sim.time });
            fresh.push(lsa);
          } else {
            cur.ts = this.sim.time;
          }
        }
        if (fresh.length) {
          this._flood(fresh, iface, area);
          this._scheduleSpf();
          if (this._isAbr()) this._scheduleReoriginate();
        }
      } else if (p.type === 'purge') {
        if (p.routerId === this.routerId) {
          if (p.seq >= this.seq) this.seq = p.seq;
          this._originate();
          return;
        }
        const key = this._lsaKey(area, p.routerId), cur = this.lsdb.get(key);
        if (cur && cur.lsa.seq <= p.seq) {
          this._purge(p.routerId, area, iface);
          this._scheduleSpf();
          if (this._isAbr()) this._scheduleReoriginate();
        }
      }
    }

    _scheduleReoriginate() {
      if (this._reorigPending) return;
      this._reorigPending = true;
      this.sim.schedule(SPF_DELAY, () => {
        this._reorigPending = false;
        if (this.enabled && this.routerId && this._isAbr()) this._originate();
      });
    }
    _scheduleSpf() {
      if (this._spfPending) return;
      this._spfPending = true;
      this.sim.schedule(SPF_DELAY, () => {
        this._spfPending = false;
        this._runSpf();
      });
    }

    /* Dijkstra over each local area's router/subnet graph, then prefer the
     * lowest-metric route when the same prefix is learned through two areas. */
    _runSpf() {
      if (!this.enabled || !this.routerId) {
        this.stack.setDynRoutes('ospf', []);
        return;
      }
      const learned = [];
      for (const area of this.activeAreas()) learned.push(...this._runSpfArea(area));
      const routes = new Map();
      for (const route of learned) {
        const key = `${route.network}/${route.len}`, old = routes.get(key);
        if (!old || route.metric < old.metric) routes.set(key, route);
        else if (route.metric === old.metric) old.nexthops = [...new Set(old.nexthops.concat(route.nexthops))].sort();
      }
      this.stack.setDynRoutes('ospf', [...routes.values()]);
    }
    _runSpfArea(area) {
      const edges = new Map();
      const addEdge = (a, b, c) => {
        if (!edges.has(a)) edges.set(a, []);
        edges.get(a).push({ to: b, cost: c });
      };
      for (const lsa of this._areaLsas(area)) {
        const rn = 'R:' + lsa.routerId;
        for (const net of lsa.nets) {
          const nn = 'N:' + net.network + '/' + net.len;
          addEdge(rn, nn, net.cost || 1);
          addEdge(nn, rn, 0);
        }
      }
      const src = 'R:' + this.routerId;
      const dist = new Map([[src, 0]]), firstHops = new Map([[src, new Set()]]), visited = new Set();
      const hopsVia = (u, to) => {
        if (u === src) return new Set();
        const fhu = firstHops.get(u) || new Set();
        if (fhu.size === 0 && to.startsWith('R:')) return new Set([to.slice(2)]);
        return new Set(fhu);
      };
      for (;;) {
        let u = null, du = Infinity;
        for (const [node, d] of dist) if (!visited.has(node) && d < du) { u = node; du = d; }
        if (u === null) break;
        visited.add(u);
        for (const e of edges.get(u) || []) {
          const nd = du + e.cost, cur = dist.get(e.to);
          if (cur === undefined || nd < cur) {
            dist.set(e.to, nd);
            firstHops.set(e.to, hopsVia(u, e.to));
          } else if (nd === cur) {
            const target = firstHops.get(e.to);
            for (const x of hopsVia(u, e.to)) target.add(x);
          }
        }
      }
      const routes = [];
      for (const [node, d] of dist) {
        if (!node.startsWith('N:')) continue;
        const [network, lenS] = node.slice(2).split('/'), len = Number(lenS);
        const connected = this.stack.ifaces.some(i => i.ip && i.isUp() && i.maskLen === len &&
          IP.networkOf(i.ip, i.maskLen) === network);
        if (connected) continue;
        const fh = firstHops.get(node);
        if (!fh || fh.size === 0) continue;
        const nexthops = [];
        for (const rid of fh) {
          const n = this.neighbors.get(this._neighborKey(area, rid));
          if (n && n.twoWay) nexthops.push(n.ip);
        }
        if (nexthops.length) routes.push({ network, len, nexthops: nexthops.sort(), metric: d });
      }
      return routes;
    }

    serialize() {
      if (!this.enabled) return null;
      return { pid: this.processId, routerId: this.manualRouterId,
        networks: this.networks.slice(), passive: [...this.passive] };
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
