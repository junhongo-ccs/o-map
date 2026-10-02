import { route, formatMin, formatClock, parseClock } from "./router.js";
import { buildPlaces, searchPlaces } from "./places.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const [NET_OLD, NET_NOW, FACTS, SPOT_IMAGES] = await Promise.all(
  ["data/network-1885.json", "data/network-now.json", "data/facts.json", "data/spot-images.json"].map((u) => fetch(u).then((r) => r.json())),
);

const state = {
  origin: null,
  dest: null,
  overrides: { old: {}, now: {} },
  departMin: 11 * 60 + 30,
  preferVehicle: false, // 明治の経路で、乗り物を少なくとも1回使う経路を出す
  result: null,
  mode: "swipe",
};

// ---------- 地図 ----------
const GSI_PALE = "https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png";
const RAPID = "https://habs.rad.naro.go.jp/rapid16/{z}/{x}/{y}.png";
const GSI_ATTR = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">地理院タイル</a>';
const RAPID_ATTR = '迅速測図：<a href="https://habs.rad.naro.go.jp/" target="_blank">農研機構農業環境研究部門</a>';

function baseStyle(kind) {
  const sources = {
    pale: { type: "raster", tiles: [GSI_PALE], tileSize: 256, maxzoom: 18, attribution: GSI_ATTR },
    rapid: { type: "raster", tiles: [RAPID], tileSize: 256, scheme: "tms", minzoom: 8, maxzoom: 16, attribution: RAPID_ATTR },
  };
  const layers = [{ id: "bg", type: "background", paint: { "background-color": "#efe9dc" } }];
  if (kind === "now") {
    layers.push({ id: "pale", type: "raster", source: "pale" });
    layers.push({ id: "rapid", type: "raster", source: "rapid", layout: { visibility: "none" }, paint: { "raster-opacity": 0.7 } });
  } else {
    layers.push({ id: "rapid", type: "raster", source: "rapid" });
  }
  return { version: 8, sources, layers };
}

const view = { center: [139.745, 35.69], zoom: 12 };
const mapNow = new maplibregl.Map({ container: "map-now", style: baseStyle("now"), ...view, maxZoom: 17, minZoom: 10 });
const mapOld = new maplibregl.Map({ container: "map-old", style: baseStyle("old"), ...view, maxZoom: 17, minZoom: 10 });
mapNow.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
let compare = new maplibregl.Compare(mapNow, mapOld, "#compare");

// 地図の読み込みを待たずに経路計算・結果表示は進める（地図は読み込み後に追いつく）
const loaded = (m) => new Promise((r) => (m.loaded() ? r() : m.once("load", r)));
let mapsReady = false;

// 1885年のネットワーク（背景として薄く表示）
function networkGeoJSON(net) {
  const n = net.nodes;
  const features = [];
  for (const w of net.ways) {
    features.push({ type: "Feature", properties: { kind: w.kind, name: w.name },
      geometry: { type: "LineString", coordinates: w.nodes.map((id) => [n[id].lon, n[id].lat]) } });
  }
  for (const l of net.lines) {
    const st = l.loop ? [...l.stations, l.stations[0]] : l.stations;
    features.push({ type: "Feature", properties: { kind: l.mode, name: l.name },
      geometry: { type: "LineString", coordinates: st.map((id) => [n[id].lon, n[id].lat]) } });
  }
  for (const [id, v] of Object.entries(n)) {
    if (v.kind === "station" || v.kind === "shuku") {
      features.push({ type: "Feature", properties: { kind: v.kind, name: v.name }, geometry: { type: "Point", coordinates: [v.lon, v.lat] } });
    }
  }
  return { type: "FeatureCollection", features };
}

const COLORS = { now: "#2f6db5", old: "#3b7a4a", walk: "#7a6a52", rail: "#2b2620", horsecar: "#a0681f" }; // old は明治の経路の線（「出」「着」のアイコンと同じ緑）

function addNetworkLayers(m) {
  m.addSource("net1885", { type: "geojson", data: networkGeoJSON(NET_OLD) });
  m.addLayer({ id: "net-kaido", type: "line", source: "net1885", filter: ["in", ["get", "kind"], ["literal", ["kaido", "street"]]],
    paint: { "line-color": "#c98a2b", "line-width": 3, "line-opacity": 0.35 } });
  m.addLayer({ id: "net-rail", type: "line", source: "net1885", filter: ["==", ["get", "kind"], "rail"],
    paint: { "line-color": COLORS.rail, "line-width": 2, "line-opacity": 0.45, "line-dasharray": [3, 2] } });
  m.addLayer({ id: "net-horse", type: "line", source: "net1885", filter: ["==", ["get", "kind"], "horsecar"],
    paint: { "line-color": COLORS.horsecar, "line-width": 2, "line-opacity": 0.5, "line-dasharray": [1, 1.5] } });
  m.addLayer({ id: "net-pt", type: "circle", source: "net1885", filter: ["==", ["geometry-type"], "Point"],
    paint: { "circle-radius": 3.5, "circle-color": "#fff", "circle-stroke-color": COLORS.rail, "circle-stroke-width": 1.5, "circle-opacity": 0.8 } });
}

const EMPTY = { type: "FeatureCollection", features: [] };
function addRouteLayers(m, id, color, visible = true) {
  m.addSource(id, { type: "geojson", data: EMPTY });
  const vis = { visibility: visible ? "visible" : "none" };
  m.addLayer({ id: `${id}-casing`, type: "line", source: id, layout: { ...vis, "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#fff", "line-width": 8, "line-opacity": 0.9 } });
  m.addLayer({ id: `${id}-walk`, type: "line", source: id, filter: ["==", ["get", "mode"], "walk"], layout: { ...vis, "line-cap": "round" },
    paint: { "line-color": color, "line-width": 4, "line-dasharray": [0.6, 1.6] } });
  m.addLayer({ id: `${id}-ride`, type: "line", source: id, filter: ["!=", ["get", "mode"], "walk"], layout: { ...vis, "line-cap": "round", "line-join": "round" },
    paint: { "line-color": color, "line-width": 5 } });
}

