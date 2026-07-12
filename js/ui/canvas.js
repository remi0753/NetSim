/* NetSim UI: SVG topology canvas — placement, wiring, drag, pan/zoom, groups,
 * multi-select, auto-layout. Packet animation is drawn on a 2D canvas overlay
 * so hundreds of in-flight frames stay cheap. */
(function (root) {
  const NetSim = root.NetSim;
  NetSim.ui = NetSim.ui || {};
  const t = (k, ...a) => NetSim.t(k, ...a);
  const SVGNS = 'http://www.w3.org/2000/svg';

  const DEV_STYLE = {
    pc:       { glyph: 'PC',  color: '#38bdf8' },
    server:   { glyph: 'SV',  color: '#4ade80' },
    hub:      { glyph: 'HUB', color: '#94a3b8' },
    switch:   { glyph: 'SW',  color: '#facc15' },
    l3switch: { glyph: 'L3',  color: '#c084fc' },
    router:   { glyph: 'RT',  color: '#fb923c' },
    lb:       { glyph: 'LB',  color: '#2dd4bf' },
  };
  const PROTO_COLOR = {
    arp: '#f5c542', icmp: '#4ade80', tcp: '#60a5fa',
    udp: '#c084fc', ctrl: '#ec4899', other: '#94a3b8',
  };
  const DEV_W = 84, DEV_H = 54;
  const GRP_W = 132, GRP_H = 76;
  const MAX_DOTS_PER_LINK = 6;

  function svgEl(tag, attrs, parent) {
    const el = document.createElementNS(SVGNS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(el);
    return el;
  }

  class CanvasView {
    constructor(app) {
      this.app = app;
      this.sim = app.sim;
      this.net = app.net;
      this.svg = document.getElementById('canvas');
      this.gGroups = document.getElementById('ggroups');
      this.gLinks = document.getElementById('glinks');
      this.gDevices = document.getElementById('gdevices');
      this.gCable = document.getElementById('gcable');
      this.gMarquee = document.getElementById('gmarquee');
      this.viewport = document.getElementById('viewport');
      this.portMenu = document.getElementById('port-menu');
      this.hintEl = document.getElementById('canvas-hint');
      this.pktCanvas = document.getElementById('pkt-canvas');
      this.pktCtx = this.pktCanvas.getContext('2d');

      this.mode = 'select';
      this.view = { x: 0, y: 0, scale: 1 };
      this.selection = null;          // {device}|{link}|{group}|{devices:[...]}
      this.placing = null;
      this.cableFrom = null;
      this._drag = null;
      this._devEls = new Map();
      this._linkEls = new Map();
      this._grpEls = new Map();

      this._buildPalette();
      this._bindPlacementDialog();
      this._bind();
      this.net.on('topology', () => this.render());
      this.net.on('changed', () => this.render());
      this._applyView();
      this.setMode('select');
    }

    /* ---------------- palette ---------------- */
    _buildPalette() {
      const pal = document.getElementById('palette');
      // keep only the palette title, then (re)build the items
      pal.querySelectorAll('.pal-item').forEach(el => el.remove());
      for (const type in NetSim.deviceTypes) {
        const st = DEV_STYLE[type];
        const item = document.createElement('div');
        item.className = 'pal-item';
        item.dataset.type = type;
        item.innerHTML =
          `<svg class="pal-icon" width="46" height="30" viewBox="0 0 46 30">
             <rect x="1.5" y="1.5" width="43" height="27" rx="6" fill="var(--bg2)" stroke="${st.color}" stroke-width="2"/>
             <text x="23" y="20" text-anchor="middle" fill="${st.color}" font-size="12" font-weight="700">${st.glyph}</text>
           </svg>
           <span class="pal-name">${NetSim.deviceLabel(type)}</span>`;
        item.addEventListener('click', () => {
          if (this.placing === type) this.cancelPlacing();
          else this.startPlacing(type);
        });
        // drag & drop placement (clicking also works)
        item.draggable = true;
        item.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('application/x-netsim-device', type);
          e.dataTransfer.effectAllowed = 'copy';
        });
        pal.appendChild(item);
      }

      // dropping a palette item on the canvas places the device there
      // (bind once; _buildPalette re-runs on language change)
      if (this._paletteDropBound) return;
      this._paletteDropBound = true;
      const wrap = document.getElementById('canvas-wrap');
      wrap.addEventListener('dragover', (e) => {
        if ([...e.dataTransfer.types].includes('application/x-netsim-device')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      });
      wrap.addEventListener('drop', (e) => {
        e.preventDefault();
        const type = e.dataTransfer.getData('application/x-netsim-device');
        if (!type || !NetSim.deviceTypes[type]) return;
        const w = this.toWorld(e.clientX, e.clientY);
        this._placeDevice(type, Math.round(w.x), Math.round(w.y), {
          afterPlace: (dev) => this.app.select({ device: dev }),
        });
      });
    }
    startPlacing(type) {
      this.cancelCable();
      this.placing = type;
      this.setMode('select', true);
      document.querySelectorAll('.pal-item').forEach(el =>
        el.classList.toggle('armed', el.dataset.type === type));
      this.svg.classList.add('placing');
      this.hint(t('cv.place', NetSim.deviceLabel(type)));
    }
    cancelPlacing() {
      this.placing = null;
      document.querySelectorAll('.pal-item').forEach(el => el.classList.remove('armed'));
      this.svg.classList.remove('placing');
      this._ghost && this._ghost.remove();
      this._ghost = null;
      this.hint('');
    }

    /* ---------------- modes ---------------- */
    setMode(mode, keepPlacing) {
      this.mode = mode;
      if (!keepPlacing) this.cancelPlacing();
      if (mode !== 'cable') this.cancelCable();
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      const btn = document.getElementById('mode-' + mode);
      if (btn) btn.classList.add('active');
      this.svg.classList.toggle('mode-cable', mode === 'cable');
      this.svg.classList.toggle('mode-delete', mode === 'delete');
      if (mode === 'cable') this.hint(t('cv.cable.start'));
      else if (mode === 'delete') this.hint(t('cv.delete.hint'));
      else if (!this.placing) this.hint('');
    }
    cancelCable() {
      this.cableFrom = null;
      this.hidePortMenu();
      this.gCable.innerHTML = '';
      if (this.mode === 'cable') this.hint(t('cv.cable.start'));
    }
    hint(msg) { this.hintEl.textContent = msg; }

    /* re-render language-dependent chrome (palette labels, mode hint, device sublabels) */
    refreshI18n() {
      this._buildPalette();
      this.render();
      if (this.mode === 'cable') this.hint(t('cv.cable.start'));
      else if (this.mode === 'delete') this.hint(t('cv.delete.hint'));
    }

    /* ---------------- coordinates / view ---------------- */
    toWorld(clientX, clientY) {
      const r = this.svg.getBoundingClientRect();
      return {
        x: (clientX - r.left - this.view.x) / this.view.scale,
        y: (clientY - r.top - this.view.y) / this.view.scale,
      };
    }
    _applyView() {
      this.viewport.setAttribute('transform',
        `translate(${this.view.x} ${this.view.y}) scale(${this.view.scale})`);
      // keep the CSS grid in sync with pan/zoom
      const wrap = this._wrapEl || (this._wrapEl = document.getElementById('canvas-wrap'));
      const s = 24 * this.view.scale;
      wrap.style.backgroundSize = `${s}px ${s}px`;
      wrap.style.backgroundPosition = `${this.view.x}px ${this.view.y}px`;
    }
    /* effective position: collapsed group members sit on the group box */
    devicePos(dev) {
      const g = this.net.groupOf(dev);
      if (g && g.collapsed) return { x: g.x, y: g.y };
      return { x: dev.x, y: dev.y };
    }
    isHidden(dev) {
      const g = this.net.groupOf(dev);
      return !!(g && g.collapsed);
    }

    centerOn(x, y, scale) {
      const r = this.svg.getBoundingClientRect();
      if (scale) this.view.scale = scale;
      this.view.x = r.width / 2 - x * this.view.scale;
      this.view.y = r.height / 2 - y * this.view.scale;
      this._applyView();
    }
    fitAll() {
      const pts = [];
      for (const d of this.net.devices) {
        if (!this.isHidden(d)) pts.push({ x: d.x, y: d.y });
      }
      for (const g of this.net.groups) {
        if (g.collapsed) pts.push({ x: g.x, y: g.y });
      }
      if (!pts.length) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of pts) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
      const r = this.svg.getBoundingClientRect();
      const bw = maxX - minX + 260, bh = maxY - minY + 220;
      const scale = Math.min(1.4, Math.max(0.15, Math.min(r.width / bw, r.height / bh)));
      this.view.scale = scale;
      this.centerOn((minX + maxX) / 2, (minY + maxY) / 2);
    }

    /* tiered auto-layout with one barycenter ordering pass */
    autoLayout() {
      const tierOf = (d) => ({ router: 0, l3switch: 1, lb: 2, switch: 2, hub: 2, server: 3, pc: 3 }[d.type] ?? 3);
      const tiers = new Map();
      for (const d of this.net.devices) {
        const t = tierOf(d);
        if (!tiers.has(t)) tiers.set(t, []);
        tiers.get(t).push(d);
      }
      const neighborXs = (d) => d.ports
        .filter(p => p.link)
        .map(p => p.other().device.x);
      for (const [t, devs] of [...tiers.entries()].sort((a, b) => a[0] - b[0])) {
        devs.sort((a, b) => {
          const ax = neighborXs(a), bx = neighborXs(b);
          const am = ax.length ? ax.reduce((s, v) => s + v, 0) / ax.length : a.x;
          const bm = bx.length ? bx.reduce((s, v) => s + v, 0) / bx.length : b.x;
          return am - bm;
        });
        const gap = devs.length > 12 ? 105 : 150;
        const width = (devs.length - 1) * gap;
        devs.forEach((d, i) => {
          d.x = Math.round(600 - width / 2 + i * gap);
          d.y = 110 + t * 180;
        });
      }
      // recompute collapsed group anchors from their members
      for (const g of this.net.groups) {
        const members = this.net.groupMembers(g);
        if (!members.length) continue;
        g.x = Math.round(members.reduce((s, d) => s + d.x, 0) / members.length);
        g.y = Math.round(members.reduce((s, d) => s + d.y, 0) / members.length);
        for (const d of members) g.offsets[d.id] = { dx: d.x - g.x, dy: d.y - g.y };
      }
      this.render();
      this.fitAll();
    }

    /* ---------------- events ---------------- */
    _bind() {
      const svg = this.svg;

      svg.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const devEl = e.target.closest('.dev-box');
        const linkEl = e.target.closest('.link-g');
        const grpEl = e.target.closest('.group-box');
        const hullEl = e.target.closest('.group-hull-label');

        if (this.placing) {
          const w = this.toWorld(e.clientX, e.clientY);
          const type = this.placing;
          const keepPlacing = e.shiftKey;
          this._placeDevice(type, Math.round(w.x), Math.round(w.y), {
            afterPlace: (dev) => {
              this.app.select({ device: dev });
              if (!keepPlacing) this.cancelPlacing();
            },
          });
          return;
        }

        if (grpEl || hullEl) {
          const gid = (grpEl || hullEl).dataset.gid;
          const g = this.net.groups.find(x => x.id === gid);
          if (!g) return;
          if (this.mode === 'delete') { this.net.removeGroup(g); this.app.select(null); return; }
          if (this._isDoubleClick('grp:' + g.id)) {
            // double-click expands a collapsed rack
            if (g.collapsed) this.net.setCollapsed(g, false);
            this.app.select({ group: g });
            return;
          }
          this.app.select({ group: g });
          if (g.collapsed) {
            const w = this.toWorld(e.clientX, e.clientY);
            this._drag = { kind: 'group', g, dx: w.x - g.x, dy: w.y - g.y };
            svg.setPointerCapture(e.pointerId);
          }
          return;
        }

        if (devEl) {
          const dev = this.net.devices.find(d => d.id === devEl.dataset.id);
          if (!dev) return;
          if (this.mode === 'delete') { this.app.deleteDevice(dev); return; }
          if (this.mode === 'cable') { this._cableClick(dev, e); return; }
          if (!e.shiftKey && this._isDoubleClick('dev:' + dev.id)) {
            // manual double-click detection: pointer capture during drag-select
            // swallows the browser's synthesized dblclick event
            this.app.openConsole(dev);
            return;
          }
          if (e.shiftKey) {
            // toggle in multi-selection
            const cur = this.selection && this.selection.devices ? this.selection.devices.slice()
              : (this.selection && this.selection.device ? [this.selection.device] : []);
            const i = cur.indexOf(dev);
            if (i >= 0) cur.splice(i, 1); else cur.push(dev);
            this.app.select(cur.length === 0 ? null : (cur.length === 1 ? { device: cur[0] } : { devices: cur }));
            return;
          }
          // drag a whole multi-selection if the grabbed device is part of it
          if (this.selection && this.selection.devices && this.selection.devices.includes(dev)) {
            const w = this.toWorld(e.clientX, e.clientY);
            this._drag = {
              kind: 'multi', devs: this.selection.devices,
              start: this.selection.devices.map(d => ({ d, x: d.x, y: d.y })),
              sx: w.x, sy: w.y,
            };
            svg.setPointerCapture(e.pointerId);
            return;
          }
          this.app.select({ device: dev });
          const w = this.toWorld(e.clientX, e.clientY);
          this._drag = { kind: 'device', dev, dx: w.x - dev.x, dy: w.y - dev.y };
          svg.setPointerCapture(e.pointerId);
          return;
        }
        if (linkEl) {
          const link = this.net.links.find(l => l.id === linkEl.dataset.id);
          if (!link) return;
          if (this.mode === 'delete') { this.net.removeLink(link); this.app.select(null); return; }
          if (this.mode === 'cable') return;
          this.app.select({ link });
          return;
        }
        // empty space
        this.hidePortMenu();
        if (this.mode === 'select') {
          if (e.shiftKey) {
            const w = this.toWorld(e.clientX, e.clientY);
            this._drag = { kind: 'marquee', x0: w.x, y0: w.y, x1: w.x, y1: w.y };
            svg.setPointerCapture(e.pointerId);
            return;
          }
          this.app.select(null);
          this._drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: this.view.x, vy: this.view.y };
          svg.setPointerCapture(e.pointerId);
        }
      });

      svg.addEventListener('pointermove', (e) => {
        if (this.placing) this._moveGhost(e);
        if (this.cableFrom) this._moveCablePreview(e);
        if (!this._drag) return;
        const d = this._drag;
        if (d.kind === 'device') {
          const w = this.toWorld(e.clientX, e.clientY);
          d.dev.x = Math.round(w.x - d.dx);
          d.dev.y = Math.round(w.y - d.dy);
          this._updateDevicePos(d.dev);
        } else if (d.kind === 'multi') {
          const w = this.toWorld(e.clientX, e.clientY);
          for (const s of d.start) {
            s.d.x = Math.round(s.x + (w.x - d.sx));
            s.d.y = Math.round(s.y + (w.y - d.sy));
          }
          for (const s of d.start) this._updateDevicePos(s.d);
        } else if (d.kind === 'group') {
          const w = this.toWorld(e.clientX, e.clientY);
          d.g.x = Math.round(w.x - d.dx);
          d.g.y = Math.round(w.y - d.dy);
          this._updateGroupPos(d.g);
        } else if (d.kind === 'pan') {
          this.view.x = d.vx + (e.clientX - d.sx);
          this.view.y = d.vy + (e.clientY - d.sy);
          this._applyView();
        } else if (d.kind === 'marquee') {
          const w = this.toWorld(e.clientX, e.clientY);
          d.x1 = w.x; d.y1 = w.y;
          this._drawMarquee(d);
        }
      });

      svg.addEventListener('pointerup', (e) => {
        if (!this._drag) return;
        const d = this._drag;
        try { svg.releasePointerCapture(e.pointerId); } catch (_) {}
        this._drag = null;
        if (d.kind === 'marquee') {
          this.gMarquee.innerHTML = '';
          const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1);
          const y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
          const hit = this.net.devices.filter(dev => !this.isHidden(dev) &&
            dev.x >= x0 && dev.x <= x1 && dev.y >= y0 && dev.y <= y1);
          if (hit.length === 0) this.app.select(null);
          else if (hit.length === 1) this.app.select({ device: hit[0] });
          else this.app.select({ devices: hit });
        }
      });

      svg.addEventListener('dblclick', (e) => {
        const grpEl = e.target.closest('.group-box');
        if (grpEl) {
          const g = this.net.groups.find(x => x.id === grpEl.dataset.gid);
          if (g) this.net.setCollapsed(g, false);
          return;
        }
        const devEl = e.target.closest('.dev-box');
        if (!devEl) return;
        const dev = this.net.devices.find(d => d.id === devEl.dataset.id);
        if (dev) this.app.openConsole(dev);
      });

      svg.addEventListener('wheel', (e) => {
        e.preventDefault();
        const factor = Math.exp(-e.deltaY * 0.0012);
        const ns = Math.min(2.5, Math.max(0.12, this.view.scale * factor));
        const r = svg.getBoundingClientRect();
        const mx = e.clientX - r.left, my = e.clientY - r.top;
        const wx = (mx - this.view.x) / this.view.scale;
        const wy = (my - this.view.y) / this.view.scale;
        this.view.scale = ns;
        this.view.x = mx - wx * ns;
        this.view.y = my - wy * ns;
        this._applyView();
      }, { passive: false });

      window.addEventListener('keydown', (e) => {
        const tag = document.activeElement && document.activeElement.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (e.key === 'Escape') {
          this.cancelPlacing();
          this.cancelCable();
          this.setMode('select');
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
          const s = this.selection;
          if (!s) return;
          if (s.device) this.app.deleteDevice(s.device);
          else if (s.devices) { for (const d of s.devices.slice()) this.app.deleteDevice(d); }
          else if (s.link) { this.net.removeLink(s.link); this.app.select(null); }
          else if (s.group) { this.net.removeGroup(s.group); this.app.select(null); }
        } else if (e.key === 'c' || e.key === 'C') this.setMode('cable');
        else if (e.key === 'd' || e.key === 'D') this.setMode('delete');
        else if (e.key === 'f' || e.key === 'F') this.fitAll();
        else if (e.key === ' ') { e.preventDefault(); this.app.toggleRun(); }
      });
    }

    /* two pointerdowns on the same object within 450ms = double click */
    _isDoubleClick(key) {
      const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
      const hit = !!(this._lastClick && this._lastClick.key === key && now - this._lastClick.t < 450);
      this._lastClick = hit ? null : { key, t: now };
      return hit;
    }

    _drawMarquee(d) {
      this.gMarquee.innerHTML = '';
      svgEl('rect', {
        class: 'marquee',
        x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1),
        width: Math.abs(d.x1 - d.x0), height: Math.abs(d.y1 - d.y0),
      }, this.gMarquee);
    }

    _moveGhost(e) {
      const w = this.toWorld(e.clientX, e.clientY);
      if (!this._ghost) {
        const st = DEV_STYLE[this.placing];
        this._ghost = svgEl('g', { opacity: 0.5 }, this.viewport);
        svgEl('rect', {
          x: -DEV_W / 2, y: -DEV_H / 2, width: DEV_W, height: DEV_H, rx: 10,
          fill: 'var(--bg3)', stroke: st.color, 'stroke-width': 2, 'stroke-dasharray': '6 4',
        }, this._ghost);
      }
      this._ghost.setAttribute('transform', `translate(${w.x} ${w.y})`);
    }

    _bindPlacementDialog() {
      this.placeModal = document.getElementById('placement-modal');
      if (!this.placeModal) return;
      this.placeTitle = document.getElementById('place-title');
      this.placeDesc = document.getElementById('place-desc');
      this.placeInput = document.getElementById('place-port-count');
      this.placeRange = document.getElementById('place-range');
      this.placeError = document.getElementById('place-error');
      document.getElementById('place-cancel').addEventListener('click', () => this._closePlacementDialog(false));
      this.placeModal.addEventListener('click', (e) => {
        if (e.target === this.placeModal) this._closePlacementDialog(false);
      });
      this.placeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this._confirmPlacementDialog();
        else if (e.key === 'Escape') this._closePlacementDialog(false);
      });
      document.getElementById('place-create').addEventListener('click', () => this._confirmPlacementDialog());
    }

    _placeDevice(type, x, y, opts) {
      const range = NetSim.portRangeFor(type);
      if (!range) {
        const dev = this.net.addDevice(type, x, y);
        if (opts && opts.afterPlace) opts.afterPlace(dev);
        return dev;
      }
      this._openPlacementDialog(type, x, y, range, opts && opts.afterPlace);
      return null;
    }

    _openPlacementDialog(type, x, y, range, afterPlace) {
      if (!this.placeModal) return;
      const label = NetSim.deviceLabel(type);
      this._pendingPlacement = { type, x, y, range, afterPlace };
      this.placeTitle.textContent = t('place.title', label);
      this.placeDesc.textContent = t('place.desc');
      this.placeInput.min = String(range.min);
      this.placeInput.max = String(range.max);
      this.placeInput.value = String(range.def);
      this.placeRange.textContent = t('place.range', range.min, range.max, range.def);
      this.placeError.textContent = '';
      this.placeModal.hidden = false;
      this.placeInput.focus();
      this.placeInput.select();
    }

    _confirmPlacementDialog() {
      const p = this._pendingPlacement;
      if (!p) return;
      const raw = Number(this.placeInput.value);
      if (!Number.isInteger(raw) || raw < p.range.min || raw > p.range.max) {
        this.placeError.textContent = t('place.badCount', p.range.min, p.range.max);
        return;
      }
      const dev = this.net.addDevice(p.type, p.x, p.y, undefined, { portCount: raw });
      const afterPlace = p.afterPlace;
      this._closePlacementDialog(true);
      if (afterPlace) afterPlace(dev);
    }

    _closePlacementDialog(accepted) {
      if (this.placeModal) this.placeModal.hidden = true;
      this._pendingPlacement = null;
      if (!accepted) this.placeError && (this.placeError.textContent = '');
    }

    /* ---------------- cabling ---------------- */
    _cableClick(dev, e) {
      if (this.cableFrom && this.cableFrom.device === dev) {
        this.hint(t('cv.cable.sameDev'));
        return;
      }
      this.showPortMenu(dev, e.clientX, e.clientY, (port) => {
        if (!this.cableFrom) {
          this.cableFrom = { device: dev, port };
          this.hint(t('cv.cable.from', dev.name, port.shortName));
        } else {
          try {
            this.net.connect(this.cableFrom.device, this.cableFrom.port, dev, port);
            this.hint(t('cv.cable.connected', this.cableFrom.device.name, this.cableFrom.port.shortName, dev.name, port.shortName));
          } catch (err) {
            this.hint(t('cv.cable.failed', err.message));
          }
          this.cableFrom = null;
          this.gCable.innerHTML = '';
        }
      });
    }
    _moveCablePreview(e) {
      const w = this.toWorld(e.clientX, e.clientY);
      this.gCable.innerHTML = '';
      const from = this.devicePos(this.cableFrom.device);
      svgEl('line', {
        x1: from.x, y1: from.y, x2: w.x, y2: w.y, class: 'cable-preview',
      }, this.gCable);
    }

    showPortMenu(dev, clientX, clientY, onPick) {
      const menu = this.portMenu;
      menu.innerHTML = `<div class="pm-title">${t('cv.portMenu.title', dev.name)}</div>`;
      for (const p of dev.ports) {
        const item = document.createElement('div');
        const used = !!p.link;
        item.className = 'pm-item' + (used ? ' used' : '');
        const peer = used ? `→ ${p.other().device.name}` : (p.adminUp ? '' : 'shutdown');
        item.innerHTML = `<span>${p.shortName}</span><span class="pm-peer">${used ? peer : t('cv.portMenu.free') + ' ' + peer}</span>`;
        if (!used) {
          item.addEventListener('click', () => { this.hidePortMenu(); onPick(p); });
        }
        menu.appendChild(item);
      }
      const wrap = document.getElementById('canvas-wrap').getBoundingClientRect();
      menu.hidden = false;
      const mw = menu.offsetWidth, mh = menu.offsetHeight;
      let px = clientX - wrap.left + 12, py = clientY - wrap.top + 12;
      if (px + mw > wrap.width) px = wrap.width - mw - 8;
      if (py + mh > wrap.height) py = wrap.height - mh - 8;
      menu.style.left = px + 'px';
      menu.style.top = py + 'px';
    }
    hidePortMenu() { this.portMenu.hidden = true; }

    /* ---------------- rendering ---------------- */
    render() {
      this._devEls.clear();
      this._linkEls.clear();
      this._grpEls.clear();
      this.gGroups.innerHTML = '';
      this.gLinks.innerHTML = '';
      this.gDevices.innerHTML = '';
      for (const g of this.net.groups) this._renderGroup(g);
      for (const link of this.net.links) this._renderLink(link);
      for (const dev of this.net.devices) {
        if (!this.isHidden(dev)) this._renderDevice(dev);
      }
      this._refreshSelection();
    }

    _renderGroup(g) {
      const members = this.net.groupMembers(g);
      if (g.collapsed) {
        const el = svgEl('g', { class: 'group-box', transform: `translate(${g.x} ${g.y})` }, this.gGroups);
        el.dataset.gid = g.id;
        svgEl('rect', {
          class: 'group-rect', x: -GRP_W / 2, y: -GRP_H / 2, width: GRP_W, height: GRP_H, rx: 10,
        }, el);
        // small rack slots motif
        for (let i = 0; i < 3; i++) {
          svgEl('rect', {
            x: -GRP_W / 2 + 10, y: -GRP_H / 2 + 12 + i * 9, width: GRP_W - 20, height: 5,
            rx: 1.5, fill: '#2a3854',
          }, el);
        }
        const name = svgEl('text', { class: 'group-name', x: 0, y: GRP_H / 2 - 18 }, el);
        name.textContent = g.name;
        const cnt = svgEl('text', { class: 'group-count', x: 0, y: GRP_H / 2 - 5 }, el);
        cnt.textContent = t('cv.group.count', members.length);
        this._grpEls.set(g.id, el);
      } else if (members.length) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const d of members) {
          minX = Math.min(minX, d.x); maxX = Math.max(maxX, d.x);
          minY = Math.min(minY, d.y); maxY = Math.max(maxY, d.y);
        }
        const pad = 62;
        const hull = svgEl('g', {}, this.gGroups);
        svgEl('rect', {
          class: 'group-hull', x: minX - pad, y: minY - pad,
          width: maxX - minX + pad * 2, height: maxY - minY + pad * 2, rx: 14,
        }, hull);
        const lbl = svgEl('text', {
          class: 'group-hull-label', x: minX - pad + 10, y: minY - pad + 16,
        }, hull);
        lbl.textContent = t('cv.group.select', g.name);
        lbl.classList.add('group-hull-label');
        lbl.dataset.gid = g.id;
      }
    }

    _renderDevice(dev) {
      const st = DEV_STYLE[dev.type] || DEV_STYLE.pc;
      const g = svgEl('g', { class: 'dev-box', transform: `translate(${dev.x} ${dev.y})` }, this.gDevices);
      g.dataset.id = dev.id;
      svgEl('rect', {
        class: 'dev-rect', x: -DEV_W / 2, y: -DEV_H / 2, width: DEV_W, height: DEV_H, rx: 10,
        stroke: st.color,
      }, g);
      const glyph = svgEl('text', { class: 'dev-glyph', x: 0, y: 0, fill: st.color }, g);
      glyph.textContent = st.glyph;
      const upCount = dev.ports.filter(p => p.isUp()).length;
      const total = dev.ports.filter(p => p.link).length;
      const led = svgEl('text', { class: 'dev-sub', x: 0, y: 16 }, g);
      led.textContent = total ? `${upCount}/${total} link` : 'no link';
      const name = svgEl('text', { class: 'dev-name', x: 0, y: DEV_H / 2 + 15 }, g);
      name.textContent = dev.name;
      const sub = svgEl('text', { class: 'dev-sub', x: 0, y: DEV_H / 2 + 28 }, g);
      sub.textContent = this._subLabel(dev);
      this._devEls.set(dev.id, g);
    }
    _subLabel(dev) {
      if (dev.type === 'lb') {
        const s = dev.iface.ip ? `${dev.iface.ip}` : t('cv.sub.noIp');
        return dev.lbPort != null ? `${s} :${dev.lbPort} → ${dev.backends.length}` : s;
      }
      if (dev.type === 'pc' || dev.type === 'server') {
        const s = dev.iface.ip ? `${dev.iface.ip}/${dev.iface.maskLen}` : (dev.dhcpMode ? t('cv.sub.dhcpWait') : t('cv.sub.noIp'));
        return dev.httpServer ? s + ' [http]' : (dev.dhcpMode && dev.iface.ip ? s + ' [dhcp]' : s);
      }
      if (dev.type === 'router' || dev.type === 'l3switch') {
        const ips = dev.stack.ifaces.filter(i => i.ip).length;
        const ospf = dev.ospf && dev.ospf.enabled ? ' OSPF' : '';
        return (ips ? `${ips} L3 if` : '') + ospf;
      }
      if (dev.type === 'switch') {
        const vl = dev.vlans.size;
        return vl > 1 ? `${vl} VLANs` : '';
      }
      return '';
    }

    _renderLink(link) {
      const pa = this.devicePos(link.a.device);
      const pb = this.devicePos(link.b.device);
      if (pa.x === pb.x && pa.y === pb.y) return;   // both inside same collapsed rack
      const g = svgEl('g', { class: 'link-g' }, this.gLinks);
      g.dataset.id = link.id;
      const hit = svgEl('line', { class: 'link-hit' }, g);
      const line = svgEl('line', { class: 'link-line' }, g);
      const la = svgEl('text', { class: 'port-label' }, g);
      const lb = svgEl('text', { class: 'port-label' }, g);
      const dense = this.net.devices.length > 40;
      la.textContent = dense ? '' : link.a.shortName;
      lb.textContent = dense ? '' : link.b.shortName;
      this._linkEls.set(link.id, { g, hit, line, la, lb });
      this._updateLinkPos(link);
    }

    _updateLinkPos(link) {
      const els = this._linkEls.get(link.id);
      if (!els) return;
      const A = this.devicePos(link.a.device), B = this.devicePos(link.b.device);
      const dx = B.x - A.x, dy = B.y - A.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const m = 40;
      const x1 = A.x + ux * m, y1 = A.y + uy * m;
      const x2 = B.x - ux * m, y2 = B.y - uy * m;
      for (const l of [els.hit, els.line]) {
        l.setAttribute('x1', x1); l.setAttribute('y1', y1);
        l.setAttribute('x2', x2); l.setAttribute('y2', y2);
      }
      els.line.setAttribute('class', 'link-line ' + (link.isUp() ? 'up' : 'down') +
        (this.selection && this.selection.link === link ? ' selected' : ''));
      const px = -uy * 10, py = ux * 10;
      els.la.setAttribute('x', A.x + ux * (m + 14) + px);
      els.la.setAttribute('y', A.y + uy * (m + 14) + py);
      els.lb.setAttribute('x', B.x - ux * (m + 14) + px);
      els.lb.setAttribute('y', B.y - uy * (m + 14) + py);
    }

    _updateDevicePos(dev) {
      const g = this._devEls.get(dev.id);
      if (g) g.setAttribute('transform', `translate(${dev.x} ${dev.y})`);
      for (const link of this.net.links) {
        if (link.a.device === dev || link.b.device === dev) this._updateLinkPos(link);
      }
    }
    _updateGroupPos(g) {
      const el = this._grpEls.get(g.id);
      if (el) el.setAttribute('transform', `translate(${g.x} ${g.y})`);
      const ids = new Set(g.devIds);
      for (const link of this.net.links) {
        if (ids.has(link.a.device.id) || ids.has(link.b.device.id)) this._updateLinkPos(link);
      }
    }

    _refreshSelection() {
      const sel = this.selection;
      const selIds = new Set();
      if (sel) {
        if (sel.device) selIds.add(sel.device.id);
        if (sel.devices) for (const d of sel.devices) selIds.add(d.id);
      }
      for (const [id, g] of this._devEls) g.classList.toggle('selected', selIds.has(id));
      for (const [gid, el] of this._grpEls) {
        el.classList.toggle('selected', !!(sel && sel.group && sel.group.id === gid));
      }
      for (const link of this.net.links) this._updateLinkPos(link);
    }
    setSelection(sel) {
      this.selection = sel;
      this._refreshSelection();
    }

    /* per-animation-frame: packet dots on the 2D canvas overlay */
    renderPackets() {
      const cv = this.pktCanvas, ctx = this.pktCtx;
      const dpr = window.devicePixelRatio || 1;
      const w = cv.clientWidth, h = cv.clientHeight;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cv.width, cv.height);
      const txs = this.sim.transmissions;
      if (!txs.length) return;
      ctx.setTransform(this.view.scale * dpr, 0, 0, this.view.scale * dpr,
        this.view.x * dpr, this.view.y * dpr);
      const now = this.sim.time;
      const perLink = new Map();
      const overflow = new Map();   // linkId -> {x, y, n}
      for (const tx of txs) {
        const link = tx.link;
        const from = this.devicePos(tx.fromPort.device);
        const to = this.devicePos(link.other(tx.fromPort).device);
        if (from.x === to.x && from.y === to.y) continue;
        const n = perLink.get(link.id) || 0;
        perLink.set(link.id, n + 1);
        if (n >= MAX_DOTS_PER_LINK) {
          const o = overflow.get(link.id) || { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, n: 0 };
          o.n++;
          overflow.set(link.id, o);
          continue;
        }
        const p = Math.min(1, Math.max(0, (now - tx.tStart) / (tx.tEnd - tx.tStart)));
        const dx = to.x - from.x, dy = to.y - from.y;
        const len = Math.hypot(dx, dy) || 1;
        const off = (n % 2 === 0 ? 1 : -1) * Math.ceil(n / 2) * 7;
        const x = from.x + dx * p + (-dy / len) * off;
        const y = from.y + dy * p + (dx / len) * off;
        ctx.beginPath();
        ctx.arc(x, y, 6.5, 0, Math.PI * 2);
        ctx.fillStyle = PROTO_COLOR[NetSim.decode.protoKey(tx.frame)] || PROTO_COLOR.other;
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,.45)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      // "+N" markers where a link carries more than the dot budget
      if (overflow.size) {
        ctx.font = 'bold 11px monospace';
        ctx.textAlign = 'center';
        for (const o of overflow.values()) {
          ctx.fillStyle = 'rgba(16,20,28,.8)';
          ctx.fillRect(o.x - 16, o.y - 9, 32, 15);
          ctx.fillStyle = '#e2e8f0';
          ctx.fillText(`+${o.n}`, o.x, o.y + 3);
        }
      }
    }
  }

  NetSim.ui.CanvasView = CanvasView;
})(typeof window !== 'undefined' ? window : globalThis);
