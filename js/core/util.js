/* NetSim core: namespace + utilities (browser & node compatible) */
(function (root) {
  const NetSim = (root.NetSim = root.NetSim || {});

  /* ---- tiny event emitter ---- */
  class Emitter {
    constructor() { this._ls = {}; }
    on(ev, fn) { (this._ls[ev] = this._ls[ev] || []).push(fn); return this; }
    off(ev, fn) {
      const a = this._ls[ev]; if (!a) return this;
      const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
      return this;
    }
    emit(ev, ...args) {
      const a = this._ls[ev]; if (!a) return;
      for (const fn of a.slice()) fn(...args);
    }
  }

  /* ---- id / mac generation ---- */
  let idSeq = 1;
  function nextId(prefix) { return (prefix || 'id') + (idSeq++); }
  function resetIds() { idSeq = 1; macSeq = 1; }

  let macSeq = 1;
  function genMac() {
    const n = macSeq++;
    const b4 = (n >> 16) & 0xff, b5 = (n >> 8) & 0xff, b6 = n & 0xff;
    return ['02', '00', '5e', hex(b4), hex(b5), hex(b6)].join(':');
  }
  function hex(b) { return b.toString(16).padStart(2, '0'); }

  const BROADCAST_MAC = 'ff:ff:ff:ff:ff:ff';

  /* ---- IPv4 helpers (dotted string <-> uint32) ---- */
  function ipToInt(ip) {
    const p = String(ip).trim().split('.');
    if (p.length !== 4) return null;
    let v = 0;
    for (const s of p) {
      if (!/^\d{1,3}$/.test(s)) return null;
      const n = Number(s);
      if (n > 255) return null;
      v = (v * 256) + n;
    }
    return v >>> 0;
  }
  function intToIp(v) {
    v = v >>> 0;
    return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.');
  }
  function isValidIp(ip) { return ipToInt(ip) !== null; }

  function maskToLen(mask) {
    const v = ipToInt(mask);
    if (v === null) return null;
    let len = 0, seenZero = false;
    for (let i = 31; i >= 0; i--) {
      if ((v >>> i) & 1) { if (seenZero) return null; len++; }
      else seenZero = true;
    }
    return len;
  }
  function lenToMask(len) {
    if (len === 0) return '0.0.0.0';
    return intToIp((0xffffffff << (32 - len)) >>> 0);
  }
  function networkOf(ip, len) {
    const v = ipToInt(ip);
    if (len === 0) return '0.0.0.0';
    return intToIp((v & ((0xffffffff << (32 - len)) >>> 0)) >>> 0);
  }
  function broadcastOf(ip, len) {
    const v = ipToInt(ip);
    if (len === 32) return intToIp(v);
    const host = (0xffffffff >>> len);
    return intToIp(((v | host) >>> 0));
  }
  function sameSubnet(ip1, ip2, len) {
    return networkOf(ip1, len) === networkOf(ip2, len);
  }
  function inNetwork(ip, net, len) {
    return networkOf(ip, len) === networkOf(net, len);
  }
  function isValidPort(port) {
    return Number.isInteger(Number(port)) && Number(port) >= 1 && Number(port) <= 65535;
  }

  /* ---- deep clone for plain-data frames (structuredClone is ~5x faster).
   * Called through a wrapper: a detached reference to structuredClone throws
   * "Illegal invocation" in Chrome. ---- */
  const clone = (typeof structuredClone === 'function')
    ? function (obj) { return structuredClone(obj); }
    : function (obj) { return JSON.parse(JSON.stringify(obj)); };

  /* ---- FNV-1a string hash (flow hashing for ECMP / port channels) ---- */
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function fmtTime(ms) {
    return (ms / 1000).toFixed(3) + 's';
  }

  NetSim.Emitter = Emitter;
  NetSim.nextId = nextId;
  NetSim.resetIds = resetIds;
  NetSim.genMac = genMac;
  NetSim.BROADCAST_MAC = BROADCAST_MAC;
  NetSim.ip = {
    toInt: ipToInt, fromInt: intToIp, isValid: isValidIp,
    maskToLen, lenToMask, networkOf, broadcastOf, sameSubnet, inNetwork,
  };
  NetSim.isValidPort = isValidPort;
  NetSim.clone = clone;
  NetSim.hashStr = hashStr;
  NetSim.fmtTime = fmtTime;
})(typeof window !== 'undefined' ? window : globalThis);
