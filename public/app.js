import { route, formatMin, formatClock, parseClock } from "./router.js";
import { buildPlaces, searchPlaces } from "./places.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const [NET_OLD, NET_NOW, FACTS] = await Promise.all(
  ["data/network-1885.json", "data/network-now.json", "data/facts.json"].map((u) => fetch(u).then((r) => r.json())),
);

const state = {
  origin: null,
  dest: null,
  overrides: { old: {}, now: {} },
  departMin: 11 * 60 + 30,
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

const COLORS = { now: "#2f6db5", old: "#b8452a", walk: "#7a6a52", rail: "#2b2620", horsecar: "#a0681f" };

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
// 候補（現在の駅・明治の地名）から選ぶ。自由入力・地図クリックでの指定はしない（現在側の4路線モデルで経路が実際とずれる地点を避けるため）
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
    opts = [...r.now, ...r.old];
    let i = 0;
    const group = (g, label, items) => (items.length ? `<li class="combo-group ${g}" role="presentation">${label}</li>` : "")
      + items.map((p) => `<li id="opt-${k}-${i}" class="combo-opt" role="option" aria-selected="false" data-i="${i++}">${esc(p.name)}<small>${esc(p.tag)}</small></li>`).join("");
    list.innerHTML = opts.length ? group("now", "現在の駅（4路線）", r.now) + group("old", "明治の地名（4路線の駅から1km以内）", r.old)
      : '<li class="combo-empty" role="presentation">候補がありません。候補は現在の4路線の駅と、その近くの明治の地名だけです</li>';
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

// ---------- 設定ページ（#settings） ----------
// 同じページ内で表示を切り替える（仮定値の変更をそのまま地図の画面の経路に反映するため）。
// 地図の画面は隠さずに設定ページを上に重ね、操作できないよう inert にする（隠すと地図の大きさが0になり、戻っても描画されない）
function showPage() {
  const settings = location.hash === "#settings";
  $(".layout").inert = settings;
  $("#settings-page").hidden = !settings;
  if (settings) { $("#nav-settings").setAttribute("aria-current", "page"); $(".settings-title").focus(); }
  else $("#nav-settings").removeAttribute("aria-current");
}
window.addEventListener("hashchange", showPage);
showPage();

// ---------- 計算と表示 ----------
function recompute(fit) {
  if (!state.origin || !state.dest) return;
  const opt = { departMin: state.departMin };
  const old = route(NET_OLD, state.origin, state.dest, state.overrides.old, opt);
  const oldWalk = route(NET_OLD, state.origin, state.dest, state.overrides.old, { ...opt, vehicles: false });
  const now = route(NET_NOW, state.origin, state.dest, state.overrides.now, opt);
  state.result = { old, oldWalk, now };
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

function renderBars({ old, oldWalk, now }) {
  const max = Math.max(old.totalMin, oldWalk.totalMin, now.totalMin, 1);
  const row = (cls, title, r, sub, extra = "") => `<div class="bar-row">
      <div class="bar-label"><span>${title} <span class="sub">${sub}</span></span><strong>${formatMin(r.totalMin)}</strong></div>
      <div class="bar ${cls}"><i style="width:${(r.totalMin / max) * 100}%"></i></div>${extra}
    </div>`;
  const fare = old.fare && old.legs.some((l) => l.mode !== "walk")
    ? `<div class="bar-fare">${FARE_ICON}運賃 ${esc(fareText(old.fare, old.fare.atLeast))}</div>` : "";
  const walkSame = oldWalk.totalMin === old.totalMin;
  const ratio = now.totalMin > 0 ? (old.totalMin / now.totalMin).toFixed(1) : null;
  $("#compare-bars").innerHTML =
    row("now", "現在", now, modesOf(now)) +
    row("old", "明治18年", old, modesOf(old), fare) +
    (walkSame ? "" : row("walk", "明治18年・徒歩のみ", oldWalk, "街道・市街路")) +
    (ratio === null ? `<p class="ratio">出発地と目的地がほぼ同じ地点です。</p>`
      : `<p class="ratio">明治18年の最速経路は、現在の約<strong>${ratio}倍</strong>の時間がかかります。${walkSame ? "この区間では、乗り物を使っても歩いた方が早く着きます。" : ""}</p>`);
}

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
  renderBars(state.result);
  renderLegs($("#legs-old"), old, false);
  renderLegs($("#legs-now"), now, true);
  const ids = [...new Set([...factsUsed(old), ...factsUsed(now)])];
  renderFacts(ids);
  renderTemplateExplain(ids);
}

// ---------- 解説 ----------
// AIを使わない定型解説。数値は経路計算の結果、文章は事実カードのみから組み立てる
function renderTemplateExplain(ids) {
  const { old, oldWalk, now } = state.result;
  const rides = old.legs.filter((l) => l.mode !== "walk");
  const depart = formatClock(state.departMin);
  const ttNote = "汽車の発着時刻と運賃は明治18年5月刊の『鉄道汽車便覧表』によります";
  const fareNote = rides.length && old.fare ? `運賃は下等で${formatSen(old.fare.sen[2])}${old.fare.atLeast ? "以上（鉄道馬車は区の区切りが分からないため1区分で計算）" : ""}、上等なら${formatSen(old.fare.sen[0])}${old.fare.atLeast ? "以上" : ""}です。` : "";
  const why = rides.length
    ? `${depart}に出発すると、明治18年の最速経路は${rides.map((l) => `${l.label}（${l.from}→${l.to}${l.departAt ? `、${l.firstRun ? "始発" : ""}${l.departAt}発` : ""}）`).join("、")}を乗り継ぎ、合計${formatMin(old.totalMin)}です。${fareNote}歩くだけなら${formatMin(oldWalk.totalMin)}かかります。${ttNote}。鉄道馬車の待ち時間と運行時間（始発・終発）は仮定値で、「設定」ページの「計算の前提」で変えられます。`
    : `${depart}に出発すると、明治18年のこの区間では、汽車や鉄道馬車を待つより歩く方が早く、${old.legs.filter((l) => l.mode === "walk" && l.label !== "徒歩（市街路・推定）").map((l) => l.label).join("・") || "市街路"}を通って${formatMin(old.totalMin)}です。現在は${formatMin(now.totalMin)}です。${ttNote}。`;
  const bodies = (pred) => ids.filter((id) => pred(id)).map((id) => ({ id, text: FACTS.facts[id].body }));
  const oldLineFacts = new Set(NET_OLD.lines.flatMap((l) => l.facts || []));
  const nowLineFacts = new Set(NET_NOW.lines.flatMap((l) => l.facts || []));
  const sections = [
    { heading: "なぜこの経路か", text: why, factIds: [] },
    { heading: "当時の交通事情", items: bodies((id) => oldLineFacts.has(id)) },
    { heading: "沿線の見どころ", items: bodies((id) => !oldLineFacts.has(id) && !nowLineFacts.has(id)) },
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

