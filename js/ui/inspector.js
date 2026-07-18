/* NetSim UI: right-hand inspector — GUI configuration for the selected device/link */
(function (root) {
  const NetSim = root.NetSim;
  NetSim.ui = NetSim.ui || {};
  const IP = NetSim.ip;
  const t = (k, ...a) => NetSim.t(k, ...a);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function statusHtml(port) {
    const t = port.statusText();
    const cls = t === 'connected' ? 'st-up' : (t === 'notconnect' ? 'st-off' : 'st-down');
    return `<span class="${cls}">${t}</span>`;
  }
  function parseMask(s) {
    s = String(s || '').trim();
    if (!s) return null;
    if (s.includes('.')) return IP.maskToLen(s);
    const m = s.match(/^\/?(\d{1,2})$/);
    if (m) { const n = Number(m[1]); return n >= 0 && n <= 32 ? n : null; }
    return null;
  }

  class Inspector {
    constructor(app) {
      this.app = app;
      this.body = document.getElementById('inspector-body');
      this.sel = null;
      app.net.on('topology', () => {
        const s = this.sel;
        if (s && s.device && !app.net.devices.includes(s.device)) {
          app.select(null);
        } else if (s && s.link && !app.net.links.includes(s.link)) {
          app.select(null);
        } else if (s && s.group && !app.net.groups.includes(s.group)) {
          app.select(null);
        } else if (s && s.devices) {
          const alive = s.devices.filter(d => app.net.devices.includes(d));
          if (alive.length !== s.devices.length) {
            app.select(alive.length > 1 ? { devices: alive } : (alive.length === 1 ? { device: alive[0] } : null));
          } else {
            this.render(s);
          }
        } else {
          this.render(s);
        }
      });
    }

    render(sel) {
      this.sel = sel;
      const b = this.body;
      if (!sel) { b.innerHTML = this._guide(); return; }
      if (sel.link) { this._renderLink(sel.link); return; }
      if (sel.group) { this._renderGroupPanel(sel.group); return; }
      if (sel.devices) { this._renderMulti(sel.devices); return; }
      this._renderDevice(sel.device);
    }

    /* ---------- group panel ---------- */
    _renderGroupPanel(g) {
      const b = this.body;
      const members = this.app.net.groupMembers(g);
      b.innerHTML = `
        <h3>▣ ${esc(g.name)}</h3>
        <div class="dev-type">${t('insp.grp.count', members.length)}</div>
        <div class="insp-row">
          <input type="text" id="grp-name" value="${esc(g.name)}">
          <button class="insp-btn" id="grp-rename">${t('insp.rename')}</button>
        </div>
        <div class="insp-row">
          <button class="insp-btn primary" id="grp-toggle">${g.collapsed ? t('insp.grp.expand') : t('insp.grp.collapse')}</button>
          <button class="insp-btn" id="grp-select">${t('insp.grp.selectMem')}</button>
          <button class="insp-btn danger" id="grp-ungroup">${t('insp.grp.ungroup')}</button>
        </div>
        <div class="insp-section">
          <div class="sec-title">${t('insp.grp.members')}</div>
          <div class="insp-note">${members.map(d => esc(d.name)).join(', ')}</div>
        </div>`;
      b.querySelector('#grp-rename').addEventListener('click', () => {
        const v = b.querySelector('#grp-name').value.trim();
        if (v) { g.name = v; this.app.net.emit('topology'); }
      });
      b.querySelector('#grp-toggle').addEventListener('click', () => {
        this.app.net.setCollapsed(g, !g.collapsed);
        this.render({ group: g });
      });
      b.querySelector('#grp-select').addEventListener('click', () => {
        if (g.collapsed) this.app.net.setCollapsed(g, false);
        this.app.select({ devices: this.app.net.groupMembers(g) });
      });
      b.querySelector('#grp-ungroup').addEventListener('click', () => {
        this.app.net.removeGroup(g);
        this.app.select(null);
      });
    }

    /* ---------- multi-select panel ---------- */
    _renderMulti(devs) {
      const b = this.body;
      const byType = {};
      for (const d of devs) byType[d.type] = (byType[d.type] || 0) + 1;
      const summary = Object.entries(byType)
        .map(([ty, n]) => `${NetSim.deviceLabel(ty)}×${n}`).join(' / ');
      const hosts = devs.filter(d => d.type === 'pc' || d.type === 'server' || d.type === 'lb');
      const cliDevs = devs.filter(d => d.cli);
      b.innerHTML = `
        <h3>${t('insp.multi.selected', devs.length)}</h3>
        <div class="dev-type">${summary}</div>
        <div class="insp-row">
          <button class="insp-btn primary" id="mul-group">${t('insp.multi.group')}</button>
          <button class="insp-btn danger" id="mul-del">${t('insp.multi.delAll')}</button>
        </div>
        ${hosts.length ? `
        <div class="insp-section">
          <div class="sec-title">${t('insp.multi.bulkIp', hosts.length)}</div>
          <div class="insp-row"><label>${t('insp.multi.startIp')}</label><input type="text" id="mul-ip" placeholder="10.0.1.10"></div>
          <div class="insp-row"><label>${t('insp.mask')}</label><input type="text" id="mul-mask" placeholder="/24" value="/24"></div>
          <div class="insp-row"><label>${t('insp.gw')}</label><input type="text" id="mul-gw" placeholder="10.0.1.1"></div>
          <div class="insp-row">
            <button class="insp-btn primary" id="mul-ip-apply">${t('insp.multi.applySeq')}</button>
            <button class="insp-btn" id="mul-dhcp">${t('insp.multi.dhcp')}</button>
          </div>
          <div class="insp-note" id="mul-ip-msg"></div>
        </div>` : ''}
        ${cliDevs.length ? `
        <div class="insp-section">
          <div class="sec-title">${t('insp.multi.bulkCli', cliDevs.length)}</div>
          <textarea id="mul-cli" rows="5" style="width:100%;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:5px;font-family:var(--mono);font-size:11px;padding:4px"
            placeholder="enable&#10;conf t&#10;vlan 10&#10;end"></textarea>
          <div class="insp-row">
            <button class="insp-btn primary" id="mul-cli-run">${t('insp.multi.cliRun')}</button>
            <span class="insp-note" id="mul-cli-msg"></span>
          </div>
        </div>` : ''}`;
      b.querySelector('#mul-group').addEventListener('click', () => {
        const g = this.app.net.createGroup(null, devs);
        this.app.select({ group: g });
      });
      b.querySelector('#mul-del').addEventListener('click', () => {
        if (!confirm(t('insp.multi.confirmDel', devs.length))) return;
        for (const d of devs.slice()) this.app.deleteDevice(d);
      });
      if (hosts.length) {
        b.querySelector('#mul-ip-apply').addEventListener('click', () => {
          const msg = b.querySelector('#mul-ip-msg');
          const start = b.querySelector('#mul-ip').value.trim();
          const maskLen = parseMask(b.querySelector('#mul-mask').value);
          const gw = b.querySelector('#mul-gw').value.trim();
          if (!IP.isValid(start) || maskLen == null) { msg.textContent = t('insp.multi.badStart'); return; }
          if (gw && !IP.isValid(gw)) { msg.textContent = t('insp.multi.badGw'); return; }
          const sorted = hosts.slice().sort((a, b2) => a.name.localeCompare(b2.name, undefined, { numeric: true }));
          let v = IP.toInt(start);
          for (const h of sorted) {
            let ip = IP.fromInt(v);
            if (gw && ip === gw) { v++; ip = IP.fromInt(v); }
            h.setIp(ip, maskLen, gw || null);
            v++;
          }
          msg.textContent = t('insp.multi.ipApplied', sorted.length, start);
        });
        b.querySelector('#mul-dhcp').addEventListener('click', () => {
          for (const h of hosts) h.useDhcp();
          b.querySelector('#mul-ip-msg').textContent = t('insp.multi.dhcpStart', hosts.length);
        });
      }
      if (cliDevs.length) {
        b.querySelector('#mul-cli-run').addEventListener('click', () => {
          const lines = b.querySelector('#mul-cli').value.split('\n').map(l => l.trim()).filter(Boolean);
          if (!lines.length) return;
          for (const d of cliDevs) {
            for (const line of lines) d.exec(line);
          }
          b.querySelector('#mul-cli-msg').textContent = t('insp.multi.cliDone', cliDevs.length, lines.length);
        });
      }
    }

    _guide() {
      return t('insp.guide');
    }

    _renderLink(link) {
      const b = this.body;
      b.innerHTML = `
        <h3>${t('insp.link.title')}</h3>
        <div class="dev-type">${t('insp.link.type')}</div>
        <div class="insp-section">
          <table class="insp-table">
            <tr><th>${t('insp.link.device')}</th><th>${t('insp.col.port')}</th><th>${t('insp.col.status')}</th></tr>
            <tr><td>${esc(link.a.device.name)}</td><td>${esc(link.a.shortName)}</td><td>${statusHtml(link.a)}</td></tr>
            <tr><td>${esc(link.b.device.name)}</td><td>${esc(link.b.shortName)}</td><td>${statusHtml(link.b)}</td></tr>
          </table>
        </div>
        <button class="insp-btn danger" id="ins-del-link">${t('insp.link.del')}</button>`;
      b.querySelector('#ins-del-link').addEventListener('click', () => {
        this.app.net.removeLink(link);
        this.app.select(null);
      });
    }

    _renderDevice(dev) {
      const b = this.body;
      const typeLabel = NetSim.deviceLabel(dev.type);
      let html = `
        <h3 id="ins-devname">${esc(dev.name)}</h3>
        <div class="dev-type">${typeLabel}</div>
        <div class="insp-row">
          <button class="insp-btn primary" id="ins-console">${t('insp.openConsole')}</button>
          <button class="insp-btn danger" id="ins-del">${t('insp.del')}</button>
        </div>
        <div class="insp-section">
          <div class="sec-title">${t('insp.name')}</div>
          <div class="insp-row">
            <input type="text" id="ins-name" value="${esc(dev.name)}">
            <button class="insp-btn" id="ins-name-apply">${t('insp.rename')}</button>
          </div>
        </div>`;

      if (dev.type === 'pc' || dev.type === 'server') html += this._hostHtml(dev);
      else if (dev.type === 'lb') html += this._hostHtml(dev) + this._lbHtml(dev) + this._vrrpHtml(dev);
      else if (dev.type === 'hub') html += this._hubHtml(dev);
      else if (dev.type === 'switch') html += this._switchHtml(dev);
      else if (dev.type === 'l3switch') html += this._switchHtml(dev) + this._sviHtml(dev) + this._aclHtml(dev) + this._vxlanHtml(dev) + this._vrrpHtml(dev) + this._routesHtml(dev) + this._ospfNoteHtml(dev);
      else if (dev.type === 'router') html += this._routerHtml(dev) + this._aclHtml(dev) + this._vrrpHtml(dev) + this._natHtml(dev) + this._routesHtml(dev) + this._ospfNoteHtml(dev);

      b.innerHTML = html;

      b.querySelector('#ins-console').addEventListener('click', () => this.app.openConsole(dev));
      b.querySelector('#ins-del').addEventListener('click', () => this.app.deleteDevice(dev));
      b.querySelector('#ins-name-apply').addEventListener('click', () => {
        const v = b.querySelector('#ins-name').value.trim();
        if (v) { dev.name = v; dev.changed(); this.render(this.sel); }
      });

      if (dev.type === 'pc' || dev.type === 'server') this._wireHost(dev);
      else if (dev.type === 'lb') { this._wireHost(dev); this._wireLb(dev); }
      else if (dev.type === 'switch') this._wireSwitch(dev);
      else if (dev.type === 'l3switch') { this._wireSwitch(dev); this._wireSvi(dev); this._wireRoutes(dev); }
      else if (dev.type === 'router') { this._wireRouter(dev); this._wireNat(dev); this._wireRoutes(dev); }
    }

    /* ---------- host ---------- */
    _hostHtml(dev) {
      const mask = dev.iface.maskLen != null ? IP.lenToMask(dev.iface.maskLen) : '';
      const poolsStr = dev.dhcpd && dev.dhcpd.enabled
        ? (dev.dhcpd.pools.map(p => `${p.network}/${p.len}`).join(', ') || t('insp.host.dhcpdPoolsNone'))
        : '';
      return `
        <div class="insp-section">
          <div class="sec-title">${t('insp.host.ipConfig')}</div>
          <div class="insp-row"><label>MAC</label><span style="font-family:var(--mono);font-size:11px">${dev.nic.mac}</span></div>
          <div class="insp-row"><label>${t('insp.host.ip')}</label><input type="text" id="ins-ip" value="${esc(dev.iface.ip || '')}" placeholder="10.0.1.11"></div>
          <div class="insp-row"><label>${t('insp.host.mask')}</label><input type="text" id="ins-mask" value="${esc(mask)}" placeholder="${t('insp.host.maskPh')}"></div>
          <div class="insp-row"><label>${t('insp.host.gw')}</label><input type="text" id="ins-gw" value="${esc(dev.gateway || '')}" placeholder="10.0.1.254"></div>
          <div class="insp-row"><button class="insp-btn primary" id="ins-ip-apply">${t('insp.apply')}</button><span class="insp-note" id="ins-ip-msg"></span></div>
        </div>
        <div class="insp-row">
          <button class="insp-btn" id="ins-dhcp">${dev.dhcpMode ? t('insp.host.dhcpRenew') : t('insp.host.dhcpGet')}</button>
          <span class="insp-note">${dev.dhcpMode ? (dev.iface.ip ? t('insp.host.dhcpBound') : t('insp.host.dhcpWait')) : ''}</span>
        </div>
        <div class="insp-section">
          <div class="sec-title">${t('insp.host.services')}</div>
          <div class="insp-row">
            <label><input type="checkbox" id="ins-http" ${dev.httpServer ? 'checked' : ''}> ${t('insp.host.http')}</label>
          </div>
          ${dev.dhcpd && dev.dhcpd.enabled
            ? `<div class="insp-note">${t('insp.host.dhcpdOn', poolsStr, dev.dhcpd.leases.size)}</div>`
            : `<div class="insp-note">${t('insp.host.dhcpdOff')}</div>`}
        </div>
        <div class="insp-section">
          <div class="sec-title">${t('insp.host.connection')}</div>
          <table class="insp-table">
            <tr><th>${t('insp.col.port')}</th><th>${t('insp.col.status')}</th><th>${t('insp.col.peer')}</th></tr>
            <tr><td>eth0</td><td>${statusHtml(dev.nic)}</td>
              <td>${dev.nic.link ? esc(dev.nic.other().device.name + ' ' + dev.nic.other().shortName) : '—'}</td></tr>
          </table>
        </div>`;
    }
    _wireHost(dev) {
      const b = this.body;
      b.querySelector('#ins-ip-apply').addEventListener('click', () => {
        const msg = b.querySelector('#ins-ip-msg');
        const ip = b.querySelector('#ins-ip').value.trim();
        const maskLen = parseMask(b.querySelector('#ins-mask').value);
        const gw = b.querySelector('#ins-gw').value.trim();
        if (!IP.isValid(ip)) { msg.textContent = t('insp.msg.badIp'); return; }
        if (maskLen == null) { msg.textContent = t('insp.msg.badMask'); return; }
        if (gw && !IP.isValid(gw)) { msg.textContent = t('insp.msg.badGw'); return; }
        dev.setIp(ip, maskLen, gw || null);
        msg.textContent = t('insp.msg.set');
      });
      b.querySelector('#ins-http').addEventListener('change', (e) => {
        dev.setHttpServer(e.target.checked);
      });
      const dhcpBtn = b.querySelector('#ins-dhcp');
      if (dhcpBtn) {
        dhcpBtn.addEventListener('click', () => {
          dev.useDhcp();
          this.render(this.sel);
        });
      }
    }

    /* ---------- load balancer ---------- */
    _lbHtml(dev) {
      const rows = dev.backends.map(bk => `
        <tr><td>${bk.ip}:${bk.port}</td>
        <td class="${bk.alive ? 'st-up' : 'st-down'}">${bk.alive ? 'UP' : 'DOWN'}</td>
        <td>${bk.conns}</td></tr>`).join('');
      return `
        <div class="insp-section">
          <div class="sec-title">${t('insp.lb.title')}</div>
          <div class="insp-row"><label>${t('insp.lb.listenPort')}</label>
            <input type="text" id="lb-port" value="${dev.lbPort != null ? dev.lbPort : ''}" placeholder="80" style="max-width:70px">
            <button class="insp-btn primary" id="lb-start">${dev.lbPort != null ? t('insp.lb.reconfig') : t('insp.lb.start')}</button>
          </div>
          <table class="insp-table">
            <tr><th>${t('insp.lb.backend')}</th><th>${t('insp.col.status')}</th><th>${t('insp.lb.conns')}</th></tr>
            ${rows || `<tr><td colspan="3">${t('insp.none')}</td></tr>`}
          </table>
          <div class="insp-row">
            <input type="text" id="lb-bk-ip" placeholder="10.0.2.10">
            <input type="text" id="lb-bk-port" placeholder="80" style="max-width:52px">
            <button class="insp-btn" id="lb-bk-add">${t('insp.add')}</button>
          </div>
        </div>`;
    }
    _wireLb(dev) {
      const b = this.body;
      b.querySelector('#lb-start').addEventListener('click', () => {
        const port = Number(b.querySelector('#lb-port').value) || 80;
        if (!NetSim.isValidPort(port)) return;
        dev.lbEnable(port);
        this.render(this.sel);
      });
      b.querySelector('#lb-bk-add').addEventListener('click', () => {
        const ip = b.querySelector('#lb-bk-ip').value.trim();
        const port = Number(b.querySelector('#lb-bk-port').value) || 80;
        if (!IP.isValid(ip) || !NetSim.isValidPort(port)) return;
        dev.addBackend(ip, port);
        this.render(this.sel);
      });
    }

    _vrrpHtml(dev) {
      const ifaces = dev.stack && dev.stack.ifaces ? dev.stack.ifaces : [];
      const rows = ifaces
        .filter(iface => iface.vrrp)
        .map(iface => {
          const v = iface.vrrp;
          const ifName = this._ifaceDisplayName(dev, iface.name);
          const cls = v.state === 'master' ? 'st-up' : 'st-off';
          return `
            <tr>
              <td>${esc(ifName)}</td>
              <td>${v.gid}</td>
              <td>${v.priority}</td>
              <td class="${cls}">${esc(v.state)}</td>
              <td>${esc(v.vip)}</td>
            </tr>`;
        }).join('');
      return `
        <div class="insp-section">
          <div class="sec-title">${t('insp.vrrp.title')}</div>
          <table class="insp-table">
            <tr><th>IF</th><th>${t('insp.vrrp.grp')}</th><th>${t('insp.vrrp.pri')}</th><th>${t('insp.col.status')}</th><th>${t('insp.vrrp.vip')}</th></tr>
            ${rows || `<tr><td colspan="5">${t('insp.none')}</td></tr>`}
          </table>
          <div class="insp-note">${t('insp.vrrp.note')}</div>
        </div>`;
    }

    _ifaceDisplayName(dev, ifname) {
      const iface = dev.stack && dev.stack.getIface ? dev.stack.getIface(ifname) : null;
      const port = iface && dev.ports.find(p => p.l3iface === iface);
      return port ? port.shortName : ifname;
    }

    _ospfNoteHtml(dev) {
      const o = dev.ospf;
      const status = o && o.enabled
        ? t('insp.ospf.on', o.routerId || t('insp.ospf.ridPending'), o.neighbors.size, (dev.stack.dynRoutes.get('ospf') || []).length)
        : t('insp.ospf.off');
      return `
        <div class="insp-section">
          <div class="sec-title">${t('insp.ospf.title')}</div>
          <div class="insp-note">${t('insp.ospf.status')}: ${status}<br>
          ${t('insp.ospf.note')}</div>
        </div>`;
    }

    /* ---------- hub ---------- */
    _hubHtml(dev) {
      const rows = dev.ports.map(p => `
        <tr><td>${p.shortName}</td><td>${statusHtml(p)}</td>
        <td>${p.link ? esc(p.other().device.name) : '—'}</td></tr>`).join('');
      return `
        <div class="insp-section">
          <div class="sec-title">${t('insp.hub.ports')}</div>
          <table class="insp-table"><tr><th>${t('insp.col.port')}</th><th>${t('insp.col.status')}</th><th>${t('insp.col.peer')}</th></tr>${rows}</table>
          <div class="insp-note">${t('insp.hub.note')}</div>
        </div>`;
    }

    /* ---------- switch (shared with L3 switch) ---------- */
    _switchHtml(dev) {
      const vlanList = [...dev.vlans].sort((a, b) => a[0] - b[0])
        .map(([id, v]) => `${id}: ${esc(v.name)}`).join(' / ');
      const rows = dev.ports.map((p, idx) => {
        const c = dev.cfg(p);
        return `
        <tr data-idx="${idx}">
          <td>${p.shortName}</td>
          <td>${statusHtml(p)}</td>
          <td><select class="sw-mode">
            <option value="access" ${c.mode === 'access' ? 'selected' : ''}>access</option>
            <option value="trunk" ${c.mode === 'trunk' ? 'selected' : ''}>trunk</option>
          </select></td>
          <td>${c.mode === 'access'
            ? `<input class="sw-vlan" type="text" value="${c.accessVlan}" size="3">`
            : `<span title="${t('insp.sw.allowedT')}">${c.allowed === 'all' ? 'all' : esc(c.allowed.join(','))}</span>`}</td>
          <td>${p.link ? esc(p.other().device.name) : '—'}</td>
        </tr>`;
      }).join('');
      return `
        <div class="insp-section">
          <div class="sec-title">${t('insp.sw.vlan')}</div>
          <div class="insp-note">${vlanList}</div>
          <div class="insp-row">
            <input type="text" id="sw-newvlan" placeholder="${t('insp.sw.newIdPh')}" style="max-width:52px">
            <input type="text" id="sw-newvlan-name" placeholder="${t('insp.sw.newNamePh')}">
            <button class="insp-btn" id="sw-addvlan">${t('insp.add')}</button>
          </div>
        </div>
        <div class="insp-section">
          <div class="sec-title">${t('insp.sw.portConfig')}</div>
          <table class="insp-table" id="sw-ports">
            <tr><th>${t('insp.col.port')}</th><th>${t('insp.col.status')}</th><th>${t('insp.sw.mode')}</th><th>VLAN</th><th>${t('insp.col.peer')}</th></tr>
            ${rows}
          </table>
          <div class="insp-note">${t('insp.sw.note')}</div>
        </div>`;
    }
    _wireSwitch(dev) {
      const b = this.body;
      b.querySelector('#sw-addvlan').addEventListener('click', () => {
        const id = Number(b.querySelector('#sw-newvlan').value);
        const name = b.querySelector('#sw-newvlan-name').value.trim();
        if (!id || id < 1 || id > 4094) return;
        dev.addVlan(id, name || undefined);
        dev.changed();
        this.render(this.sel);
      });
      b.querySelectorAll('#sw-ports tr[data-idx]').forEach(tr => {
        const port = dev.ports[Number(tr.dataset.idx)];
        const c = dev.cfg(port);
        tr.querySelector('.sw-mode').addEventListener('change', (e) => {
          c.mode = e.target.value;
          dev.changed();
          this.render(this.sel);
        });
        const vlanInput = tr.querySelector('.sw-vlan');
        if (vlanInput) {
          vlanInput.addEventListener('change', (e) => {
            const id = Number(e.target.value);
            if (!id || id < 1 || id > 4094) { e.target.value = c.accessVlan; return; }
            if (!dev.vlanActive(id)) dev.addVlan(id);
            c.accessVlan = id;
            dev.changed();
          });
        }
      });
    }

    /* ---------- L3 switch SVIs ---------- */
    _sviHtml(dev) {
      const rows = [...dev.svis].map(([vid, iface]) => `
        <tr data-vid="${vid}">
          <td>Vlan${vid}</td>
          <td><input class="svi-ip" type="text" value="${esc(iface.ip || '')}" placeholder="IP"></td>
          <td><input class="svi-mask" type="text" value="${iface.maskLen != null ? '/' + iface.maskLen : ''}" placeholder="/24" size="4"></td>
          <td class="${iface.isUp() ? 'st-up' : 'st-down'}">${iface.isUp() ? 'up' : 'down'}</td>
          <td><button class="insp-btn svi-del" title="${t('insp.del.t')}">✕</button></td>
        </tr>`).join('');
      return `
        <div class="insp-section">
          <div class="sec-title">${t('insp.svi.title')}</div>
          <table class="insp-table" id="svi-table">
            <tr><th>IF</th><th>${t('insp.svi.ip')}</th><th>${t('insp.svi.mask')}</th><th>${t('insp.col.status')}</th><th></th></tr>
            ${rows}
          </table>
          <div class="insp-row">
            <input type="text" id="svi-new" placeholder="${t('insp.svi.newPh')}" style="max-width:70px">
            <button class="insp-btn" id="svi-add">${t('insp.svi.add')}</button>
            <button class="insp-btn primary" id="svi-apply">${t('insp.apply')}</button>
          </div>
        </div>`;
    }
    _wireSvi(dev) {
      const b = this.body;
      b.querySelector('#svi-add').addEventListener('click', () => {
        const vid = Number(b.querySelector('#svi-new').value);
        if (!vid || vid < 1 || vid > 4094) return;
        dev.createSvi(vid);
        dev.changed();
        this.render(this.sel);
      });
      b.querySelector('#svi-apply').addEventListener('click', () => {
        b.querySelectorAll('#svi-table tr[data-vid]').forEach(tr => {
          const iface = dev.svis.get(Number(tr.dataset.vid));
          if (!iface) return;
          const ip = tr.querySelector('.svi-ip').value.trim();
          const maskLen = parseMask(tr.querySelector('.svi-mask').value);
          if (IP.isValid(ip) && maskLen != null) iface.setIp(ip, maskLen);
          else if (!ip) iface.clearIp();
        });
        dev.changed();
        this.render(this.sel);
      });
      b.querySelectorAll('#svi-table .svi-del').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const vid = Number(e.target.closest('tr').dataset.vid);
          dev.removeSvi(vid);
          dev.changed();
          this.render(this.sel);
        });
      });
    }

    /* ---------- router interfaces ---------- */
    _routerHtml(dev) {
      const rows = dev.ports.map((p, idx) => `
        <tr data-idx="${idx}">
          <td>${p.shortName}</td>
          <td><input class="rt-up" type="checkbox" ${p.adminUp ? 'checked' : ''} title="no shutdown"></td>
          <td><input class="rt-ip" type="text" value="${esc(p.l3iface.ip || '')}" placeholder="IP"></td>
          <td><input class="rt-mask" type="text" value="${p.l3iface.maskLen != null ? '/' + p.l3iface.maskLen : ''}" placeholder="/24" size="4"></td>
          <td>${p.link ? esc(p.other().device.name) : '—'}</td>
        </tr>`).join('');
      return `
        <div class="insp-section">
          <div class="sec-title">${t('insp.rt.ifaces')}</div>
          <table class="insp-table" id="rt-ifs">
            <tr><th>IF</th><th>up</th><th>${t('insp.rt.ip')}</th><th>${t('insp.rt.mask')}</th><th>${t('insp.col.peer')}</th></tr>
            ${rows}
          </table>
          <div class="insp-row"><button class="insp-btn primary" id="rt-apply">${t('insp.apply')}</button>
          <span class="insp-note">${t('insp.rt.shutdownNote')}</span></div>
          <div class="insp-note">${t('insp.rt.aclNote')}</div>
        </div>`;
    }
    _wireRouter(dev) {
      const b = this.body;
      b.querySelector('#rt-apply').addEventListener('click', () => {
        b.querySelectorAll('#rt-ifs tr[data-idx]').forEach(tr => {
          const p = dev.ports[Number(tr.dataset.idx)];
          p.adminUp = tr.querySelector('.rt-up').checked;
          const ip = tr.querySelector('.rt-ip').value.trim();
          const maskLen = parseMask(tr.querySelector('.rt-mask').value);
          if (IP.isValid(ip) && maskLen != null) p.l3iface.setIp(ip, maskLen);
          else if (!ip) p.l3iface.clearIp();
        });
        dev.changed();
        this.render(this.sel);
      });
    }

    /* ---------- ACL (router / L3 switch, read-only) ---------- */
    _aclHtml(dev) {
      const lists = [...dev.acls.entries()];
      const ruleRows = lists.length
        ? lists.flatMap(([num, rules]) => rules.length
          ? rules.map(rule => `<tr><td>${num}</td><td>${esc(NetSim.acl.ruleText(rule))}</td></tr>`)
          : [`<tr><td>${num}</td><td>${t('insp.none')}</td></tr>`]).join('')
        : `<tr><td colspan="2">${t('insp.none')}</td></tr>`;
      const ifaces = dev.type === 'l3switch'
        ? [...dev.svis.values()]
        : dev.ports.map(p => p.l3iface);
      const applied = ifaces.filter(i => i.aclIn != null || i.aclOut != null);
      const appliedRows = applied.length
        ? applied.map(i => `<tr><td>${esc(i.name)}</td><td>${i.aclIn == null ? '—' : i.aclIn}</td><td>${i.aclOut == null ? '—' : i.aclOut}</td></tr>`).join('')
        : `<tr><td colspan="3">${t('insp.none')}</td></tr>`;
      return `<div class="insp-section">
        <div class="sec-title">${t('insp.acl.title')}</div>
        <table class="insp-table">
          <tr><th>ACL</th><th>${t('insp.acl.rule')}</th></tr>
          ${ruleRows}
        </table>
        <div class="sec-title" style="margin-top:10px">${t('insp.acl.applied')}</div>
        <table class="insp-table">
          <tr><th>IF</th><th>in</th><th>out</th></tr>
          ${appliedRows}
        </table>
        <div class="insp-note">${t('insp.acl.note')}</div>
      </div>`;
    }

    /* ---------- VXLAN (L3 switch VTEP) ---------- */
    _vxlanHtml(dev) {
      const vx = dev.stack.vxlan;
      if (!vx) {
        return `<div class="insp-section">
          <div class="sec-title">${t('insp.vxlan.title')}</div>
          <div class="insp-note">${t('insp.vxlan.off')}</div>
          <div class="insp-note">${t('insp.vxlan.note')}</div>
        </div>`;
      }
      const source = dev.stack.getIface(vx.sourceInterface);
      const localVtep = source && source.ip ? source.ip : '—';
      return `<div class="insp-section">
        <div class="sec-title">${t('insp.vxlan.title')}</div>
        <table class="insp-table">
          <tr><th>VNI</th><td>${vx.vni}</td></tr>
          <tr><th>VLAN</th><td>${vx.vlanId}</td></tr>
          <tr><th>${t('insp.vxlan.source')}</th><td>${esc(this._ifaceDisplayName(dev, vx.sourceInterface))}</td></tr>
          <tr><th>${t('insp.vxlan.localVtep')}</th><td>${esc(localVtep)}</td></tr>
        </table>
        <div class="insp-note">${t('insp.vxlan.note')}</div>
      </div>`;
    }

    /* ---------- NAT (router) ---------- */
    _natHtml(dev) {
      const nat = dev.stack.nat;
      const roleOpt = (role, v, label) =>
        `<option value="${v}" ${role === v ? 'selected' : ''}>${label}</option>`;
      const ifRows = dev.ports.map((p, idx) => {
        const role = p.l3iface.natRole || '';
        return `<tr data-idx="${idx}">
          <td>${p.shortName}</td>
          <td>${esc(p.l3iface.ip || '—')}</td>
          <td><select class="nat-role">
            ${roleOpt(role, '', '—')}${roleOpt(role, 'inside', 'inside')}${roleOpt(role, 'outside', 'outside')}
          </select></td></tr>`;
      }).join('');
      const staticRows = nat.statics.map((s, i) => `
        <tr data-si="${i}"><td>${s.localIp}</td><td>→ ${s.globalIp}</td>
        <td><button class="insp-btn nat-static-del" title="${t('insp.del.t')}">✕</button></td></tr>`).join('');
      const dyn = nat.dynRules.length
        ? nat.dynRules.map(r => `ACL ${r.aclNum} → ${this._ifaceDisplayName(dev, r.ifname)} <b>overload</b>`).join('<br>')
        : t('insp.nat.dynNone');
      const rows = nat.rows();
      const transRows = rows.length
        ? rows.map(r => {
            const g = r.globalPort != null ? `${r.globalIp}:${r.globalPort}` : r.globalIp;
            const l = r.localPort != null ? `${r.localIp}:${r.localPort}` : r.localIp;
            return `<tr><td>${r.proto}</td><td>${g}</td><td>${l}</td></tr>`;
          }).join('')
        : `<tr><td colspan="3">${t('insp.none')}</td></tr>`;
      return `
        <div class="insp-section">
          <div class="sec-title">${t('insp.nat.ifTitle')}</div>
          <table class="insp-table" id="nat-ifs">
            <tr><th>IF</th><th>IP</th><th>NAT</th></tr>${ifRows}
          </table>
          <div class="sec-title" style="margin-top:10px">${t('insp.nat.staticTitle')}</div>
          <table class="insp-table" id="nat-static">${staticRows}</table>
          <div class="insp-row">
            <input type="text" id="nat-local" placeholder="${t('insp.nat.localPh')}" style="max-width:104px">
            <input type="text" id="nat-global" placeholder="${t('insp.nat.globalPh')}" style="max-width:104px">
            <button class="insp-btn" id="nat-static-add">${t('insp.add')}</button>
          </div>
          <div class="insp-note" id="nat-msg"></div>
          <div class="sec-title" style="margin-top:10px">${t('insp.nat.dynTitle')}</div>
          <div class="insp-note">${dyn}<br>${t('insp.nat.dynNote')}</div>
          <div class="sec-title" style="margin-top:10px">${t('insp.nat.transTitle', rows.length)}</div>
          <table class="insp-table">
            <tr><th>Pro</th><th>Inside global</th><th>Inside local</th></tr>${transRows}
          </table>
        </div>`;
    }
    _wireNat(dev) {
      const b = this.body;
      b.querySelectorAll('#nat-ifs tr[data-idx]').forEach(tr => {
        const p = dev.ports[Number(tr.dataset.idx)];
        tr.querySelector('.nat-role').addEventListener('change', (e) => {
          p.l3iface.natRole = e.target.value || null;
          dev.changed();
        });
      });
      b.querySelector('#nat-static-add').addEventListener('click', () => {
        const msg = b.querySelector('#nat-msg');
        const local = b.querySelector('#nat-local').value.trim();
        const global = b.querySelector('#nat-global').value.trim();
        if (!IP.isValid(local) || !IP.isValid(global)) { msg.textContent = t('insp.nat.badIp'); return; }
        dev.stack.nat.addStatic(local, global);
        dev.changed();
        this.render(this.sel);
      });
      b.querySelectorAll('#nat-static .nat-static-del').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const i = Number(e.target.closest('tr').dataset.si);
          const s = dev.stack.nat.statics[i];
          if (s) dev.stack.nat.removeStatic(s.localIp, s.globalIp);
          dev.changed();
          this.render(this.sel);
        });
      });
    }

    /* ---------- static routes (router / L3 switch) ---------- */
    _routesHtml(dev) {
      const rows = dev.stack.staticRoutes.map((r, i) => `
        <tr data-ri="${i}">
          <td>${r.network}/${r.len}</td><td>via ${r.nexthop}</td>
          <td><button class="insp-btn route-del">✕</button></td>
        </tr>`).join('');
      return `
        <div class="insp-section">
          <div class="sec-title">${t('insp.route.title')}</div>
          <table class="insp-table" id="route-table">
            ${rows || ''}
          </table>
          <div class="insp-row">
            <input type="text" id="route-net" placeholder="0.0.0.0/0" style="max-width:110px">
            <input type="text" id="route-nh" placeholder="${t('insp.route.nhPh')}">
            <button class="insp-btn" id="route-add">${t('insp.add')}</button>
          </div>
          <div class="insp-note" id="route-msg"></div>
        </div>`;
    }
    _wireRoutes(dev) {
      const b = this.body;
      b.querySelector('#route-add').addEventListener('click', () => {
        const msg = b.querySelector('#route-msg');
        const netSpec = b.querySelector('#route-net').value.trim();
        const nh = b.querySelector('#route-nh').value.trim();
        const m = netSpec.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/);
        if (!m || !IP.isValid(m[1]) || Number(m[2]) > 32) { msg.textContent = t('insp.route.badNet'); return; }
        if (!IP.isValid(nh)) { msg.textContent = t('insp.route.badNh'); return; }
        dev.stack.addStaticRoute(m[1], Number(m[2]), nh);
        dev.changed();
        this.render(this.sel);
      });
      b.querySelectorAll('#route-table .route-del').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const i = Number(e.target.closest('tr').dataset.ri);
          const r = dev.stack.staticRoutes[i];
          if (r) dev.stack.removeStaticRoute(r.network, r.len, r.nexthop);
          dev.changed();
          this.render(this.sel);
        });
      });
    }
  }

  NetSim.ui.Inspector = Inspector;
})(typeof window !== 'undefined' ? window : globalThis);
