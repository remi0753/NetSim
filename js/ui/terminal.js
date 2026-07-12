/* NetSim UI: per-device console terminals in the bottom panel */
(function (root) {
  const NetSim = root.NetSim;
  NetSim.ui = NetSim.ui || {};
  const t = (k, ...a) => NetSim.t(k, ...a);

  class Terminals {
    constructor(app) {
      this.app = app;
      this.tabsEl = document.getElementById('bottom-tabs');
      this.panelsEl = document.getElementById('bottom-panels');
      this.sessions = new Map();   // dev.id -> session

      this.tabsEl.addEventListener('click', (e) => {
        const closeBtn = e.target.closest('.tab-close');
        const tab = e.target.closest('.btab');
        if (!tab) return;
        if (closeBtn) { this.close(tab.dataset.tab); return; }
        this.activate(tab.dataset.tab);
      });
    }

    activate(id) {
      this.tabsEl.querySelectorAll('.btab').forEach(t =>
        t.classList.toggle('active', t.dataset.tab === id));
      this.panelsEl.querySelectorAll('.bpanel').forEach(p =>
        p.classList.toggle('active', p.id === 'panel-' + id));
      const s = this.sessions.get(id);
      if (s) s.input.focus({ preventScroll: true });
    }

    open(dev) {
      if (this.sessions.has(dev.id)) { this.activate(dev.id); return; }

      const tab = document.createElement('button');
      tab.className = 'btab';
      tab.dataset.tab = dev.id;
      tab.innerHTML = `<span class="tab-name"></span><span class="tab-close" title="${t('term.close')}">✕</span>`;
      tab.querySelector('.tab-name').textContent = '⌨ ' + dev.name;
      this.tabsEl.appendChild(tab);

      const panel = document.createElement('div');
      panel.className = 'bpanel term';
      panel.id = 'panel-' + dev.id;
      panel.innerHTML = `
        <div class="term-out"></div>
        <div class="term-in">
          <span class="term-prompt"></span>
          <input class="term-input" type="text" spellcheck="false" autocomplete="off">
        </div>`;
      this.panelsEl.appendChild(panel);

      const out = panel.querySelector('.term-out');
      const input = panel.querySelector('.term-input');
      const promptEl = panel.querySelector('.term-prompt');

      const session = { dev, tab, panel, out, input, promptEl, history: [], hi: 0 };
      this.sessions.set(dev.id, session);

      const append = (line) => {
        out.appendChild(document.createTextNode(line + '\n'));
        out.scrollTop = out.scrollHeight;
      };
      const refreshPrompt = () => { promptEl.textContent = dev.getPrompt(); };

      session.onOutput = (l) => append(l);
      session.onClear = () => { out.textContent = ''; };
      session.onPrompt = () => refreshPrompt();
      session.onChanged = () => {
        tab.querySelector('.tab-name').textContent = '⌨ ' + dev.name;
        refreshPrompt();
      };
      dev.on('output', session.onOutput);
      dev.on('clear', session.onClear);
      dev.on('prompt', session.onPrompt);
      dev.on('changed', session.onChanged);

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const line = input.value;
          input.value = '';
          if (dev.busy) return;   // async command still running
          append(dev.getPrompt() + ' ' + line);
          if (line.trim()) {
            session.history.push(line);
            session.hi = session.history.length;
          }
          dev.exec(line);
          refreshPrompt();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (session.hi > 0) { session.hi--; input.value = session.history[session.hi] || ''; }
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (session.hi < session.history.length) {
            session.hi++;
            input.value = session.history[session.hi] || '';
          }
        } else if (e.key === 'Escape') {
          input.value = '';
        }
      });

      // welcome banner
      if (dev.type === 'pc' || dev.type === 'server' || dev.type === 'lb') {
        const label = dev.type === 'server' ? 'Server' : (dev.type === 'lb' ? 'LB' : 'PC');
        append(t('term.banner.host', label));
      } else if (dev.type === 'hub') {
        append(t('term.banner.hub'));
      } else {
        append(t('term.banner.ios', dev.name));
      }
      refreshPrompt();
      this.activate(dev.id);
    }

    close(id) {
      if (id === 'packets') return;
      const s = this.sessions.get(id);
      if (!s) return;
      s.dev.off('output', s.onOutput);
      s.dev.off('clear', s.onClear);
      s.dev.off('prompt', s.onPrompt);
      s.dev.off('changed', s.onChanged);
      s.tab.remove();
      s.panel.remove();
      this.sessions.delete(id);
      this.activate('packets');
    }

    closeFor(dev) { this.close(dev.id); }
  }

  NetSim.ui.Terminals = Terminals;
})(typeof window !== 'undefined' ? window : globalThis);
