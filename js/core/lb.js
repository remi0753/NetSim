/* NetSim device: L4 load balancer — TCP proxy with round-robin backends + health check */
(function (root) {
  const NetSim = root.NetSim;
  const t = (k, ...a) => NetSim.t(k, ...a);

  const HEALTH_INTERVAL = 8000;

  class LoadBalancer extends NetSim.Host {
    constructor(net, name) {
      super(net, name);
      this.setHttpServer(false);
      this.lbPort = null;
      this.backends = [];   // {ip, port, alive, conns}
      this._rr = 0;
      this._healthTimer = null;
    }

    lbEnable(port) {
      if (this.lbPort != null) this.stack.tcpUnlisten(this.lbPort);
      this.lbPort = port;
      this.stack.tcpListen(port, (conn) => this._accept(conn));
      this._startHealth();
      this.changed();
    }
    lbDisable() {
      if (this.lbPort != null) this.stack.tcpUnlisten(this.lbPort);
      this.lbPort = null;
      this.changed();
    }
    addBackend(ip, port) {
      if (this.backends.some(b => b.ip === ip && b.port === port)) return;
      this.backends.push({ ip, port: port || 80, alive: true, conns: 0 });
      this._startHealth();
      this.changed();
    }
    removeBackend(ip) {
      this.backends = this.backends.filter(b => b.ip !== ip);
      this.changed();
    }
    configureVrrp(gid, vip) {
      const prio = this.iface.vrrp && this.iface.vrrp.gid === gid ? this.iface.vrrp.priority : 100;
      this.stack.configureVrrp(this.iface, gid, vip, prio);
      this.changed();
    }
    setVrrpPriority(gid, priority) {
      if (!this.iface.vrrp || this.iface.vrrp.gid !== gid) {
        this.out(t('cli.m.vrrpNeedIp'));
        return;
      }
      this.iface.vrrp.priority = priority;
      this.changed();
    }
    removeVrrp(gid) {
      if (this.iface.vrrp && (gid == null || this.iface.vrrp.gid === gid)) {
        this.stack.removeVrrp(this.iface);
        this.changed();
      }
    }

    _pickBackend() {
      const alive = this.backends.filter(b => b.alive);
      if (!alive.length) return null;
      const b = alive[this._rr % alive.length];
      this._rr++;
      return b;
    }

    _accept(client) {
      const backend = this._pickBackend();
      if (!backend) {
        this.out(t('lb.m.noAliveBackend', `${client.remoteIp}:${client.remotePort}`));
        client.close();
        return;
      }
      backend.conns++;
      this.out(`[lb] ${client.remoteIp}:${client.remotePort} → ${backend.ip}:${backend.port}`);
      const pending = [];
      let upOpen = false, closed = false;
      const upstream = this.stack.tcpConnect(backend.ip, backend.port, {
        onOpen: (c) => {
          upOpen = true;
          for (const d of pending) c.send(d);
          pending.length = 0;
        },
        onData: (d) => client.send(d),
        onClose: () => { if (!closed) { closed = true; client.close(); } },
        onError: () => { if (!closed) { closed = true; client.close(); } },
      });
      client.cbs.onData = (d) => {
        if (upOpen) upstream.send(d);
        else pending.push(d);
      };
      client.cbs.onClose = () => {
        if (!closed) { closed = true; if (upstream) upstream.close(); }
      };
    }

    _startHealth() {
      if (this._healthTimer) return;
      const tick = () => {
        if (!this.backends.length && this.lbPort == null) { this._healthTimer = null; return; }
        for (const b of this.backends) {
          const conn = this.stack.tcpConnect(b.ip, b.port, {
            onOpen: (c) => {
              if (!b.alive) this.sim.note('lb', t('lb.n.backendUp', this.name, b.ip, b.port));
              b.alive = true;
              c.close();
            },
            onError: () => {
              if (b.alive) this.sim.note('lb', t('lb.n.backendDown', this.name, b.ip, b.port));
              b.alive = false;
            },
          });
          if (!conn && b.alive) b.alive = false;
        }
        this._healthTimer = this.sim.schedule(HEALTH_INTERVAL, tick);
      };
      this._healthTimer = this.sim.schedule(1000, tick);
    }

    exec(line) {
      const argv = line.trim().split(/\s+/);
      const cmd = (argv[0] || '').toLowerCase();
      if (cmd === 'vrrp') {
        const gid = Number(argv[1]);
        const sub = (argv[2] || '').toLowerCase();
        if (!gid) { this.out(t('lb.m.vrrpUsage')); return; }
        if (sub === 'ip' && NetSim.ip.isValid(argv[3])) {
          this.configureVrrp(gid, argv[3]);
          this.out(t('lb.m.vrrpSet', gid, argv[3]));
          return;
        }
        if (sub === 'priority') {
          const prio = Number(argv[3]);
          if (!prio || prio < 1 || prio > 255) { this.out(t('lb.m.vrrpPriRange')); return; }
          this.setVrrpPriority(gid, prio);
          return;
        }
        this.out(t('lb.m.vrrpUsage'));
        return;
      }
      if (cmd === 'no' && (argv[1] || '').toLowerCase() === 'vrrp') {
        const gid = argv[2] ? Number(argv[2]) : null;
        this.removeVrrp(gid);
        this.out(t('lb.m.vrrpRemoved'));
        return;
      }
      if (cmd === 'show' && (argv[1] || '').toLowerCase() === 'vrrp') {
        this.out('Interface        Grp  Pri  State    Virtual IP      VMAC');
        const v = this.iface.vrrp;
        if (v) this.out(`${this.iface.name.padEnd(17)}${String(v.gid).padEnd(5)}${String(v.priority).padEnd(5)}${v.state.padEnd(9)}${v.vip.padEnd(16)}${v.vmac}`);
        else this.out(t('cli.o.noVrrp'));
        return;
      }
      if (argv[0] && argv[0].toLowerCase() === 'lb') {
        const sub = (argv[1] || '').toLowerCase();
        if (sub === 'service') {
          const port = Number(argv[2]) || 80;
          this.lbEnable(port);
          this.out(t('lb.m.lbStarted', port));
          return;
        }
        if (sub === 'backend' && argv[2] === 'add' && NetSim.ip.isValid(argv[3])) {
          this.addBackend(argv[3], Number(argv[4]) || 80);
          this.out(t('lb.m.backendAdded', argv[3], Number(argv[4]) || 80));
          return;
        }
        if (sub === 'backend' && (argv[2] === 'del' || argv[2] === 'remove') && NetSim.ip.isValid(argv[3])) {
          this.removeBackend(argv[3]);
          this.out(t('lb.m.backendRemoved', argv[3]));
          return;
        }
        if (sub === 'status' || sub === '') {
          this.out(t('lb.m.statusLine', this.lbPort != null ? 'TCP:' + this.lbPort : t('lb.m.stopped')));
          if (!this.backends.length) this.out(t('lb.m.noBackends'));
          for (const b of this.backends) {
            this.out(`  ${b.ip}:${b.port}  ${b.alive ? 'UP  ' : 'DOWN'}  conns=${b.conns}`);
          }
          return;
        }
        this.out(t('lb.m.lbUsage'));
        return;
      }
      if (cmd === 'help' || cmd === '?') {
        super.exec(line);
        for (const l of t('lb.help').split('\n')) this.out(l);
        return;
      }
      super.exec(line);
    }

    serializeConfig() {
      const cfg = super.serializeConfig();
      cfg.lbPort = this.lbPort;
      cfg.backends = this.backends.map(b => ({ ip: b.ip, port: b.port }));
      cfg.vrrp = this.iface.vrrp ? {
        gid: this.iface.vrrp.gid, vip: this.iface.vrrp.vip, priority: this.iface.vrrp.priority,
      } : null;
      return cfg;
    }
    applyConfig(cfg) {
      super.applyConfig(cfg);
      if (!cfg) return;
      if (cfg.vrrp) this.stack.configureVrrp(this.iface, cfg.vrrp.gid, cfg.vrrp.vip, cfg.vrrp.priority);
      for (const b of cfg.backends || []) this.addBackend(b.ip, b.port);
      if (cfg.lbPort != null) this.lbEnable(cfg.lbPort);
    }
  }
  LoadBalancer.TYPE = 'lb';

  NetSim.LoadBalancer = LoadBalancer;
})(typeof window !== 'undefined' ? window : globalThis);