Promise.all([loaded(mapNow), loaded(mapOld)]).then(() => {
  addNetworkLayers(mapOld);
  addRouteLayers(mapOld, "route-old", COLORS.old);
  addRouteLayers(mapNow, "route-now", COLORS.now);
  addRouteLayers(mapNow, "route-old-on-now", COLORS.old, false); // 重ね合わせ表示用
  mapsReady = true;
  applyModeToMap();
  if (state.result) drawRoutes(true);
});

const routeFC = (r) => ({ type: "FeatureCollection",
  features: (r?.legs || []).map((l) => ({ type: "Feature", properties: { mode: l.mode }, geometry: { type: "LineString", coordinates: l.coords } })) });

// 出発地・目的地マーカー（両方の地図に置く）
function markerEl(cls, text) { const el = document.createElement("div"); el.className = `marker ${cls}`; el.textContent = text; return el; }
const markers = {
  origin: [new maplibregl.Marker({ element: markerEl("o", "出") }), new maplibregl.Marker({ element: markerEl("o", "出") })],
  dest: [new maplibregl.Marker({ element: markerEl("d", "着") }), new maplibregl.Marker({ element: markerEl("d", "着") })],
};
// 名所のラベルの先頭に付けるアイコン。名所の種類（network-1885.json の category）ごとに決める
// （Material Symbols。index.html の icon_names に同じ名前を並べる）。鳥居・橋・馬の形のアイコンは無いので近いもので代用
const CATEGORY_ICON = {
  宿場: "hotel", 門: "gate", 社寺: "temple_buddhist", "川・橋": "water", 花の名所: "local_florist", 紅葉の名所: "eco",
  街道: "road", 町並み: "shopping_bag", 水車: "mode_fan", 馬場: "target",
};
// 名所のピン（事実カードのある宿場・名所。経路に関係なく両方の地図にいつも置く）。押すとカードを出す
const SPOT_KINDS = new Set(["place", "shuku"]);
const ALL_SPOTS = Object.entries(NET_OLD.nodes)
  .filter(([, n]) => SPOT_KINDS.has(n.kind) && n.facts?.some((f) => FACTS.facts[f]))
  .map(([id, n]) => ({ id, name: n.name, category: n.category, lat: n.lat, lon: n.lon, facts: n.facts.filter((f) => FACTS.facts[f]) }));
// 名所の画像（あれば）。作品名・作者・年代・所蔵・権利をクレジットとして添える
function spotImageHTML(id) {
  const im = SPOT_IMAGES.images[id];
  if (!im) return "";
  const who = [im.artist, im.date, im.holder && `${im.holder}所蔵`].filter(Boolean).join("、");
  const lic = im.licenseUrl ? `<a href="${esc(im.licenseUrl)}" target="_blank" rel="noopener">${esc(im.license)}</a>` : esc(im.license);
  return `<figure class="spot-fig"><a href="${esc(im.page)}" target="_blank" rel="noopener"><img src="${esc(im.file)}" width="${im.width}" height="${im.height}" alt="${esc(im.title)}" loading="lazy"></a>
    <figcaption>${esc(im.title)}（${esc(who)}）／${lic}</figcaption></figure>`;
}
function spotCardHTML(sp) {
  return `<div class="spot-card">${spotImageHTML(sp.id)}<strong>${esc(sp.name)}</strong>${sp.facts.map((id) => {
    const f = FACTS.facts[id];
    return `<p><span class="spot-title">${esc(f.title)}</span><br>${esc(f.body)}
      <br><a class="spot-src" href="${esc(f.source.url)}" target="_blank" rel="noopener">出典：${esc(f.source.label)}</a></p>`;
  }).join("")}</div>`;
}
// 名所のカード。地図の中（MapLibre のポップアップ）に描くと、スワイプ表示で地図ごと切り取られ、境目のつまみの下にも隠れるので、
// 地図の上に重ねた1枚の要素（#spot-card）をピンの位置に合わせて置く。開くのは1枚だけ
const spotCard = $("#spot-card");
let spotOpen = null; // { sp, map }
function placeSpotCard() {
  if (!spotOpen) return;
  const { sp, map } = spotOpen;
  const wrap = spotCard.parentElement.getBoundingClientRect();
  const pt = map.project([sp.lon, sp.lat]);
  const w = spotCard.offsetWidth, h = spotCard.offsetHeight, gap = 40;
  const x = Math.min(Math.max(8, pt.x - w / 2), wrap.width - w - 8);
  const above = pt.y - gap - h >= 8; // 上に入らなければピンの下に出す
  spotCard.style.left = `${x}px`;
  spotCard.style.top = `${above ? pt.y - gap - h : Math.max(8, Math.min(pt.y + 12, wrap.height - h - 8))}px`;
}
function openSpotCard(sp, map) {
  spotOpen = { sp, map };
  spotCard.querySelector(".spot-popup-body").innerHTML = spotCardHTML(sp) + spotActionsHTML(sp);
  spotCard.hidden = false;
  spotCard.scrollTop = 0;
  placeSpotCard();
  spotCard.querySelectorAll("img").forEach((img) => img.addEventListener("load", placeSpotCard, { once: true }));
}
function closeSpotCard() { spotOpen = null; spotCard.hidden = true; }
spotCard.querySelector(".spot-popup-close").addEventListener("click", closeSpotCard);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && spotOpen) closeSpotCard(); });
for (const m of [mapNow, mapOld]) {
  m.on("move", placeSpotCard);
  m.on("resize", placeSpotCard);
  m.on("click", (e) => { if (!e.originalEvent?.target?.closest?.(".spot-pin")) closeSpotCard(); }); // 地図の空いた所を押したら閉じる
}
const spotPins = ALL_SPOTS.flatMap((sp) => [mapNow, mapOld].map((m) => {
  const el = document.createElement("button");
  el.type = "button"; el.className = "spot-pin"; el.dataset.spot = sp.id;
  el.setAttribute("aria-label", `${sp.name}の説明を開く`);
  const icon = CATEGORY_ICON[sp.category];
  el.innerHTML = `<span class="spot-pin-label">${icon ? `<span class="material-symbols-outlined" aria-hidden="true">${icon}</span>` : ""}${esc(sp.name)}</span><span class="material-symbols-outlined" aria-hidden="true">location_on</span>`;
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    openSpotCard(sp, m);
  });
  return new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat([sp.lon, sp.lat]).addTo(m);
}));
// カードの「目的地にする」「出発地にする」。一覧（PLACES）にある名所だけ。
// 一覧にない名所（現在の6路線の駅から遠い千住宿）は、現在の経路が実際とずれるので選べない
function spotActionsHTML(sp) {
  if (!PLACES.some((p) => p.group === "old" && p.name === sp.name)) {
    return '<p class="spot-note">現在の路線の駅から遠いため、出発地・目的地には選べません</p>';
  }
  return `<div class="spot-actions">
    <button type="button" class="btn-primary spot-set" data-spot="${sp.id}" data-role="dest">目的地にする</button>
    <button type="button" class="btn-ghost spot-set" data-spot="${sp.id}" data-role="origin">出発地にする</button>
  </div>`;
}
document.addEventListener("click", (e) => {
  const b = e.target.closest(".spot-set");
  if (!b) return;
  const sp = ALL_SPOTS.find((x) => x.id === b.dataset.spot);
  closeSpotCard();
  setPoint(b.dataset.role, { name: sp.name, lat: sp.lat, lon: sp.lon });
});

