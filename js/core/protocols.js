/* NetSim core: protocol data unit builders + human-readable decoding.
 * All PDUs are plain JSON-serializable objects so they can be cloned per hop. */
(function (root) {
  const NetSim = root.NetSim;
  const { BROADCAST_MAC } = NetSim;

  /* ---------- builders ---------- */

  function eth(src, dst, type, payload, vlan) {
    return { l2: 'eth', src, dst, type, vlan: vlan == null ? null : vlan, payload, hops: 0 };
  }

  function arpRequest(senderMac, senderIp, targetIp) {
    return { op: 'request', senderMac, senderIp, targetMac: '00:00:00:00:00:00', targetIp };
  }
  function arpReply(senderMac, senderIp, targetMac, targetIp) {
    return { op: 'reply', senderMac, senderIp, targetMac, targetIp };
  }

  function ipv4(src, dst, proto, payload, ttl) {
    return { l3: 'ipv4', src, dst, proto, ttl: ttl == null ? 64 : ttl, payload };
  }

  function icmpEchoRequest(id, seq, size) {
    return { type: 'echo-request', id, seq, size: size || 32 };
  }
  function icmpEchoReply(id, seq, size) {
    return { type: 'echo-reply', id, seq, size: size || 32 };
  }
  /* orig: {src,dst,proto, udpDstPort?} summary of the packet that triggered the error */
  function icmpTtlExceeded(orig) { return { type: 'ttl-exceeded', orig }; }
  function icmpUnreachable(code, orig) { return { type: 'dest-unreachable', code, orig }; }
  // codes: 'net' | 'host' | 'port' | 'admin'

  function udp(srcPort, dstPort, data) {
    return { l4: 'udp', srcPort, dstPort, data };
  }

  function tcp(srcPort, dstPort, flags, seq, ack, data) {
    return { l4: 'tcp', srcPort, dstPort, flags, seq, ack, data: data || null };
  }

  /* ---------- decoding for logs / UI ---------- */

  function flagStr(flags) {
    const order = ['SYN', 'ACK', 'PSH', 'FIN', 'RST'];
    return order.filter(f => flags.includes(f)).join(',');
  }

  function summarize(frame) {
    const p = frame.payload;
    if (frame.type === 'arp') {
      if (p.op === 'request') {
        if (p.senderIp === p.targetIp) return `ARP Gratuitous  ${p.senderIp} is at ${p.senderMac}`;
        return `ARP Request  Who has ${p.targetIp}? Tell ${p.senderIp}`;
      }
      return `ARP Reply  ${p.senderIp} is at ${p.senderMac}`;
    }
    if (frame.type === 'ipv4') {
      const ip = p;
      const l4 = ip.payload;
      let inner;
      switch (ip.proto) {
        case 'icmp':
          if (l4.type === 'echo-request') inner = `ICMP Echo Request seq=${l4.seq}`;
          else if (l4.type === 'echo-reply') inner = `ICMP Echo Reply seq=${l4.seq}`;
          else if (l4.type === 'ttl-exceeded') inner = 'ICMP TTL Exceeded';
          else inner = `ICMP Unreachable (${l4.code})`;
          break;
        case 'tcp':
          inner = `TCP ${l4.srcPort}→${l4.dstPort} [${flagStr(l4.flags)}] seq=${l4.seq}` +
            (l4.flags.includes('ACK') ? ` ack=${l4.ack}` : '') +
            (l4.data ? ` len=${String(l4.data).length}` : '');
          break;
        case 'udp':
          if (l4.data && l4.data.dhcp) {
            inner = `DHCP ${String(l4.data.op).toUpperCase()}` +
              (l4.data.yiaddr ? ` (${l4.data.yiaddr})` : '') +
              (l4.data.giaddr ? ` via relay ${l4.data.giaddr}` : '');
          } else if (l4.dstPort === 4789 && l4.data && l4.data.vxlan) {
            const inr = l4.data.inner || {};
            inner = `VXLAN UDP/4789 VNI=${l4.data.vni} inner ${inr.src || '?'} → ${inr.dst || '?'}`;
          } else {
            inner = `UDP ${l4.srcPort}→${l4.dstPort} len=${String(l4.data == null ? '' : l4.data).length}`;
          }
          break;
        case 'ospf':
          if (l4.type === 'hello') inner = `OSPF Hello RID=${l4.routerId}`;
          else if (l4.type === 'lsu') inner = `OSPF LSUpdate (${l4.lsas.length} LSA)`;
          else inner = `OSPF LSA Purge RID=${l4.routerId}`;
          break;
        case 'vrrp':
          inner = `VRRP Advertisement grp=${l4.gid} prio=${l4.priority} vip=${l4.vip}`;
          break;
        default:
          inner = ip.proto;
      }
      const vtag = frame.vlan != null ? `[VLAN ${frame.vlan}] ` : '';
      return `${vtag}${ip.src} → ${ip.dst}  ${inner}  ttl=${ip.ttl}`;
    }
    return frame.type;
  }

  /* protocol key used for coloring */
  function protoKey(frame) {
    if (frame.type === 'arp') return 'arp';
    if (frame.type === 'ipv4') {
      const proto = frame.payload.proto;
      if (proto === 'icmp') return 'icmp';
      if (proto === 'tcp') return 'tcp';
      if (proto === 'udp' && frame.payload.payload.dstPort === 4789 && frame.payload.payload.data && frame.payload.payload.data.vxlan) return 'vxlan';
      if (proto === 'udp') return 'udp';
      if (proto === 'ospf' || proto === 'vrrp') return 'ctrl';
    }
    return 'other';
  }

  /* full layer-by-layer breakdown: [{title, fields:{k:v}}] */
  function decode(frame) {
    const layers = [];
    const l2 = {
      'Destination MAC': frame.dst,
      'Source MAC': frame.src,
      'EtherType': frame.type === 'arp' ? '0x0806 (ARP)' : '0x0800 (IPv4)',
    };
    if (frame.vlan != null) l2['802.1Q VLAN'] = String(frame.vlan);
    layers.push({ title: 'Ethernet II', fields: l2 });

    if (frame.type === 'arp') {
      const p = frame.payload;
      layers.push({
        title: 'ARP', fields: {
          'Operation': p.op === 'request' ? 'Request (1)' : 'Reply (2)',
          'Sender MAC': p.senderMac, 'Sender IP': p.senderIp,
          'Target MAC': p.targetMac, 'Target IP': p.targetIp,
        }
      });
      return layers;
    }
    const ip = frame.payload;
    layers.push({
      title: 'IPv4', fields: {
        'Source': ip.src, 'Destination': ip.dst,
        'TTL': String(ip.ttl), 'Protocol': ip.proto.toUpperCase(),
      }
    });
    const l4 = ip.payload;
    if (ip.proto === 'icmp') {
      const f = { 'Type': l4.type };
      if (l4.seq != null) { f['Identifier'] = String(l4.id); f['Sequence'] = String(l4.seq); }
      if (l4.code) f['Code'] = l4.code;
      if (l4.orig) f['Original packet'] = `${l4.orig.src} → ${l4.orig.dst} (${l4.orig.proto})`;
      layers.push({ title: 'ICMP', fields: f });
    } else if (ip.proto === 'tcp') {
      layers.push({
        title: 'TCP', fields: {
          'Source Port': String(l4.srcPort), 'Destination Port': String(l4.dstPort),
          'Flags': flagStr(l4.flags), 'Seq': String(l4.seq), 'Ack': String(l4.ack),
          'Data': l4.data ? JSON.stringify(String(l4.data).slice(0, 120)) : '(none)',
        }
      });
    } else if (ip.proto === 'udp') {
      const uf = {
        'Source Port': String(l4.srcPort), 'Destination Port': String(l4.dstPort),
      };
      if (l4.data && l4.data.dhcp) {
        layers.push({ title: 'UDP', fields: uf });
        const d = l4.data;
        const df = { 'Message Type': String(d.op).toUpperCase(), 'Client MAC (chaddr)': d.chaddr, 'Transaction ID': String(d.xid) };
        if (d.yiaddr) df['Your IP (yiaddr)'] = `${d.yiaddr}/${d.maskLen}`;
        if (d.gw) df['Router Option'] = d.gw;
        if (d.serverId) df['Server ID'] = d.serverId;
        if (d.giaddr) df['Relay (giaddr)'] = d.giaddr;
        layers.push({ title: 'DHCP', fields: df });
      } else if (l4.dstPort === 4789 && l4.data && l4.data.vxlan) {
        layers.push({ title: 'UDP', fields: uf });
        const d = l4.data, inner = d.inner || {};
        layers.push({ title: 'VXLAN', fields: {
          'Flags': 'I (0x08)', 'VNI': String(d.vni),
          'Inner Ethernet': `${inner.src || '?'} → ${inner.dst || '?'} (${inner.type || '?'})`,
        }});
      } else {
        uf['Data'] = l4.data != null ? JSON.stringify(String(l4.data).slice(0, 120)) : '(none)';
        layers.push({ title: 'UDP', fields: uf });
      }
    } else if (ip.proto === 'ospf') {
      const f = { 'Type': l4.type === 'lsu' ? 'LS Update' : (l4.type === 'hello' ? 'Hello' : 'LSA Purge') };
      if (l4.area != null) f['Area'] = String(l4.area);
      if (l4.routerId) f['Router ID'] = l4.routerId;
      if (l4.seen) f['Neighbors seen'] = l4.seen.join(', ') || '(none)';
      if (l4.lsas) {
        f['LSA count'] = String(l4.lsas.length);
        l4.lsas.slice(0, 6).forEach((lsa, i) => {
          f[`LSA[${i}] Area=${lsa.area} RID=${lsa.routerId} seq=${lsa.seq}`] =
            lsa.nets.map(n => `${n.network}/${n.len}(cost ${n.cost})`).join(', ');
        });
      }
      layers.push({ title: 'OSPF', fields: f });
    } else if (ip.proto === 'vrrp') {
      layers.push({
        title: 'VRRP', fields: {
          'Group ID': String(l4.gid), 'Priority': String(l4.priority), 'Virtual IP': l4.vip,
        }
      });
    }
    return layers;
  }

  NetSim.pdu = {
    eth, arpRequest, arpReply, ipv4,
    icmpEchoRequest, icmpEchoReply, icmpTtlExceeded, icmpUnreachable,
    udp, tcp,
  };
  NetSim.decode = { summarize, decode, protoKey, flagStr };
})(typeof window !== 'undefined' ? window : globalThis);
