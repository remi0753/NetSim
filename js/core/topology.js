/* NetSim core: network model — device/link registry, persistence, sample topologies */
(function (root) {
  const NetSim = root.NetSim;
  const IP = NetSim.ip;

  const TYPES = {
    pc:       { cls: () => NetSim.Host,         label: 'PC',        prefix: 'PC' },
    server:   { cls: () => NetSim.Server,       label: 'サーバ',     prefix: 'SV' },
    hub:      { cls: () => NetSim.Hub,          label: 'ハブ',       prefix: 'HUB' },
    switch:   { cls: () => NetSim.L2Switch,     label: 'L2スイッチ', prefix: 'SW', sizable: true, portRange: { min: 4, max: 52, def: 8 } },
    l3switch: { cls: () => NetSim.L3Switch,     label: 'L3スイッチ', prefix: 'L3SW', sizable: true, portRange: { min: 8, max: 52, def: 8 } },
    router:   { cls: () => NetSim.Router,       label: 'ルータ',     prefix: 'RT', sizable: true, portRange: { min: 2, max: 16, def: 4 } },
    lb:       { cls: () => NetSim.LoadBalancer, label: 'LB',        prefix: 'LB' },
  };
  /* translated device label for the current language (falls back to TYPES.label) */
  NetSim.deviceLabel = (type) => (NetSim.t ? NetSim.t('dev.' + type) : (TYPES[type] && TYPES[type].label) || type);
  NetSim.deviceTypeInfo = (type) => TYPES[type] || null;
  NetSim.portRangeFor = (type) => {
    const t = TYPES[type];
    return t && t.portRange ? Object.assign({}, t.portRange) : null;
  };
  NetSim.normalizePortCount = (type, value) => {
    const r = NetSim.portRangeFor(type);
    if (!r) return undefined;
    const n = Number.isFinite(Number(value)) ? Math.floor(Number(value)) : r.def;
    return Math.min(r.max, Math.max(r.min, n));
  };

  class Network extends NetSim.Emitter {
    constructor(sim) {
      super();
      this.sim = sim;
      this.devices = [];
      this.links = [];
      this.groups = [];    // {id, name, devIds:[], collapsed, x, y, offsets:{devId:{dx,dy}}}
      this._nameSeq = {};
    }

    nextName(type) {
      const prefix = TYPES[type].prefix;
      let n = this._nameSeq[type] || 0;
      let name;
      do { n++; name = prefix + n; } while (this.devices.some(d => d.name === name));
      this._nameSeq[type] = n;
      return name;
    }

    addDevice(type, x, y, name, opts) {
      const t = TYPES[type];
      if (!t) throw new Error('unknown device type: ' + type);
      const Cls = t.cls();
      const portCount = t.sizable ? NetSim.normalizePortCount(type, opts && opts.portCount) : undefined;
      const dev = new Cls(this, name || this.nextName(type), portCount);
      dev.x = x; dev.y = y;
      this.devices.push(dev);
      this.emit('topology');
      return dev;
    }

    removeDevice(dev) {
      dev.destroy();
      const i = this.devices.indexOf(dev);
      if (i >= 0) this.devices.splice(i, 1);
      for (const g of this.groups) {
        const j = g.devIds.indexOf(dev.id);
        if (j >= 0) g.devIds.splice(j, 1);
      }
      this.groups = this.groups.filter(g => g.devIds.length > 0);
      this.emit('topology');
    }

    /* ---------------- groups (racks) ---------------- */
    createGroup(name, devs) {
      const g = {
        id: NetSim.nextId('grp'), name: name || NetSim.t('topo.groupName', this.groups.length + 1),
        devIds: devs.map(d => d.id), collapsed: false,
        x: 0, y: 0, offsets: {},
      };
      this.groups.push(g);
      this.emit('topology');
      return g;
    }
    removeGroup(g, expand) {
      if (expand !== false && g.collapsed) this.setCollapsed(g, false);
      const i = this.groups.indexOf(g);
      if (i >= 0) this.groups.splice(i, 1);
      this.emit('topology');
    }
    groupOf(dev) {
      return this.groups.find(g => g.devIds.includes(dev.id)) || null;
    }
    groupMembers(g) {
      return this.devices.filter(d => g.devIds.includes(d.id));
    }
    setCollapsed(g, collapsed) {
      const members = this.groupMembers(g);
      if (collapsed && !g.collapsed) {
        let cx = 0, cy = 0;
        for (const d of members) { cx += d.x; cy += d.y; }
        g.x = Math.round(cx / Math.max(1, members.length));
        g.y = Math.round(cy / Math.max(1, members.length));
        g.offsets = {};
        for (const d of members) g.offsets[d.id] = { dx: d.x - g.x, dy: d.y - g.y };
        g.collapsed = true;
      } else if (!collapsed && g.collapsed) {
        for (const d of members) {
          const off = g.offsets[d.id];
          if (off) { d.x = g.x + off.dx; d.y = g.y + off.dy; }
        }
        g.collapsed = false;
      }
      this.emit('topology');
    }

    connect(devA, portA, devB, portB) {
      const pa = typeof portA === 'string' ? devA.getPort(portA) : portA;
      const pb = typeof portB === 'string' ? devB.getPort(portB) : portB;
      if (!pa || !pb) throw new Error('port not found');
      if (pa.link || pb.link) throw new Error('port already connected');
      if (pa.device === pb.device) throw new Error('cannot connect a device to itself');
      const link = new NetSim.Link(this.sim, pa, pb);
      this.links.push(link);
      this.recomputeStp();
      this.emit('topology');
      return link;
    }

    removeLink(link) {
      link.destroy();
      const i = this.links.indexOf(link);
      if (i >= 0) this.links.splice(i, 1);
      this.recomputeStp();
      this.emit('topology');
    }

    /*
     * Immediate-convergence STP.  `rstp` uses one common tree; the default
     * `rapid-pvst` computes one tree per VLAN and considers only links that
     * actually carry that VLAN.  Both retain the normal root/designated/
     * alternate-port tie breakers while omitting timer states.
     */
    recomputeStp() {
      const switches = this.devices.filter(d => d instanceof NetSim.L2Switch);
      if (!switches.length) return;
      const compare = (a, b) => {
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
          if (a[i] === b[i]) continue;
          return a[i] < b[i] ? -1 : 1;
        }
        return 0;
      };
      const carries = (sw, port, vlan) => {
        const c = sw.cfg(port);
        return sw.vlanActive(vlan) && (c.mode === 'access'
          ? c.accessVlan === vlan : sw.trunkAllows(c, vlan));
      };
      const isBundle = (a, b) => {
        const ac = a.device.cfg(a), bc = b.device.cfg(b);
        return ac && bc && ac.channel != null && bc.channel != null;
      };
      const store = (sw, port, vlan, role, state) => {
        const entry = { role, state };
        if (vlan == null) port.stpCommon = entry;
        else port.stpVlans.set(vlan, entry);
      };

      for (const sw of switches) {
        sw.stpVlanRoots = new Map();
        for (const port of sw.ports) {
          port.stpCommon = null;
          port.stpVlans = new Map();
        }
      }

      const calculate = (mode, vlan) => {
        const nodes = switches.filter(sw => sw.stpMode === mode && (vlan == null || sw.vlanActive(vlan)));
        if (!nodes.length) return;
        for (const sw of nodes) {
          for (const p of sw.ports) {
            if (!p.isUp() || (vlan != null && !carries(sw, p, vlan))) continue;
            store(sw, p, vlan, 'designated', 'forwarding');
          }
        }
        const nodeSet = new Set(nodes), byKey = new Map();
        for (const link of this.links) {
          const a = link.a, b = link.b;
          if (!nodeSet.has(a.device) || !nodeSet.has(b.device) || !a.isUp() || !b.isUp()) continue;
          if (vlan != null && (!carries(a.device, a, vlan) || !carries(b.device, b, vlan))) continue;
          const ak = isBundle(a, b) ? `${a.device.id}:${a.device.logicalKey(a)}` : a.id;
          const bk = isBundle(a, b) ? `${b.device.id}:${b.device.logicalKey(b)}` : b.id;
          const key = ak < bk ? `${ak}|${bk}` : `${bk}|${ak}`;
          if (!byKey.has(key)) byKey.set(key, { a: a.device, b: b.device, members: [] });
          const edge = byKey.get(key);
          edge.members.push(edge.a === a.device ? { a, b } : { a: b, b: a });
        }
        const edges = [...byKey.values()];
        const adjacent = new Map(nodes.map(sw => [sw, []]));
        for (const edge of edges) { adjacent.get(edge.a).push(edge); adjacent.get(edge.b).push(edge); }
        const visited = new Set();
        for (const seed of nodes) {
          if (visited.has(seed)) continue;
          const component = [], pending = [seed]; visited.add(seed);
          while (pending.length) {
            const sw = pending.pop(); component.push(sw);
            for (const edge of adjacent.get(sw)) {
              const peer = edge.a === sw ? edge.b : edge.a;
              if (!visited.has(peer)) { visited.add(peer); pending.push(peer); }
            }
          }
          const root = component.reduce((best, sw) => sw.stpBridgeId() < best.stpBridgeId() ? sw : best, component[0]);
          const route = new Map([[root, { cost: 0, edge: null, tie: [] }]]), settled = new Set();
          while (settled.size < component.length) {
            let current = null;
            for (const sw of component) {
              if (settled.has(sw) || !route.has(sw)) continue;
              const r = route.get(sw);
              if (!current || compare([r.cost, ...r.tie, sw.stpBridgeId()], [route.get(current).cost, ...route.get(current).tie, current.stpBridgeId()]) < 0) current = sw;
            }
            if (!current) break;
            settled.add(current);
            for (const edge of adjacent.get(current)) {
              const next = edge.a === current ? edge.b : edge.a;
              if (settled.has(next)) continue;
              const member = edge.members[0];
              const local = member.a.device === current ? member.a : member.b;
              const remote = member.a.device === current ? member.b : member.a;
              const candidate = { cost: route.get(current).cost + 1, edge,
                tie: [current.stpBridgeId(), current.stpPortId(local), remote.device.stpPortId(remote)] };
              const old = route.get(next);
              if (!old || compare([candidate.cost, ...candidate.tie], [old.cost, ...old.tie]) < 0) route.set(next, candidate);
            }
          }
          const memberSet = new Set(component);
          for (const sw of component) {
            const r = route.get(sw) || { cost: 0, edge: null };
            const rootPort = r.edge && r.edge.members.find(m => m.a.device === sw || m.b.device === sw);
            const state = { rootId: root.stpBridgeId(), cost: r.cost,
              rootPort: rootPort ? (rootPort.a.device === sw ? rootPort.a : rootPort.b) : null };
            if (vlan == null) { sw.stpRootId = state.rootId; sw.stpRootCost = state.cost; sw.stpRootPort = state.rootPort; }
            else sw.stpVlanRoots.set(vlan, state);
          }
          for (const edge of edges) {
            if (!memberSet.has(edge.a) || !memberSet.has(edge.b)) continue;
            const m0 = edge.members[0];
            const ar = vlan == null ? { rootId: edge.a.stpRootId, cost: edge.a.stpRootCost, rootPort: edge.a.stpRootPort } : edge.a.stpVlanRoots.get(vlan);
            const br = vlan == null ? { rootId: edge.b.stpRootId, cost: edge.b.stpRootCost, rootPort: edge.b.stpRootPort } : edge.b.stpVlanRoots.get(vlan);
            const av = [ar.rootId, ar.cost, edge.a.stpBridgeId(), edge.a.stpPortId(m0.a)];
            const bv = [br.rootId, br.cost, edge.b.stpBridgeId(), edge.b.stpPortId(m0.b)];
            const aDesignated = compare(av, bv) < 0;
            for (const member of edge.members) {
              const setRole = (sw, port, designated, r) => {
                const rootPort = r.rootPort && sw.logicalKey(r.rootPort) === sw.logicalKey(port);
                store(sw, port, vlan, rootPort ? 'root' : (designated ? 'designated' : 'alternate'),
                  rootPort || designated ? 'forwarding' : 'blocking');
              };
              setRole(edge.a, member.a, aDesignated, ar);
              setRole(edge.b, member.b, !aDesignated, br);
            }
          }
        }
      };

      calculate('rstp', null);
      const vlans = new Set();
      for (const sw of switches) if (sw.stpMode === 'rapid-pvst') for (const vlan of sw.vlans.keys()) vlans.add(vlan);
      for (const vlan of vlans) calculate('rapid-pvst', vlan);

      for (const sw of switches) {
        for (const p of sw.ports) {
          if (sw.stpMode === 'rstp') {
            const s = p.stpCommon || { role: p.isUp() ? 'designated' : 'disabled', state: p.isUp() ? 'forwarding' : 'disabled' };
            p.stpRole = s.role; p.stpState = s.state;
          } else {
            const values = [...p.stpVlans.values()];
            const forwarding = values.find(s => s.state === 'forwarding');
            p.stpState = !p.isUp() ? 'disabled' : (forwarding ? 'forwarding' : (values.length ? 'blocking' : 'forwarding'));
            p.stpRole = !p.isUp() ? 'disabled' : (forwarding ? forwarding.role : (values.length ? 'alternate' : 'designated'));
          }
        }
        const root = sw.stpMode === 'rapid-pvst' ? (sw.stpVlanRoots.get(1) || [...sw.stpVlanRoots.values()][0]) : null;
        if (root) { sw.stpRootId = root.rootId; sw.stpRootCost = root.cost; sw.stpRootPort = root.rootPort; }
        const signature = sw.ports.map(p => `${p.stpState}:${[...p.stpVlans].map(([v, s]) => `${v}:${s.state}`).join(',')}`).join('|');
        if (sw._lastStpSignature && sw._lastStpSignature !== signature) sw.clearMacTable();
        sw._lastStpSignature = signature;
      }
    }

    clear() {
      for (const l of this.links.slice()) l.destroy();
      this.links = [];
      this.devices = [];
      this.groups = [];
      this._nameSeq = {};
      this.emit('topology');
    }

    findByName(name) { return this.devices.find(d => d.name === name) || null; }

    serialize() {
      return {
        app: 'netsim', version: 2,
        devices: this.devices.map(d => d.serialize()),
        links: this.links.map(l => ({
          a: { dev: l.a.device.name, port: l.a.name },
          b: { dev: l.b.device.name, port: l.b.name },
        })),
        groups: this.groups.map(g => ({
          name: g.name, collapsed: g.collapsed, x: g.x, y: g.y,
          devs: this.groupMembers(g).map(d => d.name),
          offsets: Object.fromEntries(this.groupMembers(g)
            .filter(d => g.offsets[d.id])
            .map(d => [d.name, g.offsets[d.id]])),
        })),
      };
    }

    load(data) {
      if (!data || data.app !== 'netsim') throw new Error(NetSim.t('topo.badFile'));
      this.clear();
      for (const d of data.devices || []) {
        const dev = this.addDevice(d.type, d.x || 0, d.y || 0, d.name, { portCount: d.portCount });
        dev.applyConfig(d.config);
      }
      for (const l of data.links || []) {
        const da = this.findByName(l.a.dev), db = this.findByName(l.b.dev);
        if (da && db) {
          try { this.connect(da, l.a.port, db, l.b.port); } catch (e) { /* skip bad link */ }
        }
      }
      for (const gd of data.groups || []) {
        const devs = (gd.devs || []).map(n => this.findByName(n)).filter(Boolean);
        if (!devs.length) continue;
        const g = this.createGroup(gd.name, devs);
        g.collapsed = !!gd.collapsed;
        g.x = gd.x || 0; g.y = gd.y || 0;
        g.offsets = {};
        for (const d of devs) {
          const off = (gd.offsets || {})[d.name];
          if (off) g.offsets[d.id] = { dx: off.dx, dy: off.dy };
        }
      }
      this.emit('topology');
    }
  }

  /* ---------------- sample topologies ---------------- */

  function sampleRouted(net) {
    const pc1 = net.addDevice('pc', 140, 160);
    const pc2 = net.addDevice('pc', 140, 360);
    const sw1 = net.addDevice('switch', 380, 260);
    const rt1 = net.addDevice('router', 620, 260);
    const sw2 = net.addDevice('switch', 860, 260);
    const sv1 = net.addDevice('server', 1080, 260);

    net.connect(pc1, 'eth0', sw1, 'GigabitEthernet0/1');
    net.connect(pc2, 'eth0', sw1, 'GigabitEthernet0/2');
    net.connect(sw1, 'GigabitEthernet0/8', rt1, 'GigabitEthernet0/0');
    net.connect(rt1, 'GigabitEthernet0/1', sw2, 'GigabitEthernet0/8');
    net.connect(sw2, 'GigabitEthernet0/1', sv1, 'eth0');

    pc1.setIp('10.0.1.11', 24, '10.0.1.254');
    pc2.setIp('10.0.1.12', 24, '10.0.1.254');
    sv1.setIp('10.0.2.10', 24, '10.0.2.254');

    const g0 = rt1.getPort('GigabitEthernet0/0');
    const g1 = rt1.getPort('GigabitEthernet0/1');
    g0.adminUp = true; g0.l3iface.setIp('10.0.1.254', 24);
    g1.adminUp = true; g1.l3iface.setIp('10.0.2.254', 24);
  }

  function sampleVlanDc(net) {
    const core = net.addDevice('l3switch', 620, 150);
    const swA = net.addDevice('switch', 380, 360);
    const swB = net.addDevice('switch', 860, 360);
    const pc1 = net.addDevice('pc', 200, 540);
    const pc2 = net.addDevice('pc', 440, 540);
    const sv1 = net.addDevice('server', 800, 540);
    const sv2 = net.addDevice('server', 1040, 540);

    net.connect(core, 'GigabitEthernet0/1', swA, 'GigabitEthernet0/8');
    net.connect(core, 'GigabitEthernet0/2', swB, 'GigabitEthernet0/8');
    net.connect(swA, 'GigabitEthernet0/1', pc1, 'eth0');
    net.connect(swA, 'GigabitEthernet0/2', pc2, 'eth0');
    net.connect(swB, 'GigabitEthernet0/1', sv1, 'eth0');
    net.connect(swB, 'GigabitEthernet0/2', sv2, 'eth0');

    // VLANs: 10 = クライアント, 20 = サーバ
    for (const sw of [core, swA, swB]) { sw.addVlan(10, 'CLIENTS'); sw.addVlan(20, 'SERVERS'); }

    // access ports
    swA.cfg(swA.getPort('Gi0/1')).accessVlan = 10;
    swA.cfg(swA.getPort('Gi0/2')).accessVlan = 10;
    swB.cfg(swB.getPort('Gi0/1')).accessVlan = 20;
    swB.cfg(swB.getPort('Gi0/2')).accessVlan = 20;

    // trunks
    for (const [sw, pname] of [[swA, 'Gi0/8'], [swB, 'Gi0/8'], [core, 'Gi0/1'], [core, 'Gi0/2']]) {
      const c = sw.cfg(sw.getPort(pname));
      c.mode = 'trunk';
    }

    // SVIs on the core
    core.createSvi(10).setIp('10.10.10.1', 24);
    core.createSvi(20).setIp('10.10.20.1', 24);

    pc1.setIp('10.10.10.11', 24, '10.10.10.1');
    pc2.setIp('10.10.10.12', 24, '10.10.10.1');
    sv1.setIp('10.10.20.10', 24, '10.10.20.1');
    sv2.setIp('10.10.20.20', 24, '10.10.20.1');
  }

  /* ---------------- spine-leaf fabric generator ----------------
   * L3-to-the-leaf: each leaf/spine link is its own /30 subnet carried on a
   * dedicated access VLAN + SVI pair; OSPF (ECMP) distributes all routes.
   * opts: {spines, leaves, hostsPerLeaf, groups} */
  function buildFabric(net, opts) {
    opts = opts || {};
    const nSpine = Math.min(4, Math.max(1, opts.spines || 2));
    const nLeaf = Math.min(8, Math.max(1, opts.leaves || 4));
    const hpl = Math.min(48, Math.max(1, opts.hostsPerLeaf || 12));

    const cols = hpl <= 8 ? 2 : (hpl <= 24 ? 4 : 6);
    const rackW = cols * 92;
    const leafGap = Math.max(rackW + 70, 300);
    const totalW = nLeaf * leafGap;
    const leafY = 330, spineY = 110, hostY = 480;

    const spines = [], leaves = [];
    for (let s = 0; s < nSpine; s++) {
      const x = Math.round(totalW / 2 + (s - (nSpine - 1) / 2) * 300);
      const sp = net.addDevice('l3switch', x, spineY, `SPINE${s + 1}`, { portCount: nLeaf });
      spines.push(sp);
    }
    for (let l = 0; l < nLeaf; l++) {
      const x = Math.round(leafGap / 2 + l * leafGap);
      const lf = net.addDevice('l3switch', x, leafY, `LEAF${l + 1}`, { portCount: nSpine + hpl });
      leaves.push(lf);
    }

    const ospfCmds = (sw, passiveVlan) => {
      const cmds = ['enable', 'conf t', 'router ospf 1', 'network 10.0.0.0 0.255.255.255 area 0'];
      if (passiveVlan) cmds.push(`passive-interface vlan ${passiveVlan}`);
      cmds.push('end');
      for (const c of cmds) sw.exec(c);
    };

    for (let l = 0; l < nLeaf; l++) {
      const leaf = leaves[l];
      // host-facing subnet on default VLAN 1
      leaf.createSvi(1).setIp(`10.${l + 1}.0.1`, 24);
      // uplinks
      for (let s = 0; s < nSpine; s++) {
        const spine = spines[s];
        const leafPort = leaf.ports[hpl + s];
        const spinePort = spine.ports[l];
        net.connect(leaf, leafPort, spine, spinePort);
        const base = `10.200.${s}.${l * 4}`;
        const vLeaf = 100 + s, vSpine = 100 + l;
        leaf.addVlan(vLeaf, `UPLINK-S${s + 1}`);
        leaf.cfg(leafPort).accessVlan = vLeaf;
        leaf.createSvi(vLeaf).setIp(IP.fromInt(IP.toInt(base) + 1), 30);
        spine.addVlan(vSpine, `DOWNLINK-L${l + 1}`);
        spine.cfg(spinePort).accessVlan = vSpine;
        spine.createSvi(vSpine).setIp(IP.fromInt(IP.toInt(base) + 2), 30);
      }
      ospfCmds(leaf, 1);
      // hosts
      const rack = [];
      const leafX = leaf.x;
      for (let i = 0; i < hpl; i++) {
        const col = i % cols, row = Math.floor(i / cols);
        const hx = Math.round(leafX - rackW / 2 + col * 92 + 46);
        const hy = hostY + row * 84;
        const host = net.addDevice(i === 0 ? 'server' : 'pc', hx, hy, `H${l + 1}-${i + 1}`);
        net.connect(host, 'eth0', leaf, leaf.ports[i]);
        host.setIp(`10.${l + 1}.0.${10 + i}`, 24, `10.${l + 1}.0.1`);
        rack.push(host);
      }
      if (opts.groups !== false) {
        const g = net.createGroup(`Rack${l + 1}`, rack);
        if (hpl > 8) net.setCollapsed(g, true);
      }
    }
    for (const sp of spines) ospfCmds(sp, null);
    return { spines: nSpine, leaves: nLeaf, hosts: nSpine ? nLeaf * hpl : 0 };
  }

  /* HA sample: VRRP gateway pair + load balancer + DHCP relay */
  function sampleHaDc(net) {
    const sw1 = net.addDevice('switch', 300, 420);
    const sw2 = net.addDevice('switch', 860, 420);
    const rt1 = net.addDevice('router', 460, 220);
    const rt2 = net.addDevice('router', 700, 220);
    const pc1 = net.addDevice('pc', 120, 560);
    const pc2 = net.addDevice('pc', 300, 620);
    const lb1 = net.addDevice('lb', 860, 200);
    const sv1 = net.addDevice('server', 780, 620);
    const sv2 = net.addDevice('server', 960, 620);
    const dh1 = net.addDevice('server', 1100, 480, 'DHCP1');

    net.connect(pc1, 'eth0', sw1, 'Gi0/1');
    net.connect(pc2, 'eth0', sw1, 'Gi0/2');
    net.connect(rt1, 'Gi0/0', sw1, 'Gi0/7');
    net.connect(rt2, 'Gi0/0', sw1, 'Gi0/8');
    net.connect(rt1, 'Gi0/1', sw2, 'Gi0/7');
    net.connect(rt2, 'Gi0/1', sw2, 'Gi0/8');
    net.connect(lb1, 'eth0', sw2, 'Gi0/1');
    net.connect(sv1, 'eth0', sw2, 'Gi0/2');
    net.connect(sv2, 'eth0', sw2, 'Gi0/3');
    net.connect(dh1, 'eth0', sw2, 'Gi0/4');

    const conf = (rt, ip0, ip1, prio) => {
      const g0 = rt.getPort('Gi0/0'), g1 = rt.getPort('Gi0/1');
      g0.adminUp = true; g0.l3iface.setIp(ip0, 24);
      g1.adminUp = true; g1.l3iface.setIp(ip1, 24);
      for (const c of ['enable', 'conf t',
        'interface Gi0/0', `vrrp 1 ip 10.0.1.1`, `vrrp 1 priority ${prio}`, 'ip helper-address 10.0.2.9', 'exit',
        'interface Gi0/1', `vrrp 2 ip 10.0.2.1`, `vrrp 2 priority ${prio}`, 'end']) rt.exec(c);
    };
    conf(rt1, '10.0.1.2', '10.0.2.2', 120);
    conf(rt2, '10.0.1.3', '10.0.2.3', 100);

    pc1.setIp('10.0.1.11', 24, '10.0.1.1');
    // pc2 gets its address over the DHCP relay
    pc2.useDhcp();

    lb1.setIp('10.0.2.5', 24, '10.0.2.1');
    sv1.setIp('10.0.2.10', 24, '10.0.2.1');
    sv2.setIp('10.0.2.11', 24, '10.0.2.1');
    dh1.setIp('10.0.2.9', 24, '10.0.2.1');
    dh1.addDhcpPool('10.0.1.0', 24, '10.0.1.100', '10.0.1.150', '10.0.1.1');
    lb1.lbEnable(80);
    lb1.addBackend('10.0.2.10', 80);
    lb1.addBackend('10.0.2.11', 80);
  }

  /* NAT sample: a private LAN shares one global address (PAT) to reach the
   * "internet", and an inside web server is published with static NAT. */
  function sampleNat(net) {
    const pc1 = net.addDevice('pc', 120, 150);
    const pc2 = net.addDevice('pc', 120, 300);
    const svIn = net.addDevice('server', 120, 450, 'WEB-IN');
    const sw1 = net.addDevice('switch', 360, 300);
    const rt1 = net.addDevice('router', 620, 300);
    const sw2 = net.addDevice('switch', 880, 300);
    const svPub = net.addDevice('server', 1120, 200, 'WEB-NET');
    const pcOut = net.addDevice('pc', 1120, 420, 'PC-NET');

    net.connect(pc1, 'eth0', sw1, 'Gi0/1');
    net.connect(pc2, 'eth0', sw1, 'Gi0/2');
    net.connect(svIn, 'eth0', sw1, 'Gi0/3');
    net.connect(sw1, 'Gi0/8', rt1, 'Gi0/0');
    net.connect(rt1, 'Gi0/1', sw2, 'Gi0/8');
    net.connect(sw2, 'Gi0/1', svPub, 'eth0');
    net.connect(sw2, 'Gi0/2', pcOut, 'eth0');

    // inside (private 10.0.1.0/24)
    pc1.setIp('10.0.1.11', 24, '10.0.1.254');
    pc2.setIp('10.0.1.12', 24, '10.0.1.254');
    svIn.setIp('10.0.1.50', 24, '10.0.1.254');
    // outside ("internet" 203.0.113.0/24)
    svPub.setIp('203.0.113.9', 24, '203.0.113.1');
    pcOut.setIp('203.0.113.20', 24, '203.0.113.1');

    const g0 = rt1.getPort('Gi0/0'), g1 = rt1.getPort('Gi0/1');
    g0.adminUp = true; g0.l3iface.setIp('10.0.1.254', 24);
    g1.adminUp = true; g1.l3iface.setIp('203.0.113.1', 24);

    for (const c of [
      'enable', 'conf t',
      'interface Gi0/0', 'ip nat inside', 'exit',
      'interface Gi0/1', 'ip nat outside', 'exit',
      'access-list 100 permit ip 10.0.1.0 0.0.0.255 any',
      'ip nat inside source list 100 interface Gi0/1 overload',   // PAT: LAN → internet
      'ip nat inside source static 10.0.1.50 203.0.113.50',       // publish the inside server
      'end',
    ]) rt1.exec(c);
  }

  /* VXLAN sample: three tenant-edge VTEPs share one L2 segment across a
   * routed, dual-spine underlay.  The source SVI on each VTEP is deliberately
   * distinct from the tenant VLAN, as it is on a real VTEP. */
  function sampleVxlanFabric(net) {
    const spine1 = net.addDevice('l3switch', 440, 100, 'SPINE1');
    const spine2 = net.addDevice('l3switch', 920, 100, 'SPINE2');
    const nodes = [
      net.addDevice('l3switch', 220, 360, 'VTEP1'),
      net.addDevice('l3switch', 680, 360, 'VTEP2'),
      net.addDevice('l3switch', 1140, 360, 'VTEP3'),
    ];
    const endpoints = [];

    const ospf = (sw) => {
      for (const c of ['enable', 'conf t', 'router ospf 1',
        'network 172.16.0.0 0.0.255.255 area 0', 'end']) sw.exec(c);
    };

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const n = i + 1;
      const vlanS1 = 100 + n, vlanS2 = 200 + n;
      const subnet = `172.16.${n}`;

      // Each routed underlay link has its own VLAN/SVI pair.
      for (const [sw, port, vlan, host, label] of [
        [node, 'Gi0/1', vlanS1, `${subnet}.1`, 'SPINE1'],
        [spine1, `Gi0/${n}`, vlanS1, `${subnet}.2`, `VTEP${n}`],
        [node, 'Gi0/2', vlanS2, `${subnet}.5`, 'SPINE2'],
        [spine2, `Gi0/${n}`, vlanS2, `${subnet}.6`, `VTEP${n}`],
      ]) {
        sw.addVlan(vlan, `UNDERLAY-${label}`);
        sw.cfg(sw.getPort(port)).accessVlan = vlan;
        sw.createSvi(vlan).setIp(host, 30);
      }
      net.connect(node, 'Gi0/1', spine1, `Gi0/${n}`);
      net.connect(node, 'Gi0/2', spine2, `Gi0/${n}`);

      // VLAN 10 is the tenant's stretched L2 segment, represented by VNI 10100.
      node.addVlan(10, 'TENANT-A');
      node.cfg(node.getPort('Gi0/3')).accessVlan = 10;
      node.cfg(node.getPort('Gi0/4')).accessVlan = 10;
      const client = net.addDevice('pc', 120 + i * 460, 600, `CLIENT${n}`);
      const server = net.addDevice('server', 300 + i * 460, 600, `APP${n}`);
      net.connect(client, 'eth0', node, 'Gi0/3');
      net.connect(server, 'eth0', node, 'Gi0/4');
      client.setIp(`10.244.10.${10 + n}`, 24, null);
      server.setIp(`10.244.10.${20 + n}`, 24, null);
      endpoints.push(client, server);
      // Vlan101/102/103 is the VTEP source interface; static peers form the
      // deliberately simplified VXLAN control plane.
      node.stack.configureVxlan(10100, 10, `Vlan${vlanS1}`,
        nodes.filter(other => other !== node).map((_, j) => ({ vtep: `172.16.${j < i ? j + 1 : j + 2}.1` })));
      ospf(node);
    }
    ospf(spine1);
    ospf(spine2);

    for (let i = 0; i < nodes.length; i++) {
      const group = net.createGroup(`Site ${i + 1} / VTEP${i + 1}`, [nodes[i], endpoints[i * 2], endpoints[i * 2 + 1]]);
      group.x = nodes[i].x; group.y = 470;
    }
  }

  NetSim.Network = Network;
  NetSim.deviceTypes = TYPES;
  NetSim.buildFabric = buildFabric;
  NetSim.samples = [
    { id: 'routed', nameKey: 'topo.sample.routed', name: 'サンプル1: ルータ経由の2セグメント', build: sampleRouted },
    { id: 'vlan-dc', nameKey: 'topo.sample.vlanDc', name: 'サンプル2: VLAN + L3スイッチ (ミニDC)', build: sampleVlanDc },
    { id: 'ha-dc', nameKey: 'topo.sample.haDc', name: 'サンプル3: 冗長GW+LB+DHCP (VRRP)', build: sampleHaDc },
    { id: 'fabric', nameKey: 'topo.sample.fabric', name: 'サンプル4: スパイン・リーフ (OSPF+ECMP)', build: (net) => buildFabric(net, { spines: 2, leaves: 3, hostsPerLeaf: 6 }) },
    { id: 'nat', nameKey: 'topo.sample.nat', name: 'サンプル5: NAT/PAT (インターネット共有 + 静的公開)', build: sampleNat },
    { id: 'vxlan-fabric', nameKey: 'topo.sample.vxlanFabric', name: 'サンプル6: VXLAN テナント・オーバーレイ (デュアルスパイン)', build: sampleVxlanFabric },
  ];
})(typeof window !== 'undefined' ? window : globalThis);
