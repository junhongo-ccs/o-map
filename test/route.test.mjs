import assert from "node:assert/strict";
import fs from "node:fs";
import { route, parseClock, formatClock, haversineKm } from "../public/router.js";
import { validate, sanitizeInput, kanjiToNumber } from "../ai-guard.mjs";
import { buildPlaces, searchPlaces, MAX_KM } from "../public/places.js";

const load = (f) => JSON.parse(fs.readFileSync(new URL(`../public/data/${f}`, import.meta.url), "utf8"));
const OLD = load("network-1885.json"), NOW = load("network-now.json"), FACTS = load("facts.json");

const P = {
  shibuya: { name: "渋谷", lat: 35.6590, lon: 139.7020 },
  asakusa: { name: "浅草", lat: 35.7108, lon: 139.7963 },
  shinjuku: { name: "新宿", lat: 35.6905, lon: 139.7005 },
  nihonbashi: { name: "日本橋", lat: 35.6841, lon: 139.7744 },
};

let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`ok - ${name}`); };

test("ネットワーク内の参照（地点・事実カード）がすべて存在する", () => {
  for (const net of [OLD, NOW]) {
    for (const w of net.ways) for (const id of w.nodes) assert.ok(net.nodes[id], `${w.id}: ${id}`);
    for (const l of net.lines) for (const id of l.stations) assert.ok(net.nodes[id], `${l.id}: ${id}`);
    for (const x of [...net.ways, ...net.lines, ...Object.values(net.nodes)]) {
      for (const f of x.facts || []) assert.ok(FACTS.facts[f], `fact ${f}`);
    }
  }
});

test("1885年に未開業の路線を含まない", () => {
  for (const l of OLD.lines) assert.ok(l.opened <= 1885, l.id);
});

for (const [o, d] of [["shibuya", "asakusa"], ["shinjuku", "nihonbashi"]]) {
  test(`${o}→${d}: 明治は現在より遅く、徒歩のみ以下`, () => {
    const old = route(OLD, P[o], P[d]);
    const walk = route(OLD, P[o], P[d], {}, { vehicles: false });
    const now = route(NOW, P[o], P[d]);
    assert.ok(now.totalMin < old.totalMin);
    assert.ok(old.totalMin <= walk.totalMin);
    assert.ok(walk.legs.every((l) => l.mode === "walk"));
  });
}

const at = (h, m = 0) => ({ departMin: h * 60 + m });

test("時刻表：各列車は駅順に時刻が進み、駅の数と時刻の数が合う", () => {
  for (const l of OLD.lines.filter((x) => x.timetable)) {
    for (const trip of [...l.timetable.fwd, ...l.timetable.rev]) {
      assert.equal(trip.length, l.stations.length, l.id);
      const t = trip.filter((x) => x != null).map(parseClock);
      assert.ok(t.length >= 2, l.id);
      for (let i = 1; i < t.length; i++) assert.ok(t[i] > t[i - 1], `${l.id}: ${trip}`);
    }
  }
});

test("渋谷→浅草 11時半発：品川線で赤羽へ北上し、上野行きに乗り換える（資料の注記どおりの乗り換え）", () => {
  const r = route(OLD, P.shibuya, P.asakusa, {}, at(11, 30));
  const rides = r.legs.filter((l) => l.mode === "rail");
  assert.deepEqual(rides.map((l) => [l.label, l.from, l.to, l.departAt]), [
    ["日本鉄道 品川線（新橋–赤羽 直通）", "渋谷停車場", "赤羽停車場", "12:13"],
    ["日本鉄道（上野–赤羽）", "赤羽停車場", "上野停車場", "13:04"],
  ]);
});

test("新宿→日本橋 9時発：汽車を待つより歩く方が早い", () => {
  const r = route(OLD, P.shinjuku, P.nihonbashi, {}, at(9));
  assert.ok(r.legs.every((l) => l.mode === "walk"));
});

test("品川線は新橋まで直通し、品川で乗り換えない", () => {
  const r = route(OLD, P.shinjuku, { name: "新橋", lat: 35.6655, lon: 139.7596 }, {}, at(17));
  const rides = r.legs.filter((l) => l.mode === "rail");
  assert.equal(rides.length, 1);
  assert.equal(rides[0].to, "新橋停車場");
});

