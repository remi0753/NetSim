# NetSim で Kubernetes を再現する — 応用編: 物理サーバ3台 × 6ノード + 外部ゲートウェイ

[k8s-mapping.md](k8s-mapping.md) の3ノード構成(各ノード=L3スイッチを CORE に直結)を土台に、
実機に一歩近づけて **「物理サーバ層」** と **「クラスタ外への出入り口」** を足す。

- **物理サーバ層**: 1台の host server(物理サーバ)に **ノードVMを2つ** 載せ、**host server を3台**使って
  合計 **6ノード = 1クラスタ** を組む。
- **外部ゲートウェイ**: クラスタと別ネットワーク(社外/インターネット相当)の **出入り口** を境界ルータで作る。
  Pod からの外向き通信(**egress / SNAT**)と、外部からクラスタ内 Service への到達(**ingress = type=LoadBalancer 相当**)を
  NAT/PAT で再現する。

CNI・Service・OSPF・Pod GW など**データプレーンの基本対応は [k8s-mapping.md](k8s-mapping.md) のまま**。
本書はそこに差分として被せる形で読む。

---

## 1. 物理サーバ層のモデル化 —「host server = 内部の仮想ブリッジ」

実機で1台の物理サーバ上に複数のノードVMを動かすとき、各VMの仮想NICは
**サーバ内部の仮想ブリッジ(Linux bridge / Open vSwitch / vSwitch)** に刺さり、
そのブリッジが物理NICと束ねられて外(ToR スイッチ)へ出る。物理サーバ自身は
VM に対して **L3 ルータではなく L2 ブリッジ** として振る舞う。これをそのまま写す。

| インフラ要素 | NetSim での再現 | 忠実度 | 備考 |
|---|---|---|---|
| **host server(物理サーバ)** | **グループ(ラック)** = L2スイッチ + ノード2台をまとめた箱 | ◎ | 1物理に2ノードVMを収容。GUI のグループ機能で1箱に畳める |
| **サーバ内部の仮想ブリッジ**(Linux bridge / OVS) | **L2スイッチ**(`HostSW`) | ◎ | VM の仮想NICと物理NICをブリッジする、設定不要の素の L2 |
| **ノードVMの仮想NIC** | ノード(L3SW)の Gi0/1 = アップリンク | ◎ | VLAN90(underlay)にアクセス接続 |
| **物理NIC(アップリンク)** | `HostSW` の Gi0/8 → CORE | ◎ | ホスト1本の上位リンク。ここが詰まると2ノード分が道連れ(§6) |
| **ToR / 集約スイッチ** | **CORE**(L3SW) | ◎ | 3つの host server を相互接続 + Service 網 + OSPF ハブ |
| **ノード(kubelet を持つVM)** | L3スイッチ | ◎ | [k8s-mapping.md](k8s-mapping.md) と同一。Pod GW 兼ルータ |

> **要点**: 「物理サーバ」は L3 の分割点を作らない。underlay(ノード間ネットワーク)は
> **フラットな L2** として3ホストにまたがり、CORE がそれを束ねる。こうすると
> 「同じ物理サーバ上のノード同士」の通信がホスト内スイッチで完結する挙動(=ノードローカリティ、§3)を
> 観察できるようになる。これが3ノード版には無い、この構成の主眼。

---

## 2. トポロジと IP 設計

> ポート番号: L3スイッチ/L2スイッチは **Gi0/1〜Gi0/8(1始まり、Gi0/0 は無い)**、
> ルータ(EDGE-RT)は **Gi0/0〜(0始まり)**。

