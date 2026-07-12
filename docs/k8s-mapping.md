# NetSim で Kubernetes 環境を再現する — 概念対応マップ

このシミュレーターは L1〜L4 のネットワークに特化しているため、Kubernetes の
**コントロールプレーン(apiserver / etcd / scheduler)は対象外**で、
**データプレーン(Pod ネットワーク・Service・kube-proxy 相当のロードバランス)**を再現する。
「Pod がどの IP を持ち、Pod 間・Service 経由の通信がどのホップを通り、
なぜ届く／届かないか」をパケット単位で観察することがねらい。

CNI は **ルーテッド方式**(Calico host-gw 相当)を採用する。各ノードに Pod CIDR を割り当て、
ノード間はルーティングで到達させる。実物の Calico は経路配布に BGP を使うが、
本シミュレーターは BGP 未実装のため **OSPF で代替**する(挙動=「各ノードが自分の Pod CIDR を広告する」は同じ)。

---

## 1. 全体対応表

| Kubernetes の要素 | NetSim での再現 | 忠実度 | 備考 |
|---|---|---|---|
| **Node**(kubelet を持つマシン) | L3スイッチ (Pod用SVI + アップリンク + OSPF) | ◎ | ノードが Pod サブネットのゲートウェイ兼ルータになる挙動そのもの |
| **Pod** | Host(PC/サーバ)。`http server on` でコンテナ相当 | ◎ | Pod = 1ホスト = 1 IP。ping / http で疎通確認 |
| **Pod IP / Pod CIDR** | ノード毎の `10.244.N.0/24`、Pod GW = SVI `10.244.N.1` | ◎ | Flannel/Calico の既定レンジに合わせた |
| **CNI(Pod 間ネットワーク)** | 各ノードが Pod CIDR を **OSPF で広告**、ノード間はルーティング | ○ | ルーテッド方式(host-gw)相当。overlay/VXLAN は非対応 |
| **Service (ClusterIP)** | **LB デバイス**(VIP=`10.96.0.x`、backend=Pod IP:port) | ○ | VIP→複数Podのラウンドロビン分散が一致。ただし実機は分散、こちらは1台集約 |
| **Endpoints / EndpointSlice** | LB の backend 一覧(`lb status`) | ◎ | `lb backend add/del` が Endpoint の増減に対応 |
| **readiness probe** | LB のヘルスチェック(8秒間隔 TCP、失敗で振り分けから除外) | ◎ | ここは実機と 1:1 に近い |
| **kube-proxy** | LB の TCP プロキシ | △ | 実機は全ノードの iptables/IPVS に分散。集約LBで近似 |
| **NetworkPolicy** | ノードの Pod SVI に拡張 ACL(`ip access-group`) | ○ | L3/L4 の allow/deny として再現 |
| **NodePort** | ルータの静的NAT / 外部到達 | △ | ポート単位NATは未実装のため厳密再現は不可(§7) |
| **type=LoadBalancer / Ingress(L7)** | 外部LB / — | △〜✗ | L4LBで近似。ホスト・パスの L7 ルーティングは未実装 |
| **CoreDNS(Service 名前解決)** | — | ✗ | DNS未実装。ClusterIP を直接指定して代替(roadmap P1-3) |
| **コントロールプレーン(apiserver/etcd)** | — | ✗ | 本シミュレーターの対象外(データプレーンに集中) |

> **記号**: ◎=ほぼ忠実 / ○=概念は再現・簡略あり / △=近似のみ / ✗=未対応

---

## 2. 再現するトポロジ

3ノードクラスタ + 1つの ClusterIP Service。underlay(ノード間ネットワーク)を CORE が束ね、
OSPF が各ノードの Pod CIDR と Service サブネットを全体に配布する。

```
                    ┌─────────────────────────┐
                    │  CORE (L3スイッチ)        │  ← クラスタ underlay + Service網
                    │  Vlan90 10.0.0.1/24      │     OSPF エリア0
                    │  Vlan96 10.96.0.1/24     │
                    └──┬────────┬────────┬───┬─┘
             underlay  │        │        │   │ Vlan96
             10.0.0/24 │        │        │   └──────── svc-web (LB)
                       │        │        │            ClusterIP 10.96.0.10:80
       ┌───────────────┴┐ ┌────┴───────┐ ┌┴──────────────┐
       │ Node1 (L3SW)   │ │ Node2      │ │ Node3         │  ← 各ノード=L3スイッチ
       │ up  10.0.0.11  │ │ 10.0.0.12  │ │ 10.0.0.13     │     OSPF で Pod CIDR 広告
       │ Pod GW         │ │ Pod GW     │ │ Pod GW        │
       │ Vlan1 10.244.1.1│ │ 10.244.2.1 │ │ 10.244.3.1   │
       └──┬──────────┬──┘ └──┬─────────┘ └──┬────────────┘
          │          │       │              │
      ┌───┴──┐   ┌───┴──┐  ┌─┴────┐      ┌──┴───┐
      │pod1a │   │pod1b │  │pod2a │ ...  │pod3a │      ← Pod = Host(http server)
      │.11   │   │.12   │  │.11   │      │.11   │
      └──────┘   └──────┘  └──────┘      └──────┘
       10.244.1.0/24        10.244.2/24    10.244.3/24
```

