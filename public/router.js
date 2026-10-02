// 時代別ネットワーク上の経路探索。ブラウザとNode（テスト）の両方から使う ES module。
// 所要時間はすべて「距離 × 係数 ÷ 速度 + 待ち時間」で計算し、各値の根拠は network-*.json の params に置く。
// 時刻表（line.timetable）のある路線は、列車ごとの発着時刻で乗車・待ち時間を決める。それ以外は平均待ち時間の仮定値を使い、
// 運行時間（params の <mode>FirstMin / <mode>LastMin）の外では、始発前なら始発まで待ち、終発後は乗れない。

const R_KM = 6371.0088;

export function haversineKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.sqrt(h));
}

// params の {value, ...} を素の数値に展開し、overrides で上書きする
export function resolveParams(net, overrides = {}) {
  const p = {};
  for (const [k, v] of Object.entries(net.params)) p[k] = v.value;
  return { ...p, ...overrides };
}

function lineKmh(net, line, p) {
  if (net.lineSpeeds && net.lineSpeeds[line.id]) return net.lineSpeeds[line.id].kmh;
  return line.mode === "horsecar" ? p.horsecarKmh : p.railKmh;
}

function avgWaitMin(mode, p) {
  return mode === "horsecar" ? p.horsecarWaitMin : p.railWaitMin;
}

// 時刻表のない路線で、時刻 t（0時からの分）に乗り場に着いたときの待ち時間。終発後なら null
function serviceWaitMin(mode, t, p) {
  const first = p[`${mode}FirstMin`], last = p[`${mode}LastMin`];
  if (last != null && t > last) return null;
  if (first != null && t < first) return { wait: first - t, first: true };
  return { wait: avgWaitMin(mode, p), first: false };
}

// "8:00" → 480（0時からの分）
export function parseClock(s) {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}

export function formatClock(min) {
  const m = Math.round(min);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

export function buildGraph(net, p) {
  const nodes = net.nodes;
  const adj = new Map(Object.keys(nodes).map((id) => [id, []]));
  const linked = new Set();
  const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  const addBoth = (a, b, edge) => {
    adj.get(a).push({ ...edge, to: b, coords: [[nodes[a].lon, nodes[a].lat], [nodes[b].lon, nodes[b].lat]] });
    adj.get(b).push({ ...edge, to: a, coords: [[nodes[b].lon, nodes[b].lat], [nodes[a].lon, nodes[a].lat]] });
  };

  // 街道・市街路（経路が分かっている徒歩路）
  for (const way of net.ways) {
    const approxPairs = new Set((way.approxSegments || []).flatMap(([s, e]) => {
      const i = way.nodes.indexOf(s), j = way.nodes.indexOf(e);
      return way.nodes.slice(Math.min(i, j), Math.max(i, j));
    }));
    for (let i = 0; i < way.nodes.length - 1; i++) {
      const a = way.nodes[i], b = way.nodes[i + 1];
      const approx = way.kind !== "kaido" || approxPairs.has(a);
      const detour = way.kind === "kaido" ? p.walkDetourKaido : p.walkDetourStreet;
      const km = haversineKm(nodes[a], nodes[b]) * detour;
      addBoth(a, b, { mode: "walk", wayId: way.id, km, min: (km / p.walkKmh) * 60, approx });
      linked.add(key(a, b));
    }
  }

  // 鉄道・鉄道馬車
  for (const line of net.lines) {
    const st = line.loop ? [...line.stations, line.stations[0]] : line.stations;
    if (line.timetable) { addTimetableEdges(adj, nodes, line, st); continue; }
    // 時刻表のない路線：速度から所要時間を出し、乗車時に平均待ち時間を足す。向き（fwd=stations の順 / rev=逆順）で別の路線として扱う
    const kmh = lineKmh(net, line, p);
    for (let i = 0; i < st.length - 1; i++) {
      const a = st[i], b = st[i + 1];
      const km = haversineKm(nodes[a], nodes[b]);
      const base = { mode: line.mode, lineId: line.id, km, min: (km / kmh) * 60 };
      adj.get(a).push({ ...base, dir: "fwd", to: b, coords: [[nodes[a].lon, nodes[a].lat], [nodes[b].lon, nodes[b].lat]] });
      adj.get(b).push({ ...base, dir: "rev", to: a, coords: [[nodes[b].lon, nodes[b].lat], [nodes[a].lon, nodes[a].lat]] });
    }
  }

  // 近接地点を市街路（直線×係数）でつなぐ。乗換や街道間の連絡に使う
  const ids = Object.keys(nodes);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i], b = ids[j];
      if (linked.has(key(a, b))) continue;
      const d = haversineKm(nodes[a], nodes[b]);
      if (d > p.streetLinkKm) continue;
      const km = d * p.walkDetourStreet;
      addBoth(a, b, { mode: "walk", wayId: null, km, min: (km / p.walkKmh) * 60, approx: true });
    }
  }
  return { nodes, adj };
}

