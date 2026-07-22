#!/usr/bin/env node
/* Lightweight simulator benchmark. Run with: node tools/profile-sim.js */
'use strict';
const path = require('path');
const { performance } = require('perf_hooks');

const files = ['i18n', 'util', 'protocols', 'sim', 'link', 'device', 'acl', 'stack', 'nat', 'ospf', 'cli',
  'hub', 'switch', 'host', 'router', 'l3switch', 'lb', 'topology'];
for (const file of files) require(path.join(__dirname, '..', 'js', 'core', file + '.js'));
const NetSim = globalThis.NetSim;

const metrics = { scheduled: 0, transmissions: 0, linkCalls: 0, linkMs: 0, spfCalls: 0, spfMs: 0 };
const schedule = NetSim.Simulator.prototype.schedule;
NetSim.Simulator.prototype.schedule = function (delay, fn) {
  metrics.scheduled++;
  return schedule.call(this, delay, fn);
};
const addTransmission = NetSim.Simulator.prototype.addTransmission;
NetSim.Simulator.prototype.addTransmission = function (...args) {
  metrics.transmissions++;
  return addTransmission.apply(this, args);
};
const transmit = NetSim.Link.prototype.transmit;
NetSim.Link.prototype.transmit = function (...args) {
  metrics.linkCalls++;
  const start = performance.now();
  try { return transmit.apply(this, args); }
  finally { metrics.linkMs += performance.now() - start; }
};
const runSpf = NetSim.Ospf.prototype._runSpf;
NetSim.Ospf.prototype._runSpf = function (...args) {
  metrics.spfCalls++;
  const start = performance.now();
  try { return runSpf.apply(this, args); }
  finally { metrics.spfMs += performance.now() - start; }
};

const sim = new NetSim.Simulator();
const net = new NetSim.Network(sim);
let start = performance.now();
NetSim.buildFabric(net, { spines: 2, leaves: 5, hostsPerLeaf: 40, groups: true });
const buildMs = performance.now() - start;
start = performance.now();
sim.advance(60000);
const convergeMs = performance.now() - start;
for (const dev of net.devices) {
  if (dev.type === 'pc' || dev.type === 'server') {
    dev.stack.ping(dev.gateway, { count: 1 }, () => {}, () => {});
  }
}
start = performance.now();
sim.advance(30000);
const stormMs = performance.now() - start;

console.log(JSON.stringify({
  topology: { devices: net.devices.length, links: net.links.length },
  elapsedMs: { build: +buildMs.toFixed(2), converge: +convergeMs.toFixed(2), storm: +stormMs.toFixed(2) },
  metrics: { ...metrics, linkMs: +metrics.linkMs.toFixed(2), spfMs: +metrics.spfMs.toFixed(2) },
  pendingEvents: sim._heap.size,
}, null, 2));
