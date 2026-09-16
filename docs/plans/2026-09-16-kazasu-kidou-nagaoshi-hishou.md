# 計画書: かざす起動 ＋ 長押しで宇宙へ飛び立つ（DESIGN機能15の拡張）

作成 2026-09-16（Fable 5.1 で設計・実装は監修方式）。行番号は書かない。場所は `═══` 見出し・関数名・要素IDで示す。

## 1. ねらい（ユーザーの言葉）
- アプリを開くと、**スマホを向けている方角の本物の空**がそのまま画面に出る。
- 星をタップすると、その星と**星座の説明**が読める。
- **長押しすると、その方向へ空に向かって高速で飛び立ち**、宇宙へ出る。
  飛び立つ向きは「かざしていたスマホの向き」から始まる。
- 飛び立ったあとに、今まで作ってきた**宇宙遊泳（フリックの法則）**が始まる。

## 2. 完成条件（検収はこの表で判定）
| # | 条件 | 確認方法 |
|---|---|---|
| 1 | 起動直後のモードが `gaze`（地球の夜空）で、スマホではセンサー追従（かざす）が自動で始まる | 実機: 北へかざす→北極星が画面中央付近。PC: `__U.getMode()==='gaze'` |
| 2 | 東京・北・高度35.68°で北極星、南・高度54.32°で天の赤道（Dec≒0・RA≒LST）を向く | `__U.skyFake(0,35.68)` → `__U.skyState().gazeLat` ≒ 1.571（±0.01）。`__U.skyFake(180,54.32)` → gazeLat ≒ 0（±0.01） |
| 3 | 地方恒星時の計算が正しい | `__U.lst(new Date('2026-09-16T12:00:00Z'), 0)` ≒ 175.5°（±0.3） |
| 4 | 指でドラッグすると追従が切れて手動になり、📱ボタンで追従に戻せる | PC: `__U.skyFake` 後にドラッグ→`__U.skyState().on===false`。ボタン→true |
| 5 | 星タップのカードに、その星座の一言紹介（`CON_INFO`）が出て、星座の形（`hlLines`）が光る | `__U.testPick('ベガ')` 相当のタップ→カードに「こと座 ─ オルフェウスの竪琴…」、`hlLines.visible===true` |
| 6 | 画面を約0.6秒長押しすると、向いている方向へ加速して飛び立ち、`orbit` モードのダイブへ引き継がれる | `__U.launch()` → 2.4秒後 `__U.getMode()==='orbit'` かつ `__U.wander().diving===true` |
| 7 | フリックの法則（`ORB` の既存値・ダイブ/回頭/漂いの処理）は**一切変更していない** | `git diff` で `ORB` の既存キーと loop の orbit 物理部分に差分が無い |
| 8 | 歴史・太陽系めぐり・誕生日の星・時間スライダー・星座さがす が従来どおり動く | 各ボタンを一巡。`selectCon` 後は追従が切れて星座へ視線移動する |
| 9 | 構文チェック通過・実機（XQ-CC44）で 1 と 6 を目で確認 | HANDOFF 失敗ログ先頭の手順 |

## 3. 体験の流れ
1. 起動 → スプラッシュ（従来どおり3.5秒）。裏ではすでに `gaze` で空が出ている。
2. センサーが来たら、スマホの背面が向く方向の空を表示。画面の「上」はスマホの画面上方向（ロールも追従）。
3. センサーが来ない（PC・非対応）ときは、いまと同じ「指で見回す地球の夜空」。
4. 起動1.5秒後の「今夜の見どころ」カードの最終行を
   「星をタップ＝その星と星座の話 ／ 画面を長押し＝その方向へ宇宙に飛び立つ」に差し替えて操作を教える。
5. 星タップ → 従来カード ＋ 星座の一言 ＋ 星座の形が30秒光る。
6. 長押し0.6秒 → 短い振動（`navigator.vibrate(40)`、非対応は無視）＋ `SFX.whoosh(1)` → 2.4秒かけて静止から
   三乗カーブで加速（0.02pc→2.5pc）→ そのまま既存の「ダイブ」へ引き渡す（初速 `ORB.launchV`=32pc/s）。
   以後は法則どおり: 直進 → 勢いが尽きたら回頭 → 中心（太陽）をとらえて漂い。
7. 🌍ボタンで再び地球の夜空へ戻れる（追従はOFFで戻る。📱で再ON）。

## 4. 設計

### 4.1 座標系（不変・DESIGN.md §0 と同じ）
- 世界座標は赤道座標J2000、+Z=天の北極、単位pc。
- `gaze` の視線は `(cos(gazeLat)cos(gazeLon), cos(gazeLat)sin(gazeLon), sin(gazeLat))`
  ＝ **gazeLon=赤経(rad)、gazeLat=赤緯(rad)**。ここへセンサーの向きを流し込めばよい。

