/* NetSim UI: toolbar — mode switching, sim control, save/load, samples, help */
(function (root) {
  const NetSim = root.NetSim;
  NetSim.ui = NetSim.ui || {};
  const t = (k, ...a) => NetSim.t(k, ...a);

  const LS_KEY = 'netsim.save';
  const LS_AUTO = 'netsim.autosave';

  class Toolbar {
    constructor(app) {
      this.app = app;
      const $ = (id) => document.getElementById(id);

      // mode buttons
      $('mode-select').addEventListener('click', () => app.canvas.setMode('select'));
      $('mode-cable').addEventListener('click', () => app.canvas.setMode('cable'));
      $('mode-delete').addEventListener('click', () => app.canvas.setMode('delete'));

      // run / pause
      this.runBtn = $('btn-run');
      this.runBtn.addEventListener('click', () => app.toggleRun());

      // speed: slider value is log2(speed)
      const speedEl = $('speed'), speedVal = $('speed-val');
      const applySpeed = () => {
        const s = Math.pow(2, Number(speedEl.value));
        app.sim.speed = s;
        speedVal.textContent = 'x' + (s < 1 ? s.toFixed(2).replace(/0+$/, '') : s);
      };
      speedEl.addEventListener('input', applySpeed);
      applySpeed();

      this.clockEl = $('sim-clock');

      // search / fit / auto-layout
      const search = $('search');
      search.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const q = search.value.trim().toLowerCase();
        if (!q) return;
        const hits = app.net.devices.filter(d => d.name.toLowerCase().includes(q));
        if (!hits.length) { app.canvas.hint(t('tb.notFound', search.value)); return; }
        // Enter連打で次の候補へ
        this._searchIdx = (q === this._searchQ) ? (this._searchIdx + 1) % hits.length : 0;
        this._searchQ = q;
        const dev = hits[this._searchIdx];
        const g = app.net.groupOf(dev);
        if (g && g.collapsed) app.net.setCollapsed(g, false);
        app.select({ device: dev });
        const pos = app.canvas.devicePos(dev);
        app.canvas.centerOn(pos.x, pos.y, Math.max(app.canvas.view.scale, 0.8));
        app.canvas.hint(`${dev.name} (${this._searchIdx + 1}/${hits.length})`);
      });
      $('btn-fit').addEventListener('click', () => app.canvas.fitAll());
      $('btn-layout').addEventListener('click', () => app.canvas.autoLayout());

      // fabric generator
      const fabModal = $('fabric-modal');
      const fabTotal = () => {
        const s = Number($('fab-spines').value) || 0;
        const l = Number($('fab-leaves').value) || 0;
        const h = Number($('fab-hosts').value) || 0;
        $('fab-total').textContent =
          t('tb.fabTotal', Math.min(4, s), Math.min(8, l), Math.min(8, l) * Math.min(48, h));
      };
      for (const id of ['fab-spines', 'fab-leaves', 'fab-hosts']) {
        $(id).addEventListener('input', fabTotal);
      }
      $('btn-fabric').addEventListener('click', () => { fabTotal(); fabModal.hidden = false; });
      $('fab-cancel').addEventListener('click', () => { fabModal.hidden = true; });
      fabModal.addEventListener('click', (e) => { if (e.target === fabModal) fabModal.hidden = true; });
      $('fab-build').addEventListener('click', () => {
        const opts = {
          spines: Number($('fab-spines').value) || 2,
          leaves: Number($('fab-leaves').value) || 4,
          hostsPerLeaf: Number($('fab-hosts').value) || 12,
        };
        if (app.net.devices.length &&
            !confirm(t('tb.confirm.fabric'))) return;
        fabModal.hidden = true;
        app.loadTopology(() => NetSim.buildFabric(app.net, opts));
        app.canvas.fitAll();
        app.canvas.hint(t('tb.fabricDone'));
      });

      // samples
      const sampleSel = $('sample-select');
      this.sampleSel = sampleSel;
      this._buildSamples();
      sampleSel.addEventListener('change', () => {
        const s = NetSim.samples.find(x => x.id === sampleSel.value);
        sampleSel.value = '';
        if (!s) return;
        if (app.net.devices.length &&
            !confirm(t('tb.confirm.sample'))) return;
        app.loadTopology(() => s.build(app.net));
      });

      // save / load / export / import / clear
      $('btn-save').addEventListener('click', () => {
        localStorage.setItem(LS_KEY, JSON.stringify(app.net.serialize()));
        app.canvas.hint(t('tb.saved'));
      });
      $('btn-load').addEventListener('click', () => {
        const data = localStorage.getItem(LS_KEY);
        if (!data) { app.canvas.hint(t('tb.noSave')); return; }
        if (app.net.devices.length && !confirm(t('tb.confirm.load'))) return;
        app.loadTopology(() => app.net.load(JSON.parse(data)));
        app.canvas.hint(t('tb.loaded'));
      });
      $('btn-export').addEventListener('click', () => {
        const blob = new Blob([JSON.stringify(app.net.serialize(), null, 2)],
          { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'netsim-topology.json';
        a.click();
        URL.revokeObjectURL(a.href);
      });
      $('btn-import').addEventListener('click', () => $('import-file').click());
      $('import-file').addEventListener('change', (e) => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const data = JSON.parse(reader.result);
            if (app.net.devices.length && !confirm(t('tb.confirm.load'))) return;
            app.loadTopology(() => app.net.load(data));
            app.canvas.hint(t('tb.imported'));
          } catch (err) {
            alert(t('tb.importFail', err.message));
          }
        };
        reader.readAsText(file);
      });
      $('btn-clear').addEventListener('click', () => {
        if (!app.net.devices.length) return;
        if (!confirm(t('tb.confirm.clear'))) return;
        app.loadTopology(() => {});
      });

      // help
      $('btn-help').addEventListener('click', () => { $('help-modal').hidden = false; });
      $('help-close').addEventListener('click', () => { $('help-modal').hidden = true; });
      $('help-modal').addEventListener('click', (e) => {
        if (e.target.id === 'help-modal') $('help-modal').hidden = true;
      });

      // language toggle
      this.langBtn = $('btn-lang');
      this.langBtn.addEventListener('click', () => NetSim.i18n.toggle());

      // autosave on leave
      window.addEventListener('beforeunload', () => {
        try { localStorage.setItem(LS_AUTO, JSON.stringify(app.net.serialize())); } catch (_) {}
      });

      this.updateRunButton();
      this.refreshI18n();
    }

    _buildSamples() {
      const sel = this.sampleSel;
      // keep the placeholder option (index 0), replace the rest
      while (sel.options.length > 1) sel.remove(1);
      for (const s of NetSim.samples) {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.nameKey ? t(s.nameKey) : s.name;
        sel.appendChild(opt);
      }
    }

    /* re-render toolbar bits whose text is produced in JS (not static HTML) */
    refreshI18n() {
      this._buildSamples();
      this.updateRunButton();
      if (this.langBtn) this.langBtn.textContent = NetSim.i18n.lang === 'ja' ? '🌐 EN' : '🌐 日本語';
    }

    updateRunButton() {
      this.runBtn.textContent = this.app.sim.running ? t('tb.run.pause') : t('tb.run.resume');
      this.runBtn.classList.toggle('active', !this.app.sim.running);
    }
    updateClock() {
      this.clockEl.textContent = (this.app.sim.time / 1000).toFixed(1) + 's';
    }

    static autosaveData() {
      try {
        const raw = localStorage.getItem(LS_AUTO);
        return raw ? JSON.parse(raw) : null;
      } catch (_) { return null; }
    }
  }

  NetSim.ui.Toolbar = Toolbar;
})(typeof window !== 'undefined' ? window : globalThis);