// 経路が通る名所のピンを強調する
function highlightSpots(ids) {
  for (const mk of spotPins) mk.getElement().classList.toggle("on-route", ids.has(mk.getElement().dataset.spot));
}

function placeMarkers() {
  for (const k of ["origin", "dest"]) {
    const p = state[k];
    markers[k].forEach((mk, i) => {
      if (!p) return mk.remove();
      mk.setLngLat([p.lon, p.lat]).addTo(i === 0 ? mapNow : mapOld);
    });
  }
}

// ---------- 比較モード ----------
const wrap = document.querySelector(".map-wrap");
function setMode(mode) {
  const overlay = mode === "overlay";
  $("#mode-swipe").classList.toggle("on", !overlay);
  $("#mode-overlay").classList.toggle("on", overlay);
  $("#mode-swipe").setAttribute("aria-selected", String(!overlay));
  $("#mode-overlay").setAttribute("aria-selected", String(overlay));
  $("#opacity-wrap").hidden = !overlay;
  wrap.classList.toggle("overlay", overlay);
  if (overlay) {
    compare?.remove(); compare = null;
    $("#map-old").style.visibility = "hidden";
    mapNow.getContainer().style.clip = "auto";
  } else if (!compare) {
    $("#map-old").style.visibility = "visible";
    mapOld.jumpTo({ center: mapNow.getCenter(), zoom: mapNow.getZoom() });
    compare = new maplibregl.Compare(mapNow, mapOld, "#compare");
  }
  state.mode = mode;
  applyModeToMap();
}
// 地図の読み込み前にモードが切り替えられても、読み込み後にここで反映される
function applyModeToMap() {
  if (!mapsReady) return;
  const vis = state.mode === "overlay" ? "visible" : "none";
  mapNow.setLayoutProperty("rapid", "visibility", vis);
  mapNow.setPaintProperty("rapid", "raster-opacity", Number($("#opacity").value) / 100);
  for (const suffix of ["casing", "walk", "ride"]) mapNow.setLayoutProperty(`route-old-on-now-${suffix}`, "visibility", vis);
}
$("#mode-swipe").addEventListener("click", () => setMode("swipe"));
$("#mode-overlay").addEventListener("click", () => setMode("overlay"));
$("#opacity").addEventListener("input", (e) => {
  const v = Number(e.target.value);
  $("#opacity-out").textContent = `${v}%`;
  if (mapsReady) mapNow.setPaintProperty("rapid", "raster-opacity", v / 100);
});

// ---------- 地点の指定 ----------
// 候補（現在の駅・明治の地名）から選ぶ。自由入力・地図クリックでの指定はしない（現在側の6路線モデルで経路が実際とずれる地点を避けるため）
const PLACES = buildPlaces(NET_NOW, NET_OLD);

for (const k of ["origin", "dest"]) {
  const input = $(`#in-${k}`), list = $(`#list-${k}`);
  let opts = [], active = -1;
  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); active = -1; };
  const highlight = (i) => {
    active = i;
    list.querySelectorAll(".combo-opt").forEach((el, j) => el.setAttribute("aria-selected", String(j === i)));
    const el = i >= 0 && $(`#opt-${k}-${i}`);
    if (el) { input.setAttribute("aria-activedescendant", el.id); el.scrollIntoView({ block: "nearest" }); }
    else input.removeAttribute("aria-activedescendant");
  };
  const choose = (p) => { close(); setPoint(k, { name: p.name, lat: p.lat, lon: p.lon }); };
  // q が空なら全件の一覧、入力があれば絞り込み
  const render = (q = input.value) => {
    const r = searchPlaces(PLACES, q);
    opts = [...r.old, ...r.now]; // 明治の地名を先に出す（知らない地名に目が行くように）
    let i = 0;
    const group = (g, label, items) => (items.length ? `<li class="combo-group ${g}" role="presentation">${label}</li>` : "")
      + items.map((p) => `<li id="opt-${k}-${i}" class="combo-opt" role="option" aria-selected="false" data-i="${i++}">${esc(p.name)}<small>${esc(p.tag)}</small></li>`).join("");
    list.innerHTML = opts.length ? group("old", "明治の地名（6路線の駅から1km以内）", r.old) + group("now", "現在の駅（6路線）", r.now)
      : '<li class="combo-empty" role="presentation">候補がありません。候補は現在の6路線の駅と、その近くの明治の地名だけです</li>';
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    highlight(q.trim() && opts.length ? 0 : -1);
    if (!q.trim()) list.scrollTop = 0;
  };
  input.addEventListener("input", () => render());
  input.addEventListener("focus", () => { input.select(); render(""); });
  input.addEventListener("click", () => { if (list.hidden) render(""); });
  input.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return; // 変換中のEnterなどは無視
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (list.hidden) return render("");
      if (opts.length) highlight(e.key === "ArrowDown" ? (active + 1) % opts.length : active <= 0 ? opts.length - 1 : active - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!list.hidden && active >= 0) choose(opts[active]);
    } else if (e.key === "Escape") {
      close();
      input.value = state[k]?.name ?? "";
    }
  });
  // 候補から選ばずに離れたら、いま設定されている地点の名前に戻す
  input.addEventListener("blur", () => { close(); input.value = state[k]?.name ?? ""; });
  list.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const li = e.target.closest(".combo-opt");
    if (li) choose(opts[Number(li.dataset.i)]);
  });
  $(`#form-${k}`).addEventListener("submit", (e) => e.preventDefault());
}

