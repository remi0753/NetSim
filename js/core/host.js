/* NetSim device: end host (PC / Server) with a shell-like console */
(function (root) {
  const NetSim = root.NetSim;
  const IP = NetSim.ip;
  const t = (k, ...a) => NetSim.t(k, ...a);

  class Host extends NetSim.Device {
    constructor(net, name) {
      super(net, name);
      this.nic = this.addPort('eth0', { mac: NetSim.genMac() });
      this.stack = new NetSim.NetworkStack(this, { forwarding: false });
      this.iface = this.stack.addInterface('eth0', this.nic.mac, {
        send: (frame) => { if (this.nic.link) this.nic.link.transmit(this.nic, frame); },
        isUp: () => this.nic.isUp(),
      });
      this.gateway = null;
      this.httpServer = false;
      this._udpListenPorts = new Set();
      this.busy = false;   // an async command is running

      /* --- DHCP client --- */
      this.dhcpMode = false;
      this._dhcp = { state: 'idle', xid: 0, tries: 0, serverId: null };
      this.stack.udpListen(68, (src, sport, data) => this._onDhcpClient(data));

      /* --- DHCP server (optional role) --- */
      this.dhcpd = { enabled: false, pools: [], leases: new Map() };  // pools: {network,len,start,end,gw}
    }

    receiveFrame(port, frame) {
      const isMcastMac = frame.dst.startsWith('01:00:5e');
      const vrrpMac = this.iface.vrrp && this.iface.vrrp.state === 'master' && frame.dst === this.iface.vrrp.vmac;
      // NIC filter: our MAC, broadcast, IPv4 multicast, or active VRRP virtual MAC
      if (frame.dst !== this.nic.mac && frame.dst !== NetSim.BROADCAST_MAC && !isMcastMac && !vrrpMac) return;
      if (frame.vlan != null) return;   // hosts don't speak 802.1Q
      this.stack.onFrame(this.iface, frame);
    }

    setIp(ip, maskLen, gateway, opts) {
      if (!opts || !opts.fromDhcp) this.dhcpMode = false;
      this.iface.setIp(ip, maskLen);
      this.gateway = gateway || null;
      this.stack.staticRoutes = [];
      if (this.gateway) this.stack.addStaticRoute('0.0.0.0', 0, this.gateway);
      this.changed();
    }

    /* ---------------- DHCP client ---------------- */
    useDhcp() {
      this.dhcpMode = true;
      this.iface.clearIp();
      this.gateway = null;
      this.stack.staticRoutes = [];
      this.changed();
      this._dhcpStart();
    }
    _dhcpStart() {
      if (!this.dhcpMode) return;
      this._dhcp = {
        state: 'discover',
        xid: Math.floor(Math.random() * 0xffffff),
        tries: 0, serverId: null,
      };
      this._dhcpSend('discover', {});
      this._dhcpRetry();
    }
    _dhcpRetry() {
      this.sim.schedule(8000, () => {
        if (!this.dhcpMode || this._dhcp.state === 'bound' || this._dhcp.state === 'idle') return;
        if (++this._dhcp.tries >= 4) {
          this.out(t('host.m.dhcpNoResp'));
          this._dhcp.state = 'idle';
          this.sim.schedule(30000, () => { if (this.dhcpMode && this._dhcp.state === 'idle') this._dhcpStart(); });
          return;
        }
        this._dhcpSend(this._dhcp.state === 'request' ? 'request' : 'discover',
          this._dhcp.state === 'request' ? { requestedIp: this._dhcp.offered, serverId: this._dhcp.serverId } : {});
        this._dhcpRetry();
      });
    }
    _dhcpSend(op, extra) {
      const data = Object.assign({ dhcp: true, op, xid: this._dhcp.xid, chaddr: this.nic.mac }, extra);
      const pkt = NetSim.pdu.ipv4('0.0.0.0', '255.255.255.255', 'udp', NetSim.pdu.udp(68, 67, data));
      this.iface.send(NetSim.pdu.eth(this.nic.mac, NetSim.BROADCAST_MAC, 'ipv4', pkt));
    }
    _onDhcpClient(data) {
      if (!this.dhcpMode || !data || !data.dhcp) return;
      if (data.chaddr !== this.nic.mac || data.xid !== this._dhcp.xid) return;
      if (data.op === 'offer' && this._dhcp.state === 'discover') {
        this._dhcp.state = 'request';
        this._dhcp.offered = data.yiaddr;
        this._dhcp.offerInfo = data;
        this._dhcp.serverId = data.serverId;
        this._dhcpSend('request', { requestedIp: data.yiaddr, serverId: data.serverId });
      } else if (data.op === 'ack' && this._dhcp.state === 'request') {
        this._dhcp.state = 'bound';
        this.setIp(data.yiaddr, data.maskLen, data.gw || null, { fromDhcp: true });
        this.out(t('host.m.dhcpBound', data.yiaddr, data.maskLen, data.gw || t('host.m.none'), data.serverId));
      } else if (data.op === 'nak') {
        this.out(t('host.m.dhcpNak'));
        this._dhcpStart();
      }
    }

    /* ---------------- DHCP server ---------------- */
    dhcpServerEnable(on) {
      if (on && !this.dhcpd.enabled) {
        this.stack.udpListen(67, (src, sport, data) => this._onDhcpServer(src, data));
        this.dhcpd.enabled = true;
      } else if (!on && this.dhcpd.enabled) {
        this.stack.udpUnlisten(67);
        this.dhcpd.enabled = false;
      }
      this.changed();
    }
    addDhcpPool(network, len, start, end, gw) {
      this.dhcpd.pools = this.dhcpd.pools.filter(p => !(p.network === network && p.len === len));
      this.dhcpd.pools.push({ network, len, start, end, gw });
      this.dhcpServerEnable(true);
    }
    _dhcpPickPool(giaddr) {
      const ref = giaddr || this.iface.ip;
      if (!ref) return null;
      return this.dhcpd.pools.find(p => IP.inNetwork(ref, p.network, p.len)) || null;
    }
    _dhcpAllocate(pool, chaddr) {
      const cur = this.dhcpd.leases.get(chaddr);
      if (cur && IP.inNetwork(cur, pool.network, pool.len)) return cur;
      const used = new Set(this.dhcpd.leases.values());
      for (let v = IP.toInt(pool.start); v <= IP.toInt(pool.end); v++) {
        const ip = IP.fromInt(v);
        if (used.has(ip) || ip === pool.gw || ip === this.iface.ip) continue;
        return ip;
      }
      return null;
    }
    _onDhcpServer(srcIp, data) {
      if (!data || !data.dhcp || !this.dhcpd.enabled) return;
      if (data.op !== 'discover' && data.op !== 'request') return;
      const pool = this._dhcpPickPool(data.giaddr);
      if (!pool) return;
      const reply = (op, yiaddr) => {
        const payload = {
          dhcp: true, op, xid: data.xid, chaddr: data.chaddr,
          yiaddr, maskLen: pool.len, gw: pool.gw || null,
          serverId: this.iface.ip, giaddr: data.giaddr || null,
        };
        if (data.giaddr) {
          this.stack.sendUdp(data.giaddr, 67, 67, payload, {});
        } else {
          const pkt = NetSim.pdu.ipv4(this.iface.ip, '255.255.255.255', 'udp', NetSim.pdu.udp(67, 68, payload));
          this.iface.send(NetSim.pdu.eth(this.nic.mac, NetSim.BROADCAST_MAC, 'ipv4', pkt));
        }
      };
      if (data.op === 'discover') {
        const ip = this._dhcpAllocate(pool, data.chaddr);
        if (!ip) { this.out(t('host.m.dhcpdExhausted', pool.network, pool.len)); return; }
        this.dhcpd.leases.set(data.chaddr, ip);   // tentative
        reply('offer', ip);
      } else {
        if (data.serverId && data.serverId !== this.iface.ip) return;   // chose another server
        const ip = this.dhcpd.leases.get(data.chaddr) || this._dhcpAllocate(pool, data.chaddr);
        if (!ip) { reply('nak', null); return; }
        this.dhcpd.leases.set(data.chaddr, ip);
        this.out(t('host.m.dhcpdLeased', data.chaddr, ip, data.giaddr ? ' (relay ' + data.giaddr + ')' : ''));
        reply('ack', ip);
      }
    }

    setHttpServer(on) {
      if (on && !this.httpServer) {
        this.stack.tcpListen(80, (conn) => {
          conn.cbs.onData = (data) => {
            const reqLine = String(data).split('\n')[0].trim();
            this.out(`[http] ${conn.remoteIp}:${conn.remotePort} ${reqLine}`);
            const body = `<html><body><h1>Hello from ${this.name}</h1></body></html>`;
            conn.send(`HTTP/1.0 200 OK\r\nServer: NetSim/1.0\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
            this.sim.schedule(300, () => conn.close());
          };
        });
        this.httpServer = true;
      } else if (!on && this.httpServer) {
        this.stack.tcpUnlisten(80);
        this.httpServer = false;
      }
      this.changed();
    }

    getPrompt() { return this.busy ? '' : `${this.name}$`; }

    exec(line) {
      const raw = line.trim();
      if (!raw) return;
      const argv = raw.split(/\s+/);
      const cmd = argv[0].toLowerCase();
      const done = () => { this.busy = false; this.emit('prompt'); };
      switch (cmd) {
        case 'help': case '?':
          for (const l of t('host.help').split('\n')) this.out(l);
          return;
        case 'ipconfig': case 'ifconfig': {
          this.out(`${this.iface.name}: ${this.nic.isUp() ? 'UP' : 'DOWN'}  (MAC ${this.nic.mac})`);
          if (this.iface.ip) {
            this.out(`  ${t('host.k.ipv4')}: ${this.iface.ip}${this.dhcpMode ? t('host.m.viaDhcp') : ''}`);
            this.out(`  ${t('host.k.subnet')}: ${IP.lenToMask(this.iface.maskLen)} (/${this.iface.maskLen})`);
            this.out(`  ${t('host.k.defgw')}: ${this.gateway || t('host.m.notSet')}`);
          } else if (this.dhcpMode) {
            this.out(t('host.m.dhcpWaiting'));
          } else {
            this.out(t('host.m.noIpHint'));
          }
          return;
        }
        case 'set': {
          if (argv[1] === 'ip' && argv[2] && argv[2].toLowerCase() === 'dhcp') {
            this.out(t('host.m.dhcpStart'));
            this.useDhcp();
            return;
          }
          if (argv[1] !== 'ip' || argv.length < 4) { this.out(t('host.m.setIpUsage')); return; }
          const ip = argv[2];
          let maskLen = null;
          if (argv[3].includes('.')) maskLen = IP.maskToLen(argv[3]);
          else if (/^\/?\d+$/.test(argv[3])) maskLen = Number(argv[3].replace('/', ''));
          if (!IP.isValid(ip) || maskLen == null || maskLen < 0 || maskLen > 32) { this.out(t('host.m.badAddrMask')); return; }
          const gw = argv[4];
          if (gw && !IP.isValid(gw)) { this.out(t('host.m.badGw')); return; }
          if (gw && !IP.sameSubnet(ip, gw, maskLen)) this.out(t('host.m.gwNotInSubnet'));
          this.setIp(ip, maskLen, gw || null);
          this.out(`OK: ${ip}/${maskLen}${gw ? ' gw ' + gw : ''}`);
          return;
        }
        case 'hostname':
          if (!argv[1]) { this.out(t('host.m.hostnameUsage')); return; }
          this.name = argv[1]; this.changed();
          return;
        case 'shutdown':
          this.nic.adminUp = false;
          this.out(t('cli.m.linkDown', this.iface.name));
          this.changed();
          return;
        case 'no':
          if ((argv[1] || '').toLowerCase() === 'shutdown') {
            this.nic.adminUp = true;
            this.out(t('cli.m.linkUp', this.iface.name));
            this.changed();
            return;
          }
          this.out(t('host.m.unknownCmd', raw));
          return;
        case 'ping': {
          const target = argv.find(a => IP.isValid(a));
          if (!target) { this.out(t('host.m.pingUsage')); return; }
          if (!this.iface.ip) { this.out(t('host.m.noIp')); return; }
          let count = 4;
          const ci = argv.indexOf('-c');
          if (ci >= 0 && argv[ci + 1]) count = Math.min(20, Math.max(1, Number(argv[ci + 1]) || 4));
          this.busy = true;
          this.stack.ping(target, { count }, (l) => this.out(l), () => done());
          return;
        }
        case 'traceroute': case 'tracert': {
          if (!argv[1] || !IP.isValid(argv[1])) { this.out(t('host.m.traceUsage')); return; }
          if (!this.iface.ip) { this.out(t('host.m.noIp')); return; }
          this.busy = true;
          this.stack.traceroute(argv[1], (l) => this.out(l), () => done());
          return;
        }
        case 'arp': {
          if (argv[1] === '-d') { this.stack.clearArp(); this.out(t('host.m.arpCleared')); return; }
          const rows = this.stack.arpRows();
          if (!rows.length) { this.out(t('host.m.arpEmpty')); return; }
          this.out(t('host.m.arpHeader'));
          for (const r of rows) this.out(`  ${r.ip.padEnd(17)} ${r.mac.padEnd(20)} dynamic`);
          return;
        }
        case 'http': {
          if (argv[1] === 'server') {
            const on = argv[2] === 'on';
            this.setHttpServer(on);
            this.out(on ? t('host.m.httpStarted') : t('host.m.httpStopped'));
            return;
          }
          if (argv[1] === 'get') {
            const dst = argv[2];
            const port = Number(argv[3]) || 80;
            if (!dst || !IP.isValid(dst) || !NetSim.isValidPort(port)) { this.out(t('host.m.httpGetUsage')); return; }
            if (!this.iface.ip) { this.out(t('host.m.noIp')); return; }
            this.busy = true;
            this.out(`Connecting to ${dst}:${port} ...`);
            let gotData = false;
            const conn = this.stack.tcpConnect(dst, port, {
              onOpen: (c) => {
                this.out(t('host.m.connected', `${c.localIp}:${c.localPort}`));
                c.send(`GET / HTTP/1.0\r\nHost: ${dst}\r\n\r\n`);
              },
              onData: (data) => {
                gotData = true;
                for (const l of String(data).split(/\r?\n/)) this.out('  ' + l);
              },
              onClose: () => {
                if (this.busy) { this.out(gotData ? t('host.m.connClosedFin') : t('host.m.connClosed')); done(); }
              },
              onError: (err) => { if (this.busy) { this.out(t('host.m.error', err)); done(); } },
            });
            if (!conn && this.busy) done();
            return;
          }
          this.out(t('host.m.httpUsage2'));
          return;
        }
        case 'udp': {
          if (argv[1] === 'send') {
            const dst = argv[2], port = Number(argv[3]);
            const msg = argv.slice(4).join(' ') || 'hello';
            if (!IP.isValid(dst) || !NetSim.isValidPort(port)) { this.out(t('host.m.udpSendUsage')); return; }
            if (!this.iface.ip) { this.out(t('host.m.noIp')); return; }
            this.stack.sendUdp(dst, port, 40000 + Math.floor(Math.random() * 10000), msg, {
              onNoRoute: () => this.out(t('host.m.noRoute')),
            });
            this.out(`UDP ${msg.length} bytes → ${dst}:${port}`);
            return;
          }
          if (argv[1] === 'listen') {
            const port = Number(argv[2]);
            if (!NetSim.isValidPort(port)) { this.out(t('host.m.udpListenUsage')); return; }
            this.stack.udpListen(port, (src, sport, data) => {
              this.out(t('host.m.udpRecv', port, src, sport, data));
            });
            this._udpListenPorts.add(port);
            this.out(t('host.m.udpListening', port));
            return;
          }
          if (argv[1] === 'unlisten') {
            const port = Number(argv[2]);
            this.stack.udpUnlisten(port);
            this._udpListenPorts.delete(port);
            this.out(t('host.m.udpUnlisten', port));
            return;
          }
          this.out(t('host.m.udpUsage'));
          return;
        }
        case 'dhcp': {
          const sub = (argv[1] || '').toLowerCase();
          if (sub === 'pool') {
            const m = (argv[2] || '').match(/^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/);
            const start = argv[3], end = argv[4], gw = argv[5];
            if (!m || !IP.isValid(m[1]) || !IP.isValid(start) || !IP.isValid(end) || (gw && !IP.isValid(gw))) {
              this.out(t('host.m.dhcpPoolUsage'));
              return;
            }
            this.addDhcpPool(IP.networkOf(m[1], Number(m[2])), Number(m[2]), start, end, gw || null);
            this.out(t('host.m.dhcpPoolSet', m[1], m[2], start, end));
            return;
          }
          if (sub === 'server') {
            this.dhcpServerEnable(argv[2] === 'on');
            this.out(this.dhcpd.enabled ? t('host.m.dhcpdOn') : t('host.m.dhcpdOff'));
            return;
          }
          if (sub === 'leases') {
            if (!this.dhcpd.leases.size) { this.out(t('host.m.noLeases')); return; }
            this.out(t('host.m.leasesHeader'));
            for (const [mac, ip] of this.dhcpd.leases) this.out(`  ${mac.padEnd(20)} ${ip}`);
            return;
          }
          this.out(t('host.m.dhcpUsage'));
          return;
        }
        case 'clear':
          this.emit('clear');
          return;
        default:
          this.out(t('host.m.unknownCmd', cmd));
      }
    }

    serializeConfig() {
      return {
        ip: this.iface.ip, maskLen: this.iface.maskLen, gateway: this.gateway,
        nicAdminUp: this.nic.adminUp,
        httpServer: this.httpServer,
        dhcpMode: this.dhcpMode,
        dhcpd: this.dhcpd.enabled ? {
          pools: this.dhcpd.pools.slice(),
          leases: [...this.dhcpd.leases],
        } : null,
      };
    }
    applyConfig(cfg) {
      if (!cfg) return;
      if (cfg.nicAdminUp === false) this.nic.adminUp = false;
      if (cfg.dhcpMode) this.useDhcp();
      else if (cfg.ip) this.setIp(cfg.ip, cfg.maskLen, cfg.gateway);
      if (cfg.httpServer) this.setHttpServer(true);
      if (cfg.dhcpd) {
        this.dhcpd.pools = (cfg.dhcpd.pools || []).slice();
        this.dhcpd.leases = new Map(cfg.dhcpd.leases || []);
        this.dhcpServerEnable(true);
      }
    }
  }
  Host.TYPE = 'pc';

  class Server extends Host {
    constructor(net, name) {
      super(net, name);
      this.setHttpServer(true);
    }
  }
  Server.TYPE = 'server';

  NetSim.Host = Host;
  NetSim.Server = Server;
})(typeof window !== 'undefined' ? window : globalThis);
