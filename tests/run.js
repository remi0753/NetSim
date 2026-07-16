#!/usr/bin/env node
/* NetSim core smoke tests — run with: node tests/run.js */
'use strict';
const path = require('path');

const files = ['i18n', 'util', 'protocols', 'sim', 'link', 'device', 'acl', 'stack', 'nat', 'ospf', 'cli',
  'hub', 'switch', 'host', 'router', 'l3switch', 'lb', 'topology'];
for (const f of files) require(path.join(__dirname, '..', 'js', 'core', f + '.js'));
const NetSim = globalThis.NetSim;

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}`); }
}
function section(name) { console.log(`\n== ${name} ==`); }

function fresh(sampleId) {
  const sim = new NetSim.Simulator();
  const net = new NetSim.Network(sim);
  if (sampleId) NetSim.samples.find(s => s.id === sampleId).build(net);
  return { sim, net };
}
function capture(dev) {
  const lines = [];
  dev.on('output', l => lines.push(l));
  return lines;
}
function pingSync(sim, host, dst, opts) {
  const lines = [];
  let result = null;
  host.stack.ping(dst, opts || { count: 2 }, l => lines.push(l), okFlag => { result = okFlag; });
  sim.advance(120000);
  return { lines, result };
}

/* ---------- utils ---------- */
section('IPユーティリティ');
ok(NetSim.ip.maskToLen('255.255.255.0') === 24, 'maskToLen 255.255.255.0 -> 24');
ok(NetSim.ip.lenToMask(30) === '255.255.255.252', 'lenToMask 30');
ok(NetSim.ip.networkOf('10.0.1.77', 24) === '10.0.1.0', 'networkOf');
ok(NetSim.ip.broadcastOf('10.0.1.77', 24) === '10.0.1.255', 'broadcastOf');
ok(NetSim.ip.sameSubnet('10.0.1.1', '10.0.1.200', 24), 'sameSubnet true');
ok(!NetSim.ip.sameSubnet('10.0.1.1', '10.0.2.1', 24), 'sameSubnet false');
ok(NetSim.ip.maskToLen('255.0.255.0') === null, 'non-contiguous mask rejected');

/* ---------- device sizing ---------- */
section('デバイスポート数');
{
  const { net } = fresh();
  const rMin = net.addDevice('router', 0, 0, 'RMIN', { portCount: 1 });
  const rMax = net.addDevice('router', 0, 0, 'RMAX', { portCount: 99 });
  const swMax = net.addDevice('switch', 0, 0, 'SWMAX', { portCount: 99 });
  const l3Min = net.addDevice('l3switch', 0, 0, 'L3MIN', { portCount: 1 });
  ok(rMin.ports.length === 2, 'ルータの下限は2ポート');
  ok(rMax.ports.length === 16, 'ルータの上限は16ポート');
  ok(swMax.ports.length === 52, 'スイッチの上限は52ポート');
  ok(l3Min.ports.length === 8, 'L3スイッチの下限は8ポート');
}

/* ---------- STP ---------- */
section('STP: 冗長L2リンクのループ防止');
{
  const { sim, net } = fresh();
  const sw1 = net.addDevice('switch', 0, 0, 'SW1');
  const sw2 = net.addDevice('switch', 0, 0, 'SW2');
  const sw3 = net.addDevice('switch', 0, 0, 'SW3');
  const pc1 = net.addDevice('pc', 0, 0), pc2 = net.addDevice('pc', 0, 0);
  net.connect(sw1, 'Gi0/1', sw2, 'Gi0/1');
  net.connect(sw2, 'Gi0/2', sw3, 'Gi0/1');
  net.connect(sw3, 'Gi0/2', sw1, 'Gi0/2');
  net.connect(pc1, 'eth0', sw1, 'Gi0/3');
  net.connect(pc2, 'eth0', sw3, 'Gi0/3');
  pc1.setIp('192.168.10.1', 24, null);
  pc2.setIp('192.168.10.2', 24, null);
  let looped = false;
  sim.on('note', n => { if (n.kind === 'loop') looped = true; });
  const r = pingSync(sim, pc1, '192.168.10.2');
  ok(r.result === true, '三角形トポロジでも ping 成功');
  ok(!looped, 'STPがL2ループを遮断');
  ok([sw1, sw2, sw3].some(sw => sw.ports.some(p => p.stpState === 'blocking')), '少なくとも1ポートがblocking');

  const out = capture(sw3);
  sw3.exec('enable');
  sw3.exec('show spanning-tree');
  ok(out.some(l => l.includes('alternate') && l.includes('blocking')), 'show spanning-tree に代替ブロックポート');

  for (const c of ['conf t', 'spanning-tree vlan 1 priority 0', 'end']) sw3.exec(c);
  ok(sw3.stpRootId === sw3.stpBridgeId(), '優先度変更でSW3がルートブリッジ');
}

/* ---------- Rapid PVST+ equivalent ---------- */
section('STP: VLAN単位ツリー (Rapid PVST+相当)');
{
  const { net } = fresh();
  const core = net.addDevice('switch', 0, 0, 'CORE');
  const sw5 = net.addDevice('l3switch', 0, 0, 'L3SW5');
  const sw6 = net.addDevice('l3switch', 0, 0, 'L3SW6');
  net.connect(core, 'Gi0/1', sw5, 'Gi0/1');       // VLAN 1 only
  net.connect(core, 'Gi0/2', sw6, 'Gi0/1');       // VLAN 1 only
  net.connect(sw5, 'Gi0/3', sw6, 'Gi0/3');        // VLAN 200 only
  for (const sw of [sw5, sw6]) {
    sw.addVlan(200);
    const c = sw.cfg(sw.getPort('Gi0/3'));
    c.mode = 'trunk'; c.allowed = [200];
  }
  net.recomputeStp();
  ok(sw5.getPort('Gi0/3').stpVlans.get(200).state === 'forwarding' &&
    sw6.getPort('Gi0/3').stpVlans.get(200).state === 'forwarding',
  'VLAN 200だけを通すリンクは、VLAN 1の物理ループ候補により遮断されない');

  for (const sw of [core, sw5, sw6]) sw.stpMode = 'rstp';
  net.recomputeStp();
  ok([sw5, sw6].some(sw => sw.getPort('Gi0/3').stpState === 'blocking'),
    '共通ツリー(RSTP)へ切替時は冗長リンクを遮断する');
}

/* ---------- L1: hub ---------- */
section('L1: ハブ経由 ping');
{
  const { sim, net } = fresh();
  const pc1 = net.addDevice('pc', 0, 0), pc2 = net.addDevice('pc', 0, 0);
  const hub = net.addDevice('hub', 0, 0);
  net.connect(pc1, 'eth0', hub, 'Port1');
  net.connect(pc2, 'eth0', hub, 'Port2');
  pc1.setIp('192.168.0.1', 24, null);
  pc2.setIp('192.168.0.2', 24, null);
  const r = pingSync(sim, pc1, '192.168.0.2');
  ok(r.result === true, 'ハブ経由で ping 成功');
  ok(r.lines.some(l => l.includes('Reply from 192.168.0.2')), '応答が正しい送信元');
}

/* ---------- L2: switch + MAC learning ---------- */
section('L2: スイッチ・MAC学習・VLAN分離');
{
  const { sim, net } = fresh();
  const pc1 = net.addDevice('pc', 0, 0), pc2 = net.addDevice('pc', 0, 0), pc3 = net.addDevice('pc', 0, 0);
  const sw = net.addDevice('switch', 0, 0);
  net.connect(pc1, 'eth0', sw, 'GigabitEthernet0/1');
  net.connect(pc2, 'eth0', sw, 'GigabitEthernet0/2');
  net.connect(pc3, 'eth0', sw, 'GigabitEthernet0/3');
  pc1.setIp('192.168.0.1', 24, null);
  pc2.setIp('192.168.0.2', 24, null);
  pc3.setIp('192.168.0.3', 24, null);
  const r1 = pingSync(sim, pc1, '192.168.0.2');
  ok(r1.result === true, '同一VLAN内 ping 成功');
  const macs = sw.macRows();
  ok(macs.some(m => m.mac === pc1.nic.mac && m.port === 'Gi0/1'), 'PC1のMACをGi0/1で学習');
  ok(macs.some(m => m.mac === pc2.nic.mac && m.port === 'Gi0/2'), 'PC2のMACをGi0/2で学習');

  // VLAN分離: PC3をVLAN20へ
  sw.addVlan(20);
  sw.cfg(sw.getPort('Gi0/3')).accessVlan = 20;
  const r2 = pingSync(sim, pc1, '192.168.0.3');
  ok(r2.result === false, '別VLANへは ping 不可(分離されている)');
}

/* ---------- L3: routed sample ---------- */
section('L3: ルータ経由ルーティング (サンプル1)');
{
  const { sim, net } = fresh('routed');
  const pc1 = net.findByName('PC1'), sv1 = net.findByName('SV1');
  const r = pingSync(sim, pc1, '10.0.2.10');
  ok(r.result === true, 'PC1 → SV1 (別セグメント) ping 成功');
  const reply = r.lines.find(l => l.includes('Reply from 10.0.2.10'));
  ok(reply && reply.includes('ttl=63'), 'TTLがルータで1減っている (63)');

  // traceroute
  const tl = [];
  let tdone = null;
  pc1.stack.traceroute('10.0.2.10', l => tl.push(l), okF => { tdone = okF; });
  sim.advance(120000);
  ok(tdone === true, 'traceroute 完了');
  ok(tl.some(l => l.includes('10.0.1.254')), '1ホップ目がルータ (10.0.1.254)');
  ok(tl.some(l => l.includes('10.0.2.10')), '最終ホップが宛先');

  // no route
  const r3 = pingSync(sim, pc1, '172.16.0.1');
  ok(r3.result === false && r3.lines.some(l => l.includes('unreachable') || l.includes('no route') || l.includes('timed out')),
    '経路のない宛先は失敗');
}

/* ---------- 2 routers + static routes + TTL ---------- */
section('L3: 2ルータ+スタティックルート');
{
  const { sim, net } = fresh();
  const pc1 = net.addDevice('pc', 0, 0), pc2 = net.addDevice('pc', 0, 0);
  const r1 = net.addDevice('router', 0, 0), r2 = net.addDevice('router', 0, 0);
  net.connect(pc1, 'eth0', r1, 'GigabitEthernet0/0');
  net.connect(r1, 'GigabitEthernet0/1', r2, 'GigabitEthernet0/1');
  net.connect(r2, 'GigabitEthernet0/0', pc2, 'eth0');
  pc1.setIp('10.1.0.10', 24, '10.1.0.1');
  pc2.setIp('10.2.0.10', 24, '10.2.0.1');
  for (const [rt, ports] of [[r1, [['Gi0/0', '10.1.0.1'], ['Gi0/1', '10.12.0.1']]],
                             [r2, [['Gi0/0', '10.2.0.1'], ['Gi0/1', '10.12.0.2']]]]) {
    for (const [pn, ip] of ports) {
      const p = rt.getPort(pn);
      p.adminUp = true;
      p.l3iface.setIp(ip, 24);
    }
  }
  r1.stack.addStaticRoute('10.2.0.0', 24, '10.12.0.2');
  r2.stack.addStaticRoute('10.1.0.0', 24, '10.12.0.1');
  const r = pingSync(sim, pc1, '10.2.0.10');
  ok(r.result === true, '2ルータ経由 ping 成功');
  ok(r.lines.some(l => l.includes('ttl=62')), 'TTL=62 (ルータ2台通過)');
}

/* ---------- VLAN + L3 switch sample ---------- */
section('L2/L3: VLAN + L3スイッチ (サンプル2)');
{
  const { sim, net } = fresh('vlan-dc');
  const pc1 = net.findByName('PC1'), pc2 = net.findByName('PC2');
  const r1 = pingSync(sim, pc1, '10.10.10.12');
  ok(r1.result === true, '同一VLAN内 (PC1→PC2) ping 成功');
  const r2 = pingSync(sim, pc1, '10.10.20.10');
  ok(r2.result === true, 'VLAN間ルーティング (PC1→SV1) ping 成功');
  const r3 = pingSync(sim, pc1, '10.10.10.1');
  ok(r3.result === true, 'SVI (デフォルトGW) への ping 成功');
}

/* ---------- L4: TCP / HTTP ---------- */
section('L4: TCP 3-wayハンドシェイク + HTTP');
{
  const { sim, net } = fresh('routed');
  const pc1 = net.findByName('PC1');
  const out = capture(pc1);
  pc1.exec('http get 10.0.2.10');
  sim.advance(120000);
  ok(out.some(l => l.includes('3-way handshake')), 'ハンドシェイク完了');
  ok(out.some(l => l.includes('200 OK')), 'HTTP 200 OK 受信');
  ok(out.some(l => l.includes('Hello from SV1')), 'レスポンスボディ受信');
  ok(pc1.busy === false, 'コマンド終了 (busy解除)');

  // closed port -> RST
  const out2 = capture(pc1);
  pc1.exec('http get 10.0.2.10 8080');
  sim.advance(120000);
  ok(out2.some(l => l.includes('connection refused')), '閉じたポートへは RST (refused)');
}

/* ---------- L4: UDP ---------- */
section('L4: UDP');
{
  const { sim, net } = fresh('routed');
  const pc1 = net.findByName('PC1'), sv1 = net.findByName('SV1');
  const svOut = capture(sv1);
  sv1.exec('udp listen 5000');
  pc1.exec('udp send 10.0.2.10 5000 hello-dc');
  sim.advance(60000);
  ok(svOut.some(l => l.includes('hello-dc')), 'UDPデータグラムが届く');
}

/* ---------- ACL ---------- */
section('ACL (CLI設定経由)');
{
  const { sim, net } = fresh('routed');
  const pc1 = net.findByName('PC1');
  const rt1 = net.findByName('RT1');
  for (const cmd of [
    'enable', 'configure terminal',
    'access-list 100 deny icmp any host 10.0.2.10',
    'access-list 100 permit ip any any',
    'interface GigabitEthernet0/0',
    'ip access-group 100 in',
    'end',
  ]) rt1.exec(cmd);
  const r = pingSync(sim, pc1, '10.0.2.10');
  ok(r.result === false, 'ACLで ICMP がブロックされる');
  ok(r.lines.some(l => l.includes('administratively prohibited')), 'ICMP admin-prohibited を受信');

  const out = capture(pc1);
  pc1.exec('http get 10.0.2.10');
  sim.advance(120000);
  ok(out.some(l => l.includes('200 OK')), 'TCP(HTTP) は許可されている');
}

/* ---------- CLI ---------- */
section('CLI (IOS風)');
{
  const { sim, net } = fresh('routed');
  const rt1 = net.findByName('RT1');
  const sw1 = net.findByName('SW1');
  const pc1 = net.findByName('PC1');

  // 省略形コマンド
  const rtOut = capture(rt1);
  rt1.exec('en');
  const beforeEnableAgain = rtOut.length;
  rt1.exec('enable');
  ok(!rtOut.slice(beforeEnableAgain).some(l => l.includes('Invalid input') || l.includes('認識されない')),
    '特権モード中の enable はエラーにしない');
  rt1.exec('sh ip int br');
  ok(rtOut.some(l => l.includes('GigabitEthernet0/0') && l.includes('10.0.1.254')), '省略形 "sh ip int br" が動く');
  rt1.exec('sh ip route');
  ok(rtOut.some(l => l.startsWith('C') && l.includes('10.0.1.0/24')), 'show ip route に接続経路');

  // ルータから ping
  const r = (() => {
    const lines = [];
    let result = null;
    rt1.stack.ping('10.0.2.10', { count: 1 }, l => lines.push(l), f => { result = f; });
    sim.advance(60000);
    return { lines, result };
  })();
  ok(r.result === true, 'ルータ自身から ping 成功');

  // スイッチ: VLAN設定 + show
  const swOut = capture(sw1);
  for (const c of ['enable', 'conf t', 'vlan 30', 'name TEST', 'exit',
    'interface Gi0/2', 'switchport access vlan 30', 'end', 'show vlan brief']) sw1.exec(c);
  ok(swOut.some(l => l.includes('30') && l.includes('TEST')), 'VLAN作成 + show vlan brief');

  // MACテーブル (トラフィック後)
  pingSync(sim, pc1, '10.0.1.12');
  sw1.exec('show mac address-table');
  ok(swOut.some(l => l.toLowerCase().includes(pc1.nic.mac)), 'show mac address-table にPC1のMAC');

  // 不正コマンド / 曖昧コマンド
  const rtOut2 = capture(rt1);
  rt1.exec('foobar');
  ok(rtOut2.some(l => l.includes('% Invalid input')), '不正コマンドはエラー');

  // shutdown でリンクダウン → ping失敗
  for (const c of ['conf t', 'interface Gi0/1', 'shutdown', 'end']) rt1.exec(c);
  const r2 = pingSync(sim, pc1, '10.0.2.10');
  ok(r2.result === false, 'shutdown 後は疎通しない');
  for (const c of ['conf t', 'interface Gi0/1', 'no shutdown', 'end']) rt1.exec(c);
  const r3 = pingSync(sim, pc1, '10.0.2.10');
  ok(r3.result === true, 'no shutdown で復旧');

  // デバイス全体の障害シミュレーション
  rt1.exec('shutdown all');
  ok(rt1.ports.every(p => p.adminUp === false), 'shutdown all で全インターフェースを停止');
  const r4 = pingSync(sim, pc1, '10.0.2.10');
  ok(r4.result === false, 'shutdown all 後はデバイス経由の疎通が停止');
  rt1.exec('no shutdown all');
  ok(rt1.ports.every(p => p.adminUp === true), 'no shutdown all で全インターフェースを復旧');
  const r5 = pingSync(sim, pc1, '10.0.2.10');
  ok(r5.result === true, 'no shutdown all 後に疎通が復旧');

  const pcOut = capture(pc1);
  pc1.exec('shutdown');
  ok(pc1.nic.adminUp === false, 'Host CLIのshutdownでNICを停止');
  pc1.exec('no shutdown');
  ok(pc1.nic.adminUp === true, 'Host CLIのno shutdownでNICを復旧');
  ok(pcOut.some(l => l.includes('administratively down')) && pcOut.some(l => l.includes('up')), 'Host CLIのshutdown/no shutdownが結果を表示');
}

/* ---------- save / load ---------- */
section('保存 / 読み込み');
{
  const { sim, net } = fresh('vlan-dc');
  const json = JSON.stringify(net.serialize());
  const sim2 = new NetSim.Simulator();
  const net2 = new NetSim.Network(sim2);
  net2.load(JSON.parse(json));
  ok(net2.devices.length === net.devices.length, 'デバイス数が一致');
  ok(net2.links.length === net.links.length, 'リンク数が一致');
  const pc1 = net2.findByName('PC1');
  const r = pingSync(sim2, pc1, '10.10.20.10');
  ok(r.result === true, '復元後もVLAN間ルーティングが動く');
}

/* ---------- DHCP ---------- */
section('DHCP: 同一セグメント');
{
  const { sim, net } = fresh();
  const dh = net.addDevice('server', 0, 0);
  const pc1 = net.addDevice('pc', 0, 0), pc2 = net.addDevice('pc', 0, 0);
  const sw = net.addDevice('switch', 0, 0);
  net.connect(dh, 'eth0', sw, 'Gi0/1');
  net.connect(pc1, 'eth0', sw, 'Gi0/2');
  net.connect(pc2, 'eth0', sw, 'Gi0/3');
  dh.setIp('10.5.0.2', 24, null);
  dh.exec('dhcp pool 10.5.0.0/24 10.5.0.100 10.5.0.199 10.5.0.1');
  pc1.exec('set ip dhcp');
  pc2.exec('set ip dhcp');
  sim.advance(30000);
  ok(pc1.iface.ip && pc1.iface.ip.startsWith('10.5.0.1'), `PC1がリース取得 (${pc1.iface.ip})`);
  ok(pc2.iface.ip && pc2.iface.ip !== pc1.iface.ip, `PC2は別アドレス (${pc2.iface.ip})`);
  ok(pc1.gateway === '10.5.0.1', 'GWオプションが適用される');
  const r = pingSync(sim, pc1, pc2.iface.ip);
  ok(r.result === true, 'DHCP取得アドレスで相互に疎通');
}

section('DHCP: ルータ越しリレー (ip helper-address)');
{
  const { sim, net } = fresh();
  const pc = net.addDevice('pc', 0, 0);
  const rt = net.addDevice('router', 0, 0);
  const dh = net.addDevice('server', 0, 0);
  net.connect(pc, 'eth0', rt, 'Gi0/0');
  net.connect(rt, 'Gi0/1', dh, 'eth0');
  const g0 = rt.getPort('Gi0/0'), g1 = rt.getPort('Gi0/1');
  g0.adminUp = true; g0.l3iface.setIp('10.1.0.1', 24);
  g1.adminUp = true; g1.l3iface.setIp('10.9.0.1', 24);
  for (const c of ['enable', 'conf t', 'interface Gi0/0', 'ip helper-address 10.9.0.10', 'end']) rt.exec(c);
  dh.setIp('10.9.0.10', 24, '10.9.0.1');
  dh.exec('dhcp pool 10.1.0.0/24 10.1.0.100 10.1.0.150 10.1.0.1');
  pc.exec('set ip dhcp');
  sim.advance(40000);
  ok(pc.iface.ip && pc.iface.ip.startsWith('10.1.0.1'), `リレー経由でリース取得 (${pc.iface.ip})`);
  ok(pc.gateway === '10.1.0.1', 'giaddrに基づく正しいプール選択');
  const r = pingSync(sim, pc, '10.9.0.10');
  ok(r.result === true, '取得アドレスでDHCPサーバまで疎通');
}

/* ---------- OSPF + ECMP ---------- */
section('OSPF: 動的ルーティング');
{
  // PC1 - R1 --- R2 - PC2 (スタティックルートなし、OSPFで学習)
  const { sim, net } = fresh();
  const pc1 = net.addDevice('pc', 0, 0), pc2 = net.addDevice('pc', 0, 0);
  const r1 = net.addDevice('router', 0, 0), r2 = net.addDevice('router', 0, 0);
  net.connect(pc1, 'eth0', r1, 'GigabitEthernet0/0');
  net.connect(r1, 'GigabitEthernet0/1', r2, 'GigabitEthernet0/1');
  net.connect(r2, 'GigabitEthernet0/0', pc2, 'eth0');
  pc1.setIp('10.1.0.10', 24, '10.1.0.1');
  pc2.setIp('10.2.0.10', 24, '10.2.0.1');
  for (const [rt, ports] of [[r1, [['Gi0/0', '10.1.0.1'], ['Gi0/1', '10.12.0.1']]],
                             [r2, [['Gi0/0', '10.2.0.1'], ['Gi0/1', '10.12.0.2']]]]) {
    for (const [pn, ip] of ports) {
      const p = rt.getPort(pn);
      p.adminUp = true;
      p.l3iface.setIp(ip, 24);
    }
    for (const c of ['enable', 'conf t', 'router ospf 1',
      'network 10.0.0.0 0.255.255.255 area 0', 'end']) rt.exec(c);
  }
  sim.advance(30000);   // adjacency + LSA + SPF
  ok(r1.ospf.neighbors.size === 1 && r2.ospf.neighbors.size === 1, 'OSPFネイバー確立');
  const o1 = r1.stack.dynRoutes.get('ospf') || [];
  ok(o1.some(r => r.network === '10.2.0.0' && r.len === 24 && r.nexthops.includes('10.12.0.2')),
    'R1がOSPFで 10.2.0.0/24 を学習');
  const r = pingSync(sim, pc1, '10.2.0.10');
  ok(r.result === true, 'OSPF経路で ping 成功 (スタティックルートなし)');

  // CLI 表示
  const out = capture(r1);
  r1.exec('show ip ospf neighbor');
  r1.exec('show ip route');
  ok(out.some(l => l.includes('FULL')), 'show ip ospf neighbor に FULL');
  ok(out.some(l => l.startsWith('O') && l.includes('10.2.0.0/24') && l.includes('[110/')),
    'show ip route に O 経路');

  // リンク断 → 経路消滅
  for (const c of ['conf t', 'interface Gi0/1', 'shutdown', 'end']) r1.exec(c);
  sim.advance(40000);   // dead interval + purge
  const o2 = r1.stack.dynRoutes.get('ospf') || [];
  ok(!o2.some(x => x.network === '10.2.0.0'), 'リンク断で経路がパージされる');
  for (const c of ['conf t', 'interface Gi0/1', 'no shutdown', 'end']) r1.exec(c);
  sim.advance(30000);
  const r3 = pingSync(sim, pc1, '10.2.0.10');
  ok(r3.result === true, '復旧後に再収束して ping 成功');
}

section('OSPF: ECMP (スパイン・リーフ)');
{
  // leaf1 =(spine1/spine2)= leaf2 の菱形。leaf1→leaf2配下へ2等コスト経路
  const { sim, net } = fresh();
  const l1 = net.addDevice('router', 0, 0), l2 = net.addDevice('router', 0, 0);
  const s1 = net.addDevice('router', 0, 0), s2 = net.addDevice('router', 0, 0);
  const pcA = net.addDevice('pc', 0, 0), pcB = net.addDevice('pc', 0, 0);
  net.connect(l1, 'Gi0/0', s1, 'Gi0/0');
  net.connect(l1, 'Gi0/1', s2, 'Gi0/0');
  net.connect(l2, 'Gi0/0', s1, 'Gi0/1');
  net.connect(l2, 'Gi0/1', s2, 'Gi0/1');
  net.connect(l1, 'Gi0/2', pcA, 'eth0');
  net.connect(l2, 'Gi0/2', pcB, 'eth0');
  const conf = (rt, ifs) => {
    for (const [pn, ip, len] of ifs) {
      const p = rt.getPort(pn);
      p.adminUp = true;
      p.l3iface.setIp(ip, len);
    }
    for (const c of ['enable', 'conf t', 'router ospf 1',
      'network 10.0.0.0 0.255.255.255 area 0', 'end']) rt.exec(c);
  };
  conf(l1, [['Gi0/0', '10.0.11.1', 30], ['Gi0/1', '10.0.12.1', 30], ['Gi0/2', '10.1.0.1', 24]]);
  conf(l2, [['Gi0/0', '10.0.21.1', 30], ['Gi0/1', '10.0.22.1', 30], ['Gi0/2', '10.2.0.1', 24]]);
  conf(s1, [['Gi0/0', '10.0.11.2', 30], ['Gi0/1', '10.0.21.2', 30]]);
  conf(s2, [['Gi0/0', '10.0.12.2', 30], ['Gi0/1', '10.0.22.2', 30]]);
  pcA.setIp('10.1.0.10', 24, '10.1.0.1');
  pcB.setIp('10.2.0.10', 24, '10.2.0.1');
  sim.advance(40000);
  const routes = l1.stack.dynRoutes.get('ospf') || [];
  const ecmp = routes.find(r => r.network === '10.2.0.0' && r.len === 24);
  ok(ecmp && ecmp.nexthops.length === 2, `ECMP: 10.2.0.0/24 にネクストホップ2つ (${ecmp ? ecmp.nexthops.join('/') : 'なし'})`);

  // フローハッシュで別スパインへ分散
  const picks = new Set();
  for (let port = 1000; port < 1040; port++) {
    const pkt = NetSim.pdu.ipv4('10.1.0.10', '10.2.0.10', 'tcp', NetSim.pdu.tcp(port, 80, ['SYN'], 0, 0));
    const route = l1.stack.lookupRoute('10.2.0.10', pkt);
    picks.add(route.nexthop);
  }
  ok(picks.size === 2, 'フローごとに両方のスパインへ分散');
  const r = pingSync(sim, pcA, '10.2.0.10');
  ok(r.result === true, 'ECMP経路で ping 成功');

  // スパイン1つ停止 → 収束後も疎通
  for (const c of ['enable', 'conf t', 'interface Gi0/0', 'shutdown', 'end']) s1.exec(c);
  sim.advance(45000);
  const ecmp2 = (l1.stack.dynRoutes.get('ospf') || []).find(r => r.network === '10.2.0.0');
  ok(ecmp2 && ecmp2.nexthops.length === 1, '障害後はネクストホップ1つに収束');
  const r2 = pingSync(sim, pcA, '10.2.0.10');
  ok(r2.result === true, 'スパイン障害後も残路で疎通');
}

/* ---------- LACP ---------- */
section('LACP: ポートチャネル');
{
  const { sim, net } = fresh();
  const sw1 = net.addDevice('switch', 0, 0), sw2 = net.addDevice('switch', 0, 0);
  const pc1 = net.addDevice('pc', 0, 0), pc2 = net.addDevice('pc', 0, 0);
  net.connect(sw1, 'Gi0/1', sw2, 'Gi0/1');
  net.connect(sw1, 'Gi0/2', sw2, 'Gi0/2');   // 2本の並列リンク
  net.connect(pc1, 'eth0', sw1, 'Gi0/3');
  net.connect(pc2, 'eth0', sw2, 'Gi0/3');
  // チャネル未設定ならループ検知が出るはず → チャネル化でループなし
  for (const sw of [sw1, sw2]) {
    for (const c of ['enable', 'conf t', 'interface Gi0/1', 'channel-group 1 mode active',
      'exit', 'interface Gi0/2', 'channel-group 1 mode active', 'end']) sw.exec(c);
  }
  pc1.setIp('192.168.1.1', 24, null);
  pc2.setIp('192.168.1.2', 24, null);
  let looped = false;
  sim.on('note', n => { if (n.kind === 'loop') looped = true; });
  const r = pingSync(sim, pc1, '192.168.1.2');
  ok(r.result === true, 'ポートチャネル経由で ping 成功');
  ok(!looped, '並列2本でもループなし (論理1リンク扱い)');
  ok(sw1.macRows().some(m => m.port === 'Po1'), 'MACテーブルにPo1で学習');

  const out = capture(sw1);
  sw1.exec('enable');
  sw1.exec('show etherchannel summary');
  ok(out.some(l => l.includes('Po1') && l.includes('Gi0/1(P)')), 'show etherchannel summary');

  // メンバー1本ダウンでも疎通継続
  for (const c of ['conf t', 'interface Gi0/1', 'shutdown', 'end']) sw1.exec(c);
  const r2 = pingSync(sim, pc1, '192.168.1.2');
  ok(r2.result === true, 'メンバー1本ダウンでも残りで疎通');
}

/* ---------- VRRP ---------- */
section('VRRP: ゲートウェイ冗長');
{
  const { sim, net } = fresh();
  const sw = net.addDevice('switch', 0, 0);
  const rt1 = net.addDevice('router', 0, 0), rt2 = net.addDevice('router', 0, 0);
  const pc = net.addDevice('pc', 0, 0);
  const sv = net.addDevice('server', 0, 0);
  net.connect(pc, 'eth0', sw, 'Gi0/1');
  net.connect(rt1, 'Gi0/0', sw, 'Gi0/7');
  net.connect(rt2, 'Gi0/0', sw, 'Gi0/8');
  net.connect(rt1, 'Gi0/1', sv, 'eth0');   // 簡略: サーバ側はRT1直結 + RT2はダミー
  const cfg = (rt, ip, prio) => {
    const g0 = rt.getPort('Gi0/0');
    g0.adminUp = true;
    g0.l3iface.setIp(ip, 24);
    for (const c of ['enable', 'conf t', 'interface Gi0/0',
      'vrrp 1 ip 10.0.1.1', `vrrp 1 priority ${prio}`, 'end']) rt.exec(c);
  };
  cfg(rt1, '10.0.1.2', 120);
  cfg(rt2, '10.0.1.3', 100);
  pc.setIp('10.0.1.11', 24, '10.0.1.1');   // GW = 仮想IP
  sim.advance(15000);
  const v1 = rt1.getPort('Gi0/0').l3iface.vrrp;
  const v2 = rt2.getPort('Gi0/0').l3iface.vrrp;
  ok(v1.state === 'master' && v2.state === 'backup', '優先度120のRT1がマスター');
  const showVrrp = capture(rt1);
  rt1.exec('enable');
  rt1.exec('show vrrp brief');
  ok(showVrrp.some(l => l.startsWith('Gi0/0')), 'show vrrp brief のInterface列は短縮名');
  const r1 = pingSync(sim, pc, '10.0.1.1');
  ok(r1.result === true, '仮想IPへ ping 成功');

  // マスター障害 → バックアップへフェイルオーバー
  for (const c of ['conf t', 'interface Gi0/0', 'shutdown', 'end']) rt1.exec(c);
  sim.advance(15000);
  ok(v2.state === 'master', 'RT2がマスターに昇格');
  const r2 = pingSync(sim, pc, '10.0.1.1');
  ok(r2.result === true, 'フェイルオーバー後も仮想IPに疎通');

  // 復旧 → プリエンプトでRT1がマスターへ戻る
  for (const c of ['conf t', 'interface Gi0/0', 'no shutdown', 'end']) rt1.exec(c);
  sim.advance(20000);
  ok(v1.state === 'master' && v2.state === 'backup', '復旧後プリエンプトでRT1がマスターに復帰');
}

/* ---------- Load balancer ---------- */
section('L4ロードバランサ');
{
  const { sim, net } = fresh();
  const sw = net.addDevice('switch', 0, 0);
  const lb = net.addDevice('lb', 0, 0);
  const pc = net.addDevice('pc', 0, 0);
  const sv1 = net.addDevice('server', 0, 0), sv2 = net.addDevice('server', 0, 0);
  for (const [d, p] of [[lb, 'Gi0/1'], [pc, 'Gi0/2'], [sv1, 'Gi0/3'], [sv2, 'Gi0/4']]) {
    net.connect(d, 'eth0', sw, p);
  }
  lb.setIp('10.0.0.5', 24, null);
  pc.setIp('10.0.0.11', 24, null);
  sv1.setIp('10.0.0.21', 24, null);
  sv2.setIp('10.0.0.22', 24, null);
  lb.exec('lb service 80');
  lb.exec('lb backend add 10.0.0.21');
  lb.exec('lb backend add 10.0.0.22');
  sim.advance(15000);

  const bodies = [];
  const get = () => {
    const out = capture(pc);
    pc.exec('http get 10.0.0.5');
    sim.advance(90000);
    const l = out.find(x => x.includes('Hello from'));
    if (l) bodies.push(l.includes('SV1') ? 'SV1' : (l.includes('SV2') ? 'SV2' : '?'));
  };
  get(); get();
  ok(bodies.length === 2, `LB経由でHTTP応答×2 (${bodies.join(',')})`);
  ok(new Set(bodies).size === 2, 'ラウンドロビンで別サーバに分散');

  // バックエンド障害 → ヘルスチェックで除外
  sv1.setHttpServer(false);
  sim.advance(30000);
  const b1 = lb.backends.find(b => b.ip === '10.0.0.21');
  ok(b1 && b1.alive === false, 'ヘルスチェックでSV1をDOWN検出');
  const out2 = capture(pc);
  pc.exec('http get 10.0.0.5');
  sim.advance(90000);
  ok(out2.some(l => l.includes('Hello from SV2')), '生存バックエンドのみに転送');

  const help = capture(lb);
  lb.exec('?');
  ok(help.some(l => l.includes('vrrp <grp> ip <VIP>')), 'LB CLIの?にVRRPコマンドを表示');
}

/* ---------- Load balancer VRRP ---------- */
section('LB VRRP: サービスVIP冗長');
{
  const { sim, net } = fresh();
  const sw = net.addDevice('switch', 0, 0);
  const lb1 = net.addDevice('lb', 0, 0), lb2 = net.addDevice('lb', 0, 0);
  const pc = net.addDevice('pc', 0, 0);
  const sv1 = net.addDevice('server', 0, 0), sv2 = net.addDevice('server', 0, 0);
  for (const [d, p] of [[lb1, 'Gi0/1'], [lb2, 'Gi0/2'], [pc, 'Gi0/3'], [sv1, 'Gi0/4'], [sv2, 'Gi0/5']]) {
    net.connect(d, 'eth0', sw, p);
  }
  lb1.setIp('10.0.0.5', 24, null);
  lb2.setIp('10.0.0.6', 24, null);
  pc.setIp('10.0.0.11', 24, null);
  sv1.setIp('10.0.0.21', 24, null);
  sv2.setIp('10.0.0.22', 24, null);
  for (const c of ['lb service 80', 'lb backend add 10.0.0.21', 'vrrp 10 ip 10.0.0.100', 'vrrp 10 priority 120']) lb1.exec(c);
  for (const c of ['lb service 80', 'lb backend add 10.0.0.22', 'vrrp 10 ip 10.0.0.100', 'vrrp 10 priority 100']) lb2.exec(c);
  sim.advance(15000);
  ok(lb1.iface.vrrp.state === 'master' && lb2.iface.vrrp.state === 'backup', '優先度120のLB1がVRRPマスター');

  const out1 = capture(pc);
  pc.exec('http get 10.0.0.100');
  sim.advance(90000);
  ok(out1.some(l => l.includes('Hello from SV1')), 'VIP宛HTTPがマスターLB1のバックエンドへ到達');

  lb1.nic.adminUp = false;
  sim.advance(15000);
  ok(lb2.iface.vrrp.state === 'master', 'LB1停止後にLB2がマスターへ昇格');
  pc.stack.clearArp();
  const out2 = capture(pc);
  pc.exec('http get 10.0.0.100');
  sim.advance(90000);
  ok(out2.some(l => l.includes('Hello from SV2')), 'フェイルオーバー後もVIP宛HTTPが継続');

  const data = JSON.parse(JSON.stringify(net.serialize()));
  const sim2 = new NetSim.Simulator();
  const net2 = new NetSim.Network(sim2);
  net2.load(data);
  const restored = net2.findByName('LB2');
  ok(restored.iface.vrrp && restored.iface.vrrp.vip === '10.0.0.100', 'LBのVRRP設定が保存/復元される');
}

/* ---------- HA sample (VRRP + LB + DHCP relay) ---------- */
section('サンプル3: 冗長GW+LB+DHCP');
{
  const { sim, net } = fresh('ha-dc');
  sim.advance(60000);   // VRRP選出 + DHCPリレー取得
  const pc1 = net.findByName('PC1'), pc2 = net.findByName('PC2');
  ok(pc2.iface.ip && pc2.iface.ip.startsWith('10.0.1.1'), `PC2がリレー経由DHCPで取得 (${pc2.iface.ip})`);
  const rt1 = net.findByName('RT1');
  const v = rt1.getPort('Gi0/0').l3iface.vrrp;
  ok(v && v.state === 'master', 'RT1(優先度120)がVRRPマスター');
  const out = capture(pc1);
  pc1.exec('http get 10.0.2.5');
  sim.advance(90000);
  ok(out.some(l => l.includes('200 OK')), 'PC1 → VRRP GW → LB → サーバでHTTP成功');
}

/* ---------- fabric generator + performance ---------- */
section('スパイン・リーフ生成 + 性能 (200ホスト)');
{
  const { sim, net } = fresh();
  const t0 = Date.now();
  const info = NetSim.buildFabric(net, { spines: 2, leaves: 5, hostsPerLeaf: 40, groups: true });
  const tBuild = Date.now() - t0;
  ok(info.hosts === 200, `200ホスト生成 (${tBuild}ms)`);
  ok(net.devices.length === 207, 'デバイス総数 207 (2 spine + 5 leaf + 200 host)');
  ok(net.groups.length === 5 && net.groups.every(g => g.collapsed), 'ラックごとにグループ化(折りたたみ)');

  const t1 = Date.now();
  sim.advance(60000);   // OSPF収束
  const tConverge = Date.now() - t1;
  const leaf1 = net.findByName('LEAF1');
  const routes = leaf1.stack.dynRoutes.get('ospf') || [];
  const r42 = routes.find(r => r.network === '10.5.0.0' && r.len === 24);
  ok(r42 && r42.nexthops.length === 2, `LEAF1→LEAF5配下がECMP 2経路 (収束 ${tConverge}ms)`);

  // 全ホスト一斉にGWへping (ARPストーム含む)
  const t2 = Date.now();
  let good = 0, done = 0;
  for (const dev of net.devices) {
    if (dev.type !== 'pc' && dev.type !== 'server') continue;
    dev.stack.ping(dev.gateway, { count: 1 }, () => {}, (okF) => { done++; if (okF) good++; });
  }
  sim.advance(30000);
  const tStorm = Date.now() - t2;
  ok(done === 200 && good === 200, `200ホスト同時ping全成功 (${tStorm}ms)`);
  ok(tBuild + tConverge + tStorm < 10000, `合計実時間が10秒未満 (${tBuild + tConverge + tStorm}ms)`);

  // リーフ間疎通 (ECMP経由)
  const h11 = net.findByName('H1-1');
  const r = pingSync(sim, h11, '10.5.0.10');
  ok(r.result === true, 'H1-1 → H5-1 ファブリック越しに疎通');
}

/* ---------- NAT / PAT ---------- */
section('NAT/PAT (サンプル5)');
{
  const { sim, net } = fresh('nat');
  const rt1 = net.findByName('RT1');
  const pc1 = net.findByName('PC1');
  const pcOut = net.findByName('PC-NET');

  // インターフェースのinside/outside指定が入っている
  ok(rt1.getPort('Gi0/0').l3iface.natRole === 'inside', 'Gi0/0 が ip nat inside');
  ok(rt1.getPort('Gi0/1').l3iface.natRole === 'outside', 'Gi0/1 が ip nat outside');

  // 動的PAT: 内部PC → インターネット (ICMP)
  const r1 = pingSync(sim, pc1, '203.0.113.9');
  ok(r1.result === true, 'PC1 → 203.0.113.9 (PAT経由) ping 成功');
  const ent = rt1.stack.nat.entries.find(e => e.localIp === '10.0.1.11' && e.proto === 'icmp');
  ok(ent && ent.globalIp === '203.0.113.1', `内部10.0.1.11がグローバル203.0.113.1へ変換 (id→:${ent && ent.globalPort})`);

  // 動的PAT: TCP/HTTP も変換され疎通する
  const o1 = capture(pc1);
  pc1.exec('http get 203.0.113.9');
  sim.advance(120000);
  ok(o1.some(l => l.includes('Hello from WEB-NET')), 'PC1 → インターネットWebへ HTTP(PAT) 成功');
  ok(rt1.stack.nat.entries.some(e => e.proto === 'tcp' && e.localIp === '10.0.1.11'),
    'TCPフローのPAT変換エントリが作成された');

  // show ip nat translations が変換を表示
  const shown = capture(rt1);
  rt1.exec('enable'); rt1.exec('show ip nat translations');
  ok(shown.some(l => l.includes('203.0.113.1') && l.includes('10.0.1.11')), 'show ip nat translations に動的変換が表示');
  ok(shown.some(l => l.includes('203.0.113.50') && l.includes('10.0.1.50')), 'show ip nat translations に静的変換が表示');

  // 静的NAT: インターネット側PC → 公開アドレス203.0.113.50 → 内部サーバ10.0.1.50
  const o2 = capture(pcOut);
  pcOut.exec('http get 203.0.113.50');
  sim.advance(120000);
  ok(o2.some(l => l.includes('Hello from WEB-IN')), 'PC-NET → 203.0.113.50 (静的NAT) で内部サーバに到達');

  // NATを設定していない宛先(ルータ自身の外側IP)へのpingは素通り(ローカル応答)
  const r2 = pingSync(sim, pc1, '203.0.113.1');
  ok(r2.result === true, 'ルータ外側IPへの ping はローカル応答(NAT誤変換なし)');
}

/* ---------- NAT config persistence ---------- */
section('NAT: 設定の保存/復元');
{
  const { sim, net } = fresh('nat');
  const data = JSON.parse(JSON.stringify(net.serialize()));
  const sim2 = new NetSim.Simulator();
  const net2 = new NetSim.Network(sim2);
  net2.load(data);
  const rt = net2.findByName('RT1');
  ok(rt.getPort('Gi0/1').l3iface.natRole === 'outside', '復元後もGi0/1がoutside');
  ok(rt.stack.nat.statics.some(s => s.localIp === '10.0.1.50' && s.globalIp === '203.0.113.50'), '静的NATが復元された');
  ok(rt.stack.nat.dynRules.some(r => r.aclNum === 100 && r.overload), '動的PATルールが復元された');
  const pc1 = net2.findByName('PC1');
  const r = pingSync(sim2, pc1, '203.0.113.9');
  ok(r.result === true, '復元した構成でもPAT経由で疎通');
}

/* ---------- STP protection ---------- */
section('STP: 並列リンクのループ防止');
{
  const { sim, net } = fresh();
  const sw1 = net.addDevice('switch', 0, 0), sw2 = net.addDevice('switch', 0, 0);
  const pc1 = net.addDevice('pc', 0, 0);
  net.connect(sw1, 'Gi0/1', sw2, 'Gi0/1');
  net.connect(sw1, 'Gi0/2', sw2, 'Gi0/2');   // redundant link
  net.connect(pc1, 'eth0', sw1, 'Gi0/3');
  pc1.setIp('10.0.0.1', 24, null);
  let looped = false;
  sim.on('note', n => { if (n.kind === 'loop') looped = true; });
  pc1.stack.ping('10.0.0.99', { count: 1 }, () => {}, () => {});
  sim.advance(60000);
  ok(!looped, 'STPがブロードキャストストームを発生前に遮断');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