function setPoint(k, p) {
  state[k] = p;
  $(`#in-${k}`).value = p.name;
  placeMarkers();
  recompute(true);
}

$("#swap").addEventListener("click", () => {
  [state.origin, state.dest] = [state.dest, state.origin];
  $("#in-origin").value = state.origin?.name ?? ""; $("#in-dest").value = state.dest?.name ?? "";
  placeMarkers();
  recompute(true);
});

$("#in-depart").addEventListener("change", (e) => {
  if (!e.target.value) return;
  state.departMin = parseClock(e.target.value);
  recompute(false);
});
$("#in-prefer").addEventListener("change", (e) => {
  state.preferVehicle = e.target.checked;
  recompute(false);
});

// ---------- 前提条件 ----------
function statusClass(s) { return s.startsWith("出典") || s === "確認済" ? "ok" : "warn"; }

// value は HTML として埋め込む（呼び出し側でデータ由来の値だけを渡す）
// 時刻表の各列車の始発駅の時刻
const firstDepartures = (trips) => trips.map((t) => t.find((x) => x != null));

// block=true なら値を見出しの右ではなく次の行に出す（時刻表など長い値用）
function fixedRow(era, label, value, status, basis, block = false) {
  return `<div class="assume">
      <div class="assume-head">
        <span class="assume-name"><span class="era ${era}">${era === "old" ? "明治" : "現在"}</span>${esc(label)}<span class="status ${statusClass(status)}">${esc(status)}</span></span>
        ${block ? "" : `<output>${value}</output>`}
      </div>
      ${block ? `<div class="assume-val">${value}</div>` : ""}
      <p>${esc(basis)}</p>
    </div>`;
}

function renderAssumptions() {
  const rows = [];
  const add = (era, net, key, label, unit) => {
    const p = net.params[key];
    const cur = state.overrides[era][key] ?? p.value;
    const fmt = (v) => (unit === "time" ? formatClock(v) : `${v}${unit}`);
    const slider = p.min !== undefined
      ? `<input type="range" min="${p.min}" max="${p.max}" step="${p.step}" value="${cur}" data-era="${era}" data-key="${key}" data-unit="${unit}" aria-label="${esc(label)}">`
      : "";
    rows.push(`<div class="assume">
      <div class="assume-head">
        <span class="assume-name"><span class="era ${era}">${era === "old" ? "明治" : "現在"}</span>${esc(label)}<span class="status ${statusClass(p.status)}">${esc(p.status)}</span></span>
        <output id="out-${era}-${key}">${fmt(cur)}</output>
      </div>
      ${slider}
      <p>${esc(p.basis)}</p>
    </div>`);
  };
  // 時刻表のある路線（汽車）
  for (const line of NET_OLD.lines) {
    const tt = line.timetable;
    if (tt) rows.push(fixedRow("old", `${line.shortName || line.name}の発車時刻`,
      `${esc(tt.fwdFrom)} ${firstDepartures(tt.fwd).map(esc).join("・")}<br>${esc(tt.revFrom)} ${firstDepartures(tt.rev).map(esc).join("・")}`,
      tt.status, tt.basis, true));
  }
  // 運賃（汽車は会社ごと、鉄道馬車は1回あたり）
  const F = NET_OLD.fares;
  for (const c of Object.values(F.companies)) {
    const n = Object.keys(c.pairs).length;
    rows.push(fixedRow("old", `${c.name}の運賃`, `${n}区間の運賃表（上等・中等・下等）`, c.status, `${c.basis}${c.through ? `。${c.through.note}` : ""}`, true));
  }
  rows.push(fixedRow("old", "鉄道馬車の運賃", `1回 ${F.horsecar.perRide[2]}銭〜（1等は${F.horsecar.perRide[0]}銭〜）`, F.horsecar.status, F.horsecar.basis));
  add("old", NET_OLD, "horsecarWaitMin", "鉄道馬車の平均待ち時間", "分");
  add("old", NET_OLD, "horsecarFirstMin", "鉄道馬車の始発", "time");
  add("old", NET_OLD, "horsecarLastMin", "鉄道馬車の終発", "time");
  add("old", NET_OLD, "horsecarKmh", "鉄道馬車の速度", "km/h");
  add("old", NET_OLD, "walkKmh", "徒歩の速度", "km/h");
  add("old", NET_OLD, "walkDetourStreet", "市街路の迂回係数", "倍");
  add("now", NET_NOW, "railWaitMin", "電車の平均待ち時間", "分");
  add("now", NET_NOW, "railFirstMin", "電車の始発", "time");
  add("now", NET_NOW, "railLastMin", "電車の終電", "time");
  add("now", NET_NOW, "walkKmh", "徒歩の速度", "km/h");
  $("#assumptions").innerHTML = rows.join("");
  $("#assumptions").querySelectorAll('input[type="range"]').forEach((el) => el.addEventListener("input", () => {
    const { era, key, unit } = el.dataset;
    state.overrides[era][key] = Number(el.value);
    $(`#out-${era}-${key}`).textContent = unit === "time" ? formatClock(Number(el.value)) : `${el.value}${unit}`;
    recompute(false);
  }));
}
renderAssumptions();