### 4.2 センサー → 地上座標（ENU: X東・Y北・Z上）
- 優先 `deviceorientationabsolute`（Android Chrome）。1.5秒来なければ `deviceorientation` にフォールバック
  （iOS は `webkitCompassHeading` があれば `alpha = 360 - heading` で補正。iOS の権限要求
  `DeviceOrientationEvent.requestPermission()` は最初の pointerdown 内で呼ぶ。実機は Android なので iOS は「動けば幸運」扱い）。
- W3C の回転行列（Z-X'-Y''、α=alpha, β=beta, γ=gamma を rad に）:
  ```
  R = [ cA*cG - sA*sB*sG,  -cB*sA,  cA*sG + cG*sA*sB ]
      [ cG*sA + cA*sB*sG,   cA*cB,  sA*sG - cA*cG*sB ]
      [ -cB*sG,             sB,     cB*cG            ]
  ```
  端末座標: X=右, Y=画面上, Z=画面から手前。地上ベクトル = R × 端末ベクトル。
  - **カメラの向き**（背面が向く方向）＝ R × (0,0,−1) ＝ 第3列の符号反転。
  - **画面の上方向** ＝ R × (−sinθ, cosθ, 0)、θ=`screen.orientation.angle`（無ければ0）を rad に。
    （縦持ちθ=0なら (0,1,0)。横持ちで星が横倒しになったら θ の符号を反転して再確認する）
- 検証用の偽装 `__U.skyFake(azDeg, altDeg)` は行列を通さず、
  向き=(sin az·cos alt, cos az·cos alt, sin alt)、上=天頂方向を向きに直交化、で同じ後段へ流す。

### 4.3 地上座標 → 赤道座標
- 観測地 φ=緯度, 地方恒星時 L（rad）。
  `E=(-sinL, cosL, 0)`, `N=(-sinφ cosL, -sinφ sinL, cosφ)`, `U=(cosφ cosL, cosφ sinL, sinφ)`
  ENUベクトル (e,n,u) → 赤道 = e·E + n·N + u·U。
  検算: u=1（天頂）→ `radec(LST, φ)` と一致。n=1（北の地平）→ 赤緯 90−φ・赤経 LST+180°。
- 地方恒星時: `JD = Date.now()/86400000 + 2440587.5`, `T = JD - 2451545.0`,
  `GMST(deg) = (280.46061837 + 360.98564736629*T) mod 360`, `LST = GMST + 東経(deg)`。
  検算: 2026-09-16T12:00:00Z・経度0 → **175.5°**（±0.3）。
- 観測地: `navigator.geolocation.getCurrentPosition`（timeout 8秒・maximumAge 1時間）。取れたら
  `localStorage 'uchu_geo'` に `{lat,lon}` 保存、次回は保存値で即開始。拒否・失敗は東京 35.68N/139.77E。

### 4.4 カメラへの反映（loop の gaze ブランチ）
- 状態: `skyOn`(追従ON/OFF) `skyRaw`(最新の alpha/beta/gamma/absolute) `skyReady`(1回でも来た)
  `skyQt`(目標クォータニオン) `geoLat/geoLon`。
- 毎コマ `skyStep(dt)`: LST を計算 → 4.2/4.3 で「向き f」と「上 u」を赤道座標に → 右=cross(f,u)、上'=cross(右,f)、
  `Matrix4.makeBasis(右, 上', -f)` → `skyQt.setFromRotationMatrix` → `camera.quaternion.slerp(skyQt, 1-Math.pow(0.001, dt))`
  → 平滑後の前方 `(0,0,-1).applyQuaternion(camera.quaternion)` から `gazeLon=atan2(y,x)`, `gazeLat=asin(z)`,
  `vgLon=vgLat=0` を書き戻す（タップ判定・HUD・追従OFF直後の連続性のため）。
- gaze ブランチ末尾の `camera.up.set(0,0,1); camera.lookAt(...)` を
  `if (skyOn && skyReady) skyStep(dt); else { 従来の up/lookAt }` に分ける。`camera.position` の行は共通のまま。
  追従中は `seekCon`/`seekDir` の視線移動より**センサー優先**（追従中は seek を使わない: `selectCon` が追従を切る）。

### 4.5 操作
- 📱ボタン `bSky`（「かざす」）を `#ui` の 🌍地球 の直後に追加。ON中は `.on`。
  押下: 追従ON。`mode!=='gaze'` なら `selectCon` と同じ手順で history/tour から抜けて `enterGaze()`。
  リスナー未登録なら `skyStart()`。iOS 権限要求もここで。