test("時刻表の待ち時間：同じ列車に乗るなら、出発が遅いほど待ちが短く、合計は同じ", () => {
  const akabane = { name: "赤羽", lat: 35.7777, lon: 139.7209 };
  const ride = (r) => r.legs.find((l) => l.mode === "rail");
  const a = route(OLD, P.shinjuku, akabane, {}, at(7, 30)), b = route(OLD, P.shinjuku, akabane, {}, at(8, 0));
  assert.equal(ride(a).departAt, "8:28");
  assert.equal(ride(a).departAt, ride(b).departAt);
  assert.equal(ride(a).waitMin - ride(b).waitMin, 30);
  assert.equal(a.totalMin - b.totalMin, 30);
});

test("その日の最終列車の後は、品川線を使わない", () => {
  const akabane = { name: "赤羽", lat: 35.7777, lon: 139.7209 };
  const uses = (r) => r.legs.some((l) => l.label.startsWith("日本鉄道 品川線"));
  assert.ok(uses(route(OLD, P.shinjuku, akabane, {}, at(20))));   // 新宿発 20:43 が最終
  assert.ok(!uses(route(OLD, P.shinjuku, akabane, {}, at(21))));
});

test("品川線の所要時間は資料の75分（新橋→赤羽）", () => {
  const r = route(OLD, { name: "新橋", lat: 35.6658, lon: 139.7614 }, { name: "赤羽", lat: 35.7781, lon: 139.7208 }, {}, at(7, 40));
  const ride = r.legs.find((l) => l.mode === "rail");
  assert.equal(ride.departAt, "7:45");
  assert.equal(ride.moveMin, 75);
});

test("上野発8:45の急行は王子に停まらず、赤羽まで21分", () => {
  const ueno = { name: "上野", lat: 35.7134, lon: 139.7765 }, akabane = { name: "赤羽", lat: 35.7781, lon: 139.7208 };
  const ride = route(OLD, ueno, akabane, {}, at(8, 40)).legs.find((l) => l.mode === "rail");
  assert.deepEqual([ride.departAt, ride.moveMin, ride.viaNames.length], ["8:45", 21, 0]);
  // 王子から 8:50 に乗ろうとしても急行には乗れない（次は 12:55 発）
  const oji = { name: "王子", lat: 35.7536, lon: 139.7380 };
  const r = route(OLD, oji, akabane, {}, at(8, 50));
  assert.ok(!r.legs.some((l) => l.departAt && l.departAt.startsWith("9:")));
});

test("AI出力チェック：入力にない数値を検出する", () => {
  const input = { route: { totalLabel: "1時間49分" }, facts: [{ id: "horsecar", body: "1882年" }] };
  assert.deepEqual(validate({ sections: [{ text: "1882年開業。約1時間49分です。", factIds: ["horsecar"] }] }, input), []);
  assert.deepEqual(validate({ sections: [{ text: "約2時間かかります。", factIds: [] }] }, input), ["2"]);
  const out = { sections: [{ text: "", factIds: ["horsecar", "made_up"] }] };
  validate(out, input);
  assert.deepEqual(out.sections[0].factIds, ["horsecar"]);
});

test("出発地と目的地が同じ地点でも経路が返る", () => {
  const r = route(OLD, P.shibuya, P.shibuya);
  assert.equal(r.totalMin, 0);
  assert.deepEqual(r.legs, []);
});

test("AI出力チェック：全角数字・桁区切りも検出する", () => {
  const input = { route: { totalLabel: "1時間49分", km: 1200 }, facts: [] };
  assert.deepEqual(validate({ sections: [{ text: "約１時間４９分です。", factIds: [] }] }, input), []);
  assert.deepEqual(validate({ sections: [{ text: "約２時間かかります。", factIds: [] }] }, input), ["2"]);
  assert.deepEqual(validate({ sections: [{ text: "1,200kmです。", factIds: [] }] }, input), []);
});

