/* NetSim UI: packet capture log with layer-by-layer decode */
(function (root) {
  const NetSim = root.NetSim;
  NetSim.ui = NetSim.ui || {};

  const MAX_ROWS = 500;

  class PacketLog {
    constructor(app) {
      this.app = app;
      this.rowsEl = document.getElementById('pl-rows');
      this.filterEl = document.getElementById('pl-filter');
      this.protocolFilterEls = [...document.querySelectorAll('[data-protocol-filter]')];
      this.protocolSummaryEl = document.getElementById('pl-protocol-summary');
      this.autoScrollEl = document.getElementById('pl-autoscroll');
      this.captureEl = document.getElementById('pl-capture');
      this.entries = [];
      app.packetCaptureEnabled = this.captureEl.checked;

      app.sim.on('frame', (tx) => this.addFrame(tx));
      app.sim.on('note', (n) => this.addNote(n));
      this.filterEl.addEventListener('input', () => this.applyFilter());
      this.protocolFilterEls.forEach(el => el.addEventListener('change', () => {
        this.applyFilter();
        this._updateProtocolSummary();
      }));
      document.getElementById('pl-protocol-all').addEventListener('click', () => this._setProtocolFilters(true));
      document.getElementById('pl-protocol-none').addEventListener('click', () => this._setProtocolFilters(false));
      NetSim.i18n.onChange(() => this._updateProtocolSummary());
      this._updateProtocolSummary();
      this.captureEl.addEventListener('change', () => {
        app.packetCaptureEnabled = this.captureEl.checked;
        // Remove dots already in flight so disabling capture stops every
        // protocol immediately, including VXLAN encapsulated packets.
        if (!app.packetCaptureEnabled) app.sim.transmissions = [];
      });
      document.getElementById('pl-clear').addEventListener('click', () => {
        this.entries = [];
        this.rowsEl.innerHTML = '';
      });
    }

    addFrame(tx) {
      if (!this.app.packetCaptureEnabled) return;
      const frame = tx.frame;
      const from = tx.fromPort;
      const to = tx.link.other(from);
      const summary = NetSim.decode.summarize(frame);
      const path = `${from.device.name}[${from.shortName}] → ${to.device.name}`;
      const key = NetSim.decode.protoKey(frame);

      const row = document.createElement('div');
      row.className = 'pl-row p-' + key;
      row.innerHTML = `
        <span class="pl-time">${(tx.tStart / 1000).toFixed(2)}s</span>
        <span class="pl-path"></span>
        <span class="pl-sum"></span>`;
      row.querySelector('.pl-path').textContent = path;
      row.querySelector('.pl-sum').textContent = summary;

      const entry = {
        row,
        text: (path + ' ' + summary).toLowerCase(),
        protocol: this._protocolFor(frame),
        frame,
        detail: null,
      };
      row.addEventListener('click', () => this.toggleDetail(entry));
      this._push(entry);
    }

    addNote(n) {
      if (!this.app.packetCaptureEnabled) return;
      const row = document.createElement('div');
      row.className = 'pl-row p-note';
      row.innerHTML = `<span class="pl-time">${(n.time / 1000).toFixed(2)}s</span>
        <span class="pl-path">⚠ ${n.kind}</span><span class="pl-sum"></span>`;
      row.querySelector('.pl-sum').textContent = n.msg;
      this._push({ row, text: (n.kind + ' ' + n.msg).toLowerCase(), frame: null, detail: null });
    }

    _push(entry) {
      this.entries.push(entry);
      this._applyFilterTo(entry);
      this.rowsEl.appendChild(entry.row);
      while (this.entries.length > MAX_ROWS) {
        const old = this.entries.shift();
        old.row.remove();
        if (old.detail) old.detail.remove();
      }
      if (this.autoScrollEl.checked) this.rowsEl.scrollTop = this.rowsEl.scrollHeight;
    }

    toggleDetail(entry) {
      if (entry.detail) {
        entry.detail.remove();
        entry.detail = null;
        return;
      }
      if (!entry.frame) return;
      const d = document.createElement('div');
      d.className = 'pl-detail';
      for (const layer of NetSim.decode.decode(entry.frame)) {
        const lg = document.createElement('div');
        lg.className = 'layer';
        const t = document.createElement('div');
        t.className = 'layer-title';
        t.textContent = '▸ ' + layer.title;
        lg.appendChild(t);
        const f = document.createElement('div');
        f.className = 'fields';
        for (const k in layer.fields) {
          const line = document.createElement('div');
          const b = document.createElement('b');
          b.textContent = k + ':';
          line.appendChild(b);
          line.appendChild(document.createTextNode(' ' + layer.fields[k]));
          f.appendChild(line);
        }
        lg.appendChild(f);
        d.appendChild(lg);
      }
      entry.detail = d;
      entry.row.after(d);
    }

    applyFilter() {
      for (const e of this.entries) this._applyFilterTo(e);
    }
    _setProtocolFilters(checked) {
      this.protocolFilterEls.forEach(el => { el.checked = checked; });
      this.applyFilter();
      this._updateProtocolSummary();
    }
    _updateProtocolSummary() {
      const selected = this.protocolFilterEls.filter(el => el.checked).length;
      const total = this.protocolFilterEls.length;
      const key = selected === total ? 'pl.protocol.summary.all' :
        (selected === 0 ? 'pl.protocol.summary.none' : 'pl.protocol.summary.some');
      this.protocolSummaryEl.textContent = NetSim.t(key, selected, total);
    }
    _protocolFor(frame) {
      if (frame.type === 'arp') return 'arp';
      if (frame.type !== 'ipv4') return null;
      const ip = frame.payload;
      const l4 = ip.payload;
      if (ip.proto === 'udp' && l4.data && l4.data.dhcp) return 'dhcp';
      if (ip.proto === 'udp' && l4.dstPort === 4789 && l4.data && l4.data.vxlan) return 'vxlan';
      return ip.proto;
    }
    _applyFilterTo(entry) {
      const q = this.filterEl.value.trim().toLowerCase();
      const protocolEl = this.protocolFilterEls.find(el => el.dataset.protocolFilter === entry.protocol);
      const show = (!q || entry.text.includes(q)) && (!protocolEl || protocolEl.checked);
      entry.row.style.display = show ? '' : 'none';
      if (entry.detail) entry.detail.style.display = show ? '' : 'none';
    }
  }

  NetSim.ui.PacketLog = PacketLog;
})(typeof window !== 'undefined' ? window : globalThis);