// 時刻表のある路線は、列車ごとに「停車駅 → 次の停車駅」の辺を作る（通過駅は飛ばし、線形は通過駅も通る）。
// timetable.fwd / rev は列車ごとの時刻の配列で、fwd は stations の順、rev は逆順に並ぶ。null はその駅に停まらない
function addTimetableEdges(adj, nodes, line, st) {
  for (const dir of ["fwd", "rev"]) {
    const order = dir === "fwd" ? st : [...st].reverse();
    line.timetable[dir].forEach((times, k) => {
      const stops = order.map((id, i) => ({ id, i, t: times[i] })).filter((x) => x.t != null);
      for (let j = 0; j < stops.length - 1; j++) {
        const a = stops[j], b = stops[j + 1];
        const path = order.slice(a.i, b.i + 1);
        let km = 0;
        for (let q = 0; q < path.length - 1; q++) km += haversineKm(nodes[path[q]], nodes[path[q + 1]]);
        const dep = parseClock(a.t);
        adj.get(a.id).push({ mode: line.mode, lineId: line.id, trip: `${line.id}:${dir}:${k}`, to: b.id, km,
          dep, min: parseClock(b.t) - dep, coords: path.map((id) => [nodes[id].lon, nodes[id].lat]) });
      }
    });
  }
}

// 最小ヒープ（Dijkstra 用）
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(x) {
    const a = this.a; a.push(x);
    let i = a.length - 1;
    while (i > 0) { const pi = (i - 1) >> 1; if (a[pi].pri <= a[i].pri) break; [a[pi], a[i]] = [a[i], a[pi]]; i = pi; }
  }
  pop() {
    const a = this.a; const top = a[0]; const last = a.pop();
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l].pri < a[m].pri) m = l;
        if (r < a.length && a[r].pri < a[m].pri) m = r;
        if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

/**
 * origin / dest: {lat, lon, name}
 * options.vehicles=false で徒歩のみ。options.departMin は出発時刻（0時からの分、既定 9:00）
 * options.requireVehicle=true なら、乗り物（汽車・鉄道馬車など）を少なくとも1回使う経路のうち最も早いものを返す（なければ null）
 * 戻り値: { totalMin, totalKm, departMin, legs[], params }
 */
