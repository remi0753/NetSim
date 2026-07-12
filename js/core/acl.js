/* NetSim core: simplified numbered extended ACLs (Cisco-style) */
(function (root) {
  const NetSim = root.NetSim;
  const IP = NetSim.ip;

  /* addr spec: {any:true} | {host:'1.2.3.4'} | {net:'10.0.0.0', wild:'0.0.0.255'} */
  function addrMatch(spec, ip) {
    if (!spec || spec.any) return true;
    if (spec.host) return spec.host === ip;
    const n = IP.toInt(spec.net), w = IP.toInt(spec.wild), v = IP.toInt(ip);
    if (n === null || w === null || v === null) return false;
    return ((n ^ v) & ~w) === 0;
  }
  function addrText(spec) {
    if (!spec || spec.any) return 'any';
    if (spec.host) return `host ${spec.host}`;
    return `${spec.net} ${spec.wild}`;
  }

  /* rule: {action, proto:'ip'|'icmp'|'tcp'|'udp', src, dst, dstPort:null|number} */
  function ruleMatch(rule, pkt) {
    if (rule.proto !== 'ip' && rule.proto !== pkt.proto) return false;
    if (!addrMatch(rule.src, pkt.src)) return false;
    if (!addrMatch(rule.dst, pkt.dst)) return false;
    if (rule.dstPort != null) {
      if (pkt.proto !== 'tcp' && pkt.proto !== 'udp') return false;
      if (pkt.payload.dstPort !== rule.dstPort) return false;
    }
    return true;
  }
  function ruleText(rule) {
    let s = `${rule.action} ${rule.proto} ${addrText(rule.src)} ${addrText(rule.dst)}`;
    if (rule.dstPort != null) s += ` eq ${rule.dstPort}`;
    return s;
  }

  /* returns true = permit. Empty/unknown list permits (like unapplied ACL). */
  function evaluate(rules, pkt) {
    if (!rules || !rules.length) return true;
    for (const r of rules) {
      if (ruleMatch(r, pkt)) return r.action === 'permit';
    }
    return false;   // implicit deny any
  }

  NetSim.acl = { addrMatch, addrText, ruleMatch, ruleText, evaluate };
})(typeof window !== 'undefined' ? window : globalThis);