test("AI出力チェック：助数詞つきの漢数字を検出する", () => {
  assert.equal(kanjiToNumber("十八"), 18);
  assert.equal(kanjiToNumber("一八八五"), 1885);
  assert.equal(kanjiToNumber("三千五百"), 3500);
  assert.equal(kanjiToNumber("二万"), 20000);
  const input = { route: { from: "八丁堀", year: 1885, label: "明治18年" }, facts: [] };
  const v = (text) => validate({ sections: [{ text, factIds: [] }] }, input);
  assert.deepEqual(v("明治十八年の東京です。"), []);
  assert.deepEqual(v("当時は一日十里を歩きました。"), ["1", "10"]);
  assert.deepEqual(v("八丁堀から歩きます。時間は十分にあります。一般的な経路です。"), []);
  assert.deepEqual(v("三十分かかります。"), ["30"]);
});

test("AI入力の事実カードはサーバー側のデータから引き直す", () => {
  const out = sanitizeInput({ route: {}, facts: [{ id: "rail_1872", body: "捏造された本文" }, { id: "made_up" }, "shinagawa_line"] }, FACTS.facts);
  assert.deepEqual(out.facts.map((f) => f.id), ["rail_1872", "shinagawa_line"]);
  assert.equal(out.facts[0].body, FACTS.facts.rail_1872.body);
  for (const bad of [null, [], {}, { route: {} }, { route: {}, facts: "x" }]) {
    assert.throws(() => sanitizeInput(bad, FACTS.facts), (e) => e.status === 400);
  }
  assert.deepEqual(sanitizeInput({ route: {}, facts: [{ id: "__proto__" }, { id: "toString" }] }, FACTS.facts).facts, []);
});

test("運行時間：鉄道馬車は始発前なら始発まで待ち、終発後は乗れない。現在の電車も同じ", () => {
  const ueno = { name: "上野", lat: 35.7134, lon: 139.7765 }, shimbashi = { name: "新橋", lat: 35.6662, lon: 139.7583 };
  const horse = (r) => r.legs.find((l) => l.mode === "horsecar");
  // 日中は平均待ち時間で乗る（発車時刻は出さない）
  const noon = horse(route(OLD, ueno, shimbashi, {}, at(12)));
  assert.equal(noon.waitMin, OLD.params.horsecarWaitMin.value);
  assert.equal(noon.departAt, null);
  // 始発の直前に着けば、始発を待って乗る
  const first = OLD.params.horsecarFirstMin.value;
  const early = horse(route(OLD, ueno, shimbashi, {}, { departMin: first - 20 }));
  assert.ok(early.firstRun);
  assert.equal(early.departAt, formatClock(first));
  // 終発後は乗れない
  const late = route(OLD, ueno, shimbashi, {}, { departMin: OLD.params.horsecarLastMin.value + 1 });
  assert.ok(late.legs.every((l) => l.mode !== "horsecar"));
  // 現在：始発前の電車は始発の時刻に発車する
  const now = route(NOW, ueno, shimbashi, {}, { departMin: NOW.params.railFirstMin.value - 10 });
  const ride = now.legs.find((l) => l.mode === "rail");
  assert.ok(ride.firstRun);
  assert.equal(ride.departAt, formatClock(NOW.params.railFirstMin.value));
});

test("運賃表：日本鉄道9駅の全組がそろい、上等≧中等≧下等。赤羽をまたぐ運賃は赤羽までと赤羽からの合計", () => {
  const { pairs } = OLD.fares.companies.nippon;
  const st = ["st_ueno", "st_oji", "st_akabane", "st_shinagawa", "st_meguro", "st_shibuya", "st_shinjuku", "st_mejiro", "st_itabashi"];
  const get = (a, b) => pairs[`${a}|${b}`] || pairs[`${b}|${a}`];
  for (let i = 0; i < st.length; i++) for (let j = i + 1; j < st.length; j++) {
    const f = get(st[i], st[j]);
    assert.ok(f, `${st[i]}|${st[j]}`);
    assert.ok(f[0] >= f[1] && f[1] >= f[2] && f[2] > 0, `${st[i]}|${st[j]}: ${f}`);
  }
  for (const a of ["st_ueno", "st_oji"]) for (const b of st.slice(3)) {
    assert.deepEqual(get(a, b), get(a, "st_akabane").map((v, k) => v + get("st_akabane", b)[k]), `${a}|${b}`);
  }
});