### IP アドレス設計

| 区分 | サブネット | 用途 | k8s 相当 |
|---|---|---|---|
| underlay | `10.0.0.0/24` | ノード⇔CORE。VLAN 90 | ノードのプライマリ NIC 網 |
| Service | `10.96.0.0/24` | ClusterIP。VLAN 96(CORE配下) | `--service-cluster-ip-range` |
| Pod (Node1) | `10.244.1.0/24` | GW `.1`(SVI Vlan1)、Pod `.11〜` | `podCIDR` |
| Pod (Node2) | `10.244.2.0/24` | 同上 | 〃 |
| Pod (Node3) | `10.244.3.0/24` | 同上 | 〃 |

すべて `10.0.0.0/8` 配下なので、OSPF の `network 10.0.0.0 0.255.255.255 area 0`
一行で underlay・Service・全 Pod CIDR を配布できる。

---

## 3. データプレーンの対応 —「なぜ届くか」

### (a) Pod 間通信(別ノード) pod1a → pod2a
1. pod1a(`10.244.1.11`)は宛先が別サブネットなので既定GW=Node1(`10.244.1.1`)へ送る
2. Node1 の経路表に OSPF 学習の `10.244.2.0/24 via 10.0.0.12`(=Node2)
3. underlay(VLAN90)経由で Node2 へ、Node2 が pod2a に配送
4. 戻りは逆順。**カプセル化なし**(ルーテッド方式)。実機 Calico(host-gw)と同じ

→ 実機 Flannel(VXLAN)ではここで UDP/VXLAN ヘッダが付くが、本シミュレーターは
overlay 非対応なので**素の IP ルーティング**で観察する(§7 の割り切り)。

### (b) Service 経由 pod1a → ClusterIP `10.96.0.10:80`
1. pod1a → Node1 → OSPF 経路 `10.96.0.0/24 via 10.0.0.1`(CORE)→ LB(svc-web)
2. LB がラウンドロビンで backend Pod(例 `10.244.2.11:80`)を選び TCP プロキシ
3. LB→backend: LB の GW=CORE、`10.244.2.0/24 via 10.0.0.12` で Node2→pod2a
4. これが **kube-proxy の DNAT + ロードバランス**に対応。ただし実機は各ノードで
   ローカルに変換するのに対し、本モデルは LB を必ず経由する(ホップが1つ増える)

### (c) readiness → Endpoint 除外
- backend Pod で `http server off` → LB のヘルスチェックが 8 秒以内に DOWN 検出
- `lb status` の当該行が `DOWN` になり、以後の振り分けから除外
- = readiness probe 失敗で EndpointSlice から外れる挙動

---

## 4. 構築手順(実際に打つコマンド)

デバイス配置と結線は GUI(パレット→🔌結線)で行い、設定は各デバイスのコンソール
(ダブルクリック)で以下を打つ。ポートは既定 8 ポート、Gi0/0 をアップリンク、
Gi0/1 以降を Pod 用とする。

### 4-1. CORE(underlay + Service 網 + OSPF)
```
enable
configure terminal
 interface Gi0/0
  switchport access vlan 90          ! Node1 へ
  exit
 interface Gi0/1
  switchport access vlan 90          ! Node2 へ
  exit
 interface Gi0/2
  switchport access vlan 90          ! Node3 へ
  exit
 interface Gi0/3
  switchport access vlan 96          ! LB(Service網)へ
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
  end
```

### 4-2. Node1(Node2/Node3 は N を 2,3 に読み替え)
Gi0/0=アップリンク(VLAN90)、Gi0/1〜=Pod(既定VLAN1)。
```
enable
configure terminal
 interface Gi0/0
  switchport access vlan 90
  exit
 interface Vlan90
  ip address 10.0.0.11 255.255.255.0     ! Node2=.12 / Node3=.13
  exit
 interface Vlan1
  ip address 10.244.1.1 255.255.255.0    ! Pod GW。Node2=10.244.2.1 / Node3=10.244.3.1
  exit
 router ospf 1
  network 10.0.0.0 0.255.255.255 area 0
  passive-interface Vlan1                ! Pod側にHelloを送らない
  end
```

### 4-3. Pod(Host。各ノードの Gi0/1 以降に結線)
```
set ip 10.244.1.11 255.255.255.0 10.244.1.1     ! Node2配下=10.244.2.x / Node3=10.244.3.x
http server on                                   ! コンテナ(Webアプリ)相当
```