// ---------- ボトムシート（幅1100px以下） ----------
// 結果の欄を地図の上に下からかぶせ、つまみのドラッグ・タップで「少し見える／半分／全体」の3段階に止める
const sheet = $(".pane-right"), handle = $(".sheet-handle");
const mqSheet = matchMedia("(max-width: 1100px)");
const SHEET_ORDER = ["peek", "half", "full"];
const sheetHeight = { peek: () => 140, half: () => sheet.parentElement.clientHeight * 0.5, full: () => sheet.parentElement.clientHeight - 12 };
let sheetState = "peek";
function setSheet(name) {
  sheetState = name;
  if (!mqSheet.matches) { sheet.style.removeProperty("--sheet-h"); return; }
  sheet.style.setProperty("--sheet-h", `${Math.round(sheetHeight[name]())}px`);
  handle.setAttribute("aria-expanded", String(name !== "peek"));
  if (name === "peek") sheet.scrollTop = 0;
}
const stepSheet = (dir) => setSheet(SHEET_ORDER[Math.min(2, Math.max(0, SHEET_ORDER.indexOf(sheetState) + dir))]);

let drag = null;
handle.addEventListener("pointerdown", (e) => {
  if (!mqSheet.matches) return;
  drag = { y0: e.clientY, h0: sheet.getBoundingClientRect().height, y: e.clientY, t: e.timeStamp, v: 0, moved: false };
  handle.setPointerCapture(e.pointerId);
  sheet.classList.add("dragging");
});
handle.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const dt = e.timeStamp - drag.t;
  if (dt > 0) drag.v = (drag.y - e.clientY) / dt; // 上向きが正（px/ms）
  drag.y = e.clientY; drag.t = e.timeStamp;
  if (Math.abs(drag.y0 - e.clientY) > 4) drag.moved = true;
  const h = Math.min(sheetHeight.full(), Math.max(60, drag.h0 + drag.y0 - e.clientY));
  sheet.style.setProperty("--sheet-h", `${h}px`);
});
const endDrag = () => {
  if (!drag) return;
  sheet.classList.remove("dragging");
  if (!drag.moved) setSheet(sheetState === "full" ? "peek" : SHEET_ORDER[SHEET_ORDER.indexOf(sheetState) + 1]); // タップ
  else if (Math.abs(drag.v) > 0.5) {
    // 素早く払ったら、その向きで今の高さの次の段階へ
    const h = sheet.getBoundingClientRect().height;
    const up = drag.v > 0;
    const next = up ? SHEET_ORDER.find((n) => sheetHeight[n]() > h + 1) : [...SHEET_ORDER].reverse().find((n) => sheetHeight[n]() < h - 1);
    setSheet(next || (up ? "full" : "peek"));
  } else {
    // ゆっくり動かしたら、いちばん近い段階に止める
    const h = sheet.getBoundingClientRect().height;
    setSheet(SHEET_ORDER.reduce((a, b) => (Math.abs(sheetHeight[b]() - h) < Math.abs(sheetHeight[a]() - h) ? b : a)));
  }
  drag = null;
};
handle.addEventListener("pointerup", endDrag);
handle.addEventListener("pointercancel", endDrag);
handle.addEventListener("keydown", (e) => {
  if (e.key === "ArrowUp") { e.preventDefault(); stepSheet(1); }
  else if (e.key === "ArrowDown") { e.preventDefault(); stepSheet(-1); }
  else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSheet(sheetState === "full" ? "peek" : SHEET_ORDER[SHEET_ORDER.indexOf(sheetState) + 1]); }
});
mqSheet.addEventListener("change", () => setSheet(sheetState));
window.addEventListener("resize", () => { if (!drag) setSheet(sheetState); });
setSheet("peek");

// ---------- 設定ページ（#settings） ----------
// 同じページ内で表示を切り替える（仮定値の変更をそのまま地図の画面の経路に反映するため）。
// 地図の画面は隠さずに設定ページを上に重ね、操作できないよう inert にする（隠すと地図の大きさが0になり、戻っても描画されない）
function showPage() {
  const settings = location.hash === "#settings";
  $(".layout").inert = settings;
  $("#settings-page").hidden = !settings;
  $(".map-tools").hidden = settings; // 設定ページでは地図が見えないので、地図の切り替えも隠す
  if (settings) { $("#nav-settings").setAttribute("aria-current", "page"); $(".settings-title").focus(); }
  else $("#nav-settings").removeAttribute("aria-current");
}
window.addEventListener("hashchange", showPage);
showPage();

// ---------- 計算と表示 ----------
function recompute(fit) {
  if (!state.origin || !state.dest) return;
  const opt = { departMin: state.departMin };
  const fastest = route(NET_OLD, state.origin, state.dest, state.overrides.old, opt);
  // 乗り物を優先：乗り物を使う経路のうち最も早いもの。その時刻以降に乗り物がなければ、最速の経路のまま
  const ride = state.preferVehicle ? route(NET_OLD, state.origin, state.dest, state.overrides.old, { ...opt, requireVehicle: true }) : null;
  const old = ride || fastest;
  const oldWalk = route(NET_OLD, state.origin, state.dest, state.overrides.old, { ...opt, vehicles: false });
  const now = route(NET_NOW, state.origin, state.dest, state.overrides.now, opt);
  state.result = { old, oldWalk, now, fastest, preferred: !!ride, noRide: state.preferVehicle && !ride };
  state.resultGen = (state.resultGen || 0) + 1;
  renderResult();
  drawRoutes(fit);
}

