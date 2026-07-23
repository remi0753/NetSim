/* NetSim core: i18n — JA/EN dictionary + runtime language switch.
 * Loaded before every other module (browser & node). Japanese is the default
 * language; English is added on top and toggled at runtime. Dictionary values
 * are either plain strings (with {0},{1}… placeholders) or functions. */
(function (root) {
  const NetSim = (root.NetSim = root.NetSim || {});

  let lang = 'ja';
  const listeners = [];

  try {
    if (typeof localStorage !== 'undefined') {
      const s = localStorage.getItem('netsim.lang');
      if (s === 'ja' || s === 'en') lang = s;
    }
  } catch (_) {}

  const D = {
    /* ---------- app / toolbar (static HTML) ---------- */
    'app.title':        { ja: 'NetSim — L1〜L4 ネットワークシミュレーター', en: 'NetSim — L1–L4 Network Simulator' },
    'tb.mode.select':   { ja: '⬚ 選択', en: '⬚ Select' },
    'tb.mode.select.t': { ja: '選択・移動 (Esc)', en: 'Select & move (Esc)' },
    'tb.mode.cable':    { ja: '🔌 結線', en: '🔌 Connect' },
    'tb.mode.cable.t':  { ja: 'デバイス間を結線 (C)', en: 'Connect devices (C)' },
    'tb.mode.delete':   { ja: '✕ 削除', en: '✕ Delete' },
    'tb.mode.delete.t': { ja: 'クリックで削除 (D)', en: 'Click to delete (D)' },
    'tb.run.t':         { ja: 'シミュレーション実行/一時停止 (Space)', en: 'Run / pause simulation (Space)' },
    'tb.run.pause':     { ja: '⏸ 停止', en: '⏸ Pause' },
    'tb.run.resume':    { ja: '▶ 再開', en: '▶ Resume' },
    'tb.speed':         { ja: '速度', en: 'Speed' },
    'tb.baseLatency':   { ja: '通信latency基準', en: 'Network latency floor' },
    'tb.baseLatency.t': { ja: '全リンクの実通信に適用する片方向latencyの下限。0msでリンク個別値のみ使用', en: 'Actual one-way latency floor for every link; use 0ms for per-link values only' },
    'tb.clock.t':       { ja: 'シミュレーション時刻', en: 'Simulation time' },
    'tb.search.ph':     { ja: '🔍 デバイス検索', en: '🔍 Find device' },
    'tb.search.t':      { ja: '名前で検索してジャンプ (Enter)', en: 'Search by name and jump (Enter)' },
    'tb.fit':           { ja: '⛶ 全体', en: '⛶ Fit' },
    'tb.fit.t':         { ja: '全体が見えるようにズーム', en: 'Zoom to fit everything' },
    'tb.layout':        { ja: '🧭 整列', en: '🧭 Arrange' },
    'tb.layout.t':      { ja: '種類ごとに階層状に自動整列', en: 'Auto-arrange in tiers by type' },
    'tb.sample.ph':     { ja: 'サンプル構成…', en: 'Sample topologies…' },
    'tb.sample.t':      { ja: 'サンプル構成を読み込み', en: 'Load a sample topology' },
    'tb.fabric':        { ja: '🏭 DC生成', en: '🏭 Build DC' },
    'tb.fabric.t':      { ja: 'スパイン・リーフ構成を自動生成', en: 'Auto-generate a spine-leaf fabric' },
    'tb.save':          { ja: '💾 保存', en: '💾 Save' },
    'tb.save.t':        { ja: 'ブラウザに保存', en: 'Save to browser' },
    'tb.load':          { ja: '📂 読込', en: '📂 Load' },
    'tb.load.t':        { ja: 'ブラウザから読込', en: 'Load from browser' },
    'tb.export':        { ja: '⬇ 書出', en: '⬇ Export' },
    'tb.export.t':      { ja: 'JSONファイルとして書き出し', en: 'Export as a JSON file' },
    'tb.import':        { ja: '⬆ 取込', en: '⬆ Import' },
    'tb.import.t':      { ja: 'JSONファイルを読み込み', en: 'Import a JSON file' },
    'tb.clear':         { ja: '🗑 全消去', en: '🗑 Clear' },
    'tb.clear.t':       { ja: '全て削除', en: 'Delete everything' },
    'tb.help':          { ja: '？ヘルプ', en: '？ Help' },
    'tb.help.t':        { ja: 'ヘルプ', en: 'Help' },
    'tb.lang.t':        { ja: '言語 / Language', en: '言語 / Language' },
    'palette.title':    { ja: 'デバイス', en: 'Devices' },
    'inspector.title':  { ja: 'プロパティ', en: 'Properties' },
    'pl.tab':           { ja: 'パケットログ', en: 'Packet Log' },
    'pl.filter.ph':     { ja: 'フィルタ (例: ARP / 10.0.1 / TCP)', en: 'Filter (e.g. ARP / 10.0.1 / TCP)' },
    'pl.protocol':      { ja: 'プロトコル', en: 'Protocols' },
    'pl.protocol.title':{ ja: '表示するプロトコル', en: 'Protocols to display' },
    'pl.protocol.all':  { ja: 'すべて選択', en: 'Select all' },
    'pl.protocol.none': { ja: 'すべて解除', en: 'Clear all' },
    'pl.protocol.summary.all':  { ja: 'すべて', en: 'All' },
    'pl.protocol.summary.none': { ja: 'なし', en: 'None' },
    'pl.protocol.summary.some': { ja: '{0}/{1}件', en: '{0}/{1}' },
    'pl.autoscroll':    { ja: '自動スクロール', en: 'Auto-scroll' },
    'pl.capture':       { ja: 'キャプチャ', en: 'Capture' },
    'pl.clear':         { ja: 'クリア', en: 'Clear' },

    /* ---------- device labels ---------- */
    'dev.pc':       { ja: 'PC', en: 'PC' },
    'dev.server':   { ja: 'サーバ', en: 'Server' },
    'dev.hub':      { ja: 'ハブ', en: 'Hub' },
    'dev.switch':   { ja: 'L2スイッチ', en: 'L2 Switch' },
    'dev.l3switch': { ja: 'L3スイッチ', en: 'L3 Switch' },
    'dev.router':   { ja: 'ルータ', en: 'Router' },
    'dev.lb':       { ja: 'LB', en: 'LB' },

    /* ---------- samples / groups / persistence ---------- */
    'topo.sample.routed': { ja: 'サンプル1: ルータ経由の2セグメント', en: 'Sample 1: Two segments via a router' },
    'topo.sample.vlanDc': { ja: 'サンプル2: VLAN + L3スイッチ (ミニDC)', en: 'Sample 2: VLAN + L3 switch (mini DC)' },
    'topo.sample.haDc':   { ja: 'サンプル3: 冗長GW+LB+DHCP (VRRP)', en: 'Sample 3: Redundant GW + LB + DHCP (VRRP)' },
    'topo.sample.fabric': { ja: 'サンプル4: スパイン・リーフ (OSPF+ECMP)', en: 'Sample 4: Spine-leaf (OSPF + ECMP)' },
    'topo.sample.nat':    { ja: 'サンプル5: NAT/PAT (インターネット共有 + 静的公開)', en: 'Sample 5: NAT/PAT (internet sharing + static publish)' },
    'topo.sample.vxlanFabric': { ja: 'サンプル6: VXLAN テナント・オーバーレイ (デュアルスパイン)', en: 'Sample 6: VXLAN tenant overlay (dual spine)' },
    'topo.groupName':     { ja: 'グループ{0}', en: 'Group {0}' },
    'topo.badFile':       { ja: '不正なファイル形式です', en: 'Invalid file format' },

    /* ---------- canvas hints / port menu ---------- */
    'cv.place':          { ja: 'キャンバスをクリックして {0} を配置 (Shift+クリックで連続配置 / Escで解除)', en: 'Click the canvas to place a {0} (Shift+click to place several / Esc to cancel)' },
    'cv.cable.start':    { ja: '1台目のデバイスをクリック → ポートを選択', en: 'Click the first device → choose a port' },
    'cv.delete.hint':    { ja: '削除するデバイス / ケーブルをクリック', en: 'Click a device / cable to delete' },
    'cv.cable.sameDev':  { ja: '同じデバイス同士は接続できません。別のデバイスをクリックしてください', en: 'Cannot connect a device to itself. Click a different device.' },
    'cv.cable.from':     { ja: '{0} [{1}] から接続 — 2台目のデバイスをクリック (Escで中止)', en: 'Connecting from {0} [{1}] — click the second device (Esc to cancel)' },
    'cv.cable.connected':{ ja: '接続しました: {0} [{1}] ⇔ {2} [{3}]', en: 'Connected: {0} [{1}] ⇔ {2} [{3}]' },
    'cv.cable.failed':   { ja: '接続失敗: {0}', en: 'Connection failed: {0}' },
    'cv.portMenu.title': { ja: '{0} — ポートを選択', en: '{0} — choose a port' },
    'cv.portMenu.free':  { ja: '空き', en: 'free' },
    'cv.group.count':    { ja: '{0}台 (ダブルクリックで展開)', en: '{0} devices (double-click to expand)' },
    'cv.group.select':   { ja: '▣ {0} (クリックで選択)', en: '▣ {0} (click to select)' },
    'cv.sub.noIp':       { ja: 'IP未設定', en: 'no IP' },
    'cv.sub.dhcpWait':   { ja: 'DHCP取得中…', en: 'requesting DHCP…' },

    /* ---------- placement modal ---------- */
    'place.title':     { ja: '{0} のインターフェース数', en: '{0} interface count' },
    'place.desc':      { ja: '実機に近い範囲で物理インターフェース数を指定してください。', en: 'Choose the number of physical interfaces within a realistic device range.' },
    'place.portCount': { ja: 'インターフェース数', en: 'Interfaces' },
    'place.range':     { ja: '{0}〜{1} (既定: {2})', en: '{0}–{1} (default: {2})' },
    'place.badCount':  { ja: '{0}〜{1} の整数を入力してください', en: 'Enter an integer from {0} to {1}' },
    'place.create':    { ja: '配置する', en: 'Place' },
    'place.cancel':    { ja: 'キャンセル', en: 'Cancel' },

    /* ---------- terminal banners ---------- */
    'term.close':        { ja: '閉じる', en: 'Close' },
    'term.banner.host':  { ja: 'NetSim {0} console — "help" でコマンド一覧', en: 'NetSim {0} console — type "help" for the command list' },
    'term.banner.hub':   { ja: 'リピータハブ — 設定項目はありません', en: 'Repeater hub — nothing to configure' },
    'term.banner.ios':   { ja: '{0} line console — "enable" で特権モード, "?" でヘルプ', en: '{0} line console — "enable" for privileged mode, "?" for help' },

    /* ---------- main.js hints ---------- */
    'main.restored':     { ja: '前回の構成を復元しました', en: 'Restored your previous topology' },
    'main.sampleLoaded': { ja: 'サンプル構成を読み込みました — PC1をダブルクリックして "ping 10.0.2.10" を試してみてください', en: 'Loaded a sample topology — double-click PC1 and try "ping 10.0.2.10"' },

    /* ---------- toolbar (dynamic) ---------- */
    'tb.notFound':       { ja: '"{0}" は見つかりません', en: '"{0}" not found' },
    'tb.fabTotal':       { ja: '生成規模: スパイン{0} + リーフ{1} + ホスト{2}台', en: 'Size: {0} spines + {1} leaves + {2} hosts' },
    'tb.confirm.fabric': { ja: '現在の構成を破棄してファブリックを生成しますか?', en: 'Discard the current topology and build a fabric?' },
    'tb.fabricDone':     { ja: '生成完了 — OSPFが収束するまで数十秒(シミュレーション時間)かかります。速度を上げると早送りできます', en: 'Done — OSPF takes tens of seconds (simulation time) to converge; raise the speed to fast-forward' },
    'tb.confirm.sample': { ja: '現在の構成を破棄してサンプルを読み込みますか?', en: 'Discard the current topology and load a sample?' },
    'tb.saved':          { ja: 'ブラウザに保存しました', en: 'Saved to browser' },
    'tb.noSave':         { ja: '保存データがありません', en: 'No saved data' },
    'tb.confirm.load':   { ja: '現在の構成を破棄して読み込みますか?', en: 'Discard the current topology and load?' },
    'tb.loaded':         { ja: '読み込みました', en: 'Loaded' },
    'tb.imported':       { ja: 'インポートしました', en: 'Imported' },
    'tb.importFail':     { ja: '読み込みに失敗しました: {0}', en: 'Import failed: {0}' },
    'tb.confirm.clear':  { ja: '全てのデバイスとケーブルを削除しますか?', en: 'Delete all devices and cables?' },

    /* ---------- fabric modal (static HTML) ---------- */
    'fab.title':  { ja: 'スパイン・リーフ ファブリック生成', en: 'Spine-Leaf Fabric Generator' },
    'fab.desc':   { ja: 'L3-to-the-leaf 構成を自動生成します。リンクごとに /30 サブネット、OSPF (ECMP) で全経路を自動学習。ホストはラックごとにグループ化されます。', en: 'Auto-generates an L3-to-the-leaf design. Each link gets a /30 subnet, all routes are learned via OSPF (ECMP), and hosts are grouped by rack.' },
    'fab.spines': { ja: 'スパイン数 (1〜4)', en: 'Spines (1–4)' },
    'fab.leaves': { ja: 'リーフ数 (1〜8)', en: 'Leaves (1–8)' },
    'fab.hosts':  { ja: 'ホスト/リーフ (1〜48)', en: 'Hosts/leaf (1–48)' },
    'fab.build':  { ja: '生成する', en: 'Build' },
    'fab.cancel': { ja: 'キャンセル', en: 'Cancel' },

    /* ---------- help modal (static HTML) ---------- */
    'help.title': { ja: 'NetSim — L1〜L4 ネットワークシミュレーター', en: 'NetSim — L1–L4 Network Simulator' },
    'help.close': { ja: '閉じる', en: 'Close' },
    'help.left': {
      ja: `<h3>構築の流れ</h3>
        <ol>
          <li>左のパレットからデバイスを選び、キャンバスをクリックして配置</li>
          <li>ツールバーの「🔌 結線」でデバイス→ポートを2箇所選んでケーブル接続</li>
          <li>デバイスをクリック → 右パネルでIP/VLANなどを設定<br>(または「コンソール」からCLIで設定)</li>
          <li>PCのコンソールから <code>ping</code> / <code>traceroute</code> / <code>http get</code> を実行し、パケットの流れを観察</li>
        </ol>
        <h3>マウス操作</h3>
        <ul>
          <li>ドラッグ: デバイス移動 / 空白部で画面パン</li>
          <li>ホイール: ズーム</li>
          <li>ダブルクリック: コンソールを開く</li>
          <li>Delete: 選択中のデバイス/リンクを削除</li>
        </ul>`,
      en: `<h3>Getting started</h3>
        <ol>
          <li>Pick a device from the left palette and click the canvas to place it</li>
          <li>Use the toolbar's "🔌 Connect" to pick a device→port at each of two endpoints</li>
          <li>Click a device → configure IP/VLAN etc. in the right panel<br>(or configure via the CLI in a "console")</li>
          <li>From a PC console run <code>ping</code> / <code>traceroute</code> / <code>http get</code> and watch the packets flow</li>
        </ol>
        <h3>Mouse</h3>
        <ul>
          <li>Drag: move a device / pan on empty space</li>
          <li>Wheel: zoom</li>
          <li>Double-click: open a console</li>
          <li>Delete: remove the selected device/link</li>
        </ul>`,
    },
    'help.right': {
      ja: `<h3>PC / サーバのコマンド</h3>
        <ul class="mono">
          <li>set ip 10.0.1.11 255.255.255.0 10.0.1.254</li>
          <li>ping 10.0.2.10 [-c 8]</li>
          <li>traceroute 10.0.2.10</li>
          <li>arp -a / ipconfig</li>
          <li>http get 10.0.2.10 (TCPハンドシェイク観察)</li>
          <li>udp send 10.0.2.10 5000 hello</li>
        </ul>
        <h3>スイッチ/ルータのCLI (Cisco IOS風)</h3>
        <ul class="mono">
          <li>enable → configure terminal</li>
          <li>interface Gi0/1 → switchport access vlan 10</li>
          <li>interface vlan 10 → ip address … (L3スイッチ)</li>
          <li>ip route 0.0.0.0 0.0.0.0 10.0.0.1</li>
          <li>router ospf 1 → network 10.0.0.0 0.255.255.255 area 0</li>
          <li>vrrp 1 ip 10.0.1.1 / channel-group 1 mode on</li>
          <li>show spanning-tree / spanning-tree vlan 1 priority 24576</li>
          <li>ip helper-address 10.0.2.9 (DHCPリレー)</li>
          <li>access-list 100 deny icmp any host 10.0.2.10</li>
          <li>show ip route / show ip ospf neighbor / “?”でヘルプ</li>
          <li>省略形OK: <code>sh ip int br</code>, <code>conf t</code></li>
        </ul>
        <h3>大規模構成</h3>
        <ul>
          <li>「🏭 DC生成」: スパイン・リーフを自動生成 (OSPF+ECMP設定済み)</li>
          <li>Shift+ドラッグ: 複数選択 → 一括IP設定/CLI一括実行/グループ化</li>
          <li>グループ(ラック)はダブルクリックで展開/インスペクタで折りたたみ</li>
          <li>🔍検索でジャンプ / ⛶全体表示 (F) / 🧭自動整列</li>
        </ul>`,
      en: `<h3>PC / Server commands</h3>
        <ul class="mono">
          <li>set ip 10.0.1.11 255.255.255.0 10.0.1.254</li>
          <li>ping 10.0.2.10 [-c 8]</li>
          <li>traceroute 10.0.2.10</li>
          <li>arp -a / ipconfig</li>
          <li>http get 10.0.2.10 (watch the TCP handshake)</li>
          <li>udp send 10.0.2.10 5000 hello</li>
        </ul>
        <h3>Switch / Router CLI (Cisco IOS-style)</h3>
        <ul class="mono">
          <li>enable → configure terminal</li>
          <li>interface Gi0/1 → switchport access vlan 10</li>
          <li>interface vlan 10 → ip address … (L3 switch)</li>
          <li>ip route 0.0.0.0 0.0.0.0 10.0.0.1</li>
          <li>router ospf 1 → network 10.0.0.0 0.255.255.255 area 0</li>
          <li>vrrp 1 ip 10.0.1.1 / channel-group 1 mode on</li>
          <li>show spanning-tree / spanning-tree vlan 1 priority 24576</li>
          <li>ip helper-address 10.0.2.9 (DHCP relay)</li>
          <li>access-list 100 deny icmp any host 10.0.2.10</li>
          <li>show ip route / show ip ospf neighbor / “?” for help</li>
          <li>Abbreviations OK: <code>sh ip int br</code>, <code>conf t</code></li>
        </ul>
        <h3>Large topologies</h3>
        <ul>
          <li>"🏭 Build DC": auto-generate a spine-leaf fabric (OSPF+ECMP preconfigured)</li>
          <li>Shift+drag: multi-select → bulk IP / bulk CLI / grouping</li>
          <li>Groups (racks) expand on double-click / collapse from the inspector</li>
          <li>🔍 search to jump / ⛶ fit (F) / 🧭 auto-arrange</li>
        </ul>`,
    },

    /* ---------- inspector ---------- */
    'insp.guide': {
      ja: `<div class="insp-note">
        <p>デバイスまたはケーブルをクリックすると、ここに設定が表示されます。</p>
        <br>
        <p><b>クイックスタート</b></p>
        <p>1. 左のパレットからデバイスを配置</p>
        <p>2. ツールバー「🔌 結線」でケーブル接続</p>
        <p>3. デバイスを選択してIPなどを設定</p>
        <p>4. ダブルクリックでコンソールを開き<br>&nbsp;&nbsp;&nbsp;ping / traceroute / http get を実行</p>
        <br>
        <p>詳しくはツールバーの「？ヘルプ」へ。</p>
      </div>`,
      en: `<div class="insp-note">
        <p>Click a device or cable to see its settings here.</p>
        <br>
        <p><b>Quick start</b></p>
        <p>1. Place a device from the left palette</p>
        <p>2. Connect cables with the toolbar's "🔌 Connect"</p>
        <p>3. Select a device and set its IP, etc.</p>
        <p>4. Double-click to open a console and run<br>&nbsp;&nbsp;&nbsp;ping / traceroute / http get</p>
        <br>
        <p>See the toolbar's "？ Help" for details.</p>
      </div>`,
    },
    'insp.grp.count':      { ja: 'グループ ({0}台)', en: 'Group ({0} devices)' },
    'insp.rename':         { ja: '変更', en: 'Rename' },
    'insp.grp.expand':     { ja: '⊞ 展開', en: '⊞ Expand' },
    'insp.grp.collapse':   { ja: '⊟ 折りたたむ', en: '⊟ Collapse' },
    'insp.grp.selectMem':  { ja: 'メンバーを選択', en: 'Select members' },
    'insp.grp.ungroup':    { ja: 'グループ解除', en: 'Ungroup' },
    'insp.grp.members':    { ja: 'メンバー', en: 'Members' },
    'insp.multi.selected': { ja: '{0}台を選択中', en: '{0} selected' },
    'insp.multi.group':    { ja: '▣ グループ化 (ラック)', en: '▣ Group (rack)' },
    'insp.multi.delAll':   { ja: '✕ 全て削除', en: '✕ Delete all' },
    'insp.multi.bulkIp':   { ja: '一括IP設定 ({0}台のホスト)', en: 'Bulk IP ({0} hosts)' },
    'insp.multi.startIp':  { ja: '開始IP', en: 'Start IP' },
    'insp.mask':           { ja: 'マスク', en: 'Mask' },
    'insp.gw':             { ja: 'GW', en: 'GW' },
    'insp.multi.applySeq': { ja: '連番で適用', en: 'Apply sequentially' },
    'insp.multi.dhcp':     { ja: 'DHCPで取得', en: 'Use DHCP' },
    'insp.multi.bulkCli':  { ja: 'CLI一括実行 ({0}台のSW/RT)', en: 'Bulk CLI ({0} SW/RT)' },
    'insp.multi.cliRun':   { ja: '全台に実行', en: 'Run on all' },
    'insp.multi.confirmDel':{ ja: '{0}台のデバイスを削除しますか?', en: 'Delete {0} devices?' },
    'insp.multi.badStart': { ja: '開始IP/マスクが不正です', en: 'Invalid start IP / mask' },
    'insp.multi.badGw':    { ja: 'GWが不正です', en: 'Invalid GW' },
    'insp.multi.ipApplied':{ ja: '{0}台に {1} から連番で設定しました', en: 'Set {0} devices sequentially from {1}' },
    'insp.multi.dhcpStart':{ ja: '{0}台がDHCP取得を開始しました', en: '{0} devices started DHCP' },
    'insp.multi.cliDone':  { ja: '{0}台に {1} 行を実行しました', en: 'Ran {1} lines on {0} devices' },
    'insp.link.title':     { ja: 'ケーブル', en: 'Cable' },
    'insp.link.type':      { ja: '全二重リンク', en: 'Full-duplex link' },
    'insp.link.device':    { ja: 'デバイス', en: 'Device' },
    'insp.link.traffic':   { ja: 'ライブ通信量', en: 'Live traffic' },
    'insp.link.total':     { ja: '双方向の累計', en: 'Total both directions' },
    'insp.link.totalShort':{ ja: '累計', en: 'Total' },
    'insp.link.trafficNote':{ ja: '利用率は直近1秒の流量 ÷ 方向ごとの帯域上限', en: 'Utilization is traffic in the last second ÷ per-direction bandwidth' },
    'insp.link.network':   { ja: 'リンク特性', en: 'Link characteristics' },
    'insp.link.profile':   { ja: 'プリセット', en: 'Preset' },
    'insp.link.custom':    { ja: 'カスタム', en: 'Custom' },
    'insp.link.lan':       { ja: 'LAN (1 Gbps / 1 ms)', en: 'LAN (1 Gbps / 1 ms)' },
    'insp.link.metro':     { ja: 'メトロ (1 Gbps / 5 ms)', en: 'Metro (1 Gbps / 5 ms)' },
    'insp.link.wan':       { ja: 'WAN (100 Mbps / 40 ms)', en: 'WAN (100 Mbps / 40 ms)' },
    'insp.link.mobile':    { ja: 'モバイル (20 Mbps / 60±15 ms)', en: 'Mobile (20 Mbps / 60±15 ms)' },
    'insp.link.satellite': { ja: '衛星 (25 Mbps / 300±20 ms)', en: 'Satellite (25 Mbps / 300±20 ms)' },
    'insp.link.bandwidth': { ja: '帯域 (Mbps)', en: 'Bandwidth (Mbps)' },
    'insp.link.latency':   { ja: '片方向遅延 (ms)', en: 'One-way latency (ms)' },
    'insp.link.jitter':    { ja: 'jitter ± (ms)', en: 'Jitter ± (ms)' },
    'insp.link.queue':     { ja: 'FIFO上限 (packet)', en: 'FIFO limit (packets)' },
    'insp.link.effective': { ja: '実効latency: max(個別 {0}ms, 基準 {1}ms) = {2}ms', en: 'Effective latency: max(link {0}ms, floor {1}ms) = {2}ms' },
    'insp.link.drops':     { ja: 'キュー破棄: {0}', en: 'Queue drops: {0}' },
    'insp.link.bad':       { ja: '値の範囲を確認してください', en: 'Check the value ranges' },
    'insp.col.port':       { ja: 'ポート', en: 'Port' },
    'insp.col.status':     { ja: '状態', en: 'Status' },
    'insp.col.peer':       { ja: '接続先', en: 'Connected to' },
    'insp.link.del':       { ja: '✕ ケーブルを削除', en: '✕ Delete cable' },
    'insp.openConsole':    { ja: '⌨ コンソールを開く', en: '⌨ Open console' },
    'insp.del':            { ja: '✕ 削除', en: '✕ Delete' },
    'insp.name':           { ja: '名前', en: 'Name' },
    'insp.apply':          { ja: '適用', en: 'Apply' },
    'insp.add':            { ja: '追加', en: 'Add' },
    'insp.none':           { ja: '(なし)', en: '(none)' },
    'insp.host.ipConfig':  { ja: 'IP設定', en: 'IP settings' },
    'insp.host.ip':        { ja: 'IPアドレス', en: 'IP address' },
    'insp.host.mask':      { ja: 'サブネットマスク', en: 'Subnet mask' },
    'insp.host.maskPh':    { ja: '255.255.255.0 か /24', en: '255.255.255.0 or /24' },
    'insp.host.gw':        { ja: 'デフォルトGW', en: 'Default GW' },
    'insp.host.dhcpRenew': { ja: 'DHCP再取得', en: 'Renew DHCP' },
    'insp.host.dhcpGet':   { ja: 'DHCPで自動取得', en: 'Use DHCP' },
    'insp.host.dhcpBound': { ja: 'DHCPで取得済み', en: 'Leased via DHCP' },
    'insp.host.dhcpWait':  { ja: 'DHCP取得中…', en: 'Requesting DHCP…' },
    'insp.host.services':  { ja: 'サービス', en: 'Services' },
    'insp.host.http':      { ja: 'HTTPサーバ (TCP:80)', en: 'HTTP server (TCP:80)' },
    'insp.host.dhcpdPoolsNone': { ja: 'プール未設定', en: 'no pools' },
    'insp.host.dhcpdOn':   { ja: 'DHCPサーバ: 有効 ({0} / リース {1}件)<br>設定はコンソール: <code>dhcp pool ...</code>', en: 'DHCP server: on ({0} / {1} leases)<br>Configure in the console: <code>dhcp pool ...</code>' },
    'insp.host.dhcpdOff':  { ja: 'DHCPサーバはコンソールで設定: <code>dhcp pool 10.0.1.0/24 10.0.1.100 10.0.1.199 10.0.1.1</code>', en: 'Configure the DHCP server in the console: <code>dhcp pool 10.0.1.0/24 10.0.1.100 10.0.1.199 10.0.1.1</code>' },
    'insp.host.connection':{ ja: '接続', en: 'Connection' },
    'insp.msg.badIp':      { ja: '不正なIPです', en: 'Invalid IP' },
    'insp.msg.badMask':    { ja: '不正なマスクです', en: 'Invalid mask' },
    'insp.msg.badGw':      { ja: '不正なGWです', en: 'Invalid GW' },
    'insp.msg.set':        { ja: '設定しました', en: 'Applied' },
    'insp.lb.title':       { ja: 'ロードバランサ (L4 / round-robin)', en: 'Load balancer (L4 / round-robin)' },
    'insp.lb.listenPort':  { ja: '待受ポート', en: 'Listen port' },
    'insp.lb.reconfig':    { ja: '再設定', en: 'Reconfigure' },
    'insp.lb.start':       { ja: '開始', en: 'Start' },
    'insp.lb.backend':     { ja: 'バックエンド', en: 'Backend' },
    'insp.lb.conns':       { ja: '接続数', en: 'Conns' },
    'insp.vrrp.title':     { ja: 'VRRP', en: 'VRRP' },
    'insp.vrrp.grp':       { ja: 'Grp', en: 'Grp' },
    'insp.vrrp.pri':       { ja: 'Pri', en: 'Pri' },
    'insp.vrrp.vip':       { ja: 'Virtual IP', en: 'Virtual IP' },
    'insp.vrrp.note':      { ja: '設定はCLIで行います: <code>vrrp &lt;grp&gt; ip &lt;VIP&gt;</code> / <code>vrrp &lt;grp&gt; priority &lt;1-255&gt;</code><br>確認: <code>show vrrp brief</code>', en: 'Configure in the CLI: <code>vrrp &lt;grp&gt; ip &lt;VIP&gt;</code> / <code>vrrp &lt;grp&gt; priority &lt;1-255&gt;</code><br>Check: <code>show vrrp brief</code>' },
    'insp.ospf.title':     { ja: 'OSPF', en: 'OSPF' },
    'insp.ospf.on':        { ja: '有効 (RID {0}, ネイバー {1}件, OSPF経路 {2}件)', en: 'on (RID {0}, {1} neighbors, {2} OSPF routes)' },
    'insp.ospf.ridPending':{ ja: '未決定', en: 'pending' },
    'insp.ospf.off':       { ja: '無効', en: 'off' },
    'insp.ospf.status':    { ja: '状態', en: 'Status' },
    'insp.ospf.note':      { ja: '設定はCLI: <code>router ospf 1</code> → <code>network 10.0.0.0 0.255.255.255 area 0</code><br>複数areaではarea 0接続のABRが必要。確認: <code>show ip ospf neighbor</code> / <code>show ip ospf database</code> / <code>show ip route</code>', en: 'Configure in the CLI: <code>router ospf 1</code> → <code>network 10.0.0.0 0.255.255.255 area 0</code><br>Multi-area routing requires an ABR connected to area 0. Check: <code>show ip ospf neighbor</code> / <code>show ip ospf database</code> / <code>show ip route</code>' },
    'insp.hub.ports':      { ja: 'ポート (リピータ動作)', en: 'Ports (repeater)' },
    'insp.hub.note':       { ja: 'ハブは受信フレームを全ポートへ中継します (衝突ドメインの学習用)', en: 'A hub repeats received frames to all ports (for learning collision domains)' },
    'insp.sw.vlan':        { ja: 'VLAN', en: 'VLAN' },
    'insp.sw.newIdPh':     { ja: 'ID', en: 'ID' },
    'insp.sw.newNamePh':   { ja: '名前 (任意)', en: 'Name (optional)' },
    'insp.sw.portConfig':  { ja: 'ポート設定', en: 'Port settings' },
    'insp.sw.mode':        { ja: 'モード', en: 'Mode' },
    'insp.sw.allowedT':    { ja: '許可VLAN', en: 'Allowed VLANs' },
    'insp.sw.note':        { ja: 'トランクの許可VLAN・ネイティブVLANはCLIで設定:<br><code>switchport trunk allowed vlan 10,20</code>', en: 'Set trunk allowed / native VLANs in the CLI:<br><code>switchport trunk allowed vlan 10,20</code>' },
    'insp.svi.title':      { ja: 'SVI (VLANインターフェース)', en: 'SVI (VLAN interfaces)' },
    'insp.svi.ip':         { ja: 'IPアドレス', en: 'IP address' },
    'insp.svi.mask':       { ja: 'マスク', en: 'Mask' },
    'insp.svi.add':        { ja: 'SVI追加', en: 'Add SVI' },
    'insp.svi.newPh':      { ja: 'VLAN ID', en: 'VLAN ID' },
    'insp.del.t':          { ja: '削除', en: 'Delete' },
    'insp.rt.ifaces':      { ja: 'インターフェース', en: 'Interfaces' },
    'insp.rt.ip':          { ja: 'IPアドレス', en: 'IP address' },
    'insp.rt.mask':        { ja: 'マスク', en: 'Mask' },
    'insp.rt.shutdownNote':{ ja: '※ 新品のルータIFは shutdown 状態です', en: '※ New router interfaces start shut down' },
    'insp.rt.aclNote':     { ja: 'ACLはCLIで設定: <code>access-list 100 …</code> → <code>ip access-group 100 in</code>', en: 'Configure ACLs in the CLI: <code>access-list 100 …</code> → <code>ip access-group 100 in</code>' },
    'insp.nat.ifTitle':    { ja: 'NAT — 内側/外側インターフェース', en: 'NAT — inside/outside interfaces' },
    'insp.nat.staticTitle':{ ja: '静的NAT (1:1)', en: 'Static NAT (1:1)' },
    'insp.nat.localPh':    { ja: '内部IP', en: 'Inside IP' },
    'insp.nat.globalPh':   { ja: 'グローバルIP', en: 'Global IP' },
    'insp.nat.dynTitle':   { ja: '動的PAT (overload)', en: 'Dynamic PAT (overload)' },
    'insp.nat.dynNone':    { ja: '(未設定)', en: '(not configured)' },
    'insp.nat.dynNote':    { ja: '設定はCLI:<br><code>access-list 100 permit ip 10.0.1.0 0.0.0.255 any</code><br><code>ip nat inside source list 100 interface Gi0/1 overload</code>', en: 'Configure in the CLI:<br><code>access-list 100 permit ip 10.0.1.0 0.0.0.255 any</code><br><code>ip nat inside source list 100 interface Gi0/1 overload</code>' },
    'insp.nat.transTitle': { ja: '変換テーブル ({0})', en: 'Translations ({0})' },
    'insp.nat.badIp':      { ja: 'IPアドレスが不正です', en: 'Invalid IP address' },
    'insp.acl.title':      { ja: 'ACL', en: 'ACL' },
    'insp.acl.rule':       { ja: '規則', en: 'Rule' },
    'insp.acl.applied':    { ja: 'インターフェース適用', en: 'Interface attachment' },
    'insp.acl.note':       { ja: 'ACLの追加・変更はコンソールで設定します: <code>access-list 100 permit|deny ...</code>', en: 'Add or change ACLs in the console: <code>access-list 100 permit|deny ...</code>' },
    'insp.vxlan.title':    { ja: 'VXLAN (VTEP)', en: 'VXLAN (VTEP)' },
    'insp.vxlan.off':      { ja: '未設定', en: 'Not configured' },
    'insp.vxlan.source':   { ja: '送信元IF', en: 'Source interface' },
    'insp.vxlan.localVtep':{ ja: 'ローカルVTEP', en: 'Local VTEP' },
    'insp.vxlan.note':     { ja: '設定はCLI: <code>vxlan vni 10100 vlan 10 source-interface Vlan151</code><br><code>vxlan peer 10.0.10.12</code><br>inner Ethernet を UDP/4789 でカプセル化します。制御プレーンは静的VTEPリストです。', en: 'Configure in the CLI: <code>vxlan vni 10100 vlan 10 source-interface Vlan151</code><br><code>vxlan peer 10.0.10.12</code><br>Inner Ethernet is encapsulated in UDP/4789; the control plane is a static VTEP list.' },
    'insp.route.title':    { ja: 'スタティックルート', en: 'Static routes' },
    'insp.route.nhPh':     { ja: 'ネクストホップ', en: 'Next hop' },
    'insp.route.badNet':   { ja: '宛先は 10.0.2.0/24 の形式で', en: 'Destination must look like 10.0.2.0/24' },
    'insp.route.badNh':    { ja: '不正なネクストホップです', en: 'Invalid next hop' },

    /* ---------- CLI help strings (shown by "?") ---------- */
    'cli.h.enable':        { ja: '特権モードへ移行', en: 'Enter privileged mode' },
    'cli.h.exitSession':   { ja: 'セッション終了', en: 'End session' },
    'cli.h.disable':       { ja: 'ユーザモードへ戻る', en: 'Return to user mode' },
    'cli.h.toEnable':      { ja: '特権モードへ戻る', en: 'Return to privileged mode' },
    'cli.h.confTerm':      { ja: 'グローバル設定モード', en: 'Global configuration mode' },
    'cli.h.write':         { ja: '設定保存 (シミュレータでは常時保存)', en: 'Save config (always saved in this simulator)' },
    'cli.h.copyRun':       { ja: '設定保存', en: 'Save config' },
    'cli.h.shutAll':       { ja: '全物理インターフェースを無効化', en: 'Disable all physical interfaces' },
    'cli.h.noShutAll':     { ja: '全物理インターフェースを有効化', en: 'Enable all physical interfaces' },
    'cli.h.clearMac':      { ja: 'MACアドレステーブルをクリア', en: 'Clear the MAC address table' },
    'cli.h.clearNat':      { ja: 'NAT動的変換をクリア', en: 'Clear dynamic NAT translations' },
    'cli.h.clearArp':      { ja: 'ARPキャッシュをクリア', en: 'Clear the ARP cache' },
    'cli.h.ping':          { ja: 'ICMPエコー送信', en: 'Send ICMP echo' },
    'cli.h.traceroute':    { ja: '経路表示', en: 'Trace the route' },
    'cli.h.hostname':      { ja: 'ホスト名を設定', en: 'Set the hostname' },
    'cli.h.interface':     { ja: 'インターフェース設定', en: 'Configure an interface' },
    'cli.h.noInterface':   { ja: 'SVIを削除', en: 'Delete an SVI' },
    'cli.h.ipRouting':     { ja: 'IPルーティングを有効化', en: 'Enable IP routing' },
    'cli.h.vlanCreate':    { ja: 'VLANを作成', en: 'Create a VLAN' },
    'cli.h.vlanDelete':    { ja: 'VLANを削除', en: 'Delete a VLAN' },
    'cli.h.ipRoute':       { ja: 'スタティックルート追加', en: 'Add a static route' },
    'cli.h.noIpRoute':     { ja: 'スタティックルート削除', en: 'Delete a static route' },
    'cli.h.acl':           { ja: 'ACLエントリ追加 (permit|deny proto src dst [eq port])', en: 'Add an ACL entry (permit|deny proto src dst [eq port])' },
    'cli.h.noAcl':         { ja: 'ACLを削除', en: 'Delete an ACL' },
    'cli.h.natStatic':     { ja: '静的NAT (内部→グローバル 1:1)', en: 'Static NAT (inside→global 1:1)' },
    'cli.h.noNatStatic':   { ja: '静的NATを削除', en: 'Delete static NAT' },
    'cli.h.natDyn':        { ja: '動的PAT (ACL一致トラフィックを指定IFのアドレスへ過負荷変換)', en: 'Dynamic PAT (overload ACL-matched traffic onto an interface address)' },
    'cli.h.noNatDyn':      { ja: '動的PATを削除', en: 'Delete dynamic PAT' },
    'cli.h.vxlanSource':   { ja: 'VXLAN VNI・ローカルVLAN・送信元VTEPインターフェースを設定', en: 'Configure VXLAN VNI, local VLAN, and source VTEP interface' },
    'cli.h.vxlanPeer':     { ja: 'リモートVTEPを追加（静的ingress replication）', en: 'Add a remote VTEP (static ingress replication)' },
    'cli.h.noVxlan':       { ja: 'VXLAN設定を削除', en: 'Remove VXLAN configuration' },
    'cli.h.routerOspf':    { ja: 'OSPFプロセスを開始', en: 'Start an OSPF process' },
    'cli.h.noRouterOspf':  { ja: 'OSPFプロセスを停止', en: 'Stop the OSPF process' },
    'cli.h.routerId':      { ja: 'ルータIDを設定', en: 'Set the router ID' },
    'cli.h.network':       { ja: '対象ネットワークを追加 (net wildcard area)', en: 'Add a network (net wildcard area)' },
    'cli.h.noNetwork':     { ja: '対象ネットワークを削除', en: 'Remove a network' },
    'cli.h.passive':       { ja: 'ヘロー送信を抑止 (経路広告は継続)', en: 'Suppress Hellos (keep advertising routes)' },
    'cli.h.noPassive':     { ja: 'passive-interfaceを解除', en: 'Clear passive-interface' },
    'cli.h.toConfig':      { ja: 'グローバル設定へ戻る', en: 'Return to global config' },
    'cli.h.ifShutdown':    { ja: 'インターフェースを無効化', en: 'Disable the interface' },
    'cli.h.ifNoShutdown':  { ja: 'インターフェースを有効化', en: 'Enable the interface' },
    'cli.h.description':   { ja: '説明を設定', en: 'Set a description' },
    'cli.h.swAccess':      { ja: 'アクセスポートに設定', en: 'Set as an access port' },
    'cli.h.swTrunk':       { ja: 'トランクポートに設定', en: 'Set as a trunk port' },
    'cli.h.swAccessVlan':  { ja: 'アクセスVLANを設定', en: 'Set the access VLAN' },
    'cli.h.swAllowed':     { ja: '許可VLANを設定 (all | 10,20 | add 30)', en: 'Set allowed VLANs (all | 10,20 | add 30)' },
    'cli.h.swNative':      { ja: 'ネイティブVLANを設定', en: 'Set the native VLAN' },
    'cli.h.stpPriority':   { ja: 'STPブリッジ優先度を設定', en: 'Set STP bridge priority' },
    'cli.h.stpMode':       { ja: 'STPモードを設定', en: 'Set STP mode' },
    'cli.h.ipAddress':     { ja: 'IPアドレスを設定', en: 'Set the IP address' },
    'cli.h.noIpAddress':   { ja: 'IPアドレスを削除', en: 'Remove the IP address' },
    'cli.h.ospfCost':      { ja: 'OSPFコストを設定', en: 'Set the OSPF cost' },
    'cli.h.helper':        { ja: 'DHCPリレー先を設定', en: 'Set a DHCP relay target' },
    'cli.h.noHelper':      { ja: 'DHCPリレーを解除', en: 'Clear DHCP relay' },
    'cli.h.vrrpIp':        { ja: 'VRRP仮想IPを設定', en: 'Set the VRRP virtual IP' },
    'cli.h.vrrpPri':       { ja: 'VRRP優先度を設定 (デフォルト100)', en: 'Set VRRP priority (default 100)' },
    'cli.h.noVrrp':        { ja: 'VRRPを解除', en: 'Remove VRRP' },
    'cli.h.channelGroup':  { ja: '静的ポートチャネルに参加 (mode on)', en: 'Join a static port channel (mode on)' },
    'cli.h.noChannelGroup':{ ja: 'ポートチャネルから離脱', en: 'Leave the port channel' },
    'cli.h.aclIn':         { ja: '受信方向ACLを適用', en: 'Apply an inbound ACL' },
    'cli.h.aclOut':        { ja: '送信方向ACLを適用', en: 'Apply an outbound ACL' },
    'cli.h.noAclIn':       { ja: '受信方向ACLを解除', en: 'Remove the inbound ACL' },
    'cli.h.noAclOut':      { ja: '送信方向ACLを解除', en: 'Remove the outbound ACL' },
    'cli.h.natInside':     { ja: 'NAT内側(プライベート側)インターフェースに指定', en: 'Mark as the NAT inside (private) interface' },
    'cli.h.natOutside':    { ja: 'NAT外側(グローバル側)インターフェースに指定', en: 'Mark as the NAT outside (global) interface' },
    'cli.h.noNatInside':   { ja: 'NAT内側指定を解除', en: 'Clear the NAT inside marking' },
    'cli.h.noNatOutside':  { ja: 'NAT外側指定を解除', en: 'Clear the NAT outside marking' },
    'cli.h.vlanName':      { ja: 'VLAN名を設定', en: 'Set the VLAN name' },
    'cli.h.showRun':       { ja: '現在の設定を表示', en: 'Show the running configuration' },
    'cli.h.showVersion':   { ja: 'バージョン情報', en: 'Version information' },
    'cli.h.showIpIntBrief':{ ja: 'L3インターフェース一覧', en: 'List L3 interfaces' },
    'cli.h.showIpRoute':   { ja: 'ルーティングテーブル', en: 'Routing table' },
    'cli.h.showArp':       { ja: 'ARPテーブル', en: 'ARP table' },
    'cli.h.showOspfNbr':   { ja: 'OSPFネイバー一覧', en: 'List OSPF neighbors' },
    'cli.h.showOspfDb':    { ja: 'OSPF LSDB', en: 'OSPF LSDB' },
    'cli.h.showVrrp':      { ja: 'VRRP状態一覧', en: 'VRRP status' },
    'cli.h.showEther':     { ja: 'ポートチャネル一覧', en: 'List port channels' },
    'cli.h.showMac':       { ja: 'MACアドレステーブル', en: 'MAC address table' },
    'cli.h.showStp':       { ja: 'STP状態を表示', en: 'Show spanning-tree status' },
    'cli.h.showVlan':      { ja: 'VLAN一覧', en: 'List VLANs' },
    'cli.h.showIntStatus': { ja: 'ポート状態一覧', en: 'Interface status' },
    'cli.h.showAcls':      { ja: 'ACL一覧', en: 'List ACLs' },
    'cli.h.showNat':       { ja: 'NAT変換テーブル', en: 'NAT translation table' },
    'cli.h.showVxlan':     { ja: 'VXLAN VNI・VLAN・VTEP一覧を表示', en: 'Show VXLAN VNI, VLAN, and VTEPs' },

    /* ---------- CLI runtime messages ---------- */
    'cli.m.invalidInput':  { ja: '% Invalid input detected: "{0}"  ("?" でヘルプ表示)', en: '% Invalid input detected: "{0}"  (type "?" for help)' },
    'cli.m.ambiguous':     { ja: '% Ambiguous command: 候補が複数あります ("?" で確認)', en: '% Ambiguous command: multiple matches (type "?" to check)' },
    'cli.m.natCleared':    { ja: '%NAT: 動的変換テーブルをクリアしました', en: '%NAT: cleared the dynamic translation table' },
    'cli.m.vxlanBad':      { ja: '% VXLAN VNI は 1〜16777215、VLAN は 1〜4094、送信元は有効なL3インターフェースである必要があります', en: '% VXLAN VNI must be 1-16777215, VLAN 1-4094, and the source a valid L3 interface' },
    'cli.m.vxlanNeedSource': { ja: '% 先に vxlan vni ... source-interface ... を設定してください', en: '% Configure VXLAN VNI and source interface first' },
    'cli.m.sviNotFound':   { ja: '% SVI が見つかりません', en: '% SVI not found' },
    'cli.m.ipRoutingAlways':{ ja: '(このモデルでは常に有効です)', en: '(always enabled in this model)' },
    'cli.m.vlanRange':     { ja: '% VLAN IDは1〜4094', en: '% VLAN ID must be 1–4094' },
    'cli.m.badMask':       { ja: '% 不正なサブネットマスクです', en: '% Invalid subnet mask' },
    'cli.m.ifNotFound':    { ja: '% インターフェースが見つかりません', en: '% Interface not found' },
    'cli.m.linkDown':      { ja: '%LINK: {0} を administratively down にしました', en: '%LINK: {0} is now administratively down' },
    'cli.m.linkUp':        { ja: '%LINK: {0} を up にしました', en: '%LINK: {0} is now up' },
    'cli.m.sviNoShutdown': { ja: '% SVI に shutdown は未対応です', en: '% shutdown is not supported on an SVI' },
    'cli.m.vlanAutoCreated':{ ja: '% VLAN {0} を自動作成しました', en: '% Auto-created VLAN {0}' },
    'cli.m.noIpOnIface':   { ja: '% このインターフェースにIPは設定できません', en: '% This interface cannot take an IP' },
    'cli.m.notL3':         { ja: '% L3インターフェースではありません', en: '% Not an L3 interface' },
    'cli.m.vrrpNeedIp':    { ja: '% 先に vrrp <グループ> ip <IP> を設定してください', en: '% Configure vrrp <group> ip <IP> first' },
    'cli.m.vrrpGroupRange':{ ja: '% VRRPグループは 1〜255 で指定してください', en: '% VRRP group must be 1–255' },
    'cli.m.vrrpPriRange':  { ja: '% VRRP priority は 1〜255 で指定してください', en: '% VRRP priority must be 1–255' },
    'cli.m.ospfAreaRange': { ja: '% OSPF area は 0〜4294967295 で指定してください', en: '% OSPF area must be 0–4294967295' },
    'cli.m.staticChannelOnly': { ja: '% このモデルのポートチャネルは静的 mode on のみ対応です', en: '% This model supports static port-channel mode on only' },
    'cli.m.notPhysPort':   { ja: '% 物理ポートではありません', en: '% Not a physical port' },
    'cli.m.setAllPorts':   { ja: '%LINK: {0}個のインターフェースを {1} にしました', en: '%LINK: set {0} interfaces to {1}' },
    'cli.m.sviCreated':    { ja: '%SVI Vlan{0} を作成しました', en: '%SVI Vlan{0} created' },
    'cli.m.ifNotFoundName':{ ja: '% インターフェース "{0}" が見つかりません', en: '% Interface "{0}" not found' },
    'cli.m.aclUsage':      { ja: '% 使い方: access-list <番号> permit|deny <ip|icmp|tcp|udp> <送信元> <宛先> [eq <ポート>]', en: '% Usage: access-list <num> permit|deny <ip|icmp|tcp|udp> <src> <dst> [eq <port>]' },
    'cli.m.aclProto':      { ja: '% プロトコルは ip|icmp|tcp|udp', en: '% Protocol must be ip|icmp|tcp|udp' },
    'cli.m.aclSrc':        { ja: '% 送信元は any | host <IP> | <net> <wildcard>', en: '% Source must be any | host <IP> | <net> <wildcard>' },
    'cli.m.aclDst':        { ja: '% 宛先は any | host <IP> | <net> <wildcard>', en: '% Destination must be any | host <IP> | <net> <wildcard>' },
    'cli.m.aclPort':       { ja: '% ポート指定は eq <番号>', en: '% Port must be given as eq <num>' },
    'cli.o.noRoutes':      { ja: '   (経路がありません)', en: '   (no routes)' },
    'cli.o.unresolved':    { ja: ' (未解決)', en: ' (unresolved)' },
    'cli.o.ospfNotRunning':{ ja: '% OSPFは動作していません', en: '% OSPF is not running' },
    'cli.o.pending':       { ja: '(未決定)', en: '(pending)' },
    'cli.o.noNeighbors':   { ja: '  (ネイバーなし)', en: '  (no neighbors)' },
    'cli.o.noLsa':         { ja: '  (LSAなし)', en: '  (no LSAs)' },
    'cli.o.noVrrp':        { ja: '  (VRRP設定なし)', en: '  (no VRRP configured)' },
    'cli.o.noPortChannel': { ja: '  (ポートチャネルなし)', en: '  (no port channels)' },
    'cli.o.etherLegend':   { ja: '  (P)=バンドル中 (D)=ダウン — フレームはフローハッシュでメンバーに分散されます', en: '  (P)=bundled (D)=down — frames are spread across members by flow hash' },
    'cli.o.noMacEntries':  { ja: '        (エントリなし)', en: '        (no entries)' },
    'cli.o.natUnsupported':{ ja: '% このデバイスはNAT非対応です', en: '% This device does not support NAT' },
    'cli.o.natNotConfigured':{ ja: '% NATは設定されていません', en: '% NAT is not configured' },
    'cli.o.natNoActive':   { ja: '  (アクティブな変換はありません)', en: '  (no active translations)' },
    'cli.o.vxlanNotConfigured': { ja: '% VXLANは設定されていません', en: '% VXLAN is not configured' },
    'cli.o.noAcls':        { ja: '(ACLはありません)', en: '(no ACLs)' },

    /* ---------- host console ---------- */
    'host.help': {
      ja: [
        'コマンド一覧:',
        '  ipconfig                          IP設定の表示',
        '  set ip <IP> <サブネットマスク> [GW]   IPアドレス設定',
        '  ping <IP> [-c 回数]               ICMPエコー送信',
        '  traceroute <IP>                   経路の表示 (UDP+TTL)',
        '  arp -a | arp -d                   ARPテーブル表示 / クリア',
        '  http get <IP> [ポート]            HTTP GET (TCP)',
        '  http server on|off                HTTPサーバ起動/停止 (TCP:80)',
        '  udp send <IP> <ポート> <文字列>   UDPデータグラム送信',
        '  udp listen <ポート> / unlisten    UDP待ち受け',
        '  set ip dhcp                       DHCPでIPを自動取得',
        '  dhcp pool <net>/<len> <開始> <終了> <GW>   DHCPサーバのプール設定',
        '  dhcp server on|off / dhcp leases  DHCPサーバ制御',
        '  shutdown / no shutdown            NICを無効化 / 有効化',
        '  hostname <名前>                   ホスト名変更',
        '  clear                             画面クリア',
      ].join('\n'),
      en: [
        'Commands:',
        '  ipconfig                          Show IP settings',
        '  set ip <IP> <subnet mask> [GW]    Configure the IP address',
        '  ping <IP> [-c count]              Send ICMP echo',
        '  traceroute <IP>                   Trace the route (UDP+TTL)',
        '  arp -a | arp -d                   Show / clear the ARP table',
        '  http get <IP> [port]              HTTP GET (TCP)',
        '  http server on|off                Start/stop the HTTP server (TCP:80)',
        '  udp send <IP> <port> <text>       Send a UDP datagram',
        '  udp listen <port> / unlisten      Listen on UDP',
        '  set ip dhcp                       Obtain an IP via DHCP',
        '  dhcp pool <net>/<len> <start> <end> <GW>   Configure a DHCP server pool',
        '  dhcp server on|off / dhcp leases  Control the DHCP server',
        '  shutdown / no shutdown            Disable / enable the NIC',
        '  hostname <name>                   Change the hostname',
        '  clear                             Clear the screen',
      ].join('\n'),
    },
    'host.k.ipv4':       { ja: 'IPv4 アドレス', en: 'IPv4 address' },
    'host.k.subnet':     { ja: 'サブネットマスク', en: 'Subnet mask' },
    'host.k.defgw':      { ja: 'デフォルトゲートウェイ', en: 'Default gateway' },
    'host.m.viaDhcp':    { ja: ' (DHCPで取得)', en: ' (via DHCP)' },
    'host.m.notSet':     { ja: '(未設定)', en: '(not set)' },
    'host.m.none':       { ja: 'なし', en: 'none' },
    'host.m.dhcpWaiting':{ ja: '  IPv4 アドレス: (DHCP取得中...)', en: '  IPv4 address: (requesting DHCP...)' },
    'host.m.noIpHint':   { ja: '  IPv4 アドレス: (未設定)  — "set ip" で設定してください', en: '  IPv4 address: (not set)  — use "set ip" to configure' },
    'host.m.dhcpStart':  { ja: 'DHCPでアドレスを取得します...', en: 'Requesting an address via DHCP...' },
    'host.m.setIpUsage': { ja: '使い方: set ip <IP> <マスク> [ゲートウェイ] / set ip dhcp', en: 'Usage: set ip <IP> <mask> [gateway] / set ip dhcp' },
    'host.m.badAddrMask':{ ja: '% 不正なアドレス/マスクです', en: '% Invalid address / mask' },
    'host.m.badGw':      { ja: '% 不正なゲートウェイです', en: '% Invalid gateway' },
    'host.m.gwNotInSubnet':{ ja: '警告: ゲートウェイが同一サブネットにありません', en: 'Warning: the gateway is not in the same subnet' },
    'host.m.hostnameUsage':{ ja: '使い方: hostname <名前>', en: 'Usage: hostname <name>' },
    'host.m.unknownCmd': { ja: "'{0}' は認識されないコマンドです。'help' で一覧を表示します。", en: "'{0}' is not a recognized command. Type 'help' for the list." },
    'host.m.pingUsage':  { ja: '使い方: ping <IP> [-c 回数]', en: 'Usage: ping <IP> [-c count]' },
    'host.m.noIp':       { ja: '% IPアドレスが未設定です', en: '% No IP address configured' },
    'host.m.traceUsage': { ja: '使い方: traceroute <IP>', en: 'Usage: traceroute <IP>' },
    'host.m.arpCleared': { ja: 'ARPテーブルをクリアしました', en: 'Cleared the ARP table' },
    'host.m.arpEmpty':   { ja: 'ARPテーブルは空です', en: 'The ARP table is empty' },
    'host.m.arpHeader':  { ja: '  IPアドレス        MACアドレス          種類', en: '  IP address        MAC address          Type' },
    'host.m.httpStarted':{ ja: 'HTTPサーバを起動しました (TCP:80 待ち受け)', en: 'HTTP server started (listening on TCP:80)' },
    'host.m.httpStopped':{ ja: 'HTTPサーバを停止しました', en: 'HTTP server stopped' },
    'host.m.httpGetUsage':{ ja: '使い方: http get <IP> [ポート]', en: 'Usage: http get <IP> [port]' },
    'host.m.connected':  { ja: 'Connected (3-way handshake 完了) local={0}', en: 'Connected (3-way handshake done) local={0}' },
    'host.m.connClosedFin':{ ja: '接続を終了しました (FIN)', en: 'Connection closed (FIN)' },
    'host.m.connClosed': { ja: '接続が閉じられました', en: 'Connection closed' },
    'host.m.error':      { ja: 'エラー: {0}', en: 'Error: {0}' },
    'host.m.httpUsage2': { ja: '使い方: http get <IP> [ポート] / http server on|off', en: 'Usage: http get <IP> [port] / http server on|off' },
    'host.m.udpSendUsage':{ ja: '使い方: udp send <IP> <ポート> <文字列>', en: 'Usage: udp send <IP> <port> <text>' },
    'host.m.noRoute':    { ja: '% 経路がありません', en: '% No route' },
    'host.m.udpListenUsage':{ ja: '使い方: udp listen <ポート>', en: 'Usage: udp listen <port>' },
    'host.m.udpRecv':    { ja: '[udp:{0}] {1}:{2} から受信: "{3}"', en: '[udp:{0}] received from {1}:{2}: "{3}"' },
    'host.m.udpListening':{ ja: 'UDP ポート {0} で待ち受け開始', en: 'Listening on UDP port {0}' },
    'host.m.udpUnlisten':{ ja: 'UDP ポート {0} の待ち受けを停止', en: 'Stopped listening on UDP port {0}' },
    'host.m.udpUsage':   { ja: '使い方: udp send|listen|unlisten ...', en: 'Usage: udp send|listen|unlisten ...' },
    'host.m.dhcpPoolUsage':{ ja: '使い方: dhcp pool <net>/<len> <開始IP> <終了IP> [<GW>]', en: 'Usage: dhcp pool <net>/<len> <startIP> <endIP> [<GW>]' },
    'host.m.dhcpPoolSet':{ ja: 'DHCPプールを設定し、サーバを起動しました ({0}/{1} → {2}〜{3})', en: 'Configured a DHCP pool and started the server ({0}/{1} → {2}–{3})' },
    'host.m.dhcpdOn':    { ja: 'DHCPサーバ: 有効 (UDP:67)', en: 'DHCP server: on (UDP:67)' },
    'host.m.dhcpdOff':   { ja: 'DHCPサーバ: 停止', en: 'DHCP server: off' },
    'host.m.noLeases':   { ja: 'リースはありません', en: 'No leases' },
    'host.m.leasesHeader':{ ja: '  MACアドレス          IPアドレス', en: '  MAC address          IP address' },
    'host.m.dhcpUsage':  { ja: '使い方: dhcp pool ... / dhcp server on|off / dhcp leases', en: 'Usage: dhcp pool ... / dhcp server on|off / dhcp leases' },
    'host.m.dhcpNoResp': { ja: 'DHCP: サーバから応答がありません (30秒後に再試行)', en: 'DHCP: no response from server (retrying in 30s)' },
    'host.m.dhcpBound':  { ja: 'DHCP: {0}/{1} を取得 (GW {2}, サーバ {3})', en: 'DHCP: leased {0}/{1} (GW {2}, server {3})' },
    'host.m.dhcpNak':    { ja: 'DHCP: 要求が拒否されました (NAK) — 再取得します', en: 'DHCP: request rejected (NAK) — retrying' },
    'host.m.dhcpdExhausted':{ ja: '[dhcpd] プール {0}/{1} が枯渇しています', en: '[dhcpd] pool {0}/{1} is exhausted' },
    'host.m.dhcpdLeased':{ ja: '[dhcpd] {0} に {1} をリース{2}', en: '[dhcpd] leased {1} to {0}{2}' },

    /* ---------- load balancer console ---------- */
    'lb.m.vrrpUsage':    { ja: '使い方: vrrp <グループ> ip <VIP> / vrrp <グループ> priority <値>', en: 'Usage: vrrp <group> ip <VIP> / vrrp <group> priority <value>' },
    'lb.m.vrrpSet':      { ja: 'VRRP グループ{0} 仮想IP {1} を設定', en: 'VRRP group {0} virtual IP {1} set' },
    'lb.m.vrrpPriRange': { ja: '% priority は 1〜255 で指定してください', en: '% priority must be 1–255' },
    'lb.m.vrrpRemoved':  { ja: 'VRRP設定を解除しました', en: 'Removed VRRP configuration' },
    'lb.m.lbStarted':    { ja: 'ロードバランサをTCP:{0}で開始しました', en: 'Load balancer started on TCP:{0}' },
    'lb.m.backendAdded': { ja: 'バックエンド {0}:{1} を追加', en: 'Added backend {0}:{1}' },
    'lb.m.backendRemoved':{ ja: 'バックエンド {0} を削除', en: 'Removed backend {0}' },
    'lb.m.stopped':      { ja: '停止中', en: 'stopped' },
    'lb.m.statusLine':   { ja: 'サービス: {0}  方式: round-robin', en: 'Service: {0}  method: round-robin' },
    'lb.m.noBackends':   { ja: 'バックエンドなし — "lb backend add <IP> [port]" で追加', en: 'No backends — add with "lb backend add <IP> [port]"' },
    'lb.m.lbUsage':      { ja: '使い方: lb service <port> / lb backend add|del <IP> [port] / lb status', en: 'Usage: lb service <port> / lb backend add|del <IP> [port] / lb status' },
    'lb.m.portRange':    { ja: '% ポートは 1〜65535 で指定してください', en: '% Port must be 1–65535' },
    'lb.m.noAliveBackend':{ ja: '[lb] {0} — 稼働中のバックエンドがありません', en: '[lb] {0} — no healthy backends' },
    'lb.n.backendUp':    { ja: '{0}: バックエンド {1}:{2} が復旧', en: '{0}: backend {1}:{2} recovered' },
    'lb.n.backendDown':  { ja: '{0}: バックエンド {1}:{2} がダウン', en: '{0}: backend {1}:{2} down' },
    'lb.help': {
      ja: [
        '  lb service <port>                 ロードバランサ開始',
        '  lb backend add|del <IP> [port]    バックエンド管理',
        '  lb status                         状態表示',
        '  vrrp <grp> ip <VIP>               LB仮想IPを冗長化',
        '  vrrp <grp> priority <1-255>       VRRP優先度を設定',
        '  show vrrp brief                   VRRP状態表示',
      ].join('\n'),
      en: [
        '  lb service <port>                 Start the load balancer',
        '  lb backend add|del <IP> [port]    Manage backends',
        '  lb status                         Show status',
        '  vrrp <grp> ip <VIP>               Make the LB VIP redundant',
        '  vrrp <grp> priority <1-255>       Set VRRP priority',
        '  show vrrp brief                   Show VRRP status',
      ].join('\n'),
    },

    /* ---------- other device / stack notes ---------- */
    'hub.noConfig':      { ja: 'ハブに設定項目はありません(全ポートへ単純中継します)', en: 'A hub has nothing to configure (it repeats to all ports)' },
    'net.acl.denied':    { ja: '{0}: ACL が {1} → {2} ({3}) を拒否 [{4} {5}]', en: '{0}: ACL denied {1} → {2} ({3}) [{4} {5}]' },
    'net.dhcp.relay':    { ja: '{0}: DHCP {1} を {2} へリレー (giaddr={3})', en: '{0}: relayed DHCP {1} to {2} (giaddr={3})' },
    'net.vrrp.masterFail':{ ja: 'マスター障害を検出', en: 'detected master failure' },
    'net.vrrp.becameMaster':{ ja: '{0}: VRRP グループ{1} ({2}) のマスターに遷移 — {3}', en: '{0}: became VRRP master for group {1} ({2}) — {3}' },
    'net.vrrp.higherPri':{ ja: '{0}: VRRP グループ{1} — より高い優先度 ({2}) を検出しバックアップへ', en: '{0}: VRRP group {1} — saw higher priority ({2}), moving to backup' },
    'net.vrrp.preempt':  { ja: '優先度 {0} > {1} (プリエンプト)', en: 'priority {0} > {1} (preempt)' },
    'net.ospf.neighborDown':{ ja: '{0}: OSPFネイバー {1} がダウン', en: '{0}: OSPF neighbor {1} down' },
    'net.ospf.neighborUp':{ ja: '{0}: OSPFネイバー {1} を確立 ({2})', en: '{0}: OSPF neighbor {1} established ({2})' },
    'net.nat.created':   { ja: '{0}: NAT変換を作成 {1} → {2} ({3})', en: '{0}: created NAT translation {1} → {2} ({3})' },
    'net.loop.detected': { ja: 'フレームのホップ数が64を超過 — L2ループの可能性 ({0})', en: 'Frame exceeded 64 hops — possible L2 loop ({0})' },
    'net.link.queueDrop': { ja: '{0} {1}: FIFOキュー上限({2} packet)のためフレームを破棄', en: '{0} {1}: frame dropped at FIFO limit ({2} packets)' },
  };

  function t(key, ...args) {
    const e = D[key];
    if (!e) return key;
    let v = e[lang] != null ? e[lang] : e.ja;
    if (typeof v === 'function') return v(...args);
    return String(v).replace(/\{(\d+)\}/g, (m, i) => (args[i] != null ? args[i] : ''));
  }

  const i18n = {
    get lang() { return lang; },
    set(l) {
      if ((l !== 'ja' && l !== 'en') || l === lang) return;
      lang = l;
      try { if (typeof localStorage !== 'undefined') localStorage.setItem('netsim.lang', l); } catch (_) {}
      for (const cb of listeners.slice()) { try { cb(lang); } catch (_) {} }
    },
    toggle() { this.set(lang === 'ja' ? 'en' : 'ja'); },
    onChange(cb) { listeners.push(cb); return cb; },
    t,
    dict: D,
    /* apply translations to static DOM marked with data-i18n[-html|-title|-ph] */
    apply(rootEl) {
      if (typeof document === 'undefined') return;
      const scope = rootEl || document;
      scope.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.getAttribute('data-i18n')); });
      scope.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = t(el.getAttribute('data-i18n-html')); });
      scope.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.getAttribute('data-i18n-title')); });
      scope.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.getAttribute('data-i18n-ph')); });
      document.title = t('app.title');
      if (document.documentElement) document.documentElement.lang = lang;
    },
  };

  NetSim.i18n = i18n;
  NetSim.t = t;
})(typeof window !== 'undefined' ? window : globalThis);