```
        別ネットワーク (社外/インターネット)  203.0.113.0/24
        ┌────────────┐  ext-  ┌──────────────┐  境界ルータ(NAT)
        │ ext-client │──-SW──│  EDGE-RT      │  Gi0/1 outside 203.0.113.1
        │ .20        │        │  (router)    │  Gi0/0 inside  10.0.0.254
        └────────────┘        └──────┬───────┘   ↑クラスタ側の既定GW
                          CORE Gi0/5 │ (VLAN90 = underlay)
        ┌────────────────────────────┴──────────────────────────────┐
        │ CORE (L3SW) = ToR / 集約スイッチ                            │ OSPF area0
        │ Vlan90 10.0.0.1/24 (underlay)  Vlan96 10.96.0.1/24 (Svc網)  │──● svc-web(LB)
        └──┬────────────┬────────────┬────────────────────────────┬──┘   ClusterIP
        Gi0/1        Gi0/2        Gi0/3        (Gi0/4→LB, VLAN96)─┘      10.96.0.10:80
           │VLAN90       │VLAN90       │VLAN90
      ┌────┴─────┐  ┌────┴─────┐  ┌────┴─────┐
      │ HostSW1  │  │ HostSW2  │  │ HostSW3  │   ← host server の仮想ブリッジ (L2, 設定不要)
      │  = host1 │  │  = host2 │  │  = host3 │      Gi0/8=上位(物理NIC), Gi0/1・Gi0/2=ノード
      └─┬──────┬─┘  └─┬──────┬─┘  └─┬──────┬─┘
      Gi0/1  Gi0/2  Gi0/1  Gi0/2  Gi0/1  Gi0/2
        │      │      │      │      │      │       (各ノードの uplink = Gi0/1)
     ┌──┴─┐ ┌─┴──┐ ┌─┴──┐ ┌─┴──┐ ┌─┴──┐ ┌─┴──┐
     │Node1│ │Node2│ │Node3│ │Node4│ │Node5│ │Node6│ ← node = L3SW (VM)
     │.11  │ │.12  │ │.13  │ │.14  │ │.15  │ │.16  │   underlay 10.0.0.1N
     │244.1│ │244.2│ │244.3│ │244.4│ │244.5│ │244.6│   Pod CIDR 10.244.N.0/24
     └─┬──┘ └─┬──┘ └─┬──┘ └─┬──┘ └─┬──┘ └─┬──┘
      Pods   Pods   Pods   Pods   Pods   Pods         ← Pod=Host(http server), 各node Gi0/2+
```

### ノードと物理サーバの対応

| ノード | 所属 host | 接続 | underlay (Vlan90) | Pod GW (Vlan1) | Pod CIDR |
|---|---|---|---|---|---|
| Node1 | **host1** | HostSW1 Gi0/1 | 10.0.0.11 | 10.244.1.1 | 10.244.1.0/24 |
| Node2 | **host1** | HostSW1 Gi0/2 | 10.0.0.12 | 10.244.2.1 | 10.244.2.0/24 |
| Node3 | **host2** | HostSW2 Gi0/1 | 10.0.0.13 | 10.244.3.1 | 10.244.3.0/24 |
| Node4 | **host2** | HostSW2 Gi0/2 | 10.0.0.14 | 10.244.4.1 | 10.244.4.0/24 |
| Node5 | **host3** | HostSW3 Gi0/1 | 10.0.0.15 | 10.244.5.1 | 10.244.5.0/24 |
| Node6 | **host3** | HostSW3 Gi0/2 | 10.0.0.16 | 10.244.6.1 | 10.244.6.0/24 |

### サブネット一覧

| 区分 | サブネット | 割当 | k8s 相当 |
|---|---|---|---|
| underlay | `10.0.0.0/24` (VLAN90) | CORE=.1、Node1〜6=.11〜.16、**EDGE=.254** | ノードのプライマリ NIC 網 |
| Service | `10.96.0.0/24` (VLAN96) | CORE=.1(GW)、ClusterIP=.10(LB) | `--service-cluster-ip-range` |
| Pod (Node N) | `10.244.N.0/24` | GW `.1`(SVI Vlan1)、Pod `.11〜` | `podCIDR` |
| **外部網** | `203.0.113.0/24` | EDGE=.1(GW)、**外部公開VIP=.50**、ext-client=.20 | 社外/インターネット、LoadBalancer VIP |

underlay・Service・全 Pod CIDR は `10.0.0.0/8` 配下なので、OSPF は各機器とも
`network 10.0.0.0 0.255.255.255 area 0` の一行で足りる。外部網 `203.0.113.0/24` だけは
配下外なので OSPF には載らず、クラスタ側は**静的デフォルト経路**で EDGE へ向ける(§4-6)。

---