### 4-4. Service(LB。CORE の Gi0/3 に結線)
```
set ip 10.96.0.10 255.255.255.0 10.96.0.1        ! ClusterIP
lb service 80
lb backend add 10.244.1.11 80                    ! Pod を Endpoint 登録
lb backend add 10.244.2.11 80
lb backend add 10.244.3.11 80
lb status
```

---

## 5. kubectl 操作との対応

| kubectl / k8s 操作 | NetSim での確認・操作 |
|---|---|
| `kubectl get nodes` | CORE で `show ip ospf neighbor`(各ノード=FULL のネイバー) |
| ノードの `podCIDR` | 各ノードで `show ip route` の connected `C 10.244.N.0/24` |
| `kubectl get pods -o wide` | 各ノードで `show arp` / `show mac address-table`(Pod の IP/MAC) |
| Pod 間経路の確認 | Pod から `traceroute 10.244.2.11`(通るノードが見える) |
| `kubectl run` / スケール | Host を追加・結線し `set ip` + `http server on`、LB に `lb backend add` |
| `kubectl get svc` | LB の `lb status`(ClusterIP=LB の IP、ポート) |
| `kubectl get endpoints` | LB の `lb status` の backend 行(UP/DOWN と conns) |
| Service へアクセス | Pod から `http get 10.96.0.10` |
| readiness 失敗 | backend Pod で `http server off` → `lb status` が DOWN |
| Pod/ノード障害 | 該当リンクを `shutdown` → OSPF 再収束を `show ip route` で観察 |
| NetworkPolicy 適用 | ノードの Pod SVI に `ip access-group` + `access-list`(§6) |

---

## 6. 応用シナリオ

### NetworkPolicy(Pod 隔離)
「Node3 の Pod へ、Node1 の Pod からのアクセスだけ拒否」を Node3 で ACL 化:
```
configure terminal
 access-list 110 deny ip 10.244.1.0 0.0.0.255 10.244.3.0 0.0.0.255
 access-list 110 permit ip any any
 interface Vlan1
  ip access-group 110 out          ! Node3 の Pod へ出る方向で評価
  end
```
→ `10.244.1.x`(Node1 の Pod)からの通信だけ落ち、他ノードからは届く。
NetworkPolicy の podSelector/namespaceSelector を L3/L4 ACL に翻訳したもの。

### 障害と収束(ノードダウン)
- Node2 のアップリンク(Gi0/0)を `shutdown` → OSPF が `10.244.2.0/24` を失効
- 他ノードの `show ip route` から該当経路が消える = そのノードの Pod が到達不能に
- LB のヘルスチェックが `10.244.2.11` を DOWN 検出し振り分けから除外
- = ノード障害時に該当 Pod の Endpoint が落ちる挙動

---

## 7. 再現できない・簡略化する点(実機との差)

| 項目 | 本シミュレーターでの扱い | 実機との差 |
|---|---|---|
| **CoreDNS / Service 名** | 無し。ClusterIP を直接指定 | `svc.cluster.local` の名前解決ができない |
| **kube-proxy の分散** | 中央 LB 1台に集約 | 実機は各ノードの iptables/IPVS でローカル DNAT。ホップ数・障害波及が異なる |
| **CNI overlay(VXLAN)** | ルーテッド(OSPF)で代替 | Flannel の VXLAN カプセル化ヘッダは観察できない |
| **経路配布プロトコル** | OSPF | 実機 Calico は BGP(本シミュレーターは BGP 未実装) |
| **Pod の実体** | Host 1台 | 複数コンテナ / sidecar / initContainer / namespace は表現しない |
| **NodePort** | ポート単位 NAT が未実装 | `:30000` 形式の外部公開は厳密再現不可(静的NATで近似説明) |
| **Ingress(L7)** | 未対応 | ホスト・パスによる HTTP ルーティングは不可(L4 LB まで) |
| **コントローラ** | 手動操作 | Deployment/ReplicaSet の自動復旧・自動スケールは無い |

> **特に相性が良い点**: readiness probe → LB ヘルスチェック、Endpoint 増減 → `lb backend add/del`、
> ルーテッド CNI → OSPF による Pod CIDR 配布。この3つはほぼ実機どおりに学べる。

---

## 8. 次の一手

- **この対応表どおりにサンプルを組む** → `js/core/topology.js` の `samples` に
  `sampleK8s(net)` を追加すれば、ツールバーから 1 クリックで上記クラスタを展開できる
  (既存の `sampleHaDc` / `buildFabric` と同じ書き方)。
- **ネイティブ k8s モードにする** → Pod / Service / kube-proxy / CoreDNS を第一級の
  デバイス種別として実装する設計。overlay(VXLAN)や NodePort の厳密再現もここで扱う。
  規模を扱うため [roadmap-todo.md](roadmap-todo.md) の P0(集約モデル)と接続する。
