/* NetSim core: shared IPv4 network stack (ARP, routing, ICMP, UDP, TCP).
 * Used by hosts (forwarding=false), routers and L3 switches (forwarding=true). */
(function (root) {
  const NetSim = root.NetSim;
  const IP = NetSim.ip;
  const pdu = NetSim.pdu;
  const BC = NetSim.BROADCAST_MAC;

  const ARP_TIMEOUT = 3000, ARP_RETRIES = 2, ARP_AGE = 240000;
  const PING_TIMEOUT = 20000, TCP_SYN_TIMEOUT = 8000, TCP_SYN_RETRIES = 2;
  const TCP_MSS = 1200, TCP_INITIAL_RTO = 1000, TCP_MAX_RETRIES = 6;

  class L3Interface {
    constructor(stack, name, mac, hooks) {
      this.stack = stack;
      this.name = name;
      this.mac = mac;
      this.ip = null;
      this.maskLen = null;
      this._hooks = hooks;   // { send(frame), isUp() }
      this.aclIn = null;     // ACL number or null
      this.aclOut = null;
      this.ospfCost = 1;
      this.helperAddr = null;   // DHCP relay (ip helper-address)
      this.natRole = null;      // 'inside' | 'outside' | null (ip nat inside/outside)
      this.vrrp = null;         // {gid, vip, priority, state, vmac, lastAdv, lastSent}
    }
    isUp() { return this._hooks.isUp(); }
    send(frame) { if (this.isUp()) this._hooks.send(frame); }
    setIp(ip, maskLen) { this.ip = ip; this.maskLen = maskLen; }
    clearIp() { this.ip = null; this.maskLen = null; }
  }

  class NetworkStack {
    constructor(device, opts) {
      opts = opts || {};
      this.device = device;
      this.sim = device.sim;
      this.forwarding = !!opts.forwarding;
      this.hostname = () => device.name;
      this.ifaces = [];
      this.arpTable = new Map();      // ip -> {mac, ifname, ts}
      this._arpPending = new Map();   // ip -> {iface, queue:[{pkt,onFail}], tries, timer}
      this.staticRoutes = [];         // {network, len, nexthop, type:'S'}
      this.udpListeners = new Map();  // port -> fn(srcIp, srcPort, data)
      this.tcpListeners = new Map();  // port -> fn(conn)
      this.tcpConns = new Map();      // key -> conn
      this._pingSessions = new Map(); // id -> session
      this._pingId = 100;
      this.aclCheck = null;           // fn(dir,'in'|'out', iface, ipPkt) -> bool permit
      this.dynRoutes = new Map();     // proto ('ospf') -> [{network,len,nexthops:[ip],metric}]
      this.mcastHandlers = new Map(); // '224.0.0.5' -> fn(iface, pkt)
      this.nat = null;                // NAT box (routers only); null = feature absent
      this.getAcl = null;             // fn(num) -> rules[]  (set by devices that own ACLs)
      // Optional VXLAN endpoint.  A VNI is bound to one local VLAN and uses
      // static ingress replication to its remote VTEPs (a deliberately small
      // control plane, but the data plane is Ethernet-in-UDP/4789 VXLAN).
      this.vxlan = null;               // {vni,vlanId,sourceInterface,peers:[{vtep}]}
      this._vrrpTicking = false;
    }

    static isMulticastIp(ip) {
      const f = Number(String(ip).split('.')[0]);
      return f >= 224 && f <= 239;
    }

    /* ---------- interfaces ---------- */
    addInterface(name, mac, hooks) {
      const ifc = new L3Interface(this, name, mac, hooks);
      this.ifaces.push(ifc);
      return ifc;
    }
    removeInterface(ifc) {
      const i = this.ifaces.indexOf(ifc);
      if (i >= 0) this.ifaces.splice(i, 1);
    }
    getIface(name) {
      const n = String(name).toLowerCase();
      return this.ifaces.find(i => i.name.toLowerCase() === n) || null;
    }
    displayIface(ifaceOrName) {
      const iface = typeof ifaceOrName === 'string' ? this.getIface(ifaceOrName) : ifaceOrName;
      if (!iface) return String(ifaceOrName || '');
      const port = this.device.ports.find(p => p.l3iface === iface);
      return port ? port.shortName : iface.name;
    }
    configureVxlan(vni, vlanId, sourceInterface, peers) {
      const source = this.getIface(sourceInterface);
      if (!source || !Number.isInteger(Number(vni)) || Number(vni) < 1 || Number(vni) > 16777215 ||
          !Number.isInteger(Number(vlanId)) || Number(vlanId) < 1 || Number(vlanId) > 4094) {
        this.vxlan = null;
        return false;
      }
      this.vxlan = {
        vni: Number(vni), vlanId: Number(vlanId), sourceInterface: source.name,
        peers: (peers || []).map(p => ({ vtep: p.vtep || p })).filter(p => IP.isValid(p.vtep)),
      };
      return true;
    }
    clearVxlan() { this.vxlan = null; }
    ownsIp(ip) {
      return this.ifaces.some(i => i.ip === ip ||
        (i.vrrp && i.vrrp.state === 'master' && i.vrrp.vip === ip));
    }
    isLocalBroadcast(ip) {
      if (ip === '255.255.255.255') return true;
      return this.ifaces.some(i => i.ip && i.isUp() &&
        ip === IP.broadcastOf(i.ip, i.maskLen));
    }

    /* ---------- routing ---------- */
    addStaticRoute(network, len, nexthop) {
      this.removeStaticRoute(network, len, nexthop);
      this.staticRoutes.push({ network: IP.networkOf(network, len), len, nexthop, type: 'S' });
    }
    removeStaticRoute(network, len, nexthop) {
      const net = IP.networkOf(network, len);
      this.staticRoutes = this.staticRoutes.filter(r =>
        !(r.network === net && r.len === len && (nexthop == null || r.nexthop === nexthop)));
    }
    /* dynamic routing protocols install their routes here (replaces previous set) */
    setDynRoutes(proto, routes) { this.dynRoutes.set(proto, routes); }

    /* full table: connected + static + dynamic (with resolved egress iface) */
    routeTable() {
      const rows = [];
      for (const i of this.ifaces) {
        if (i.ip && i.isUp()) {
          rows.push({ type: 'C', network: IP.networkOf(i.ip, i.maskLen), len: i.maskLen, nexthops: [], ifname: i.name, metric: 0 });
        }
      }
      for (const r of this.staticRoutes) {
        const via = this._connectedLookup(r.nexthop);
        rows.push({ type: 'S', network: r.network, len: r.len, nexthops: [r.nexthop], ifname: via ? via.name : null, metric: 0 });
      }
      for (const [, routes] of this.dynRoutes) {
        for (const r of routes) {
          const hops = r.nexthops.map(nh => {
            const via = this._connectedLookup(nh);
            return { nexthop: nh, ifname: via ? via.name : null };
          });
          rows.push({ type: 'O', network: r.network, len: r.len, nexthops: r.nexthops, hops, metric: r.metric || 0 });
        }
      }
      return rows;
    }
    _connectedLookup(dst) {
      let best = null;
      for (const i of this.ifaces) {
        if (!i.ip || !i.isUp()) continue;
        if (IP.sameSubnet(dst, i.ip, i.maskLen)) {
          if (!best || i.maskLen > best.maskLen) best = i;
        }
      }
      return best;
    }
    /* longest-prefix match with admin distance (C=0 < S=1 < O=110).
     * ECMP: equal-cost nexthops are chosen per-flow via 5-tuple hash. */
    lookupRoute(dst, pkt) {
      let best = null;   // {len, dist, choices:[{iface, nexthop}]}
      const consider = (len, dist, choices) => {
        if (!choices.length) return;
        if (!best || len > best.len || (len === best.len && dist < best.dist)) {
          best = { len, dist, choices };
        }
      };
      const direct = this._connectedLookup(dst);
      if (direct) consider(direct.maskLen, 0, [{ iface: direct, nexthop: dst }]);
      for (const r of this.staticRoutes) {
        if (!IP.inNetwork(dst, r.network, r.len)) continue;
        const egress = this._connectedLookup(r.nexthop);
        if (egress) consider(r.len, 1, [{ iface: egress, nexthop: r.nexthop }]);
      }
      for (const [, routes] of this.dynRoutes) {
        for (const r of routes) {
          if (!IP.inNetwork(dst, r.network, r.len)) continue;
          const choices = [];
          for (const nh of r.nexthops) {
            const egress = this._connectedLookup(nh);
            if (egress) choices.push({ iface: egress, nexthop: nh });
          }
          consider(r.len, 110, choices);
        }
      }
      if (!best) return null;
      if (best.choices.length === 1) return best.choices[0];
      return best.choices[this._flowHash(pkt, dst) % best.choices.length];
    }
    _flowHash(pkt, dst) {
      let s = String(dst);
      if (pkt) {
        s = pkt.src + '|' + pkt.dst + '|' + pkt.proto;
        const l4 = pkt.payload;
        if ((pkt.proto === 'tcp' || pkt.proto === 'udp') && l4) {
          s += '|' + l4.srcPort + '|' + l4.dstPort;
        }
      }
      return NetSim.hashStr(s);
    }
    /* ---------- ARP ---------- */
    _arpLearn(ip, mac, ifname) {
      this.arpTable.set(ip, { mac, ifname, ts: this.sim.time });
      const pend = this._arpPending.get(ip);
      if (pend) {
        this._arpPending.delete(ip);
        this.sim.cancel(pend.timer);
        for (const item of pend.queue) this._emitIpFrame(pend.iface, mac, item.pkt);
      }
    }
    /* queue pkt until mac known; onFail(pkt) if resolution fails */
    _resolveAndSend(iface, nexthop, pkt, onFail) {
      const cached = this.arpTable.get(nexthop);
      if (cached && this.sim.time - cached.ts < ARP_AGE) {
        this._emitIpFrame(iface, cached.mac, pkt);
        return;
      }
      let pend = this._arpPending.get(nexthop);
      if (pend) { pend.queue.push({ pkt, onFail }); return; }
      pend = { iface, queue: [{ pkt, onFail }], tries: 0, timer: null };
      this._arpPending.set(nexthop, pend);
      this._arpSendRequest(iface, nexthop, pend);
    }
    _arpSendRequest(iface, targetIp, pend) {
      pend.tries++;
      iface.send(pdu.eth(iface.mac, BC, 'arp', pdu.arpRequest(iface.mac, iface.ip, targetIp)));
      pend.timer = this.sim.schedule(ARP_TIMEOUT, () => {
        if (pend.tries < ARP_RETRIES) {
          this._arpSendRequest(iface, targetIp, pend);
        } else {
          this._arpPending.delete(targetIp);
          for (const item of pend.queue) if (item.onFail) item.onFail(item.pkt);
        }
      });
    }
    _emitIpFrame(iface, dstMac, pkt) {
      iface.send(pdu.eth(iface.mac, dstMac, 'ipv4', pkt));
    }

    /* ---------- sending IP ---------- */
    /* opts: {onNoRoute(pkt), onArpFail(pkt), forwarded:boolean} */
    sendIp(pkt, opts) {
      opts = opts || {};
      if (pkt.dst === '255.255.255.255' ||
          (pkt.src && this.ifaces.some(i => i.ip === pkt.src && pkt.dst === IP.broadcastOf(i.ip, i.maskLen)))) {
        // limited broadcast out of the src iface (or all up ifaces)
        for (const i of this.ifaces) {
          if (!i.ip || !i.isUp()) continue;
          if (pkt.src && pkt.src !== i.ip) continue;
          const copy = NetSim.clone(pkt);
          if (!copy.src) copy.src = i.ip;
          i.send(pdu.eth(i.mac, BC, 'ipv4', copy));
        }
        return;
      }
      const route = this.lookupRoute(pkt.dst, pkt);
      if (!route) {
        if (opts.onNoRoute) opts.onNoRoute(pkt);
        return;
      }
      if (!pkt.src) pkt.src = route.iface.ip;
      // outbound ACL applies to forwarded traffic only (IOS behaviour)
      if (opts.forwarded && this.aclCheck && !this.aclCheck('out', route.iface, pkt)) {
        this._aclDeny(route.iface, pkt, 'out');
        return;
      }
      if (pkt.dst === route.iface.ip || this.ownsIp(pkt.dst)) {
        // to self
        this._deliverLocal(route.iface, pkt);
        return;
      }
      this._resolveAndSend(route.iface, route.nexthop, pkt, opts.onArpFail || null);
    }

    _aclDeny(iface, pkt, dir) {
      this.sim.note('acl', NetSim.t('net.acl.denied', this.hostname(), pkt.src, pkt.dst, pkt.proto, this.displayIface(iface), dir));
      this._sendIcmpError(pkt, 'dest-unreachable', 'admin', null);
    }

    /* ---------- receive path ---------- */
    onFrame(iface, frame) {
      if (frame.type === 'arp') { this._onArp(iface, frame.payload); return; }
      if (frame.type !== 'ipv4') return;
      // accept: our MAC, broadcast, multicast, or the VRRP virtual MAC when master
      const vrrpMac = iface.vrrp && iface.vrrp.state === 'master' && frame.dst === iface.vrrp.vmac;
      const isMcastMac = frame.dst.startsWith('01:00:5e');
      if (frame.dst !== iface.mac && frame.dst !== BC && !isMcastMac && !vrrpMac) return;
      const pkt = frame.payload;

      // multicast is consumed locally (never forwarded)
      if (NetworkStack.isMulticastIp(pkt.dst)) {
        const h = this.mcastHandlers.get(pkt.dst);
        if (h) h(iface, pkt);
        return;
      }

      const isMine = this.ownsIp(pkt.dst) || this.isLocalBroadcast(pkt.dst);
      if (this.aclCheck && iface.aclIn != null && !this.aclCheck('in', iface, pkt)) {
        this.sim.note('acl', NetSim.t('net.acl.denied', this.hostname(), pkt.src, pkt.dst, pkt.proto, this.displayIface(iface), 'in'));
        if (!this.isLocalBroadcast(pkt.dst)) this._sendIcmpError(pkt, 'dest-unreachable', 'admin', iface);
        return;
      }
      // NAT (outside -> inside): rewrite the destination before the routing/local decision
      if (this.forwarding && this.nat && iface.natRole === 'outside' && this.nat.translateInbound(pkt)) {
        this._forward(iface, pkt);
        return;
      }
      if (isMine) { this._deliverLocal(iface, pkt); return; }
      if (!this.forwarding) return;   // hosts silently drop transit traffic
      this._forward(iface, pkt);
    }

    _forward(inIface, pkt) {
      const fwd = NetSim.clone(pkt);
      fwd.ttl -= 1;
      if (fwd.ttl <= 0) {
        this._sendIcmpError(pkt, 'ttl-exceeded', null, inIface);
        return;
      }
      // NAT (inside -> outside): rewrite the source when routed out an outside interface
      if (this.nat && inIface.natRole === 'inside') {
        const route = this.lookupRoute(fwd.dst, fwd);
        if (route && route.iface.natRole === 'outside') this.nat.translateOutbound(fwd);
      }
      this.sendIp(fwd, {
        forwarded: true,
        onNoRoute: (p) => this._sendIcmpError(p, 'dest-unreachable', 'net', inIface),
        onArpFail: (p) => this._sendIcmpError(p, 'dest-unreachable', 'host', inIface),
      });
    }

    _deliverLocal(iface, pkt) {
      switch (pkt.proto) {
        case 'icmp': this._onIcmp(iface, pkt); break;
        case 'udp': this._onUdp(iface, pkt); break;
        case 'tcp': this._onTcp(iface, pkt); break;
      }
    }

    /* ---------- ARP handlers ---------- */
    _onArp(iface, arp) {
      if (!iface.ip) return;
      if (arp.op === 'request') {
        // gratuitous learning of the requester
        if (IP.sameSubnet(arp.senderIp, iface.ip, iface.maskLen)) {
          this._arpLearn(arp.senderIp, arp.senderMac, iface.name);
        }
        if (arp.targetIp === iface.ip) {
          iface.send(pdu.eth(iface.mac, arp.senderMac, 'arp',
            pdu.arpReply(iface.mac, iface.ip, arp.senderMac, arp.senderIp)));
        } else if (iface.vrrp && iface.vrrp.state === 'master' && arp.targetIp === iface.vrrp.vip) {
          // VRRP master answers for the virtual IP with the virtual MAC
          iface.send(pdu.eth(iface.vrrp.vmac, arp.senderMac, 'arp',
            pdu.arpReply(iface.vrrp.vmac, iface.vrrp.vip, arp.senderMac, arp.senderIp)));
        } else if (this.nat && iface.natRole === 'outside' && this.nat.answersArpFor(arp.targetIp)) {
          // proxy-ARP for a static NAT inside-global address on the outside subnet
          iface.send(pdu.eth(iface.mac, arp.senderMac, 'arp',
            pdu.arpReply(iface.mac, arp.targetIp, arp.senderMac, arp.senderIp)));
        }
      } else {
        this._arpLearn(arp.senderIp, arp.senderMac, iface.name);
      }
    }

    /* ---------- ICMP ---------- */
    _sendIcmpError(origPkt, type, code, inIface) {
      // never generate errors about ICMP errors
      if (origPkt.proto === 'icmp') {
        const t = origPkt.payload.type;
        if (t !== 'echo-request' && t !== 'echo-reply') return;
      }
      const orig = {
        src: origPkt.src, dst: origPkt.dst, proto: origPkt.proto,
        udpDstPort: origPkt.proto === 'udp' ? origPkt.payload.dstPort : undefined,
        icmpId: origPkt.proto === 'icmp' ? origPkt.payload.id : undefined,
        icmpSeq: origPkt.proto === 'icmp' ? origPkt.payload.seq : undefined,
      };
      const body = type === 'ttl-exceeded' ? pdu.icmpTtlExceeded(orig) : pdu.icmpUnreachable(code, orig);
      const src = inIface && inIface.ip ? inIface.ip : null;
      this.sendIp(NetSim.pdu.ipv4(src, origPkt.src, 'icmp', body), {});
    }

    _onIcmp(iface, pkt) {
      const icmp = pkt.payload;
      if (icmp.type === 'echo-request') {
        if (this.isLocalBroadcast(pkt.dst)) return;
        const reply = pdu.ipv4(pkt.dst, pkt.src, 'icmp', pdu.icmpEchoReply(icmp.id, icmp.seq, icmp.size));
        // reply from the address that was pinged
        if (!this.ownsIp(reply.src)) reply.src = null;
        this.sendIp(reply, {});
        return;
      }
      if (icmp.type === 'echo-reply') {
        const s = this._pingSessions.get(icmp.id);
        if (s && s.onReply) s.onReply(pkt, icmp);
        return;
      }
      // errors: route back to whoever is waiting on the original packet
      const orig = icmp.orig || {};
      if (orig.proto === 'icmp' && orig.icmpId != null) {
        const s = this._pingSessions.get(orig.icmpId);
        if (s && s.onError) s.onError(pkt, icmp);
      } else if (orig.proto === 'udp' && this._traceSession &&
                 orig.udpDstPort >= 33434 && orig.udpDstPort < 33534) {
        this._traceSession(pkt, icmp);
      } else if (orig.proto === 'tcp') {
        // could notify TCP conns; simplified: ignore
      }
    }

    /* ping API: outputs human lines through out(line); done() when finished */
    ping(dst, opts, out, done) {
      opts = opts || {};
      const count = opts.count || 4;
      const size = opts.size || 32;
      const id = this._pingId++;
      const sim = this.sim;
      let seq = 0, received = 0, finishedSeqs = new Set();
      const times = [];
      out(`PING ${dst}: ${size} bytes of data`);

      const timers = {};
      const advanced = new Set();
      /* move on to the next sequence (cancels the pending timeout) */
      const proceed = (mySeq, delay) => {
        if (advanced.has(mySeq)) return;
        advanced.add(mySeq);
        if (timers[mySeq]) sim.cancel(timers[mySeq]);
        sim.schedule(delay, sendNext);
      };
      const session = {
        onReply: (pkt, icmp) => {
          if (finishedSeqs.has(icmp.seq)) return;
          finishedSeqs.add(icmp.seq);
          received++;
          const rtt = Math.round(sim.time - sentAt[icmp.seq]);
          times.push(rtt);
          out(`Reply from ${pkt.src}: bytes=${size} seq=${icmp.seq} ttl=${pkt.ttl} time=${rtt}ms`);
          proceed(icmp.seq, 500);
        },
        onError: (pkt, icmp) => {
          const s = icmp.orig ? icmp.orig.icmpSeq : null;
          if (s != null && finishedSeqs.has(s)) return;
          if (s != null) finishedSeqs.add(s);
          if (icmp.type === 'ttl-exceeded') out(`From ${pkt.src}: TTL expired in transit`);
          else if (icmp.code === 'admin') out(`From ${pkt.src}: Destination administratively prohibited`);
          else out(`From ${pkt.src}: Destination ${icmp.code || 'net'} unreachable`);
          if (s != null) proceed(s, 500);
        },
      };
      this._pingSessions.set(id, session);
      const sentAt = {};

      const finish = () => {
        this._pingSessions.delete(id);
        const loss = Math.round(((seq - received) / Math.max(seq, 1)) * 100);
        out('');
        out(`--- ${dst} ping statistics ---`);
        out(`${seq} packets transmitted, ${received} received, ${loss}% packet loss`);
        if (times.length) {
          out(`rtt min/avg/max = ${Math.min(...times)}/${Math.round(times.reduce((a, b) => a + b, 0) / times.length)}/${Math.max(...times)} ms`);
        }
        if (done) done(received > 0);
      };

      const sendNext = () => {
        if (seq >= count) { finish(); return; }
        seq++;
        const mySeq = seq;
        sentAt[mySeq] = sim.time;
        const pkt = pdu.ipv4(null, dst, 'icmp', pdu.icmpEchoRequest(id, mySeq, size));
        if (opts.ttl) pkt.ttl = opts.ttl;
        let failed = false;
        this.sendIp(pkt, {
          onNoRoute: () => { failed = true; out(`ping: sendto: no route to host ${dst}`); },
          onArpFail: () => {
            if (!finishedSeqs.has(mySeq)) {
              finishedSeqs.add(mySeq);
              out(`From ${this._anyIp() || 'local'}: Destination host unreachable (ARP failed)`);
            }
            proceed(mySeq, 500);
          },
        });
        if (failed) { finish(); return; }
        timers[mySeq] = sim.schedule(PING_TIMEOUT, () => {
          if (advanced.has(mySeq)) return;
          advanced.add(mySeq);
          if (!finishedSeqs.has(mySeq)) { finishedSeqs.add(mySeq); out(`Request timed out. seq=${mySeq}`); }
          sendNext();
        });
      };
      sendNext();
    }
    _anyIp() {
      const i = this.ifaces.find(i => i.ip);
      return i ? i.ip : null;
    }

    /* traceroute using UDP probes + ICMP TTL exceeded */
    traceroute(dst, out, done) {
      // per-probe timeout: a deep hop's RTT is 2 links per hop (hubs/switches
      // double the count) plus ARP resolution stalls on a cold path
      const MAX_HOPS = 16, TIMEOUT = Math.max(5000, 4 * MAX_HOPS * this.sim.linkDelay);
      const sim = this.sim;
      out(`traceroute to ${dst}, ${MAX_HOPS} hops max`);
      let ttl = 0;
      let finished = false;
      let hopTimer = null, answered = false, sentTime = 0;

      this._traceSession = (pkt, icmp) => {
        if (finished || answered) return;
        // a late reply to an earlier probe must not be credited to this hop
        if (icmp.orig && icmp.orig.udpDstPort !== 33434 + ttl) return;
        answered = true;
        sim.cancel(hopTimer);
        const rtt = Math.round(sim.time - sentTime);
        if (icmp.type === 'ttl-exceeded') {
          out(`${String(ttl).padStart(2)}  ${pkt.src}  ${rtt}ms`);
          next();
        } else if (icmp.type === 'dest-unreachable' && icmp.code === 'port') {
          out(`${String(ttl).padStart(2)}  ${pkt.src}  ${rtt}ms`);
          end(true);
        } else {
          out(`${String(ttl).padStart(2)}  ${pkt.src}  ${rtt}ms  !${icmp.code || 'X'}`);
          end(false);
        }
      };
      const end = (ok) => {
        finished = true;
        this._traceSession = null;
        out('trace complete');
        if (done) done(ok);
      };
      const next = () => {
        if (finished) return;
        if (ttl >= MAX_HOPS) { end(false); return; }
        ttl++;
        answered = false;
        sentTime = sim.time;
        const pkt = pdu.ipv4(null, dst, 'udp', pdu.udp(33434, 33434 + ttl, 'probe'));
        pkt.ttl = ttl;
        let noroute = false;
        this.sendIp(pkt, {
          onNoRoute: () => { noroute = true; out(`traceroute: no route to host`); },
          onArpFail: () => { /* will just time out */ },
        });
        if (noroute) { end(false); return; }
        hopTimer = sim.schedule(TIMEOUT, () => {
          if (answered || finished) return;
          out(`${String(ttl).padStart(2)}  *  (timeout)`);
          next();
        });
      };
      next();
    }

    /* ---------- UDP ---------- */
    udpListen(port, fn) { this.udpListeners.set(port, fn); }
    udpUnlisten(port) { this.udpListeners.delete(port); }
    sendUdp(dstIp, dstPort, srcPort, data, opts) {
      this.sendIp(pdu.ipv4(null, dstIp, 'udp', pdu.udp(srcPort, dstPort, data)), opts || {});
    }
    _onUdp(iface, pkt) {
      const u = pkt.payload;
      if (u.dstPort === 4789 && u.data && u.data.vxlan && this._onVxlan(iface, pkt, u.data)) return;
      if (u.dstPort === 67 && u.data && u.data.dhcp && this.forwarding &&
          this._dhcpRelay(iface, pkt, u.data)) return;
      const fn = this.udpListeners.get(u.dstPort);
      if (fn) { fn(pkt.src, u.srcPort, u.data, iface); return; }
      if (!this.isLocalBroadcast(pkt.dst)) {
        this._sendIcmpError(pkt, 'dest-unreachable', 'port', iface);
      }
    }

    /* Actual VXLAN data plane shape: inner Ethernet in outer UDP/4789.
     * Static peers are a compact replacement for multicast/EVPN control plane. */
    sendVxlan(peerVtep, innerFrame) {
      const vx = this.vxlan;
      const source = vx && this.getIface(vx.sourceInterface);
      if (!vx || !source || !source.ip || !source.isUp() || !IP.isValid(peerVtep)) return false;
      const entropy = 49152 + (NetSim.hashStr(`${innerFrame.src}|${innerFrame.dst}|${vx.vni}`) % 16384);
      const outer = pdu.ipv4(source.ip, peerVtep, 'udp', pdu.udp(entropy, 4789, {
        vxlan: true, flags: 0x08, vni: vx.vni, inner: NetSim.clone(innerFrame),
      }));
      this.sendIp(outer, {});
      this.sim.note('vxlan', `${this.hostname()}: VXLAN UDP/4789 VNI ${vx.vni} ${innerFrame.src} -> ${innerFrame.dst} via ${peerVtep}`);
      return true;
    }
    _onVxlan(iface, pkt, data) {
      const vx = this.vxlan;
      if (!vx || data.vni !== vx.vni || data.flags !== 0x08 || !data.inner || data.inner.l2 !== 'eth') return false;
      if (vx.peers.length && !vx.peers.some(p => p.vtep === pkt.src)) return true;
      if (typeof this.device.receiveVxlanFrame !== 'function') return true;
      this.device.receiveVxlanFrame(vx.vni, NetSim.clone(data.inner), pkt.src);
      this.sim.note('vxlan', `${this.hostname()}: decapsulated UDP/4789 VNI ${data.vni} ${data.inner.src} -> ${data.inner.dst}`);
      return true;
    }

    /* DHCP relay agent (ip helper-address). Returns true if the packet was relayed. */
    _dhcpRelay(iface, pkt, d) {
      if ((d.op === 'discover' || d.op === 'request') && iface.helperAddr && !d.giaddr) {
        const relayed = NetSim.clone(d);
        relayed.giaddr = iface.ip;
        this.sim.note('dhcp', NetSim.t('net.dhcp.relay', this.hostname(), d.op, iface.helperAddr, iface.ip));
        this.sendUdp(iface.helperAddr, 67, 67, relayed, {});
        return true;
      }
      if ((d.op === 'offer' || d.op === 'ack' || d.op === 'nak') && d.giaddr && this.ownsIp(d.giaddr)) {
        const out = this.ifaces.find(i => i.ip === d.giaddr);
        if (out) {
          const bpkt = pdu.ipv4(out.ip, '255.255.255.255', 'udp', pdu.udp(67, 68, d));
          out.send(pdu.eth(out.mac, BC, 'ipv4', bpkt));
        }
        return true;
      }
      return false;
    }

    /* ---------- VRRP ---------- */
    configureVrrp(iface, gid, vip, priority) {
      if (!Number.isInteger(Number(gid)) || gid < 1 || gid > 255 ||
          !Number.isInteger(Number(priority)) || priority < 1 || priority > 255) return false;
      const hexId = gid.toString(16).padStart(2, '0');
      iface.vrrp = {
        gid, vip, priority: priority || 100,
        state: 'backup', vmac: '00:00:5e:00:01:' + hexId,
        lastAdv: this.sim.time, lastSent: 0,
      };
      this.mcastHandlers.set('224.0.0.18', (ifc, pkt) => this._onVrrpAdvert(ifc, pkt));
      this._startVrrpTick();
      return true;
    }
    removeVrrp(iface) { iface.vrrp = null; }
    _startVrrpTick() {
      if (this._vrrpTicking) return;
      this._vrrpTicking = true;
      const ADV = 2000, MASTER_DOWN = 7000;
      const tick = () => {
        let any = false;
        for (const iface of this.ifaces) {
          const v = iface.vrrp;
          if (!v) continue;
          any = true;
          if (!iface.isUp() || !iface.ip) {
            if (v.state === 'master') { v.state = 'backup'; }
            continue;
          }
          if (v.state === 'master') {
            if (this.sim.time - v.lastSent >= ADV) this._sendVrrpAdvert(iface);
          } else if (this.sim.time - v.lastAdv > MASTER_DOWN) {
            this._vrrpBecomeMaster(iface, NetSim.t('net.vrrp.masterFail'));
          }
        }
        if (any || this.ifaces.some(i => i.vrrp)) this.sim.schedule(1000, tick);
        else this._vrrpTicking = false;
      };
      this.sim.schedule(500 + Math.floor(Math.random() * 500), tick);
    }
    _sendVrrpAdvert(iface) {
      const v = iface.vrrp;
      v.lastSent = this.sim.time;
      const pkt = pdu.ipv4(iface.ip, '224.0.0.18', 'vrrp',
        { gid: v.gid, priority: v.priority, vip: v.vip });
      pkt.ttl = 255;
      // sourced from the virtual MAC (as real VRRP does) so that switches keep
      // the vMAC pinned to the current master's port
      iface.send(pdu.eth(v.vmac, '01:00:5e:00:00:12', 'ipv4', pkt));
    }
    _vrrpBecomeMaster(iface, reason) {
      const v = iface.vrrp;
      if (v.state === 'master') return;
      v.state = 'master';
      this.sim.note('vrrp', NetSim.t('net.vrrp.becameMaster', this.hostname(), v.gid, v.vip, reason));
      // gratuitous ARP so switches learn the vMAC on the new port
      iface.send(pdu.eth(v.vmac, BC, 'arp',
        pdu.arpRequest(v.vmac, v.vip, v.vip)));
      this._sendVrrpAdvert(iface);
    }
    _onVrrpAdvert(iface, pkt) {
      const v = iface.vrrp;
      if (pkt.ttl !== 255) return;
      if (!v || !pkt.payload || pkt.payload.gid !== v.gid) return;
      const p = pkt.payload;
      const theirsWins = p.priority > v.priority ||
        (p.priority === v.priority && IP.toInt(pkt.src) > IP.toInt(iface.ip || '0.0.0.0'));
      if (theirsWins) {
        if (v.state === 'master') {
          v.state = 'backup';
          this.sim.note('vrrp', NetSim.t('net.vrrp.higherPri', this.hostname(), v.gid, p.priority));
        }
        v.lastAdv = this.sim.time;
      } else if (v.state !== 'master') {
        // we outrank the current master: preempt
        this._vrrpBecomeMaster(iface, NetSim.t('net.vrrp.preempt', v.priority, p.priority));
      }
    }

    /* ---------- TCP (simplified but stateful) ---------- */
    tcpListen(port, onConn) { this.tcpListeners.set(port, onConn); }
    tcpUnlisten(port) { this.tcpListeners.delete(port); }

    _tcpKey(lip, lport, rip, rport) { return `${lip}:${lport}|${rip}:${rport}`; }

    tcpConnect(dstIp, dstPort, cbs) {
      cbs = cbs || {};
      const route = this.lookupRoute(dstIp);
      const localIp = route ? route.iface.ip : this._anyIp();
      if (!localIp) { if (cbs.onError) cbs.onError('no route to host'); return null; }
      const localPort = 49000 + Math.floor(Math.random() * 15000);
      const conn = this._newConn(localIp, localPort, dstIp, dstPort, cbs);
      conn.state = 'SYN_SENT';
      conn.iss = 1000 + Math.floor(Math.random() * 9000);
      conn.seq = conn.iss;
      this._tcpSend(conn, ['SYN'], null);
      conn.seq++;   // SYN consumes one
      let tries = 0;
      const retry = () => {
        conn.synTimer = this.sim.schedule(TCP_SYN_TIMEOUT, () => {
          if (conn.state !== 'SYN_SENT') return;
          if (tries++ < TCP_SYN_RETRIES) {
            this._tcpSendRaw(conn, ['SYN'], conn.iss, 0, null);
            retry();
          } else {
            conn.state = 'CLOSED';
            this.tcpConns.delete(conn.key);
            if (conn.cbs.onError) conn.cbs.onError('connection timed out');
          }
        });
      };
      retry();
      return conn;
    }

    _newConn(lip, lport, rip, rport, cbs) {
      const stack = this;
      const conn = {
        key: this._tcpKey(lip, lport, rip, rport),
        localIp: lip, localPort: lport, remoteIp: rip, remotePort: rport,
        state: 'CLOSED', iss: 0, seq: 0, ack: 0, cbs: cbs || {},
        mss: TCP_MSS, cwnd: TCP_MSS, ssthresh: 8 * TCP_MSS,
        bytesInFlight: 0, sendQueue: '', unacked: new Map(),
        srtt: null, rttvar: null, rto: TCP_INITIAL_RTO,
        closeRequested: false, finSeq: null,
        send(data) {
          if (this.state !== 'ESTABLISHED') return false;
          this.sendQueue += String(data);
          stack._tcpFlush(this);
          return true;
        },
        close() {
          if (this.state !== 'ESTABLISHED' && this.state !== 'CLOSE_WAIT') return;
          this.closeRequested = true;
          stack._tcpMaybeClose(this);
        },
      };
      this.tcpConns.set(conn.key, conn);
      return conn;
    }

    _tcpSend(conn, flags, data) {
      this._tcpSendRaw(conn, flags, conn.seq, conn.ack, data);
    }
    _tcpSendRaw(conn, flags, seq, ack, data) {
      const seg = pdu.tcp(conn.localPort, conn.remotePort, flags, seq, ack, data);
      // Simulator-only observability fields; these are not TCP header fields.
      seg.cwnd = Math.round(conn.cwnd);
      seg.bytesInFlight = conn.bytesInFlight;
      this.sendIp(pdu.ipv4(conn.localIp, conn.remoteIp, 'tcp', seg), {
        onArpFail: () => { if (conn.cbs.onError) conn.cbs.onError('host unreachable'); },
        onNoRoute: () => { if (conn.cbs.onError) conn.cbs.onError('no route to host'); },
      });
    }

    _tcpFlush(conn) {
      if (conn.state !== 'ESTABLISHED' || !conn.sendQueue) {
        this._tcpMaybeClose(conn);
        return;
      }
      let allowance = Math.max(0, Math.floor(conn.cwnd - conn.bytesInFlight));
      while (conn.sendQueue && allowance > 0) {
        const len = Math.min(conn.mss, allowance, conn.sendQueue.length);
        if (len <= 0) break;
        const data = conn.sendQueue.slice(0, len);
        conn.sendQueue = conn.sendQueue.slice(len);
        const rec = {
          seq: conn.seq, data, len, retries: 0, timer: null,
          sentAt: this.sim.time, retransmitted: false,
        };
        conn.seq += len;
        conn.bytesInFlight += len;
        conn.unacked.set(rec.seq, rec);
        this._tcpTransmitData(conn, rec);
        allowance -= len;
      }
    }

    _tcpTransmitData(conn, rec) {
      this._tcpSendRaw(conn, ['PSH', 'ACK'], rec.seq, conn.ack, rec.data);
      rec.sentAt = this.sim.time;
      this.sim.cancel(rec.timer);
      rec.timer = this.sim.schedule(conn.rto, () => {
        if (!conn.unacked.has(rec.seq) || conn.state === 'CLOSED') return;
        if (rec.retries++ >= TCP_MAX_RETRIES) {
          this._tcpAbort(conn, 'connection timed out');
          return;
        }
        conn.ssthresh = Math.max(2 * conn.mss, Math.floor(conn.cwnd / 2));
        conn.cwnd = conn.mss;
        conn.rto = Math.min(60000, conn.rto * 2);
        rec.retransmitted = true;
        this.sim.note('tcp', `TCP timeout ${conn.localIp}:${conn.localPort}; cwnd=${conn.cwnd}`);
        this._tcpTransmitData(conn, rec);
      });
    }

    _tcpAckData(conn, ack) {
      let acked = 0;
      for (const [seq, rec] of conn.unacked) {
        if (seq + rec.len > ack) continue;
        this.sim.cancel(rec.timer);
        conn.unacked.delete(seq);
        conn.bytesInFlight = Math.max(0, conn.bytesInFlight - rec.len);
        acked += rec.len;
        if (!rec.retransmitted) {
          const sample = Math.max(1, this.sim.time - rec.sentAt);
          if (conn.srtt == null) {
            conn.srtt = sample;
            conn.rttvar = sample / 2;
          } else {
            conn.rttvar = 0.75 * conn.rttvar + 0.25 * Math.abs(conn.srtt - sample);
            conn.srtt = 0.875 * conn.srtt + 0.125 * sample;
          }
          conn.rto = Math.min(60000, Math.max(200, conn.srtt + 4 * conn.rttvar));
        }
      }
      if (!acked) return;
      if (conn.cwnd < conn.ssthresh) conn.cwnd += acked;
      else conn.cwnd += conn.mss * acked / conn.cwnd;
      this._tcpFlush(conn);
      this._tcpMaybeClose(conn);
    }

    _tcpMaybeClose(conn) {
      if (!conn.closeRequested || conn.sendQueue || conn.unacked.size) return;
      if (conn.state !== 'ESTABLISHED' && conn.state !== 'CLOSE_WAIT') return;
      const fromEstablished = conn.state === 'ESTABLISHED';
      conn.finSeq = conn.seq;
      this._tcpSend(conn, ['FIN', 'ACK'], null);
      conn.seq++;
      conn.state = fromEstablished ? 'FIN_WAIT_1' : 'LAST_ACK';
    }

    _tcpCleanup(conn) {
      this.sim.cancel(conn.synTimer);
      for (const rec of conn.unacked.values()) this.sim.cancel(rec.timer);
      conn.unacked.clear();
      conn.bytesInFlight = 0;
    }

    _tcpAbort(conn, reason) {
      if (conn.state === 'CLOSED') return;
      this._tcpCleanup(conn);
      conn.state = 'CLOSED';
      this.tcpConns.delete(conn.key);
      if (conn.cbs.onError) conn.cbs.onError(reason);
    }

    _onTcp(iface, pkt) {
      const seg = pkt.payload;
      const key = this._tcpKey(pkt.dst, seg.dstPort, pkt.src, seg.srcPort);
      let conn = this.tcpConns.get(key);
      const F = f => seg.flags.includes(f);

      if (!conn) {
        if (F('SYN') && !F('ACK')) {
          const listener = this.tcpListeners.get(seg.dstPort);
          if (!listener) { this._tcpRst(pkt, seg); return; }
          conn = this._newConn(pkt.dst, seg.dstPort, pkt.src, seg.srcPort, {});
          conn.state = 'SYN_RCVD';
          conn.iss = 5000 + Math.floor(Math.random() * 9000);
          conn.seq = conn.iss;
          conn.ack = seg.seq + 1;
          conn._listener = listener;
          this._tcpSend(conn, ['SYN', 'ACK'], null);
          conn.seq++;
        } else if (!F('RST')) {
          this._tcpRst(pkt, seg);
        }
        return;
      }

      if (F('RST')) {
        const wasSyn = conn.state === 'SYN_SENT';
        this._tcpCleanup(conn);
        conn.state = 'CLOSED';
        this.tcpConns.delete(conn.key);
        if (conn.cbs.onError) conn.cbs.onError(wasSyn ? 'connection refused' : 'connection reset by peer');
        return;
      }

      if (F('ACK')) this._tcpAckData(conn, seg.ack);

      switch (conn.state) {
        case 'SYN_SENT':
          if (F('SYN') && F('ACK')) {
            this.sim.cancel(conn.synTimer);
            conn.ack = seg.seq + 1;
            conn.state = 'ESTABLISHED';
            this._tcpSend(conn, ['ACK'], null);
            if (conn.cbs.onOpen) conn.cbs.onOpen(conn);
          }
          break;
        case 'SYN_RCVD':
          if (F('ACK') && !F('SYN')) {
            conn.state = 'ESTABLISHED';
            if (conn._listener) conn._listener(conn);
          }
          break;
        case 'ESTABLISHED':
          if (seg.data != null && String(seg.data).length) {
            const data = String(seg.data);
            if (seg.seq !== conn.ack) {
              // Duplicate or out-of-order data: cumulative ACK asks for conn.ack.
              this._tcpSend(conn, ['ACK'], null);
              break;
            }
            conn.ack = seg.seq + data.length;
            this._tcpSend(conn, ['ACK'], null);
            if (conn.cbs.onData) conn.cbs.onData(data, conn);
          }
          if (F('FIN')) {
            conn.ack = seg.seq + (seg.data ? String(seg.data).length : 0) + 1;
            this._tcpSend(conn, ['ACK'], null);
            conn.state = 'CLOSE_WAIT';
            if (conn.cbs.onClose) conn.cbs.onClose(conn);
            // application closes promptly in this simulator
            this.sim.schedule(200, () => { if (conn.state === 'CLOSE_WAIT') conn.close(); });
          }
          break;
        case 'FIN_WAIT_1':
          if (F('FIN')) {
            conn.ack = seg.seq + 1;
            this._tcpSend(conn, ['ACK'], null);
            conn.state = F('ACK') && seg.ack >= conn.finSeq + 1 ? 'TIME_WAIT' : 'CLOSING';
            this._tcpTimeWait(conn);
          } else if (F('ACK') && seg.ack >= conn.finSeq + 1) {
            conn.state = 'FIN_WAIT_2';
          }
          break;
        case 'FIN_WAIT_2':
          if (seg.data != null && String(seg.data).length) {
            conn.ack = seg.seq + String(seg.data).length;
            this._tcpSend(conn, ['ACK'], null);
            if (conn.cbs.onData) conn.cbs.onData(String(seg.data), conn);
          }
          if (F('FIN')) {
            conn.ack = seg.seq + 1;
            this._tcpSend(conn, ['ACK'], null);
            conn.state = 'TIME_WAIT';
            this._tcpTimeWait(conn);
          }
          break;
        case 'CLOSING':
          if (F('ACK')) { conn.state = 'TIME_WAIT'; this._tcpTimeWait(conn); }
          break;
        case 'LAST_ACK':
          if (F('ACK') && seg.ack >= conn.finSeq + 1) {
            this._tcpCleanup(conn);
            conn.state = 'CLOSED';
            this.tcpConns.delete(conn.key);
            if (conn.cbs.onClose) conn.cbs.onClose(conn);
          }
          break;
      }
    }
    _tcpTimeWait(conn) {
      this.sim.schedule(3000, () => {
        this._tcpCleanup(conn);
        conn.state = 'CLOSED';
        this.tcpConns.delete(conn.key);
        if (conn.cbs.onClose) conn.cbs.onClose(conn);
      });
    }
    _tcpRst(pkt, seg) {
      const rst = pdu.tcp(seg.dstPort, seg.srcPort, ['RST', 'ACK'], 0, seg.seq + 1, null);
      this.sendIp(pdu.ipv4(pkt.dst, pkt.src, 'tcp', rst), {});
    }

    /* ---------- housekeeping ---------- */
    clearArp() { this.arpTable.clear(); }
    arpRows() {
      const rows = [];
      for (const [ip, e] of this.arpTable) {
        rows.push({ ip, mac: e.mac, ifname: e.ifname, age: Math.round((this.sim.time - e.ts) / 1000) });
      }
      return rows;
    }
  }

  NetSim.NetworkStack = NetworkStack;
})(typeof window !== 'undefined' ? window : globalThis);