## 3. ノードローカリティ — この構成でこそ見える挙動

underlay をフラット L2 にしたので、ノード間 Pod 通信の**物理経路が配置で変わる**。

| 通信 | 物理経路 | 何が言えるか |
|---|---|---|
| **同一ノード**内 Pod↔Pod | ノード(L3SW)の中で完結 | ホップ0。同一ノードスケジューリング最速 |
| **同一 host server** の別ノード<br>(例 Node1↔Node2) | `Node1 → HostSW1 → Node2`<br>**ホスト内スイッチで完結。CORE を通らない** | 物理NIC・ToR を消費しない。同じ物理に載せる利点 |
| **別 host server**<br>(例 Node1↔Node3) | `Node1 → HostSW1 → CORE → HostSW2 → Node3`<br>物理NIC・ToR を経由 | ホスト跨ぎは上位リンク帯域を使う |

**確かめ方**(§6 に再掲): pod1a(Node1配下)から `traceroute` すると、
Node2 配下の Pod へは経由ルータが Node1→Node2 の1段、Node3 配下へは Node1→Node3 の1段だが、
**パケットログ**を見ると前者は HostSW1 で折り返し、後者は CORE を通っているのが分かる。

> k8s では `topologySpreadConstraints` / Pod アフィニティ(`topologyKey: kubernetes.io/hostname`)で
> 「同じ物理に寄せる/散らす」を制御する。その効き目(近さ=速さ、集中=障害同時性)を
> このトポロジで体感できる。障害同時性は §6 のホスト障害で見る。

---

## 4. 構築手順(実際に打つコマンド)

配置・結線は GUI(パレット→🔌結線)で行い、設定は各デバイスのコンソール(ダブルクリック)で打つ。
ポートは既定8ポート。**[k8s-mapping.md](k8s-mapping.md) §4 と重なる部分はそのまま**で、
差分(host server層の L2、静的デフォルト、外部GW)を中心に示す。

### 4-0. 置くデバイス

| 役割 | パレット | 台数 | 名前 |
|---|---|---|---|
| ToR/集約 | L3スイッチ | 1 | CORE |
| host server 内ブリッジ | **L2スイッチ** | 3 | HostSW1〜3 |
| ノード(VM) | L3スイッチ | 6 | Node1〜6 |
| Pod | Host(PC/サーバ) | 6〜 | 各ノード配下に1つ以上 |
| Service | LB | 1 | svc-web |
| 境界ルータ | **ルータ** | 1 | EDGE-RT |
| 外部ホスト | Host(PC/サーバ) | 1 | ext-client |
| 外部網スイッチ | L2スイッチ | 1 | ext-SW |

**結線**: 各 HostSW の Gi0/1・Gi0/2 に2ノードの Gi0/1(uplink)、HostSW の Gi0/8 を CORE(Gi0/1〜0/3)へ。
CORE Gi0/4→LB、CORE Gi0/5→EDGE-RT Gi0/0。EDGE-RT Gi0/1→ext-SW Gi0/8、ext-SW Gi0/1→ext-client。
各ノードの Gi0/2 以降に Pod。**GUI で HostSW+2ノード+その Pod をまとめてグループ化**すると host server が1箱になる。
(L3SW/L2SW は Gi0/1 始まり・Gi0/0 なし、ルータは Gi0/0 始まり)

### 4-1. CORE(ToR + Service 網 + OSPF + 既定経路)

3ノード版([k8s-mapping.md](k8s-mapping.md) §4-1)に対し、ノード向けが3ポート(先が L2 に変わるだけ)、
**EDGE 向け Gi0/5** と **外部への既定経路** を足す。

```
enable
configure terminal
 interface Gi0/1
  switchport access vlan 90          ! → HostSW1
  exit
 interface Gi0/2
  switchport access vlan 90          ! → HostSW2
  exit
 interface Gi0/3
  switchport access vlan 90          ! → HostSW3
  exit
 interface Gi0/4
  switchport access vlan 96          ! → LB(Service網)
  exit
 interface Gi0/5
  switchport access vlan 90          ! → EDGE-RT(underlay)
  exit
 interface Vlan90
  ip address 10.0.0.1 255.255.255.0
  exit
 interface Vlan96
  ip address 10.96.0.1 255.255.255.0
  exit
 router ospf 1
  network 10.0.0.0 0.255.255.255 area 0
  passive-interface Vlan96           ! Service網側はHello不要
  exit
 ip route 0.0.0.0 0.0.0.0 10.0.0.254 ! 外部・LB戻り用の既定経路 → EDGE
 end
```

