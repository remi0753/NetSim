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
      this.autoScrollEl = document.getElementById('pl-autoscroll');
      this.captureEl = document.getElementById('pl-capture');
      this.entries = [];

      app.sim.on('frame', (tx) => this.addFrame(tx));
      app.sim.on('note', (n) => this.addNote(n));
      this.filterEl.addEventListener('input', () => this.applyFilter());
      document.getElementById('pl-clear').addEventListener('click', () => {
        this.entries = [];
        this.rowsEl.innerHTML = '';
      });
    }

    addFrame(tx) {
      if (!this.captureEl.checked) return;
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

      const entry = { row, text: (path + ' ' + summary).toLowerCase(), frame, detail: null };
      row.addEventListener('click', () => this.toggleDetail(entry));
      this._push(entry);
    }

    addNote(n) {
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
    _applyFilterTo(entry) {
      const q = this.filterEl.value.trim().toLowerCase();
      const show = !q || entry.text.includes(q);
      entry.row.style.display = show ? '' : 'none';
      if (entry.detail) entry.detail.style.display = show ? '' : 'none';
    }
  }

  NetSim.ui.PacketLog = PacketLog;
})(typeof window !== 'undefined' ? window : globalThis);
