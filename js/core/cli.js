/* NetSim core: Cisco IOS-like CLI for switches / routers / L3 switches.
 * Supports command abbreviation ("sh ip int br"), "?" help, and config modes. */
(function (root) {
  const NetSim = root.NetSim;
  const IP = NetSim.ip;
  const t = (k, ...a) => NetSim.t(k, ...a);

  /* pattern token types: literal | <ip> | <mask> | <num> | <word> | <rest> */
  function tokenMatches(patTok, inTok) {
    if (patTok === '<ip>') return IP.isValid(inTok) ? { val: inTok } : null;
    if (patTok === '<mask>') return IP.isValid(inTok) ? { val: inTok } : null;
    if (patTok === '<num>') return /^\d+$/.test(inTok) ? { val: Number(inTok) } : null;
    if (patTok === '<word>') return { val: inTok };
    // literal with IOS-style abbreviation
    if (patTok.startsWith(inTok.toLowerCase())) return { lit: patTok, exact: patTok === inTok.toLowerCase() };
    return null;
  }

  class IosCli {
    /* caps: {l2, l3, svi, acl} */
    constructor(device, caps) {
      this.device = device;
      this.caps = caps;
      this.mode = 'user';
      this.ctx = {};        // {port} | {svi} | {vlanId}
      this.cmds = { user: [], enable: [], config: [], 'config-if': [], 'config-vlan': [], 'config-router': [] };
      this._register();
      device.cli = this;
    }
    out(l) { this.device.out(l); }

    prompt() {
      const n = this.device.name;
      switch (this.mode) {
        case 'user': return n + '>';
        case 'enable': return n + '#';
        case 'config': return n + '(config)#';
        case 'config-if': return n + '(config-if)#';
        case 'config-vlan': return n + '(config-vlan)#';
        case 'config-router': return n + '(config-router)#';
      }
      return n + '>';
    }

    add(mode, pattern, help, handler, cond) {
      this.cmds[mode].push({ pattern: pattern.split(/\s+/), help, handler, cond });
    }
    available(mode) {
      return this.cmds[mode].filter(c => !c.cond || c.cond());
    }

    exec(line) {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (trimmed.endsWith('?')) { this._help(trimmed.slice(0, -1).trim()); return; }
      const tokens = trimmed.split(/\s+/);
      const matches = [];
      for (const cmd of this.available(this.mode)) {
        const m = this._match(cmd.pattern, tokens);
        if (m) matches.push({ cmd, m });
      }
      if (!matches.length) {
        this.out(t('cli.m.invalidInput', trimmed));
        return;
      }
      // prefer commands with more exact literal token matches, then more literals overall
      matches.sort((a, b) => b.m.exactCount - a.m.exactCount || b.m.litCount - a.m.litCount);
      const best = matches.filter(x => x.m.exactCount === matches[0].m.exactCount && x.m.litCount === matches[0].m.litCount);
      if (best.length > 1) { this.out(t('cli.m.ambiguous')); return; }
      best[0].cmd.handler(best[0].m.args, tokens);
    }

    _match(pattern, tokens) {
      const args = [];
      let litCount = 0, exactCount = 0;
      let pi = 0, ti = 0;
      while (pi < pattern.length) {
        const pt = pattern[pi];
        if (pt === '<rest>') {
          if (ti >= tokens.length) return null;
          args.push(tokens.slice(ti).join(' '));
          return { args, litCount, exactCount };
        }
        if (ti >= tokens.length) return null;
        const r = tokenMatches(pt, tokens[ti]);
        if (!r) return null;
        if (r.lit !== undefined) { litCount++; if (r.exact) exactCount++; }
        else args.push(r.val);
        pi++; ti++;
      }
      if (ti !== tokens.length) return null;
      return { args, litCount, exactCount };
    }

    _help(prefix) {
      const tokens = prefix ? prefix.split(/\s+/) : [];
      const nexts = new Map();
      for (const cmd of this.available(this.mode)) {
        const pat = cmd.pattern;
        let ok = true;
        for (let i = 0; i < tokens.length; i++) {
          if (i >= pat.length) { ok = false; break; }
          if (pat[i] === '<rest>') break;
          if (!tokenMatches(pat[i], tokens[i])) { ok = false; break; }
        }
        if (!ok) continue;
        const next = pat[tokens.length] || '<cr>';
        if (!nexts.has(next)) nexts.set(next, cmd.help || '');
      }
      if (!nexts.size) { this.out('% Unrecognized command'); return; }
      const keys = [...nexts.keys()].sort();
      for (const k of keys) {
        // help was registered as a dictionary key; resolve for the current language
        this.out(`  ${k.padEnd(24)} ${t(nexts.get(k))}`);
      }
    }

    /* ---------------- command registration ---------------- */
    _register() {
      const dev = this.device;
      const caps = this.caps;
      const stack = () => dev.stack;

      /* ----- user mode ----- */
      this.add('user', 'enable', 'cli.h.enable', () => { this.mode = 'enable'; });
      this.add('user', 'exit', 'cli.h.exitSession', () => {});
      this._addShow('user');

      /* ----- enable mode ----- */
      this.add('enable', 'enable', 'cli.h.enable', () => {});
      this.add('enable', 'disable', 'cli.h.disable', () => { this.mode = 'user'; });
      this.add('enable', 'exit', 'cli.h.exitSession', () => { this.mode = 'user'; });
      this.add('enable', 'configure terminal', 'cli.h.confTerm', () => {
        this.out('Enter configuration commands, one per line.  End with END.');
        this.mode = 'config';
      });
      this._addShow('enable');
      this.add('enable', 'write', 'cli.h.write', () => this.out('Building configuration... [OK]'));
      this.add('enable', 'copy running-config startup-config', 'cli.h.copyRun', () => this.out('Building configuration... [OK]'));
      this.add('enable', 'shutdown all', 'cli.h.shutAll', () => this._setAllPorts(false));
      this.add('enable', 'no shutdown all', 'cli.h.noShutAll', () => this._setAllPorts(true));
      if (caps.l2) {
        this.add('enable', 'clear mac address-table', 'cli.h.clearMac', () => { dev.clearMacTable(); this.out('MAC address table cleared.'); });
      }
      if (caps.nat) {
        this.add('enable', 'clear ip nat translation *', 'cli.h.clearNat', () => { dev.stack.nat.clearDynamic(); this.out(t('cli.m.natCleared')); });
      }
      if (caps.l3) {
        this.add('enable', 'clear arp-cache', 'cli.h.clearArp', () => { stack().clearArp(); this.out('ARP cache cleared.'); });
        this.add('enable', 'ping <ip>', 'cli.h.ping', (a) => this._ping(a[0]));
        this.add('user', 'ping <ip>', 'cli.h.ping', (a) => this._ping(a[0]));
        this.add('enable', 'traceroute <ip>', 'cli.h.traceroute', (a) => {
          dev.busy = true;
          stack().traceroute(a[0], l => this.out(l), () => { dev.busy = false; dev.emit('prompt'); });
        });
      }

      /* ----- config mode ----- */
      this.add('config', 'hostname <word>', 'cli.h.hostname', (a) => { dev.name = a[0]; dev.changed(); });
      this.add('config', 'end', 'cli.h.toEnable', () => { this.mode = 'enable'; this.ctx = {}; });
      this.add('config', 'exit', 'cli.h.toEnable', () => { this.mode = 'enable'; this.ctx = {}; });
      this.add('config', 'interface <rest>', 'cli.h.interface', (a) => this._enterInterface(a[0]));
      this.add('config', 'shutdown all', 'cli.h.shutAll', () => this._setAllPorts(false));
      this.add('config', 'no shutdown all', 'cli.h.noShutAll', () => this._setAllPorts(true));
      if (caps.svi) {
        this.add('config', 'no interface <rest>', 'cli.h.noInterface', (a) => {
          const svi = this._resolveSvi(a[0]);
          if (!svi) { this.out(t('cli.m.sviNotFound')); return; }
          dev.removeSvi(svi.vlanId);
          dev.changed();
        });
        this.add('config', 'ip routing', 'cli.h.ipRouting', () => this.out(t('cli.m.ipRoutingAlways')));
      }
      if (caps.l2) {
        this.add('config', 'spanning-tree mode <word>', 'cli.h.stpMode', (a) => {
          const mode = a[0].toLowerCase();
          if (mode !== 'rstp' && mode !== 'rapid-pvst') {
            this.out('Supported modes: rstp, rapid-pvst.');
            return;
          }
          dev.stpMode = mode;
          dev.changed();
        });
        this.add('config', 'spanning-tree vlan <num> priority <num>', 'cli.h.stpPriority', (a) => {
          if (a[1] > 61440 || a[1] % 4096 !== 0) {
            this.out('Priority must be a multiple of 4096 (0-61440).');
            return;
          }
          dev.stpPriority = a[1];
          dev.changed();
        });
        this.add('config', 'vlan <num>', 'cli.h.vlanCreate', (a) => {
          if (a[0] < 1 || a[0] > 4094) { this.out(t('cli.m.vlanRange')); return; }
          dev.addVlan(a[0]);
          this.ctx = { vlanId: a[0] };
          this.mode = 'config-vlan';
          dev.changed();
        });
        this.add('config', 'no vlan <num>', 'cli.h.vlanDelete', (a) => { dev.removeVlan(a[0]); dev.changed(); });
      }
      if (caps.l3) {
        this.add('config', 'ip route <ip> <mask> <ip>', 'cli.h.ipRoute', (a) => {
          const len = IP.maskToLen(a[1]);
          if (len === null) { this.out(t('cli.m.badMask')); return; }
          stack().addStaticRoute(a[0], len, a[2]);
          dev.changed();
        });
        this.add('config', 'no ip route <ip> <mask> <ip>', 'cli.h.noIpRoute', (a) => {
          const len = IP.maskToLen(a[1]);
          if (len === null) { this.out(t('cli.m.badMask')); return; }
          stack().removeStaticRoute(a[0], len, a[2]);
          dev.changed();
        });
        this.add('config', 'no ip route <ip> <mask>', 'cli.h.noIpRoute', (a) => {
          const len = IP.maskToLen(a[1]);
          if (len === null) { this.out(t('cli.m.badMask')); return; }
          stack().removeStaticRoute(a[0], len, null);
          dev.changed();
        });
      }
      if (caps.acl) {
        this.add('config', 'access-list <num> <rest>', 'cli.h.acl', (a) => this._addAcl(a[0], a[1]));
        this.add('config', 'no access-list <num>', 'cli.h.noAcl', (a) => { dev.acls.delete(a[0]); dev.changed(); });
      }
      if (caps.nat) {
        this.add('config', 'ip nat inside source static <ip> <ip>', 'cli.h.natStatic', (a) => {
          dev.stack.nat.addStatic(a[0], a[1]); dev.changed();
        });
        this.add('config', 'no ip nat inside source static <ip> <ip>', 'cli.h.noNatStatic', (a) => {
          dev.stack.nat.removeStatic(a[0], a[1]); dev.changed();
        });
        this.add('config', 'ip nat inside source list <num> interface <word> overload', 'cli.h.natDyn', (a) => {
          const ifname = this._ifaceNameOf(a[1]);
          if (!ifname) { this.out(t('cli.m.ifNotFound')); return; }
          dev.stack.nat.addDynamic(a[0], ifname, true); dev.changed();
        });
        this.add('config', 'no ip nat inside source list <num> interface <word> overload', 'cli.h.noNatDyn', (a) => {
          dev.stack.nat.removeDynamic(a[0], this._ifaceNameOf(a[1]) || a[1]); dev.changed();
        });
      }
      if (caps.vxlan) {
        this.add('config', 'vxlan vni <num> vlan <num> source-interface <rest>', 'cli.h.vxlanSource', (a) => {
          const ifname = this._ifaceNameOf(a[2]);
          if (!ifname) { this.out(t('cli.m.ifNotFound')); return; }
          const peers = dev.stack.vxlan ? dev.stack.vxlan.peers : [];
          if (!dev.stack.configureVxlan(a[0], a[1], ifname, peers)) { this.out(t('cli.m.vxlanBad')); return; }
          dev.changed();
        });
        this.add('config', 'vxlan peer <ip>', 'cli.h.vxlanPeer', (a) => {
          const vx = dev.stack.vxlan;
          if (!vx) { this.out(t('cli.m.vxlanNeedSource')); return; }
          const peers = vx.peers.filter(p => p.vtep !== a[0]);
          peers.push({ vtep: a[0] });
          dev.stack.configureVxlan(vx.vni, vx.vlanId, vx.sourceInterface, peers);
          dev.changed();
        });
        this.add('config', 'no vxlan', 'cli.h.noVxlan', () => { dev.stack.clearVxlan(); dev.changed(); });
      }
      if (caps.ospf) {
        this.add('config', 'router ospf <num>', 'cli.h.routerOspf', (a) => {
          dev.ospf.start(a[0]);
          this.mode = 'config-router';
          dev.changed();
        });
        this.add('config', 'no router ospf <num>', 'cli.h.noRouterOspf', () => { dev.ospf.stop(); dev.changed(); });

        this.add('config-router', 'router-id <ip>', 'cli.h.routerId', (a) => {
          dev.ospf.manualRouterId = a[0]; dev.changed();
        });
        this.add('config-router', 'network <ip> <ip> area <num>', 'cli.h.network', (a) => {
          if (a[2] !== 0) { this.out(t('cli.m.ospfArea0Only')); return; }
          dev.ospf.networks.push({ net: a[0], wild: a[1], area: a[2] });
          dev.changed();
        });
        this.add('config-router', 'no network <ip> <ip> area <num>', 'cli.h.noNetwork', (a) => {
          dev.ospf.networks = dev.ospf.networks.filter(n => !(n.net === a[0] && n.wild === a[1]));
          dev.changed();
        });
        this.add('config-router', 'passive-interface <rest>', 'cli.h.passive', (a) => {
          const name = this._ifaceNameOf(a[0]);
          if (!name) { this.out(t('cli.m.ifNotFound')); return; }
          dev.ospf.passive.add(name.toLowerCase());
          dev.changed();
        });
        this.add('config-router', 'no passive-interface <rest>', 'cli.h.noPassive', (a) => {
          const name = this._ifaceNameOf(a[0]);
          if (name) dev.ospf.passive.delete(name.toLowerCase());
        });
        this.add('config-router', 'exit', 'cli.h.toConfig', () => { this.mode = 'config'; });
        this.add('config-router', 'end', 'cli.h.toEnable', () => { this.mode = 'enable'; this.ctx = {}; });
      }

      /* ----- config-if ----- */
      const ifCmd = (pattern, help, handler, cond) => this.add('config-if', pattern, help, handler, cond);
      ifCmd('exit', 'cli.h.toConfig', () => { this.mode = 'config'; this.ctx = {}; });
      ifCmd('end', 'cli.h.toEnable', () => { this.mode = 'enable'; this.ctx = {}; });
      ifCmd('shutdown', 'cli.h.ifShutdown', () => {
        const p = this.ctx.port;
        if (p) { p.adminUp = false; this.out(t('cli.m.linkDown', p.name)); dev.changed(); }
        else this.out(t('cli.m.sviNoShutdown'));
      });
      ifCmd('no shutdown', 'cli.h.ifNoShutdown', () => {
        const p = this.ctx.port;
        if (p) { p.adminUp = true; this.out(t('cli.m.linkUp', p.name)); dev.changed(); }
        else this.out(t('cli.m.sviNoShutdown'));
      });
      ifCmd('description <rest>', 'cli.h.description', (a) => { if (this.ctx.port) this.ctx.port.description = a[0]; });

      if (caps.l2) {
        ifCmd('switchport mode access', 'cli.h.swAccess', () => {
          const c = this._portCfg(); if (!c) return;
          c.mode = 'access'; dev.changed();
        });
        ifCmd('switchport mode trunk', 'cli.h.swTrunk', () => {
          const c = this._portCfg(); if (!c) return;
          c.mode = 'trunk'; dev.changed();
        });
        ifCmd('switchport access vlan <num>', 'cli.h.swAccessVlan', (a) => {
          const c = this._portCfg(); if (!c) return;
          if (!dev.vlanActive(a[0])) { dev.addVlan(a[0]); this.out(t('cli.m.vlanAutoCreated', a[0])); }
          c.accessVlan = a[0]; dev.changed();
        });
        ifCmd('switchport trunk allowed vlan <rest>', 'cli.h.swAllowed', (a) => {
          const c = this._portCfg(); if (!c) return;
          this._setAllowedVlans(c, a[0]);
          dev.changed();
        });
        ifCmd('switchport trunk native vlan <num>', 'cli.h.swNative', (a) => {
          const c = this._portCfg(); if (!c) return;
          c.nativeVlan = a[0]; dev.changed();
        });
      }
      if (caps.l3) {
        ifCmd('ip address <ip> <mask>', 'cli.h.ipAddress', (a) => {
          const len = IP.maskToLen(a[1]);
          if (len === null) { this.out(t('cli.m.badMask')); return; }
          const iface = this._l3Iface();
          if (!iface) { this.out(t('cli.m.noIpOnIface')); return; }
          iface.setIp(a[0], len);
          dev.changed();
        });
        ifCmd('no ip address', 'cli.h.noIpAddress', () => {
          const iface = this._l3Iface();
          if (iface) { iface.clearIp(); dev.changed(); }
        });
      }
      if (caps.ospf) {
        ifCmd('ip ospf cost <num>', 'cli.h.ospfCost', (a) => {
          const iface = this._l3Iface();
          if (!iface) { this.out(t('cli.m.notL3')); return; }
          iface.ospfCost = Math.max(1, a[0]);
          dev.changed();
        });
      }
      if (caps.helper) {
        ifCmd('ip helper-address <ip>', 'cli.h.helper', (a) => {
          const iface = this._l3Iface();
          if (!iface) { this.out(t('cli.m.notL3')); return; }
          iface.helperAddr = a[0];
          dev.changed();
        });
        ifCmd('no ip helper-address', 'cli.h.noHelper', () => {
          const iface = this._l3Iface();
          if (iface) { iface.helperAddr = null; dev.changed(); }
        });
      }
      if (caps.vrrp) {
        ifCmd('vrrp <num> ip <ip>', 'cli.h.vrrpIp', (a) => {
          const iface = this._l3Iface();
          if (!iface) { this.out(t('cli.m.notL3')); return; }
          if (a[0] < 1 || a[0] > 255) { this.out(t('cli.m.vrrpGroupRange')); return; }
          const prio = iface.vrrp && iface.vrrp.gid === a[0] ? iface.vrrp.priority : 100;
          if (!dev.stack.configureVrrp(iface, a[0], a[1], prio)) { this.out(t('cli.m.vrrpGroupRange')); return; }
          dev.changed();
        });
        ifCmd('vrrp <num> priority <num>', 'cli.h.vrrpPri', (a) => {
          const iface = this._l3Iface();
          if (!iface || !iface.vrrp || iface.vrrp.gid !== a[0]) { this.out(t('cli.m.vrrpNeedIp')); return; }
          if (a[1] < 1 || a[1] > 255) { this.out(t('cli.m.vrrpPriRange')); return; }
          iface.vrrp.priority = a[1];
          dev.changed();
        });
        ifCmd('no vrrp <num>', 'cli.h.noVrrp', () => {
          const iface = this._l3Iface();
          if (iface) { dev.stack.removeVrrp(iface); dev.changed(); }
        });
      }
      if (caps.lacp) {
        ifCmd('channel-group <num> mode <word>', 'cli.h.channelGroup', (a) => {
          const c = this._portCfg(); if (!c) return;
          if (a[1].toLowerCase() !== 'on') { this.out(t('cli.m.staticChannelOnly')); return; }
          c.channel = a[0];
          dev.changed();
        });
        ifCmd('no channel-group', 'cli.h.noChannelGroup', () => {
          const c = this._portCfg(); if (!c) return;
          c.channel = null;
          dev.changed();
        });
      }
      if (caps.acl) {
        ifCmd('ip access-group <num> in', 'cli.h.aclIn', (a) => {
          const iface = this._l3Iface();
          if (!iface) { this.out(t('cli.m.notL3')); return; }
          iface.aclIn = a[0]; dev.changed();
        });
        ifCmd('ip access-group <num> out', 'cli.h.aclOut', (a) => {
          const iface = this._l3Iface();
          if (!iface) { this.out(t('cli.m.notL3')); return; }
          iface.aclOut = a[0]; dev.changed();
        });
        ifCmd('no ip access-group in', 'cli.h.noAclIn', () => { const i = this._l3Iface(); if (i) { i.aclIn = null; dev.changed(); } });
        ifCmd('no ip access-group out', 'cli.h.noAclOut', () => { const i = this._l3Iface(); if (i) { i.aclOut = null; dev.changed(); } });
      }
      if (caps.nat) {
        ifCmd('ip nat inside', 'cli.h.natInside', () => {
          const i = this._l3Iface();
          if (!i) { this.out(t('cli.m.notL3')); return; }
          i.natRole = 'inside'; dev.changed();
        });
        ifCmd('ip nat outside', 'cli.h.natOutside', () => {
          const i = this._l3Iface();
          if (!i) { this.out(t('cli.m.notL3')); return; }
          i.natRole = 'outside'; dev.changed();
        });
        ifCmd('no ip nat inside', 'cli.h.noNatInside', () => { const i = this._l3Iface(); if (i && i.natRole === 'inside') { i.natRole = null; dev.changed(); } });
        ifCmd('no ip nat outside', 'cli.h.noNatOutside', () => { const i = this._l3Iface(); if (i && i.natRole === 'outside') { i.natRole = null; dev.changed(); } });
      }

      /* ----- config-vlan ----- */
      this.add('config-vlan', 'name <word>', 'cli.h.vlanName', (a) => {
        if (this.ctx.vlanId) { dev.addVlan(this.ctx.vlanId, a[0]); dev.changed(); }
      });
      this.add('config-vlan', 'exit', 'cli.h.toConfig', () => { this.mode = 'config'; this.ctx = {}; });
      this.add('config-vlan', 'end', 'cli.h.toEnable', () => { this.mode = 'enable'; this.ctx = {}; });
    }

    _ping(dst) {
      const dev = this.device;
      dev.busy = true;
      dev.stack.ping(dst, { count: 5 }, l => this.out(l), () => { dev.busy = false; dev.emit('prompt'); });
    }

    _setAllPorts(adminUp) {
      const dev = this.device;
      for (const p of dev.ports) p.adminUp = adminUp;
      this.out(t('cli.m.setAllPorts', dev.ports.length, adminUp ? 'up' : 'administratively down'));
      dev.changed();
    }

    _ifaceDisplayName(iface) {
      const port = this.device.ports.find(p => p.l3iface === iface);
      return port ? port.shortName : iface.name;
    }

    _portCfg() {
      if (!this.ctx.port || !this.device.portCfg) { this.out(t('cli.m.notPhysPort')); return null; }
      return this.device.cfg(this.ctx.port);
    }
    _l3Iface() {
      if (this.ctx.svi) return this.ctx.svi.iface;
      if (this.ctx.port && this.ctx.port.l3iface) return this.ctx.port.l3iface;
      return null;
    }

    _setAllowedVlans(c, spec) {
      const s = spec.trim().toLowerCase();
      if (s === 'all') { c.allowed = 'all'; return; }
      const parseList = (str) => str.split(',').flatMap(part => {
        const m = part.trim().match(/^(\d+)-(\d+)$/);
        if (m) {
          const out = [];
          for (let v = Number(m[1]); v <= Number(m[2]); v++) out.push(v);
          return out;
        }
        return /^\d+$/.test(part.trim()) ? [Number(part.trim())] : [];
      });
      if (s.startsWith('add ')) {
        if (c.allowed === 'all') c.allowed = [];
        c.allowed = [...new Set([...c.allowed, ...parseList(s.slice(4))])].sort((a, b) => a - b);
      } else if (s.startsWith('remove ')) {
        if (c.allowed === 'all') return;
        const rm = new Set(parseList(s.slice(7)));
        c.allowed = c.allowed.filter(v => !rm.has(v));
      } else {
        c.allowed = [...new Set(parseList(s))].sort((a, b) => a - b);
      }
    }

    _resolvePort(text) {
      const s = text.replace(/\s+/g, '').toLowerCase();
      const m = s.match(/^(?:g|gi|gig|giga|gigabitethernet)(\d+\/\d+)$/);
      if (!m) return null;
      return this.device.ports.find(p => p.shortName.toLowerCase() === 'gi' + m[1]) || null;
    }
    /* canonical L3 interface name from CLI text (physical port or SVI) */
    _ifaceNameOf(text) {
      const port = this._resolvePort(text);
      if (port) return port.name;
      const s = text.replace(/\s+/g, '').toLowerCase();
      const m = s.match(/^vlan(\d+)$/);
      if (m) return 'Vlan' + m[1];
      return null;
    }
    _resolveSvi(text) {
      const s = text.replace(/\s+/g, '').toLowerCase();
      const m = s.match(/^vlan(\d+)$/);
      if (!m) return null;
      const vlanId = Number(m[1]);
      return this.device.svis ? { vlanId, iface: this.device.svis.get(vlanId) } : null;
    }
    _enterInterface(text) {
      const port = this._resolvePort(text);
      if (port) {
        this.ctx = { port };
        this.mode = 'config-if';
        return;
      }
      if (this.caps.svi) {
        const sviRef = this._resolveSvi(text);
        if (sviRef) {
          let iface = sviRef.iface;
          if (!iface) {
            iface = this.device.createSvi(sviRef.vlanId);
            this.out(t('cli.m.sviCreated', sviRef.vlanId));
            this.device.changed();
          }
          this.ctx = { svi: { vlanId: sviRef.vlanId, iface } };
          this.mode = 'config-if';
          return;
        }
      }
      this.out(t('cli.m.ifNotFoundName', text));
    }

    _parseAddr(tokens, i) {
      const t = tokens[i];
      if (!t) return null;
      if (t.toLowerCase() === 'any') return { spec: { any: true }, next: i + 1 };
      if (t.toLowerCase() === 'host') {
        if (!IP.isValid(tokens[i + 1])) return null;
        return { spec: { host: tokens[i + 1] }, next: i + 2 };
      }
      if (IP.isValid(t) && IP.isValid(tokens[i + 1])) {
        return { spec: { net: t, wild: tokens[i + 1] }, next: i + 2 };
      }
      return null;
    }
    _addAcl(num, rest) {
      const t = rest.split(/\s+/);
      const action = t[0] ? t[0].toLowerCase() : '';
      if (action !== 'permit' && action !== 'deny') { this.out(t('cli.m.aclUsage')); return; }
      const proto = t[1] ? t[1].toLowerCase() : '';
      if (!['ip', 'icmp', 'tcp', 'udp'].includes(proto)) { this.out(t('cli.m.aclProto')); return; }
      const src = this._parseAddr(t, 2);
      if (!src) { this.out(t('cli.m.aclSrc')); return; }
      const dst = this._parseAddr(t, src.next);
      if (!dst) { this.out(t('cli.m.aclDst')); return; }
      let dstPort = null;
      if (t[dst.next]) {
        if (t[dst.next].toLowerCase() === 'eq' && /^\d+$/.test(t[dst.next + 1] || '')) {
          dstPort = Number(t[dst.next + 1]);
        } else { this.out(t('cli.m.aclPort')); return; }
      }
      const dev = this.device;
      if (!dev.acls.has(num)) dev.acls.set(num, []);
      dev.acls.get(num).push({ action, proto, src: src.spec, dst: dst.spec, dstPort });
      dev.changed();
    }

    /* ---------------- show commands ---------------- */
    _addShow(mode) {
      const dev = this.device;
      const caps = this.caps;
      this.add(mode, 'show running-config', 'cli.h.showRun', () => this._showRun());
      this.add(mode, 'show version', 'cli.h.showVersion', () => {
        this.out('NetSim IOS-like Software, Version 1.0');
        this.out(`${dev.name} (${dev.type}) uptime: ${NetSim.fmtTime(dev.sim.time)}`);
      });
      if (caps.l3) {
        this.add(mode, 'show ip interface brief', 'cli.h.showIpIntBrief', () => this._showIpIntBrief());
        this.add(mode, 'show ip route', 'cli.h.showIpRoute', () => this._showIpRoute());
        this.add(mode, 'show arp', 'cli.h.showArp', () => this._showArp());
      }
      if (caps.ospf) {
        this.add(mode, 'show ip ospf neighbor', 'cli.h.showOspfNbr', () => this._showOspfNeighbors());
        this.add(mode, 'show ip ospf database', 'cli.h.showOspfDb', () => this._showOspfDb());
      }
      if (caps.vrrp) {
        this.add(mode, 'show vrrp brief', 'cli.h.showVrrp', () => this._showVrrp());
      }
      if (caps.lacp) {
        this.add(mode, 'show etherchannel summary', 'cli.h.showEther', () => this._showEtherchannel());
      }
      if (caps.l2) {
        this.add(mode, 'show spanning-tree', 'cli.h.showStp', () => this._showSpanningTree());
        this.add(mode, 'show spanning-tree vlan <num>', 'cli.h.showStp', (a) => this._showSpanningTree(a[0]));
        this.add(mode, 'show mac address-table', 'cli.h.showMac', () => this._showMacTable());
        this.add(mode, 'show vlan brief', 'cli.h.showVlan', () => this._showVlanBrief());
        this.add(mode, 'show interfaces status', 'cli.h.showIntStatus', () => this._showIntStatus());
      }
      if (caps.acl) {
        this.add(mode, 'show access-lists', 'cli.h.showAcls', () => this._showAcls());
      }
      if (caps.nat) {
        this.add(mode, 'show ip nat translations', 'cli.h.showNat', () => this._showNat());
      }
      if (caps.vxlan) this.add(mode, 'show vxlan', 'cli.h.showVxlan', () => this._showVxlan());
    }

    _showIpIntBrief() {
      const dev = this.device;
      this.out('Interface              IP-Address      OK? Method Status                Protocol');
      for (const iface of dev.stack.ifaces) {
        let status, proto;
        const port = dev.ports.find(p => p.l3iface === iface);
        if (port) {
          status = !port.adminUp ? 'administratively down' : (port.isUp() ? 'up' : 'down');
          proto = port.isUp() ? 'up' : 'down';
        } else {
          status = iface.isUp() ? 'up' : 'down';
          proto = status;
        }
        this.out(
          iface.name.padEnd(23) +
          (iface.ip || 'unassigned').padEnd(16) +
          'YES manual '.padEnd(11) +
          status.padEnd(22) + proto);
      }
    }

    _showIpRoute() {
      this.out('Codes: C - connected, S - static, O - OSPF');
      this.out('');
      const rows = this.device.stack.routeTable();
      if (!rows.length) { this.out(t('cli.o.noRoutes')); return; }
      rows.sort((a, b) => IP.toInt(a.network) - IP.toInt(b.network) || a.len - b.len);
      for (const r of rows) {
        if (r.type === 'C') {
          this.out(`C    ${r.network}/${r.len} is directly connected, ${r.ifname}`);
        } else if (r.type === 'S') {
          const flag = r.network === '0.0.0.0' && r.len === 0 ? 'S*  ' : 'S   ';
          this.out(`${flag} ${r.network}/${r.len} [1/0] via ${r.nexthops[0]}${r.ifname ? ', ' + r.ifname : t('cli.o.unresolved')}`);
        } else {
          // dynamic (ECMP: one via-line per nexthop)
          const head = `O    ${r.network}/${r.len} [110/${r.metric}]`;
          const hops = r.hops && r.hops.length ? r.hops : r.nexthops.map(nh => ({ nexthop: nh, ifname: null }));
          hops.forEach((h, i) => {
            const prefix = i === 0 ? head : ' '.repeat(head.length);
            this.out(`${prefix} via ${h.nexthop}${h.ifname ? ', ' + h.ifname : ''}`);
          });
        }
      }
    }

    _showOspfNeighbors() {
      const ospf = this.device.ospf;
      if (!ospf || !ospf.enabled) { this.out(t('cli.o.ospfNotRunning')); return; }
      this.out(`OSPF Router ID: ${ospf.routerId || t('cli.o.pending')}  Process: ${ospf.processId}`);
      this.out('Neighbor ID     State      Address         Interface');
      for (const n of ospf.neighbors.values()) {
        const dead = Math.max(0, Math.round((20000 - (this.device.sim.time - n.lastSeen)) / 1000));
        this.out(`${n.routerId.padEnd(16)}${(n.twoWay ? 'FULL' : 'INIT').padEnd(11)}${n.ip.padEnd(16)}${n.ifname} (dead ${dead}s)`);
      }
      if (!ospf.neighbors.size) this.out(t('cli.o.noNeighbors'));
    }
    _showOspfDb() {
      const ospf = this.device.ospf;
      if (!ospf || !ospf.enabled) { this.out(t('cli.o.ospfNotRunning')); return; }
      this.out('OSPF Link State Database (Router LSAs)');
      for (const { lsa, ts } of ospf.lsdb.values()) {
        const age = Math.round((this.device.sim.time - ts) / 1000);
        this.out(`  RID ${lsa.routerId}  seq=${lsa.seq}  age=${age}s`);
        for (const net of lsa.nets) this.out(`     ${net.network}/${net.len}  cost ${net.cost}`);
      }
      if (!ospf.lsdb.size) this.out(t('cli.o.noLsa'));
    }
    _showVrrp() {
      this.out('Interface        Grp  Pri  State    Virtual IP      VMAC');
      let any = false;
      for (const iface of this.device.stack.ifaces) {
        const v = iface.vrrp;
        if (!v) continue;
        any = true;
        this.out(`${this._ifaceDisplayName(iface).padEnd(17)}${String(v.gid).padEnd(5)}${String(v.priority).padEnd(5)}${v.state.padEnd(9)}${v.vip.padEnd(16)}${v.vmac}`);
      }
      if (!any) this.out(t('cli.o.noVrrp'));
    }
    _showEtherchannel() {
      const dev = this.device;
      const groups = new Map();
      for (const p of dev.ports) {
        const c = dev.cfg(p);
        if (c.channel != null) {
          if (!groups.has(c.channel)) groups.set(c.channel, []);
          groups.get(c.channel).push(p);
        }
      }
      if (!groups.size) { this.out(t('cli.o.noPortChannel')); return; }
      this.out('Group  Port-channel  Ports');
      for (const [n, ports] of [...groups].sort((a, b) => a[0] - b[0])) {
        const list = ports.map(p => `${p.shortName}(${p.isUp() ? 'P' : 'D'})`).join(' ');
        this.out(`${String(n).padEnd(7)}Po${String(n).padEnd(12)}${list}`);
      }
      this.out(t('cli.o.etherLegend'));
    }

    _showArp() {
      this.out('Protocol  Address          Age (sec)  Hardware Addr       Interface');
      for (const iface of this.device.stack.ifaces) {
        if (iface.ip) this.out(`Internet  ${iface.ip.padEnd(17)}-          ${iface.mac.padEnd(20)}${iface.name}`);
      }
      for (const r of this.device.stack.arpRows()) {
        this.out(`Internet  ${r.ip.padEnd(17)}${String(r.age).padEnd(11)}${r.mac.padEnd(20)}${r.ifname}`);
      }
    }

    _showMacTable() {
      this.out('          Mac Address Table');
      this.out('-------------------------------------------');
      this.out('Vlan    Mac Address       Type        Ports');
      this.out('----    -----------       --------    -----');
      const rows = this.device.macRows();
      if (!rows.length) this.out(t('cli.o.noMacEntries'));
      for (const r of rows) {
        this.out(`${String(r.vlan).padEnd(8)}${r.mac.padEnd(18)}DYNAMIC     ${r.port}`);
      }
    }

    _showSpanningTree(vlan) {
      const dev = this.device;
      const shownVlan = vlan == null ? 1 : vlan;
      const tree = dev.stpMode === 'rapid-pvst' ? dev.stpVlanRoots.get(shownVlan) : {
        rootId: dev.stpRootId, cost: dev.stpRootCost, rootPort: dev.stpRootPort,
      };
      if (!tree) { this.out(`No spanning-tree instance for VLAN ${shownVlan}.`); return; }
      const rootMac = tree.rootId.slice(6).match(/.{1,2}/g).join(':');
      this.out(`Spanning tree mode ${dev.stpMode} (simulated rapid convergence)`);
      if (dev.stpMode === 'rapid-pvst') this.out(`VLAN ${shownVlan}`);
      this.out(`Root ID    Priority ${tree.rootId.slice(0, 5)}  Address ${rootMac}  Cost ${tree.cost}`);
      this.out(`Bridge ID  Priority ${dev.stpPriority}  Address ${dev.baseMac}`);
      this.out('Interface           Role         State       Cost');
      for (const p of dev.ports) {
        const state = dev.stpMode === 'rapid-pvst' ? p.stpVlans.get(shownVlan) : p.stpCommon;
        if (!state) continue;
        this.out(`${p.shortName.padEnd(20)}${state.role.padEnd(13)}${state.state.padEnd(12)}4`);
      }
    }

    _showVlanBrief() {
      const dev = this.device;
      this.out('VLAN Name                             Status    Ports');
      this.out('---- -------------------------------- --------- -------------------------------');
      const ids = [...dev.vlans.keys()].sort((a, b) => a - b);
      for (const id of ids) {
        const ports = dev.ports
          .filter(p => { const c = dev.cfg(p); return c.mode === 'access' && c.accessVlan === id; })
          .map(p => p.shortName).join(', ');
        this.out(`${String(id).padEnd(5)}${dev.vlans.get(id).name.padEnd(33)}active    ${ports}`);
      }
    }

    _showIntStatus() {
      const dev = this.device;
      this.out('Port      Name               Status       Vlan       Duplex  Speed Type');
      for (const p of dev.ports) {
        const c = dev.cfg(p);
        const vlan = c.mode === 'trunk' ? 'trunk' : String(c.accessVlan);
        this.out(
          p.shortName.padEnd(10) +
          (p.description || '').slice(0, 18).padEnd(19) +
          p.statusText().padEnd(13) +
          vlan.padEnd(11) +
          'full    1000  1000BaseT');
      }
    }

    _showNat() {
      const nat = this.device.stack.nat;
      if (!nat) { this.out(t('cli.o.natUnsupported')); return; }
      const rows = nat.rows();
      if (!nat.configured() && !rows.length) { this.out(t('cli.o.natNotConfigured')); return; }
      const fmt = (ip, port) => (port != null ? `${ip}:${port}` : ip);
      this.out('Pro   Inside global          Inside local           Outside global');
      if (!rows.length) { this.out(t('cli.o.natNoActive')); return; }
      for (const r of rows) {
        const og = r.outIp ? fmt(r.outIp, r.outPort) : '---';
        this.out(
          r.proto.padEnd(6) +
          fmt(r.globalIp, r.globalPort).padEnd(23) +
          fmt(r.localIp, r.localPort).padEnd(23) + og);
      }
    }

    _showVxlan() {
      const vx = this.device.stack.vxlan;
      if (!vx) { this.out(t('cli.o.vxlanNotConfigured')); return; }
      this.out(`VNI ${vx.vni}  VLAN ${vx.vlanId}  source-interface ${vx.sourceInterface}`);
      this.out('Remote VTEP');
      for (const p of vx.peers) this.out(p.vtep);
    }

    _showAcls() {
      const dev = this.device;
      if (!dev.acls.size) { this.out(t('cli.o.noAcls')); return; }
      for (const [num, rules] of dev.acls) {
        this.out(`Extended IP access list ${num}`);
        rules.forEach((r, i) => this.out(`    ${(i + 1) * 10} ${NetSim.acl.ruleText(r)}`));
      }
    }

    _showRun() {
      const dev = this.device, caps = this.caps;
      const L = [];
      L.push('Building configuration...');
      L.push('!');
      L.push(`hostname ${dev.name}`);
      L.push('!');
      if (caps.l2) {
        if (dev.stpMode !== 'rapid-pvst') {
          L.push(`spanning-tree mode ${dev.stpMode}`);
          L.push('!');
        }
        if (dev.stpPriority !== 32768) {
          L.push(`spanning-tree vlan 1 priority ${dev.stpPriority}`);
          L.push('!');
        }
        const ids = [...dev.vlans.keys()].filter(v => v !== 1).sort((a, b) => a - b);
        for (const id of ids) {
          L.push(`vlan ${id}`);
          L.push(` name ${dev.vlans.get(id).name}`);
          L.push('!');
        }
      }
      const l3Lines = (iface) => {
        const out = [];
        if (iface.ip) out.push(` ip address ${iface.ip} ${IP.lenToMask(iface.maskLen)}`);
        else out.push(' no ip address');
        if (iface.aclIn != null) out.push(` ip access-group ${iface.aclIn} in`);
        if (iface.aclOut != null) out.push(` ip access-group ${iface.aclOut} out`);
        if (iface.natRole === 'inside') out.push(' ip nat inside');
        else if (iface.natRole === 'outside') out.push(' ip nat outside');
        if (iface.helperAddr) out.push(` ip helper-address ${iface.helperAddr}`);
        if (iface.ospfCost && iface.ospfCost !== 1) out.push(` ip ospf cost ${iface.ospfCost}`);
        if (iface.vrrp) {
          out.push(` vrrp ${iface.vrrp.gid} ip ${iface.vrrp.vip}`);
          if (iface.vrrp.priority !== 100) out.push(` vrrp ${iface.vrrp.gid} priority ${iface.vrrp.priority}`);
        }
        return out;
      };
      for (const p of dev.ports) {
        L.push(`interface ${p.name}`);
        if (p.description) L.push(` description ${p.description}`);
        if (caps.l2 && dev.portCfg) {
          const c = dev.cfg(p);
          if (c.mode === 'trunk') {
            L.push(' switchport mode trunk');
            if (c.allowed !== 'all') L.push(` switchport trunk allowed vlan ${c.allowed.join(',')}`);
            if (c.nativeVlan !== 1) L.push(` switchport trunk native vlan ${c.nativeVlan}`);
          } else {
            L.push(' switchport mode access');
            if (c.accessVlan !== 1) L.push(` switchport access vlan ${c.accessVlan}`);
          }
          if (c.channel != null) L.push(` channel-group ${c.channel} mode on`);
        }
        if (p.l3iface) L.push(...l3Lines(p.l3iface));
        L.push(p.adminUp ? ' no shutdown' : ' shutdown');
        L.push('!');
      }
      if (caps.svi && dev.svis) {
        for (const [vlanId, iface] of dev.svis) {
          L.push(`interface Vlan${vlanId}`);
          L.push(...l3Lines(iface));
          L.push('!');
        }
      }
      if (caps.ospf && dev.ospf && dev.ospf.enabled) {
        L.push(`router ospf ${dev.ospf.processId}`);
        if (dev.ospf.manualRouterId) L.push(` router-id ${dev.ospf.manualRouterId}`);
        for (const n of dev.ospf.networks) L.push(` network ${n.net} ${n.wild} area ${n.area}`);
        for (const pi of dev.ospf.passive) L.push(` passive-interface ${pi}`);
        L.push('!');
      }
      if (caps.l3) {
        for (const r of dev.stack.staticRoutes) {
          L.push(`ip route ${r.network} ${IP.lenToMask(r.len)} ${r.nexthop}`);
        }
      }
      if (caps.vxlan && dev.stack.vxlan) {
        const vx = dev.stack.vxlan;
        L.push(`vxlan vni ${vx.vni} vlan ${vx.vlanId} source-interface ${vx.sourceInterface}`);
        for (const p of vx.peers) L.push(`vxlan peer ${p.vtep}`);
      }
      if (caps.nat && dev.stack.nat) {
        for (const s of dev.stack.nat.statics) L.push(`ip nat inside source static ${s.localIp} ${s.globalIp}`);
        for (const r of dev.stack.nat.dynRules) L.push(`ip nat inside source list ${r.aclNum} interface ${r.ifname} overload`);
      }
      if (caps.acl && dev.acls) {
        for (const [num, rules] of dev.acls) {
          for (const r of rules) L.push(`access-list ${num} ${NetSim.acl.ruleText(r)}`);
        }
      }
      L.push('end');
      for (const l of L) this.out(l);
    }
  }

  NetSim.IosCli = IosCli;
})(typeof window !== 'undefined' ? window : globalThis);