### 4-2. HostSW1〜3(物理サーバの内部ブリッジ = 素の L2)

**アクセス VLAN90 を張るだけ**。IP も OSPF も持たない(仮想ブリッジそのもの)。3台とも同じ。

```
enable
configure terminal
 interface Gi0/1
  switchport access vlan 90          ! → 奇数ノード(Node1/3/5)
  exit
 interface Gi0/2
  switchport access vlan 90          ! → 偶数ノード(Node2/4/6)
  exit
 interface Gi0/8
  switchport access vlan 90          ! → CORE(アップリンク=物理NIC)
  end
```

### 4-3. Node1〜6(N=1..6 を読み替え)

3ノード版([k8s-mapping.md](k8s-mapping.md) §4-2)と実質同一。差分は **外部向けの静的デフォルト経路** の1行だけ。
アップリンク `Gi0/1` の先が CORE 直結から HostSW 経由に変わるが、ノードから見た設定は変わらない。

```
enable
configure terminal
 interface Gi0/1
  switchport access vlan 90
  exit
 interface Vlan90
  ip address 10.0.0.1N 255.255.255.0     ! ← 下表の「underlay」
  exit
 interface Vlan1
  ip address 10.244.N.1 255.255.255.0    ! ← 下表の「Pod GW」
  exit
 router ospf 1
  network 10.0.0.0 0.255.255.255 area 0
  passive-interface Vlan1                ! Pod側にHelloを送らない
  exit
 ip route 0.0.0.0 0.0.0.0 10.0.0.254     ! 既定経路 → EDGE(Pod egress 用)
 end
```

| ノード | underlay(Vlan90) | Pod GW(Vlan1) |
|---|---|---|
| Node1 | 10.0.0.11 | 10.244.1.1 |
| Node2 | 10.0.0.12 | 10.244.2.1 |
| Node3 | 10.0.0.13 | 10.244.3.1 |
| Node4 | 10.0.0.14 | 10.244.4.1 |
| Node5 | 10.0.0.15 | 10.244.5.1 |
| Node6 | 10.0.0.16 | 10.244.6.1 |

### 4-4. Pod(Host。各ノードの Gi0/2 以降)

```
set ip 10.244.N.11 255.255.255.0 10.244.N.1     ! Node N 配下
http server on                                   ! コンテナ(Webアプリ)相当
```

### 4-5. Service(LB。CORE の Gi0/4、VLAN96)

6ノードなので backend(Endpoint)を各ノードの Pod ぶん登録する。

```
set ip 10.96.0.10 255.255.255.0 10.96.0.1        ! ClusterIP
lb service 80
lb backend add 10.244.1.11 80
lb backend add 10.244.2.11 80
lb backend add 10.244.3.11 80
lb backend add 10.244.4.11 80
lb backend add 10.244.5.11 80
lb backend add 10.244.6.11 80
lb status
```

### 4-6. EDGE-RT(境界ルータ = クラスタと別ネットワークの出入り口)

**ルータのインターフェースは初期状態 shutdown** なので `no shutdown` が要る。
inside=underlay 側、outside=別ネットワーク側。egress(PAT)と ingress(静的NAT)の両方をここで作る。

```
enable
configure terminal
 interface Gi0/0
  ip address 10.0.0.254 255.255.255.0    ! inside(underlay)。クラスタ側の既定GW
  ip nat inside
  no shutdown
  exit
 interface Gi0/1
  ip address 203.0.113.1 255.255.255.0   ! outside(別ネットワーク)
  ip nat outside
  no shutdown
  exit
 router ospf 1
  network 10.0.0.0 0.255.255.255 area 0  ! underlay で OSPF 参加 → Pod CIDR / Service網を学習
  exit                                    ! (外部網203.0.113/24は配下外なのでOSPFには載らない)
 access-list 100 permit ip 10.244.0.0 0.0.255.255 any     ! 全 Pod CIDR(10.244.*.*)
 ip nat inside source list 100 interface Gi0/1 overload   ! egress: Pod→外部 を PAT
 ip nat inside source static 10.96.0.10 203.0.113.50      ! ingress: ClusterIP を外部公開(LoadBalancer VIP)
 end
```