test("運賃：日本鉄道の乗り継ぎは通し運賃、品川線の新橋発は官設鉄道の新橋–品川を足す、鉄道馬車は最低額", () => {
  // 渋谷→浅草 11時半発：品川線（渋谷→赤羽）＋日本鉄道（赤羽→上野）の通し運賃 26銭 ＋ 鉄道馬車 2銭〜（下等）
  const r = route(OLD, P.shibuya, P.asakusa, {}, at(11, 30));
  assert.deepEqual(r.fare.sen, [80 + 3, 52 + 2, 26 + 2]);
  assert.ok(r.fare.atLeast);
  assert.ok(r.legs.some((l) => l.fare?.through));
  // 新橋→渋谷 7:30発：品川線の直通列車。新橋–品川 [25,10,5] ＋ 品川–渋谷 [25,16,8]
  const shimbashi = { name: "新橋", lat: 35.6662, lon: 139.7583 };
  const r2 = route(OLD, shimbashi, P.shibuya, {}, at(7, 30));
  const ride = r2.legs.find((l) => l.mode === "rail");
  assert.equal(ride.fromId, "st_shimbashi");
  assert.deepEqual(r2.fare.sen, [50, 26, 13]);
  assert.ok(!r2.fare.atLeast);
  // 歩くだけなら0円。現在のネットワークには運賃データがない
  assert.deepEqual(route(OLD, P.shibuya, P.asakusa, {}, { vehicles: false }).fare.sen, [0, 0, 0]);
  assert.equal(route(NOW, P.shibuya, P.asakusa).fare, null);
});

test("乗り物を優先：歩いた方が早い時刻でも、駅で待って汽車に乗る経路を返す。乗り物がない時刻は null", () => {
  const shibuyaSt = { name: "渋谷駅", lat: 35.65808, lon: 139.70176 }, shinagawaSt = { name: "品川駅", lat: 35.6287, lon: 139.73913 };
  const fastest = route(OLD, shibuyaSt, shinagawaSt, {}, at(9));
  assert.ok(fastest.legs.every((l) => l.mode === "walk"));
  const ride = route(OLD, shibuyaSt, shinagawaSt, {}, { ...at(9), requireVehicle: true });
  const train = ride.legs.find((l) => l.mode === "rail");
  assert.equal(train.departAt, "10:41"); // 品川線の上り、渋谷10:41発
  assert.ok(ride.totalMin > fastest.totalMin);
  // 夜遅く（汽車も鉄道馬車も終わった後）は、乗り物を使う経路がない
  assert.equal(route(OLD, shibuyaSt, shinagawaSt, {}, { ...at(23, 30), requireVehicle: true }), null);
});

test("汽車・馬車を優先（walkWeight）：新宿→日本橋 11:30発は、2時間歩かず、新宿停車場で待って汽車に乗る", () => {
  const fastest = route(OLD, P.shinjuku, P.nihonbashi, {}, at(11, 30));
  assert.ok(fastest.legs.every((l) => l.mode === "walk")); // 最速は歩くだけ（約2時間）
  const r = route(OLD, P.shinjuku, P.nihonbashi, {}, { ...at(11, 30), walkWeight: 3 });
  const walkMin = r.legs.filter((l) => l.mode === "walk").reduce((s, l) => s + l.moveMin, 0);
  assert.ok(walkMin <= 10, `歩くのは${walkMin}分`);
  const first = r.legs.find((l) => l.mode !== "walk");
  assert.deepEqual([first.mode, first.from, first.departAt], ["rail", "新宿停車場", "12:25"]);
  assert.ok(first.waitMin >= 50); // 駅での待ち時間は所要時間に入る（出発時刻はそのまま）
  assert.ok(r.totalMin > fastest.totalMin);
  // 重みなし（0）なら、最速の経路と同じ
  assert.equal(route(OLD, P.shinjuku, P.nihonbashi, {}, { ...at(11, 30), walkWeight: 0 }).totalMin, fastest.totalMin);
});