function drawRoutes(fit) {
  if (!mapsReady) return;
  const { old, now } = state.result;
  mapOld.getSource("route-old").setData(routeFC(old));
  mapNow.getSource("route-now").setData(routeFC(now));
  mapNow.getSource("route-old-on-now").setData(routeFC(old));
  if (fit) {
    const pts = [...old.legs, ...now.legs].flatMap((l) => l.coords);
    if (state.origin) pts.push([state.origin.lon, state.origin.lat], [state.dest.lon, state.dest.lat]);
    const b = pts.reduce((bb, c) => bb.extend(c), new maplibregl.LngLatBounds(pts[0], pts[0]));
    mapNow.fitBounds(b, { padding: { top: 70, bottom: 60, left: 50, right: 50 }, animate: false });
    if (compare) mapOld.jumpTo({ center: mapNow.getCenter(), zoom: mapNow.getZoom() });
  }
}

function renderBars({ old, oldWalk, now, fastest, preferred, noRide }) {
  const max = Math.max(old.totalMin, now.totalMin, 1);
  const row = (cls, title, r, sub, extra = "") => `<div class="bar-row">
      <div class="bar-label"><span>${title} <span class="sub">${sub}</span></span><strong>${formatMin(r.totalMin)}</strong></div>
      <div class="bar ${cls}"><i style="width:${(r.totalMin / max) * 100}%"></i></div>${extra}
    </div>`;
  const fare = old.fare && old.legs.some((l) => l.mode !== "walk")
    ? `<div class="bar-fare">${FARE_ICON}運賃 ${esc(fareText(old.fare, old.fare.atLeast))}</div>` : "";
  const walkSame = oldWalk.totalMin === old.totalMin;
  const ratio = now.totalMin > 0 ? (old.totalMin / now.totalMin).toFixed(1) : null;
  $("#compare-bars").innerHTML =
    row("now", "現在", now, modeIcons(now, true)) +
    row("old", "明治18年", old, modeIcons(old, false), fare) +
    (ratio === null ? `<p class="ratio">出発地と目的地がほぼ同じ地点です。</p>`
      : `<p class="ratio">明治18年の${preferred ? "乗り物を使う経路" : "最速経路"}は、現在の約<strong>${ratio}倍</strong>の時間がかかります。${
        preferred && old.totalMin > fastest.totalMin ? `乗り物を優先しています（${fastest.legs.every((l) => l.mode === "walk") ? "歩くだけ" : "最速の経路"}なら${formatMin(fastest.totalMin)}）。`
        : noRide ? "この時刻からは乗り物を使う経路がないため、最速の経路を表示しています。"
        : walkSame ? "この区間では、乗り物を使っても歩いた方が早く着きます。" : ""}</p>${laterDepartHTML(old)}`);
}

// 最初に乗る汽車を駅で長く待つときは、出発を遅らせても同じ汽車に間に合うことを伝え、その時刻にするボタンを出す
// （乗るまでの徒歩の時間は出発時刻によらないので、待ち時間の分だけ遅らせてよい）
const LATER_MIN = 10;
function laterDepartHTML(r) {
  const first = r.legs.find((l) => l.mode !== "walk");
  if (!first?.departAt || first.waitMin < LATER_MIN || state.departMin + first.waitMin >= 24 * 60) return "";
  const t = formatClock(state.departMin + first.waitMin);
  return `<p class="later">駅で${formatMin(first.waitMin)}待ちます。出発を${t}に遅らせても、同じ${first.firstRun ? "始発" : `${first.departAt}発`}に間に合います。
    <button type="button" class="btn-ghost later-btn" data-depart="${t}">出発を${t}にする</button></p>`;
}
document.addEventListener("click", (e) => {
  const b = e.target.closest(".later-btn");
  if (!b) return;
  state.departMin = parseClock(b.dataset.depart);
  $("#in-depart").value = b.dataset.depart.padStart(5, "0");
  recompute(false);
});

const MODE_LABEL = { walk: "徒歩", rail: "汽車", horsecar: "鉄道馬車" };
// 経路の内訳で区間の先頭に付けるアイコン（Material Symbols。index.html の icon_names に同じ名前を並べる）
const LEG_ICON = { walk: "directions_walk", horsecar: "trolley_cable_car", rail: "directions_railway", "now-rail": "train" };
const FARE_ICON = '<span class="material-symbols-outlined fare-icon" aria-hidden="true">payments</span>';

// 運賃（銭）の表示。100銭＝1円
const formatSen = (n) => (n >= 100 ? `${Math.floor(n / 100)}円${n % 100 ? `${n % 100}銭` : ""}` : `${n}銭`);
// [上等, 中等, 下等] のうち下等を主に、上等・中等を添える
function fareText(f, atLeast = false) {
  if (!f || f.unknown) return "運賃不明";
  const t = (n) => `${formatSen(n)}${atLeast ? "〜" : ""}`;
  return `下等 ${t(f.sen[2])}（中等 ${t(f.sen[1])}・上等 ${t(f.sen[0])}）`;
}
// 使う手段のアイコンを経路の順に並べる（Google マップ風。同じ手段が続くときは1つにまとめる）。読み上げ用に手段名も入れる
function modeIcons(r, isNow) {
  const seq = [];
  for (const l of r.legs) {
    const k = isNow && l.mode !== "walk" ? "now-rail" : l.mode;
    if (seq[seq.length - 1] !== k) seq.push(k);
  }
  return seq.map((k) => `<span class="material-symbols-outlined leg-icon ${k}" aria-hidden="true">${LEG_ICON[k]}</span>`)
    .join('<span class="mode-sep" aria-hidden="true">›</span>') + `<span class="sr-only">${modesOf(r)}</span>`;
}

function modesOf(r) {
  return [...new Set(r.legs.map((l) => (r === state.result.now && l.mode === "rail" ? "電車" : MODE_LABEL[l.mode])))].join("・");
}