export function route(net, origin, dest, overrides = {}, options = {}) {
  const p = resolveParams(net, overrides);
  const { nodes, adj } = buildGraph(net, p);
  const vehicles = options.vehicles !== false;
  const requireVehicle = vehicles && !!options.requireVehicle;
  const departMin = options.departMin ?? 9 * 60;
  const O = "__origin", D = "__dest";
  const all = { ...nodes, [O]: { ...origin, name: origin.name || "出発地" }, [D]: { ...dest, name: dest.name || "目的地" } };

  const walkEdge = (from, to) => {
    const km = haversineKm(all[from], all[to]) * p.walkDetourStreet;
    return { mode: "walk", wayId: null, km, min: (km / p.walkKmh) * 60, approx: true, to,
      coords: [[all[from].lon, all[from].lat], [all[to].lon, all[to].lat]] };
  };

  const originEdges = [walkEdge(O, D)];
  const toDest = new Map();
  for (const id of Object.keys(nodes)) {
    if (haversineKm(origin, nodes[id]) <= p.accessRadiusKm) originEdges.push(walkEdge(O, id));
    if (haversineKm(nodes[id], dest) <= p.accessRadiusKm) toDest.set(id, walkEdge(id, D));
  }
  const edgesOf = (id) => {
    if (id === O) return originEdges;
    const list = adj.get(id) || [];
    const extra = toDest.get(id);
    return extra ? [...list, extra] : list;
  };

  // 状態 = (地点, 乗車中の列車／路線と向き)。乗車には待ち時間を足す。
  // 時刻表の路線は、駅に早く着いて損をすることがない（遅れて着けば同じか後の列車になる）ので、Dijkstra 法のままで最短になる
  // 優先度 pri = 所要分 + 徒歩分 × ごく小さい係数。同着なら、歩き回るより駅で待つ経路を選ぶ（所要時間 cost は変えない）
  const WALK_TIE = 1e-6;
  // 状態には「乗り物をもう使ったか」も含める（requireVehicle のとき、使っていない状態で目的地に着いても終わりにしない）
  const sKey = (n, l, v) => `${n}#${l || ""}#${v ? 1 : 0}`;
  const best = new Map([[sKey(O, null, false), 0]]);
  const prev = new Map();
  const heap = new Heap();
  heap.push({ cost: 0, pri: 0, node: O, line: null, used: false });
  let goal = null;

  while (heap.size) {
    const cur = heap.pop();
    const ck = sKey(cur.node, cur.line, cur.used);
    if (cur.pri > best.get(ck)) continue;
    if (cur.node === D) {
      if (requireVehicle && !cur.used) continue;
      goal = cur; break;
    }
    for (const e of edgesOf(cur.node)) {
      if (!vehicles && e.mode !== "walk") continue;
      const nextLine = e.mode === "walk" ? null : e.trip || `${e.lineId}:${e.dir}`;
      let wait = 0, firstRun = false;
      if (e.mode !== "walk" && cur.line !== nextLine) {
        if (e.trip) {
          wait = e.dep - (departMin + cur.cost);
          if (wait < -1e-9) continue; // この列車はもう出ている
          wait = Math.max(0, wait);
        } else {
          const w = serviceWaitMin(e.mode, departMin + cur.cost, p);
          if (!w) continue; // 終発後
          ({ wait, first: firstRun } = w);
        }
      }
      const cost = cur.cost + e.min + wait;
      const pri = cur.pri + e.min + wait + (e.mode === "walk" ? e.min * WALK_TIE : 0);
      const used = cur.used || e.mode !== "walk";
      const nk = sKey(e.to, nextLine, used);
      if (pri < (best.get(nk) ?? Infinity)) {
        best.set(nk, pri);
        prev.set(nk, { from: ck, edge: e, wait, firstRun, boardAt: cur.cost + wait });
        heap.push({ cost, pri, node: e.to, line: nextLine, used });
      }
    }
  }
  if (!goal) return null;

  // 経路を復元し、同じ手段・同じ路線（または同じ街道）の連続区間を1区間にまとめる
  const steps = [];
  for (let k = sKey(goal.node, goal.line, goal.used); prev.has(k); k = prev.get(k).from) {
    const s = prev.get(k);
    steps.unshift({ ...s, fromNode: s.from.split("#")[0] });
  }

  const lineById = Object.fromEntries(net.lines.map((l) => [l.id, l]));
  const wayById = Object.fromEntries(net.ways.map((w) => [w.id, w]));
  const legs = [];
  for (const s of steps) {
    const e = s.edge;
    const groupKey = e.mode === "walk" ? `walk:${e.wayId || ""}` : `${e.mode}:${e.trip || e.lineId}`;
    const last = legs[legs.length - 1];
    if (last && last.groupKey === groupKey && s.wait === 0) {
      last.km += e.km; last.moveMin += e.min; last.to = e.to; last.approx = last.approx || e.approx;
      last.coords.push(...e.coords.slice(1)); last.via.push(e.to);
    } else {
      legs.push({ groupKey, mode: e.mode, lineId: e.lineId || null, wayId: e.wayId || null,
        from: s.fromNode, to: e.to, km: e.km, moveMin: e.min, waitMin: s.wait, boardAt: s.boardAt, timetabled: !!e.trip, firstRun: s.firstRun,
        approx: !!e.approx, coords: [...e.coords], via: [s.fromNode, e.to] });
    }
  }
  // 名前のない短い徒歩区間が連続した場合もまとめる
  const merged = [];
  for (const l of legs) {
    const last = merged[merged.length - 1];
    if (last && last.mode === "walk" && l.mode === "walk" && !last.wayId && !l.wayId) {
      last.km += l.km; last.moveMin += l.moveMin; last.to = l.to; last.coords.push(...l.coords.slice(1)); last.via.push(...l.via.slice(1));
    } else merged.push(l);
  }

  const name = (id) => all[id].name;
  // 出発地点と同じ場所の駅に入るだけ、のようなごく短い徒歩区間は表示しない（所要時間は合計に残る）
  const shown = merged.filter((l) => !(l.mode === "walk" && l.km < 0.05));
  const out = shown.map((l) => {
    const line = l.lineId ? lineById[l.lineId] : null;
    const way = l.wayId ? wayById[l.wayId] : null;
    const facts = new Set([...(line?.facts || []), ...(way?.facts || [])]);
    for (const id of l.via) for (const f of all[id]?.facts || []) facts.add(f);
    return {
      mode: l.mode, lineId: l.lineId, fromId: l.from, toId: l.to,
      label: line ? line.name : way ? way.name : "徒歩（市街路・推定）",
      from: name(l.from), to: name(l.to),
      viaNames: l.via.slice(1, -1).map(name).filter((n) => n && !n.startsWith("__")),
      viaIds: l.via.filter((id) => !id.startsWith("__")), // 区間が通る地点（両端を含む）。沿線の見どころに使う
      km: round1(l.km), moveMin: Math.round(l.moveMin), waitMin: Math.round(l.waitMin),
      approx: l.approx, opened: line?.opened ?? null,
      // 時刻表のある路線と、始発を待って乗る場合だけ発車時刻を出す（平均待ち時間で乗る場合は時刻に意味がない）
      departAt: l.timetabled || l.firstRun ? formatClock(departMin + l.boardAt) : null,
      firstRun: !!l.firstRun,
      coords: l.coords, facts: [...facts],
    };
  });
  const totalMin = Math.round(goal.cost);
  const fare = computeFares(net, out);
  return { totalMin, totalKm: round1(out.reduce((s, l) => s + l.km, 0)), departMin, legs: out, fare, params: p };
}