test("沿線の見どころ用の地点ID：新宿→日本橋 9時発は、甲州街道で内藤新宿・四谷大木戸を通る順に並ぶ", () => {
  const ids = route(OLD, P.shinjuku, P.nihonbashi, {}, at(9)).legs.flatMap((l) => l.viaIds);
  const i = ids.indexOf("naito_shinjuku"), j = ids.indexOf("yotsuya_okido");
  assert.ok(i >= 0 && j > i, ids.join(","));
  assert.ok(ids.every((id) => OLD.nodes[id]), "出発地・目的地の仮の地点は含まない");
});

test("名所：事実カードのある宿場・名所にはすべて種類（category）と画像がある", () => {
  const CATS = ["宿場", "門", "社寺", "川・橋", "花の名所", "紅葉の名所", "庭園", "街道", "町並み", "水車", "馬場", "茶屋", "料理屋"];
  const IMAGES = load("spot-images.json").images;
  for (const [id, n] of Object.entries(OLD.nodes)) {
    if (!["place", "shuku"].includes(n.kind) || !n.facts?.some((f) => FACTS.facts[f])) continue;
    assert.ok(CATS.includes(n.category), `${id}: ${n.category}`);
    assert.ok(IMAGES[id] && fs.existsSync(new URL(`../public/${IMAGES[id].file}`, import.meta.url)), `${id}: 画像`);
  }
  // 事実カードに添える画像は、事実カードがあり、画像のファイルもある
  for (const [fid, im] of Object.entries(load("spot-images.json").factImages || {})) {
    assert.ok(FACTS.facts[fid], `${fid}: 事実カード`);
    assert.ok(fs.existsSync(new URL(`../public/${im.file}`, import.meta.url)), `${fid}: 画像`);
  }
});

test("地点の候補：漢字・ひらがな・カタカナの途中入力で、現在の駅と明治の地名が出る", () => {
  const places = buildPlaces(NOW, OLD);
  const names = (q) => { const r = searchPlaces(places, q); return [r.now.map((p) => p.name), r.old.map((p) => p.name)]; };
  assert.deepEqual(names("品川"), [["品川駅"], ["品川宿", "品川停車場"]]);
  assert.deepEqual(names("しなが"), names("品川"));
  assert.deepEqual(names("シナガ"), names("品川"));
  assert.deepEqual(names("品川駅"), names("品川"));
  assert.ok(names("しんじゅく")[1].includes("内藤新宿（追分）"));
  assert.ok(names("雷門")[1].includes("浅草（雷門）"));
  assert.deepEqual(names("大井町"), [[], []]);
  // 空の入力では全件を一覧表示する
  assert.equal(names("")[0].length + names("")[1].length, places.length);
  assert.equal(searchPlaces(places, "しんばし").now[0].tag, "山手線・銀座線");
  // すべての候補に読みがある（読みの登録漏れがない）
  for (const p of places) assert.ok(p.keys.some((k) => /^[ぁ-ゟー]+$/.test(k)), p.name);
});

test("地点の候補：明治の地名は現在の6路線の駅から1km以内だけ（遠い地点は現在の経路が実際とずれるため）", () => {
  const places = buildPlaces(NOW, OLD);
  const stations = Object.values(NOW.nodes).filter((n) => n.kind === "station");
  const old = places.filter((p) => p.group === "old");
  for (const p of old) assert.ok(stations.some((s) => haversineKm(p, s) <= MAX_KM), p.name);
  for (const name of ["三軒茶屋", "千住宿", "半蔵門", "浅草橋"]) assert.ok(!old.some((p) => p.name === name), name);
  // 京浜東北線・埼京線を足したので、赤羽・王子・板橋の周辺は選べる
  for (const name of ["赤羽停車場", "王子停車場", "板橋宿", "飛鳥山", "王子稲荷"]) assert.ok(old.some((p) => p.name === name), name);
});

console.log(`\n${n} tests passed`);
