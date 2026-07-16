# VXLAN Kubernetes overlay topology

`demo-vxlan.json` keeps the existing campus, redundancy, NAT, and Kubernetes
lab topology. The Kubernetes Pod CIDRs are no longer advertised by OSPF.
Instead, every worker is a VXLAN tunnel endpoint (VTEP) on VLAN 151.

```mermaid
flowchart LR
  EXT[Campus / external networks]
  CORE[L3SW1 / L3SW2\nCampus distribution]
  SVC[L3SW3 / L3SW4\nService + egress VTEPs\nVRRP: 10.0.10.1]
  LB[Service LB pair\nVIP: 10.96.0.10]
  N1[Worker 1\nVTEP 10.0.10.11\nPod CIDR 10.224.1.0/24]
  N2[Worker 2\nVTEP 10.0.10.12\nPod CIDR 10.224.2.0/24]
  N6[Worker 6\nVTEP 10.0.10.16\nPod CIDR 10.224.6.0/24]

  EXT --- CORE --- SVC
  SVC --- LB
  SVC --- N1
  SVC --- N2
  SVC --- N6
  N1 -. VXLAN VNI 10100 .-> N2
  N2 -. VXLAN VNI 10100 .-> N6
```

## Routing and encapsulation

- OSPF advertises only the `10.0.10.0/24` Kubernetes underlay. No device
  outside the cluster learns `10.224.0.0/16` or an individual Pod CIDR.
- Each worker has static VXLAN prefix-to-VTEP mappings for the Pod CIDRs owned
  by the other workers. An inner packet to a remote Pod is wrapped in an outer
  packet whose source and destination are the two VTEP addresses.
- `L3SW3` and `L3SW4` are also VTEPs. They can encapsulate Service LB traffic
  to a selected Pod without installing Pod routes in the campus core.
- Worker `Vlan2` is NAT inside and `Vlan151` is NAT outside. Traffic to
  non-`10.0.0.0/8` destinations is source-NATed to the worker VTEP address.
  Return traffic therefore reaches the worker without an external Pod route.
- The NAT ACL deliberately excludes `10.0.0.0/8`, so Service-to-Pod traffic
  keeps its Pod source address and the LB TCP proxy remains stateful.

## What this models and what it does not

This models a static VXLAN control plane plus Node-local masquerade. In a
production Kubernetes installation, the CNI normally programs the prefix-to-
VTEP mappings and conntrack state automatically; EVPN, BGP, multicast, or a
control-plane database can distribute that information. This simulator uses
the saved topology configuration as that control plane.