- OSPF を underlay で回すことで EDGE は Pod CIDR(10.244.N.0/24)と Service 網(10.96.0.0/24)を学習する。
  これで **ingress の DNAT 先(ClusterIP)** と **egress の戻り(該当 Pod)** を正しくルーティングできる。
- 外部網 `203.0.113.0/24` は EDGE の connected として持つだけ(OSPF には広告しない)。
  だからクラスタ側は §4-1・§4-3 の **静的デフォルト → 10.0.0.254** で外へ出る。

### 4-7. ext-client(外部ホスト)

```
set ip 203.0.113.20 255.255.255.0 203.0.113.1
http server on                                   ! (任意)egress の応答確認用
```

---

## 5. 外部ゲートウェイの対応 — egress / ingress

| k8s / ネットワーク要素 | NetSim での再現 | 忠実度 | 備考 |
|---|---|---|---|
| **Pod egress**(外向き SNAT / masquerade) | 境界ルータの **PAT**(`... interface Gi0/1 overload`) | ○ | Pod 送信元 IP → EDGE のグローバル(203.0.113.1)に集約。ポートで多重化 |
| **type=LoadBalancer の外部VIP** | **静的NAT**(ClusterIP→外部IP)+ proxy-ARP | ○ | 外部 `203.0.113.50` → ClusterIP `10.96.0.10`。1:1 |
| **egress の送信元固定**(egress IP) | 特定 Pod の静的NAT | ○ | `ip nat inside source static <PodIP> <外部IP>` で固定公開も可 |
| **NodePort**(`:30000`) | (静的NATで近似) | △ | ポート単位NATは未実装。厳密再現は不可([k8s-mapping.md](k8s-mapping.md) §7) |
| **Ingress(L7:ホスト/パス)** | 非対応 | ✗ | L4 まで。HTTP ルーティングは不可 |

### (a) egress: Pod → 外部 `pod1a → ext-client`
1. pod1a(`10.244.1.11`)→ 既定GW Node1 → Node1 の**静的デフォルト** `0.0.0.0/0 via 10.0.0.254` で EDGE へ
2. EDGE は inside→outside へ抜けるとき ACL100 に一致した送信元を PAT: `10.244.1.11:xxxx → 203.0.113.1:yyyy`
3. ext-client には **203.0.113.1 から来たように見える**(Pod IP は外に漏れない = masquerade)
4. `show ip nat translations` を EDGE で見ると変換表が並ぶ。戻りは EDGE が宛先を Pod IP に戻して該当ノードへ

### (b) ingress: 外部 → Service `ext-client → 203.0.113.50:80`
1. ext-client → `203.0.113.50`。EDGE が **proxy-ARP** で応答し、outside→inside で宛先を DNAT: `203.0.113.50 → 10.96.0.10`(ClusterIP)
2. EDGE は OSPF 学習の `10.96.0.0/24 via 10.0.0.1`(CORE)で LB へ。LB がラウンドロビンで backend Pod に TCP プロキシ
3. 戻りは LB(src `10.96.0.10`)→ CORE →(CORE の静的デフォルト)→ EDGE。EDGE が inside→outside で src を `203.0.113.50` に戻す
4. = **type=LoadBalancer の外部 VIP** に外から到達し、内部で複数 Pod に分散される挙動

---

## 6. 検証(打って確かめる)