- pointermove の gaze 分岐: `if (skyOn) skySetOn(false);` を先頭に足す（ドラッグ＝手動へ）。
- `skySetOn(b)`: `skyOn=b; $('bSky').classList.toggle('on', b);`
- `exitGaze()`・`selectCon()`・`launchToSpace()` は `skySetOn(false)` を呼ぶ（他モード・視線移動・飛翔中は追従しない）。
- 起動時: `enterGaze(); skySetOn(true); skyStart();` を `requestAnimationFrame(loop)` の直前に置く。
  センサーが来なければ `skyReady=false` のまま＝従来の手動 gaze と同じ見え方（PCはこれ）。

### 4.6 長押し → 飛び立ち
- pointerdown（1本指・`mode==='gaze'`）で `lpTimer = setTimeout(()=>{ if (pointers.size===1 && tapInfo) { tapInfo=null; launchToSpace(); } }, 600)`。
  pointerup / pointercancel / 2本目の指 で `clearTimeout(lpTimer)`。移動9px超は既存の `tapInfo=null` で自然に無効化。
- `launchToSpace()`（gaze 以外では何もしない）:
  1. `d = (0,0,-1).applyQuaternion(camera.quaternion)`（いま向いている方向）、
     `camUp = (0,1,0).applyQuaternion(camera.quaternion)`（ロールを引き継ぎ、飛び立ち時にカクッと回らないため）。
  2. `skySetOn(false); card.classList.remove('show'); panelEl.classList.remove('open');`
  3. `mode='orbit'; $('bHome').classList.remove('on'); selectedCon=-1;`
     `launching=true; launchT=0; launchDir.copy(d); cpos.copy(d).multiplyScalar(0.02); cvel.set(0,0,0); viewTarget.copy(d); diving=false; lastUserT=tNow;`
  4. `navigator.vibrate?.(40); SFX.whoosh(1);`
- loop の orbit ブランチ**先頭**（`seekingBH` 判定の前）に飛翔フェーズを足す。飛翔中は既存の物理を**通らない**:
  ```
  if (launching) {
    launchT += dt; const p = Math.min(1, launchT / ORB.launchT);
    cpos.copy(launchDir).multiplyScalar(0.02 + (ORB.rMin + 0.5 - 0.02) * p*p*p); // 静止→三乗で加速
    viewTarget.copy(launchDir);
    if (p >= 1) { // 既存のダイブ法則へ引き渡す（法則側は無変更）
      launching = false;
      cvel.copy(launchDir).multiplyScalar(ORB.launchV);
      steerAxis.crossVectors(launchDir, camUp).normalize();
      diveT = 0; diving = true;
    }
    camR = cpos.length(); lookAlong();
  } else { ...既存の orbit 処理そのまま... }
  ```
  `ORB` には **キーを2つ追加するだけ**: `launchT: 2.4, launchV: 32`（既存キーの値は変更禁止）。
  引き渡し後は既存法則: 直進(0.8s)→減速(drag 0.78)→回頭(turnSlow)→中心を見る漂い。太陽は遠ざかって暗い点になる（本物）。

### 4.7 タップ → 星座の説明
- `selectCon(ci)` の先頭（`selectedCon=ci` から `hlTimer` の設定まで）を `highlightCon(ci, withAll)` に切り出す。
  `withAll=true` のとき従来どおり `consLines.visible=true; $('bCons').classList.add('on'); consLines.material.opacity=0.10` も行う。
  `selectCon` は `highlightCon(ci, true)` を呼び、残りは従来のまま（動きは変えない）。
- `pickStar` の実在星カード: `s[5]>=0` なら `highlightCon(s[5], false)` を呼び、カードに
  `<div class="k">${conJp} ─ ${CON_INFO[abbr]||''}</div>` を `.s` の直後に追加（`abbr=D.cons[s[5]]`）。
  CSS: `#card .k { color:#9fb6e6; font-size:12px; margin-top:6px; letter-spacing:0.04em; max-width:80vw; }`。
  gaze/orbit 両方で有効（history/tour は `pickStar` 冒頭で return 済み）。

### 4.8 検証フック（`window.__U` に追加）
- `skyState()` → `{on, ready, lat, lon, lstDeg, gazeLon, gazeLat, launching, launchT}`
- `skyFake(azDeg, altDeg)` → 偽装センサー（4.2）。`skyOn=true, skyReady=true` にする。
- `skyOn(b)` → `skySetOn(b)`
- `setGeo(lat, lon)` → 観測地を上書き（保存はしない）
- `lst(date, lonDeg)` → 地方恒星時（deg）
- `launch()` → `launchToSpace()`
- `wander()` は既存（speed/camR/diving）。

## 5. この変更で壊れうる箇所（先に洗い、検収で確かめる）
1. **起動モードが orbit→gaze に変わる**: 起動1.5秒後の「今夜の見どころ」は gaze 前提なので好都合。
   `__U.setCam` 等の既存フックは mode を変えないため影響なし。🌍ボタンの `.on` 初期状態を合わせる。