// 運賃（net.fares があるネットワークだけ）。金額は [上等, 中等, 下等] の銭。
// 同じ会社の汽車を続けて乗り継ぐときは、最初に乗った駅から最後に降りた駅までの通し運賃にする（各区間の leg.fare に入れ、続きの区間は through=true）。
// 鉄道馬車は1回乗るごとの最低額（atLeast=true）。表にない区間は unknown=true
export function computeFares(net, legs) {
  const F = net.fares;
  if (!F) return null;
  const add = (a, b) => a.map((v, i) => v + b[i]);
  const companyOf = (lineId) => Object.keys(F.companies).find((cid) => F.companies[cid].lines.includes(lineId));
  const pairOf = (cid, a, b) => F.companies[cid].pairs[`${a}|${b}`] || F.companies[cid].pairs[`${b}|${a}`] || null;
  const seg = (a, b) => (a === b ? [0, 0, 0] : Object.keys(F.companies).map((cid) => pairOf(cid, a, b)).find(Boolean) || null);
  // 表にない組（例：品川線の新橋–渋谷）は through.at の駅で分けて、両側の運賃を足す
  const fareOf = (cid, a, b) => {
    const direct = pairOf(cid, a, b);
    if (direct) return direct;
    const t = F.companies[cid].through;
    const x = t && seg(a, t.at), y = t && seg(t.at, b);
    return x && y ? add(x, y) : null;
  };
  let total = [0, 0, 0], atLeast = false, unknown = false, journey = null;
  legs.forEach((l, i) => {
    if (l.mode === "walk") { journey = null; return; }
    if (l.mode === "horsecar" && F.horsecar?.lines.includes(l.lineId)) {
      l.fare = { sen: [...F.horsecar.perRide], atLeast: !!F.horsecar.atLeast };
      total = add(total, l.fare.sen); atLeast ||= !!F.horsecar.atLeast; journey = null;
      return;
    }
    const cid = companyOf(l.lineId);
    if (!cid) { l.fare = { unknown: true }; unknown = true; journey = null; return; }
    if (journey && journey.cid === cid && legs[i - 1] === journey.last && journey.last.toId === l.fromId) {
      // 乗り継ぎ：通し運賃に置き換える
      const sen = fareOf(cid, journey.from, l.toId);
      if (journey.first.fare.sen) total = total.map((v, k) => v - journey.first.fare.sen[k]);
      journey.first.fare = sen ? { sen } : { unknown: true };
      if (sen) total = add(total, sen); else unknown = true;
      l.fare = { through: true };
      journey.last = l;
      return;
    }
    const sen = fareOf(cid, l.fromId, l.toId);
    l.fare = sen ? { sen } : { unknown: true };
    if (sen) total = add(total, sen); else unknown = true;
    journey = { cid, from: l.fromId, first: l, last: l };
  });
  return { sen: total, atLeast, unknown, classes: F.classes };
}

function round1(x) { return Math.round(x * 10) / 10; }

export function formatMin(min) {
  if (min < 60) return `${min}分`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}時間${m}分` : `${h}時間`;
}