| 見たいこと | 操作 | 期待 |
|---|---|---|
| 6ノード+EDGE が全て OSPF 隣接 | CORE で `show ip ospf neighbor` | Node1〜6・EDGE が **FULL**(=`kubectl get nodes` 全 Ready) |
| Pod CIDR が全部見える | CORE で `show ip route` | `O 10.244.1.0/24`〜`10.244.6.0/24` が並ぶ |
| **同一ホスト vs 別ホスト**の経路差 | pod1a で `traceroute 10.244.2.11`(同host)と `traceroute 10.244.3.11`(別host) | パケットログで前者は HostSW1 折り返し、後者は CORE 経由(§3) |
| **egress**(Pod→外部) | pod1a で `http get 203.0.113.20` / `ping 203.0.113.20`、EDGE で `show ip nat translations` | 応答が返り、変換表に `10.244.1.11 ↔ 203.0.113.1` |
| **ingress**(外部→Service) | ext-client で `http get 203.0.113.50` | LB 経由でどれかの Pod が応答(繰り返すと分散) |
| readiness 失敗 | backend Pod で `http server off` | `lb status` が DOWN、振り分けから除外 |
| **ホスト障害(物理サーバ1台ダウン)** | **HostSW2 の Gi0/8 を `shutdown`**(host2 の物理NIC断) | Node3・Node4 が**同時に**クラスタから分断 → `10.244.3.0/24`と`10.244.4.0/24`が全ノードの経路表から消え、LB は両 Pod を DOWN 検出 |

> **ホスト障害の含意**: 1物理=2ノードなので、host server 1台の障害で **2ノード分の Pod が一度に落ちる**。
> これが k8s の**障害ドメイン**の考え方そのもの。だから同一 Service のレプリカを
> `topologySpreadConstraints` / anti-affinity で**別ホストに散らす**(全部 host2 に載っていたら host2 障害で全滅)。
> このトポロジなら「散らした/寄せた」の差を、Pod を載せるノードを変えて実演できる。

---

## 7. この応用構成で新たに学べること / 割り切り

**新たに学べる点**
- **物理サーバ層**: ノードVM ↔ 仮想ブリッジ ↔ 物理NIC ↔ ToR の積み重ね(§1)
- **ノードローカリティ**: 同一ノード/同一ホスト/別ホストでホップと物理経路が変わる(§3)
- **障害ドメイン**: 1物理の障害で2ノード同時ダウン → レプリカ分散の必要性(§6)
- **egress / ingress**: Pod の外向き SNAT と、外部からの LoadBalancer VIP 到達(§5)

**割り切り(実機との差)** — 基本は [k8s-mapping.md](k8s-mapping.md) §7 と同じ。加えて:
- **物理サーバは L2 ブリッジとして表現**。ハイパーバイザ(KVM/vSwitch)の実体・vNIC のキュー等は無い
- **underlay はフラット L2**。実機でホスト単位に L3 セグメントを切る設計(ルーテッド host)も可能だが、
  ここでは「物理はブリッジ」に振り、ローカリティを見せることを優先
- **NodePort / L7 Ingress** は未対応のまま(§5 表・[k8s-mapping.md](k8s-mapping.md) §7)。ingress は L4 の VIP 公開まで

> **代替設計(参考)**: 物理サーバを L3 の境界(各ホスト=ルータ/L3SW、ホストごとに別サブネット)にすると、
> 「ラック単位 L3」に近づき OSPF のホップが1段増える。ローカリティは見えなくなるが、
> スパイン・リーフ([README](../README.md) の 🏭 DC Generator)に寄せたい場合はこちら。

```
              L3SW3 Gi0/5 ──┐                 ┌── L3SW4 Gi0/4
                            │                 │
                      ┌─────┴──────┐   IC   ┌──┴─────────┐
                      │ K8S_HOSTS_1│═══════ │ K8S_HOSTS_2│   IC = 相互接続
                      │  (root)    │ Gi0/4  │ (2nd root) │   (LACP推奨:Po1)
                      └┬───┬───┬───┘ -Gi0/8 └┬───┬───┬───┘
                 Gi0/1 │Gi0/2│Gi0/3          │Gi0/1│Gi0/2│Gi0/3
                       │   │   │             │   │   │
          HOST_1_Br Gi0/8  │   │   HOST_1_Br Gi0/7  │   │     ← 各bridgeを両集約へ
          HOST_2_Br Gi0/8──┘   │   HOST_2_Br Gi0/7──┘   │       dual-home
          HOST3_Br  Gi0/8──────┘   HOST3_Br  Gi0/7──────┘

```