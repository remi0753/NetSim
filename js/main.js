/* NetSim: application bootstrap */
(function () {
  const NetSim = window.NetSim;
  const t = (k, ...a) => NetSim.t(k, ...a);

  const sim = new NetSim.Simulator();
  const net = new NetSim.Network(sim);

  const app = {
    sim, net,
    canvas: null, inspector: null, terminals: null, packetLog: null, toolbar: null,

    select(sel) {
      this.canvas.setSelection(sel);
      this.inspector.render(sel);
    },
    openConsole(dev) {
      this.terminals.open(dev);
    },
    deleteDevice(dev) {
      this.terminals.closeFor(dev);
      this.net.removeDevice(dev);
      this.select(null);
    },
    toggleRun() {
      sim.running = !sim.running;
      this.toolbar.updateRunButton();
    },
    /* swap in a new topology (clear + build) with clean console state */
    loadTopology(build) {
      for (const dev of this.net.devices.slice()) this.terminals.closeFor(dev);
      this.net.clear();
      build();
      this.select(null);
      this.canvas.render();
    },
  };

  // accidental drops (dragged SVG/text/files) must never navigate the page:
  // on file:// this surfaces as "Unsafe attempt to load URL ..." errors
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  app.canvas = new NetSim.ui.CanvasView(app);
  app.inspector = new NetSim.ui.Inspector(app);
  app.terminals = new NetSim.ui.Terminals(app);
  app.packetLog = new NetSim.ui.PacketLog(app);
  app.toolbar = new NetSim.ui.Toolbar(app);

  // apply the (restored) language to static DOM, and re-render on toggle
  NetSim.i18n.apply();
  NetSim.i18n.onChange(() => {
    NetSim.i18n.apply();          // static HTML (toolbar, modals, labels)
    app.toolbar.refreshI18n();    // sample list, run button, lang button
    app.canvas.refreshI18n();     // palette labels, device sublabels, hints
    app.inspector.render(app.inspector.sel);  // current property panel
  });

  // initial topology: restore autosave, else load sample 1
  const auto = NetSim.ui.Toolbar.autosaveData();
  let restored = false;
  if (auto && auto.devices && auto.devices.length) {
    try {
      net.load(auto);
      restored = true;
      app.canvas.hint(t('main.restored'));
    } catch (_) { net.clear(); }
  }
  if (!restored) {
    NetSim.samples[0].build(net);
    app.canvas.hint(t('main.sampleLoaded'));
  }
  app.select(null);
  app.canvas.render();

  // animation loop
  let last = performance.now();
  function loop(now) {
    const dt = Math.min(100, now - last);
    last = now;
    sim.tick(dt);
    app.canvas.renderPackets();
    app.inspector.updateLive();
    app.toolbar.updateClock();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  window.netsimApp = app;   // for debugging
})();
