#!/usr/bin/env node
/* NetSim browser UI test (headless Chrome).
 * 前提: macOS + Google Chrome + `npm i puppeteer-core` 済みの環境で:
 *   node tests/browser.js
 */
'use strict';
const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME = process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'file://' + path.resolve(__dirname, '..', 'index.html');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-first-run', '--disable-extensions'],
    defaultViewport: { width: 1500, height: 950 },
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  page.on('dialog', (d) => d.accept());

  await page.goto(URL, { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 800));

  let pass = 0, fail = 0;
  const ok = (cond, label) => {
    if (cond) { pass++; console.log('  ok   ' + label); }
    else { fail++; console.log('  FAIL ' + label); }
  };
  const sw1Pos = () => page.evaluate(() => {
    const app = window.netsimApp;
    const sw = app.net.findByName('SW1');
    const r = document.getElementById('canvas').getBoundingClientRect();
    const v = app.canvas.view;
    return { x: r.left + v.x + sw.x * v.scale, y: r.top + v.y + sw.y * v.scale };
  });

  // 1. boot + sample topology rendered
  const boot = await page.evaluate(() => ({
    hasApp: !!window.netsimApp,
    devices: window.netsimApp ? window.netsimApp.net.devices.length : 0,
    links: window.netsimApp ? window.netsimApp.net.links.length : 0,
    devEls: document.querySelectorAll('.dev-box').length,
    linkEls: document.querySelectorAll('.link-g').length,
    palItems: document.querySelectorAll('.pal-item').length,
    baseLatency: Number(document.getElementById('base-latency').value),
    simBaseLatency: window.netsimApp ? window.netsimApp.sim.baseLatencyMs : null,
  }));
  ok(boot.hasApp, 'アプリ起動');
  ok(boot.devices === 6 && boot.devEls === 6, `サンプル構成のデバイス描画 (${boot.devEls}/6)`);
  ok(boot.links === 5 && boot.linkEls === 5, `リンク描画 (${boot.linkEls}/5)`);
  ok(boot.palItems === 7, 'パレットに7種のデバイス (LB含む)');
  ok(boot.baseLatency === 100 && boot.simBaseLatency === 100,
    '通信latency基準のUI初期値は100ms');
  const changedBaseLatency = await page.evaluate(() => {
    const input = document.getElementById('base-latency');
    input.value = '250';
    input.dispatchEvent(new Event('change'));
    return {
      sim: window.netsimApp.sim.baseLatencyMs,
      saved: localStorage.getItem('netsim.baseLatencyMs'),
    };
  });
  ok(changedBaseLatency.sim === 250 && changedBaseLatency.saved === '250',
    '通信latency基準をUIから変更・保存');

  // 2. terminal ping across the router (clock sped up)
  await page.evaluate(() => {
    const app = window.netsimApp;
    app.sim.speed = 80;
    app.openConsole(app.net.findByName('PC1'));
  });
  await page.type('.bpanel.active .term-input', 'ping 10.0.2.10 -c 2');
  await page.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 1500));
  const termText = await page.evaluate(() =>
    document.querySelector('.bpanel.active .term-out').textContent);
  ok(termText.includes('Reply from 10.0.2.10'), 'ターミナルから ping 成功 (ルータ越し)');
  ok(/2 packets transmitted, 2 received/.test(termText), 'ping 統計表示');

  // 3. packet log
  const plInfo = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.pl-row')];
    return {
      count: rows.length,
      hasArp: rows.some(r => r.textContent.includes('ARP')),
      hasIcmp: rows.some(r => r.textContent.includes('ICMP Echo')),
    };
  });
  ok(plInfo.count > 5, `パケットログに記録 (${plInfo.count}行)`);
  ok(plInfo.hasArp && plInfo.hasIcmp, 'ARP と ICMP がログに存在');

  // 3a. selecting a cable shows live traffic amount and bandwidth utilization
  const linkTraffic = await page.evaluate(() => {
    const app = window.netsimApp;
    app.sim.running = false;
    const pc = app.net.findByName('PC1');
    const link = pc.nic.link;
    const original = link.settings();
    link.configure({ ...original, bandwidthMbps: 0.008 });
    link.transmit(pc.nic, window.NetSim.pdu.eth(
      pc.nic.mac, pc.nic.other().mac || 'ff:ff:ff:ff:ff:ff', 'test',
      { marker: 'traffic-meter', pad: 'x'.repeat(100) }));
    app.sim.advance(50);
    app.select({ link });
    app.inspector.updateLive();
    const first = document.querySelector('[data-link-traffic-dir="0"]');
    const result = {
      rows: document.querySelectorAll('[data-link-traffic-dir]').length,
      text: document.querySelector('.link-traffic').textContent,
      percentage: first.querySelector('.link-traffic-pct').textContent,
      width: parseFloat(first.querySelector('.link-traffic-fill').style.width),
    };
    link.configure(original);
    app.sim.running = true;
    return result;
  });
  ok(linkTraffic.rows === 2 && linkTraffic.text.includes('ライブ通信量') &&
    linkTraffic.text.includes('双方向の累計'),
  'ケーブル選択で方向別の通信量を表示');
  ok(linkTraffic.percentage !== '0.00%' && linkTraffic.width > 0,
    '直近1秒の帯域利用率を数値とゲージで表示');

  // 3b. all protocol filters are available from the compact menu
  const protocolFilters = await page.evaluate(() => ({
    values: [...document.querySelectorAll('[data-protocol-filter]')].map(el => el.dataset.protocolFilter),
    summary: document.getElementById('pl-protocol-summary').textContent,
    menu: !!document.querySelector('.pl-protocol-menu'),
  }));
  ok(protocolFilters.menu && protocolFilters.summary.includes('すべて') &&
    protocolFilters.values.join(',') === 'arp,icmp,tcp,udp,dhcp,vxlan,ospf,vrrp',
    '全プロトコルのフィルターをコンパクトなメニューに表示');

  // 4. decode detail
  const detail = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.pl-row')].find(r => r.textContent.includes('ICMP Echo'));
    if (!row) return null;
    row.click();
    const d = document.querySelector('.pl-detail');
    return d ? d.textContent : null;
  });
  ok(detail && detail.includes('Ethernet II') && detail.includes('IPv4') && detail.includes('ICMP'),
    'パケット詳細デコード表示 (L2/L3/L4)');

  // 5. router CLI
  await page.evaluate(() => {
    const app = window.netsimApp;
    app.openConsole(app.net.findByName('RT1'));
  });
  await page.type('.bpanel.active .term-input', 'en');
  await page.keyboard.press('Enter');
  await page.type('.bpanel.active .term-input', 'sh ip route');
  await page.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 200));
  const rtText = await page.evaluate(() =>
    document.querySelector('.bpanel.active .term-out').textContent);
  ok(rtText.includes('10.0.1.0/24') && rtText.includes('directly connected'),
    'ルータCLI: sh ip route (省略形)');
  const prompt = await page.evaluate(() =>
    document.querySelector('.bpanel.active .term-prompt').textContent);
  ok(prompt === 'RT1#', '特権モードプロンプト (RT1#)');

  // 6. VRRP configured via CLI is visible in the inspector
  await page.type('.bpanel.active .term-input', 'conf t');
  await page.keyboard.press('Enter');
  await page.type('.bpanel.active .term-input', 'interface Gi0/0');
  await page.keyboard.press('Enter');
  await page.type('.bpanel.active .term-input', 'vrrp 1 ip 10.0.1.1');
  await page.keyboard.press('Enter');
  await page.type('.bpanel.active .term-input', 'vrrp 1 priority 120');
  await page.keyboard.press('Enter');
  await page.type('.bpanel.active .term-input', 'end');
  await page.keyboard.press('Enter');
  await page.evaluate(() => {
    const app = window.netsimApp;
    app.select({ device: app.net.findByName('RT1') });
  });
  const vrrpInspector = await page.evaluate(() =>
    [...document.querySelectorAll('#inspector-body .insp-section')]
      .find(sec => (sec.querySelector('.sec-title') || {}).textContent === 'VRRP')
      .textContent);
  ok(vrrpInspector.includes('Gi0/0') && vrrpInspector.includes('10.0.1.1') &&
    vrrpInspector.includes('120') && !vrrpInspector.includes('GigabitEthernet0/0') &&
    vrrpInspector.includes('show vrrp brief'),
    'CLIで設定したVRRPがインスペクタに短縮IF名で表示される');

  // 7. click-select on canvas -> inspector
  let pos = await sw1Pos();
  await page.mouse.click(pos.x, pos.y);
  await new Promise(r => setTimeout(r, 150));
  const inspText = await page.evaluate(() =>
    document.getElementById('inspector-body').textContent);
  ok(inspText.includes('SW1') && inspText.includes('ポート設定'), 'クリック選択 → インスペクタにスイッチ設定');

  // 7b. real double-click on a device opens its console tab
  await page.mouse.click(pos.x, pos.y);
  await page.mouse.click(pos.x, pos.y);
  await new Promise(r => setTimeout(r, 200));
  const dblState = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll('.btab')].map(t => t.textContent),
    activePrompt: (document.querySelector('.bpanel.active .term-prompt') || {}).textContent,
  }));
  ok(dblState.tabs.some(t => t.includes('SW1')) && dblState.activePrompt === 'SW1>',
    'ダブルクリックでコンソールが開く (SW1>)');
  await page.evaluate(() => window.netsimApp.terminals.close(
    window.netsimApp.net.findByName('SW1').id));

  // 7. palette placement
  await page.click('.pal-item[data-type="pc"]');
  await page.mouse.click(pos.x + 120, pos.y + 160);
  await new Promise(r => setTimeout(r, 150));
  const placed = await page.evaluate(() => ({
    count: window.netsimApp.net.devices.length,
    hasPc3: !!window.netsimApp.net.findByName('PC3'),
  }));
  ok(placed.count === 7 && placed.hasPc3, 'パレットから新規PCを配置 (PC3)');

  // 8. cable mode via UI clicks
  await page.click('#mode-cable');
  const pc3Pos = await page.evaluate(() => {
    const app = window.netsimApp;
    const d = app.net.findByName('PC3');
    const r = document.getElementById('canvas').getBoundingClientRect();
    const v = app.canvas.view;
    return { x: r.left + v.x + d.x * v.scale, y: r.top + v.y + d.y * v.scale };
  });
  await page.mouse.click(pc3Pos.x, pc3Pos.y);
  await new Promise(r => setTimeout(r, 150));
  ok(await page.evaluate(() => !document.getElementById('port-menu').hidden),
    '結線モード: ポート選択メニュー表示');
  await page.evaluate(() => {
    [...document.querySelectorAll('#port-menu .pm-item:not(.used)')][0].click();
  });
  pos = await sw1Pos();
  await page.mouse.click(pos.x, pos.y);
  await new Promise(r => setTimeout(r, 150));
  await page.evaluate(() => {
    [...document.querySelectorAll('#port-menu .pm-item:not(.used)')][0].click();
  });
  await new Promise(r => setTimeout(r, 150));
  ok(await page.evaluate(() => {
    const app = window.netsimApp;
    return app.net.findByName('PC3').nic.link !== null && app.net.links.length === 6;
  }), 'UI操作でケーブル接続完了 (PC3⇔SW1)');

  // 9. HTTP over TCP from the UI
  await page.click('#mode-select');
  await page.evaluate(() => {
    const app = window.netsimApp;
    app.openConsole(app.net.findByName('PC2'));
  });
  await page.type('.bpanel.active .term-input', 'http get 10.0.2.10');
  await page.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 1200));
  const httpText = await page.evaluate(() =>
    document.querySelector('.bpanel.active .term-out').textContent);
  ok(httpText.includes('200 OK'), 'ブラウザUIから HTTP GET → 200 OK');
  ok(await page.evaluate(() =>
    [...document.querySelectorAll('.pl-row')].some(r => r.textContent.includes('[SYN]'))),
    'TCP SYN がパケットログに記録');

  // 10. save to localStorage
  await page.click('#btn-save');
  ok(await page.evaluate(() => !!localStorage.getItem('netsim.save')), 'ブラウザ保存 (localStorage)');

  // 11. spine-leaf fabric generation via dialog
  await page.click('#btn-fabric');
  ok(await page.evaluate(() => !document.getElementById('fabric-modal').hidden), 'DC生成ダイアログ表示');
  await page.evaluate(() => {
    document.getElementById('fab-spines').value = '2';
    document.getElementById('fab-leaves').value = '3';
    document.getElementById('fab-hosts').value = '10';
  });
  await page.click('#fab-build');
  await new Promise(r => setTimeout(r, 400));
  const fab = await page.evaluate(() => ({
    devices: window.netsimApp.net.devices.length,
    groups: window.netsimApp.net.groups.length,
    collapsed: window.netsimApp.net.groups.filter(g => g.collapsed).length,
    grpBoxes: document.querySelectorAll('.group-box').length,
    devEls: document.querySelectorAll('.dev-box').length,
  }));
  ok(fab.devices === 35, `ファブリック生成 (2+3+30=35台)`);
  ok(fab.groups === 3 && fab.collapsed === 3 && fab.grpBoxes === 3,
    'ラック3つが折りたたみ表示 (ホストは非表示)');
  ok(fab.devEls === 5, '表示中デバイスはスイッチ5台のみ');

  // 12. OSPF converges; ping across the fabric from a rack host console
  await page.evaluate(() => { window.netsimApp.sim.speed = 200; });
  await new Promise(r => setTimeout(r, 800));   // ~160s sim: adjacency + SPF
  const ospfInfo = await page.evaluate(() => {
    const leaf1 = window.netsimApp.net.findByName('LEAF1');
    return {
      neighbors: leaf1.ospf.neighbors.size,
      routes: (leaf1.stack.dynRoutes.get('ospf') || []).length,
      ecmp: (leaf1.stack.dynRoutes.get('ospf') || []).some(r => r.nexthops.length === 2),
    };
  });
  ok(ospfInfo.neighbors === 2, `LEAF1のOSPFネイバー2件 (スパイン2台)`);
  ok(ospfInfo.ecmp, 'ECMP経路 (ネクストホップ2つ) を学習');

  // 12b. protocol filters hide only their matching packets and compose with text filtering
  const protocolFilterResult = await page.evaluate(() => {
    const app = window.netsimApp;
    const from = app.net.findByName('LEAF1').ports.find(port => port.link);
    const pdu = window.NetSim.pdu;
    const add = (frame) => app.packetLog.addFrame({
      frame,
      fromPort: from, link: from.link, tStart: app.sim.time,
    });
    add(pdu.eth('00:00:5e:00:00:01', '01:00:5e:00:00:05', 'ipv4',
      pdu.ipv4('10.0.0.1', '224.0.0.5', 'ospf', { type: 'hello', routerId: '10.0.0.1', seen: [] })));
    add(pdu.eth('00:00:5e:00:00:01', '01:00:5e:00:00:12', 'ipv4',
      pdu.ipv4('10.0.0.1', '224.0.0.18', 'vrrp', { gid: 1, priority: 100, vip: '10.0.0.254' })));
    add(pdu.eth('00:00:5e:00:00:01', 'ff:ff:ff:ff:ff:ff', 'arp',
      pdu.arpRequest('00:00:5e:00:00:01', '10.0.0.1', '10.0.0.254')));

    const ospfEntry = app.packetLog.entries.findLast(entry => entry.protocol === 'ospf');
    const vrrpEntry = app.packetLog.entries.findLast(entry => entry.protocol === 'vrrp');
    const arpEntry = app.packetLog.entries.findLast(entry => entry.protocol === 'arp');
    const ospf = document.getElementById('pl-filter-ospf');
    const vrrp = document.getElementById('pl-filter-vrrp');
    ospf.checked = false;
    ospf.dispatchEvent(new Event('change'));
    const ospfHidden = ospfEntry.row.style.display === 'none';
    const otherProtocolsStillVisible = vrrpEntry.row.style.display !== 'none' && arpEntry.row.style.display !== 'none';
    vrrp.checked = false;
    vrrp.dispatchEvent(new Event('change'));
    const vrrpHidden = vrrpEntry.row.style.display === 'none';
    ospf.checked = true;
    vrrp.checked = true;
    ospf.dispatchEvent(new Event('change'));
    document.getElementById('pl-protocol-none').click();
    const allHidden = [ospfEntry, vrrpEntry, arpEntry].every(entry => entry.row.style.display === 'none');
    document.getElementById('pl-protocol-all').click();
    const allVisible = [ospfEntry, vrrpEntry, arpEntry].every(entry => entry.row.style.display !== 'none');
    const text = document.getElementById('pl-filter');
    text.value = 'vrrp';
    text.dispatchEvent(new Event('input'));
    const textFilterStillWorks = ospfEntry.row.style.display === 'none' &&
      vrrpEntry.row.style.display !== 'none';
    text.value = '';
    text.dispatchEvent(new Event('input'));
    return { ospfHidden, otherProtocolsStillVisible, vrrpHidden, allHidden, allVisible, textFilterStillWorks };
  });
  ok(protocolFilterResult.ospfHidden && protocolFilterResult.otherProtocolsStillVisible &&
    protocolFilterResult.vrrpHidden && protocolFilterResult.allHidden && protocolFilterResult.allVisible &&
    protocolFilterResult.textFilterStillWorks, 'プロトコルを個別/一括で表示・非表示（テキストフィルターと併用）');
  await page.evaluate(() => {
    const app = window.netsimApp;
    app.openConsole(app.net.findByName('H1-1'));
  });
  await page.type('.bpanel.active .term-input', 'ping 10.3.0.10 -c 2');
  await page.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 700));
  const fabPing = await page.evaluate(() =>
    document.querySelector('.bpanel.active .term-out').textContent);
  ok(fabPing.includes('Reply from 10.3.0.10'), 'ラック内ホストからファブリック越しに ping 成功');

  // 13. search jumps to a hidden host (auto-expands its rack)
  await page.type('#search', 'H2-3');
  await page.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 300));
  const searched = await page.evaluate(() => {
    const app = window.netsimApp;
    const sel = app.canvas.selection;
    return {
      name: sel && sel.device ? sel.device.name : null,
      rackExpanded: !app.net.groups.find(g => g.name === 'Rack2').collapsed,
    };
  });
  ok(searched.name === 'H2-3' && searched.rackExpanded, '検索でラックが展開されデバイスへジャンプ');

  // 14. multi-select bulk panel
  await page.evaluate(() => {
    const app = window.netsimApp;
    const devs = app.net.devices.filter(d => d.name.startsWith('H2-'));
    app.select({ devices: devs });
  });
  const multiText = await page.evaluate(() =>
    document.getElementById('inspector-body').textContent);
  ok(multiText.includes('10台を選択中') && multiText.includes('一括IP設定'),
    '複数選択で一括設定パネル表示');

  // 15. auto layout + fit don't crash and keep the topology intact
  await page.click('#btn-layout');
  await page.click('#btn-fit');
  await new Promise(r => setTimeout(r, 200));
  const after = await page.evaluate(() => window.netsimApp.net.devices.length);
  ok(after === 35, '自動整列/全体表示後もトポロジー維持');

  // 16. palette drag & drop places a device (and stray drops never navigate)
  const dropped = await page.evaluate(() => {
    const before = window.netsimApp.net.devices.length;
    const wrap = document.getElementById('canvas-wrap');
    const r = wrap.getBoundingClientRect();
    const dt = new DataTransfer();
    dt.setData('application/x-netsim-device', 'router');
    for (const type of ['dragover', 'drop']) {
      wrap.dispatchEvent(new DragEvent(type, {
        bubbles: true, cancelable: true,
        clientX: r.left + 320, clientY: r.top + 260, dataTransfer: dt,
      }));
    }
    const modalShown = !document.getElementById('placement-modal').hidden;
    document.getElementById('place-port-count').value = '6';
    document.getElementById('place-create').click();
    const addedDev = window.netsimApp.net.devices[window.netsimApp.net.devices.length - 1];
    const strayDrop = new DragEvent('drop', {
      bubbles: true, cancelable: true, dataTransfer: new DataTransfer(),
    });
    document.body.dispatchEvent(strayDrop);
    return {
      added: window.netsimApp.net.devices.length === before + 1,
      modalShown,
      portCount: addedDev && addedDev.ports.length,
      strayPrevented: strayDrop.defaultPrevented,
    };
  });
  ok(dropped.modalShown, '配置時にインターフェース数ダイアログ表示');
  ok(dropped.added, 'パレットからドラッグ&ドロップで配置');
  ok(dropped.portCount === 6, '指定したインターフェース数でルータを配置');
  ok(dropped.strayPrevented, '無関係なドロップはナビゲーションを抑止 (Unsafe URL対策)');

  // 17. packet-log bursts are retained and painted as one bounded batch
  await page.evaluate(() => {
    const sim = window.netsimApp.sim;
    for (let i = 0; i < 800; i++) sim.note('batch-test', 'BATCH-' + i);
  });
  await new Promise(r => setTimeout(r, 100));
  const batchedLog = await page.evaluate(() => ({
    rows: document.querySelectorAll('#pl-rows .pl-row').length,
    entries: window.netsimApp.packetLog.entries.length,
    last: document.querySelector('#pl-rows .pl-row:last-child .pl-sum').textContent,
  }));
  ok(batchedLog.rows === 500 && batchedLog.entries === 500 && batchedLog.last === 'BATCH-799',
    '大量ログを500件のring bufferにまとめて描画');

  console.log(`\n${pass} passed, ${fail} failed`);
  if (errors.length) {
    console.log('\nJS errors:');
    for (const e of errors) console.log('  ' + e);
  } else {
    console.log('JS errors: none');
  }
  await browser.close();
  process.exit(fail || errors.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