function renderLegs(el, r, isNow) {
  const items = r.legs.map((l, i) => {
    const mode = isNow && l.mode === "rail" ? "電車" : MODE_LABEL[l.mode];
    const cls = isNow && l.mode !== "walk" ? "now-rail" : l.mode;
    const via = l.viaNames.length && l.mode === "walk" && l.viaNames.length <= 6 ? `<div class="leg-sub">経由：${l.viaNames.map(esc).join("・")}</div>` : "";
    const dep = l.departAt ? `<span class="dep">${l.firstRun ? "始発 " : ""}${l.departAt}発</span>　` : "";
    const wait = l.waitMin ? `<span class="wait">待ち ${l.waitMin}分</span> ＋ ` : "";
    const opened = l.opened ? `（${l.opened}年開業）` : "";
    const approx = l.approx && l.mode === "walk" ? '<span class="badge-approx">道筋は推定</span>' : "";
    const fare = isNow || !l.fare ? "" : `<div class="leg-sub leg-fare">${FARE_ICON}${l.fare.through ? "運賃は前の区間からの通し運賃に含む" : `運賃 ${esc(fareText(l.fare, l.fare.atLeast))}`}</div>`;
    return `<li class="leg ${cls}"><span class="leg-dot"></span>
      <div class="leg-title">${LEG_ICON[cls] ? `<span class="material-symbols-outlined leg-icon ${cls}" aria-hidden="true">${LEG_ICON[cls]}</span>` : ""}<span class="mode">${mode}</span>${esc(l.label)}${opened}${approx}</div>
      <div class="leg-sub">${esc(l.from)} → ${esc(l.to)}　${dep}${wait}移動 ${l.moveMin}分 ・ ${l.km}km</div>${via}${fare}
    </li>`;
  });
  const icon = (name) => `<span class="material-symbols-outlined end-icon" aria-hidden="true">${name}</span>`;
  const fareTotal = !isNow && r.fare && r.legs.some((l) => l.mode !== "walk") ? `・${icon("payments")}運賃 下等 ${formatSen(r.fare.sen[2])}${r.fare.atLeast ? "〜" : ""}` : "";
  items.push(`<li class="leg-end">${esc(state.dest.name)}（${icon("timer")}合計 ${formatMin(r.totalMin)}${fareTotal}）</li>`);
  el.innerHTML = items.join("");
}

function factsUsed(r) {
  const ids = new Set(r.legs.flatMap((l) => l.facts));
  return [...ids].filter((id) => FACTS.facts[id]);
}

function renderFacts(ids, cited = new Set()) {
  $("#facts").innerHTML = ids.map((id) => {
    const f = FACTS.facts[id];
    return `<li class="fact" id="fact-${id}">
      <div class="fact-head"><span>${esc(f.title)} <span class="fid">[${id}]</span>${cited.has(id) ? " ✓" : ""}</span><span class="status ${statusClass(f.status)}">${esc(f.status)}</span></div>
      <p>${esc(f.body)}</p>
      <a href="${esc(f.source.url)}" target="_blank" rel="noopener">${esc(f.source.label)}</a>
    </li>`;
  }).join("");
}

function renderResult() {
  const { old, now } = state.result;
  $("#empty").hidden = true;
  $("#result").hidden = false;
  if (sheetState === "peek") setSheet("half"); // 経路が出たら、結果を半分まで広げる
  renderBars(state.result);
  renderLegs($("#legs-old"), old, false);
  renderLegs($("#legs-now"), now, true);
  renderSpots(old);
  const ids = [...new Set([...factsUsed(old), ...factsUsed(now)])];
  renderFacts(ids);
  renderTemplateExplain(ids);
}

// ---------- 沿線の見どころ ----------
// 明治の経路が通る名所（ALL_SPOTS のうち経路上のもの）を、通る順に並べる
function spotsOf(r) {
  const byId = new Map(ALL_SPOTS.map((sp) => [sp.id, sp]));
  return [...new Set(r.legs.flatMap((l) => l.viaIds || []))].filter((id) => byId.has(id)).map((id) => byId.get(id));
}
function renderSpots(r) {
  const spots = spotsOf(r);
  $("#spots-sec").hidden = !spots.length;
  $("#spots").innerHTML = spots.map((sp) => `<li class="spot">
      <span class="material-symbols-outlined spot-icon" aria-hidden="true">location_on</span>${spotCardHTML(sp)}
    </li>`).join("");
  highlightSpots(new Set(spots.map((sp) => sp.id)));
}

// ---------- 解説 ----------
// AIを使わない定型解説。数値は経路計算の結果、文章は事実カードのみから組み立てる
function renderTemplateExplain(ids) {
  const { old, oldWalk, now, preferred } = state.result;
  const rides = old.legs.filter((l) => l.mode !== "walk");
  const depart = formatClock(state.departMin);
  const ttNote = "汽車の発着時刻と運賃は明治18年5月刊の『鉄道汽車便覧表』によります";
  const fareNote = rides.length && old.fare ? `運賃は下等で${formatSen(old.fare.sen[2])}${old.fare.atLeast ? "以上（鉄道馬車は区の区切りが分からないため1区分で計算）" : ""}、上等なら${formatSen(old.fare.sen[0])}${old.fare.atLeast ? "以上" : ""}です。` : "";
  const why = rides.length
    ? `${depart}に出発すると、明治18年の${preferred ? "乗り物を使う経路のうち最も早いもの" : "最速経路"}は${rides.map((l) => `${l.label}（${l.from}→${l.to}${l.departAt ? `、${l.firstRun ? "始発" : ""}${l.departAt}発` : ""}）`).join("、")}を乗り継ぎ、合計${formatMin(old.totalMin)}です。${fareNote}歩くだけなら${formatMin(oldWalk.totalMin)}かかります。${ttNote}。鉄道馬車の待ち時間と運行時間（始発・終発）は仮定値で、「設定」ページの「計算の前提」で変えられます。`
    : `${depart}に出発すると、明治18年のこの区間では、汽車や鉄道馬車を待つより歩く方が早く、${old.legs.filter((l) => l.mode === "walk" && l.label !== "徒歩（市街路・推定）").map((l) => l.label).join("・") || "市街路"}を通って${formatMin(old.totalMin)}です。現在は${formatMin(now.totalMin)}です。${ttNote}。`;
  const bodies = (pred) => ids.filter((id) => pred(id)).map((id) => ({ id, text: FACTS.facts[id].body }));
  const oldLineFacts = new Set(NET_OLD.lines.flatMap((l) => l.facts || []));
  const nowLineFacts = new Set(NET_NOW.lines.flatMap((l) => l.facts || []));
  const sections = [
    { heading: "なぜこの経路か", text: why, factIds: [] },
    { heading: "当時の交通事情", items: bodies((id) => oldLineFacts.has(id)) },
    { heading: "現在の路線", items: bodies((id) => nowLineFacts.has(id)) },
  ];
  $("#explain").innerHTML = sections.map((s) => {
    if (s.items) {
      if (!s.items.length) return "";
      return `<div class="explain-sec"><h3>${s.heading}</h3><p>${s.items.map((x) => `${esc(x.text)}<a class="cite" href="#fact-${x.id}">[${x.id}]</a>`).join(" ")}</p></div>`;
    }
    return `<div class="explain-sec"><h3>${s.heading}</h3><p>${esc(s.text)}</p></div>`;
  }).join("");
  $("#ai-status").textContent = "定型解説（事実カードと計算結果のみから作成）";
}