2. **戻す経路**: 追従ONを切る経路は ①ドラッグ ②📱再押下 ③exitGaze ④selectCon ⑤launchToSpace の5つ。全部 `skySetOn(false)` を通す。
3. **長押しタイマーの取り消し**: pointerup / pointercancel / 2本目 / 移動超過 の4経路。カード上で始めた押下は canvas に来ない（従来仕様）。
4. **フリックの法則は不変**: `ORB` 既存値・orbit 物理・pointerup のフリック処理に差分を出さない。飛翔は「新しい入口」だけ。
5. **rMin の壁**: 飛翔中は既存物理を通らないので 0.02pc から始めても壁に弾かれない。引き渡し点は rMin+0.5。
6. **CSS 詳細度**: `#card .k` は既存 `.d/.y` と同じ形なので負けない。
7. **slerp とロール**: 追従中は `camera.up` を触らない。追従OFF直後は gazeLon/gazeLat を書き戻してあるので lookAt に滑らかに戻る（ロールは一瞬で0に戻る＝許容。気になれば次回 roll を減衰）。
8. **セキュアコンテキスト**: センサー・位置情報は https か localhost のみ。実機は `adb reverse` の localhost なので可。将来ホスティングする場合は https 必須。

## 6. 実装指示書（サブエージェント用・自己完結）
**対象ファイル: `index.html` のみ**（READMEとHANDOFFの更新は監修側が行う）。**下記以外の変更は禁止。**
1. CSS: `#card .y` の直後に `#card .k` を追加（4.7）。
2. HTML `#ui`: `bHome` の直後に `<button id="bSky"><span class="ic">📱</span><span>かざす</span></button>`。
3. 「═══ カメラ ═══」セクション末尾（`pointercancel` の直後）に新セクション
   `// ═══════════════ かざす（センサー追従）と長押し飛翔 ═══════════════` を作り、4.2〜4.6 の状態変数・
   `skyStart/skySetOn/skyStep/lstDeg/enuToEq/launchToSpace/highlightCon`（highlightCon は selectCon の近くでも可）を置く。
4. `ORB` に `launchT: 2.4, launchV: 32` を追加（既存キー不変）。
5. pointerdown/pointerup/pointercancel/pointermove へ 4.5・4.6 の最小追記。
6. `exitGaze()` に `skySetOn(false)` を追加。`selectCon` は `highlightCon(ci,true)` を呼ぶ形に整理し `enterGaze()` の後に `skySetOn(false)`。
7. loop: orbit ブランチ先頭に飛翔フェーズ、gaze ブランチ末尾を `skyOn&&skyReady` で分岐（4.4）。
8. `pickStar` の実在星カードに `.k` と `highlightCon(s[5], false)`（4.7）。
9. 「今夜の見どころ」カードの `.y` 文言を §3-4 の文に変更。
10. 起動: `requestAnimationFrame(loop)` の直前に `enterGaze(); skySetOn(true); skyStart();`。
11. `window.__U` に 4.8 のフックを追加（末尾の `window.__U.planets = ...` と同じ形で `window.__U.skyState = ...` と足してよい）。
12. **構文チェック**（HANDOFF 失敗ログ先頭の手順）→ プレビュー `uchu-app`(port 8790) で §2 の 2,3,4,5,6,7 を `__U` フックで確認し、
    数値を報告に貼る → `git add index.html && git commit -m "かざす起動と長押し飛翔: センサー追従・星座説明・飛び立ち演出（機能15拡張）" && git push`。
13. 報告は「変更した関数名の一覧」「§2 の各番号の実測値」「壊れうる箇所 §5 の1〜8 をどう確認したか」の3点だけ。

## 7. 実機確認（監修側・XQ-CC44）
- `adb -s HQ62CQ0DE6 reverse tcp:8790 tcp:8790` → `adb shell am start -a android.intent.action.VIEW -d "http://localhost:8790/?v=N"`。
- 位置情報の許可ダイアログ→許可。北へかざして北極星、頭上へ向けて天頂の星座、南の低い空に惑星（見える季節なら）。
- 長押し → 加速して飛び立ち → 8秒ほどで回頭 → 太陽が小さな点になって中心に。
- 横持ちで星が横倒しにならないこと（θ の符号確認）。
- 見た目はスクリーンショット（`adb exec-out screencap -p > file.png`）を自分の目で見る。縦・横の両方。

## 8. 文書更新（実装後・監修側）
- `README.md` 機能の項に「かざす起動・長押し飛翔・星座の一言」を追記。`DESIGN.md` 機能15 に「2026-09-16 実装（本計画書）」。
- `docs/HANDOFF.md` 現在の状況に1項目追加＋次にやること更新。commit & push。