function aiInput() {
  const { old, oldWalk, now } = state.result;
  const strip = (r) => ({
    totalMin: r.totalMin, totalLabel: formatMin(r.totalMin), totalKm: r.totalKm,
    legs: r.legs.map(({ mode, label, from, to, km, moveMin, waitMin, departAt, opened, approx, viaNames, fare }) =>
      ({ mode, label, from, to, km, moveMin, waitMin, ...(departAt && { departAt }), opened, routeIsEstimated: approx, via: viaNames,
        ...(fare && { fareSen: fare.through ? "前の区間の通し運賃に含む" : fare.unknown ? "不明" : { 上等: fare.sen[0], 中等: fare.sen[1], 下等: fare.sen[2], atLeast: !!fare.atLeast } }) })),
    ...(r.fare && { fareTotalSen: { 上等: r.fare.sen[0], 中等: r.fare.sen[1], 下等: r.fare.sen[2], atLeast: r.fare.atLeast } }),
  });
  const p = (net, era, keys) => keys.map((k) => {
    const v = state.overrides[era === "明治18年" ? "old" : "now"][k] ?? net.params[k].value;
    return { era, name: k, value: net.params[k].unit === "time" ? formatClock(v) : v, basis: net.params[k].basis, status: net.params[k].status };
  });
  const ids = [...new Set([...factsUsed(old), ...factsUsed(now)])];
  return {
    origin: state.origin.name, destination: state.dest.name, departTime: formatClock(state.departMin),
    route: { meiji1885: strip(old), meiji1885WalkOnly: { totalMin: oldWalk.totalMin, totalLabel: formatMin(oldWalk.totalMin) }, now: strip(now) },
    assumptions: [
      ...p(NET_OLD, "明治18年", ["walkKmh", "walkDetourStreet", "horsecarKmh", "horsecarWaitMin", "horsecarFirstMin", "horsecarLastMin"]),
      ...p(NET_NOW, "現在", ["walkKmh", "railWaitMin", "railFirstMin", "railLastMin"]),
      ...Object.values(NET_OLD.fares.companies).map((c) => ({ era: "明治18年", name: `${c.name}の運賃`, value: "運賃表（単位：銭、100銭＝1円）", basis: c.basis + (c.through ? `。${c.through.note}` : ""), status: c.status })),
      { era: "明治18年", name: "鉄道馬車の運賃", value: `1回${NET_OLD.fares.horsecar.perRide[2]}銭以上（1等${NET_OLD.fares.horsecar.perRide[0]}銭以上）`, basis: NET_OLD.fares.horsecar.basis, status: NET_OLD.fares.horsecar.status },
      ...NET_OLD.lines.filter((l) => l.timetable).map((l) => ({ era: "明治18年", name: `${l.name}の発車時刻`,
        value: `${l.timetable.fwdFrom} ${firstDepartures(l.timetable.fwd).join("・")} / ${l.timetable.revFrom} ${firstDepartures(l.timetable.rev).join("・")}`,
        basis: l.timetable.basis, status: l.timetable.status })),
    ],
    facts: ids.map((id) => ({ id, title: FACTS.facts[id].title, body: FACTS.facts[id].body, status: FACTS.facts[id].status })),
  };
}

// AI解説は、server.mjs で動かしていて AI が設定されているときだけ使える。
// GitHub Pages などの静的な公開では /api/status が無いので、ボタンは隠したまま（定型解説だけ）
fetch("api/status").then((r) => (r.ok ? r.json() : null)).catch(() => null)
  .then((s) => { if (s?.ai) $("#btn-ai").hidden = false; });

// 解説の [id] を押したら、たたまれている事実カードの欄を開いてからそのカードへ移る
document.addEventListener("click", (e) => { if (e.target.closest("a.cite")) $("#facts-acc").open = true; });

$("#btn-ai").addEventListener("click", async () => {
  if (!state.result) return;
  const btn = $("#btn-ai");
  const gen = state.resultGen;
  btn.disabled = true;
  $("#ai-status").textContent = "AIが解説を書いています…";
  try {
    const input = aiInput();
    const r = await fetch("api/explain", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    // 応答を待つ間に経路が変わっていたら、古い経路の解説なので表示しない
    if (gen !== state.resultGen) return;
    const cited = new Set(data.sections.flatMap((s) => s.factIds));
    $("#explain").innerHTML = data.sections.map((s) => `<div class="explain-sec"><h3>${esc(s.heading)}</h3>
      <p>${esc(s.text)}${s.factIds.map((id) => `<a class="cite" href="#fact-${id}">[${id}]</a>`).join("")}</p></div>`).join("");
    renderFacts(input.facts.map((f) => f.id), cited);
    $("#ai-status").textContent = `AI解説（${data.model}）— 入力にない数値が含まれていないことを自動チェック済み`;
  } catch (e) {
    if (gen !== state.resultGen) return;
    $("#ai-status").textContent = `AI解説を表示できませんでした：${e.message}。定型解説を表示しています。`;
  } finally {
    btn.disabled = false;
  }
});

