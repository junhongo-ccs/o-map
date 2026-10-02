// 出発地・目的地の候補。現在の駅と明治の地名（ネットワークの地点）から作り、一覧表示と入力途中の絞り込みに使う。
// 住所検索は使わない（「品川」が品川区役所付近になるなど、意図しない地点になるため）。
// 現在側は6路線だけの簡略モデルなので、明治の地名はモデル内の駅から MAX_KM 以内のものに限る（遠い地点は現在の経路が実際とずれる）。
import { haversineKm } from "./router.js";

export const MAX_KM = 1.0;

// 読み（ひらがな）。キーは地名から「（…）」と末尾の「宿」「停車場」を除いたもの
const YOMI = {
  品川: "しながわ", 高輪ゲートウェイ: "たかなわげーとうぇい", 田町: "たまち", 浜松町: "はままつちょう", 新橋: "しんばし",
  有楽町: "ゆうらくちょう", 東京: "とうきょう", 神田: "かんだ", 秋葉原: "あきはばら", 御徒町: "おかちまち", 上野: "うえの",
  鶯谷: "うぐいすだに", 日暮里: "にっぽり", 西日暮里: "にしにっぽり", 田端: "たばた", 駒込: "こまごめ", 巣鴨: "すがも",
  大塚: "おおつか", 池袋: "いけぶくろ", 目白: "めじろ", 高田馬場: "たかだのばば", 新大久保: "しんおおくぼ", 新宿: "しんじゅく",
  代々木: "よよぎ", 原宿: "はらじゅく", 渋谷: "しぶや", 恵比寿: "えびす", 目黒: "めぐろ", 五反田: "ごたんだ", 大崎: "おおさき",
  御茶ノ水: "おちゃのみず", 四ツ谷: "よつや", 表参道: "おもてさんどう", 外苑前: "がいえんまえ", 青山一丁目: "あおやまいっちょうめ",
  赤坂見附: "あかさかみつけ", 溜池山王: "ためいけさんのう", 虎ノ門: "とらのもん", 銀座: "ぎんざ", 京橋: "きょうばし",
  日本橋: "にほんばし", 三越前: "みつこしまえ", 末広町: "すえひろちょう", 上野広小路: "うえのひろこうじ", 稲荷町: "いなりちょう",
  田原町: "たわらまち", 浅草: "あさくさ", 新大塚: "しんおおつか", 茗荷谷: "みょうがだに", 後楽園: "こうらくえん",
  本郷三丁目: "ほんごうさんちょうめ", 淡路町: "あわじちょう", 大手町: "おおてまち", 霞ケ関: "かすみがせき",
  国会議事堂前: "こっかいぎじどうまえ", 四谷三丁目: "よつやさんちょうめ", 新宿御苑前: "しんじゅくぎょえんまえ",
  新宿三丁目: "しんじゅくさんちょうめ", 西新宿: "にししんじゅく", 上中里: "かみなかざと", 東十条: "ひがしじゅうじょう", 十条: "じゅうじょう",
  半蔵門: "はんぞうもん", 四谷見附: "よつやみつけ", 四谷大木戸: "よつやおおきど", 高輪大木戸: "たかなわおおきど",
  須田町: "すだちょう", 本郷: "ほんごう", 本郷追分: "ほんごうおいわけ", 浅草橋: "あさくさばし", 三軒茶屋: "さんげんぢゃや",
  内藤新宿: "ないとうしんじゅく", 板橋: "いたばし", 千住: "せんじゅ", 赤羽: "あかばね", 王子: "おうじ",
  飛鳥山: "あすかやま", 王子稲荷: "おうじいなり", 穏田の水車: "おんでんのすいしゃ", 広尾の古川: "ひろおのふるかわ", 目黒の太鼓橋: "めぐろのたいこばし", 金王八幡宮: "こんのうはちまんぐう", 雑司ヶ谷鬼子母神: "ぞうしがやきしもじん", 面影橋: "おもかげばし", 姿見の橋: "すがたみのはし", 関口の芭蕉庵・椿山: "せきぐちのばしょうあんちんざん", 滝野川: "たきのがわ", 音無川の大滝: "おとなしがわのおおたき", 尾張町: "おわりちょう", 芝口: "しばぐち", 雷門: "かみなりもん", 追分: "おいわけ", 鉄道馬車: "てつどうばしゃ",
};
const SUFFIX_YOMI = { 宿: "しゅく", 停車場: "ていしゃじょう" };
const OLD_KIND = { place: "地名", shuku: "宿場", station: "停車場", stop: "鉄道馬車" };

// カタカナ→ひらがな、空白除去
const norm = (s) => String(s).replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60)).replace(/\s/g, "");

function yomiOf(name) {
  const base = name.replace(/（.*?）/g, "");
  const m = base.match(/^(.*?)(宿|停車場)?$/);
  const head = YOMI[m[1]] ?? YOMI[base] ?? "";
  const tail = YOMI[m[1]] && m[2] ? SUFFIX_YOMI[m[2]] : "";
  const paren = [...name.matchAll(/（(.*?)）/g)].map((x) => YOMI[x[1]] ?? "");
  return [head + tail, ...paren].filter(Boolean);
}

export function buildPlaces(netNow, netOld, maxKm = MAX_KM) {
  const out = [];
  const byName = new Map();
  const nodeLines = {};
  for (const l of netNow.lines) for (const id of l.stations) (nodeLines[id] ??= []).push(l.name.replace(/^(JR|東京メトロ)/, "").replace(/（.*?）/, ""));
  for (const [id, n] of Object.entries(netNow.nodes)) {
    if (n.kind !== "station") continue;
    const p = byName.get(n.name);
    if (p) { p.lines.push(...(nodeLines[id] || []).filter((x) => !p.lines.includes(x))); continue; }
    const q = { group: "now", name: `${n.name}駅`, lines: [...(nodeLines[id] || [])], lat: n.lat, lon: n.lon, keys: [n.name, ...yomiOf(n.name)].map(norm) };
    byName.set(n.name, q);
    out.push(q);
  }
  for (const p of out) p.tag = p.lines.join("・");
  const stations = Object.values(netNow.nodes).filter((n) => n.kind === "station");
  for (const n of Object.values(netOld.nodes)) {
    if (!OLD_KIND[n.kind]) continue;
    if (!stations.some((s) => haversineKm(n, s) <= maxKm)) continue;
    out.push({ group: "old", name: n.name, tag: OLD_KIND[n.kind], lat: n.lat, lon: n.lon,
      keys: [n.name, ...[...n.name.matchAll(/（(.*?)）/g)].map((x) => x[1]), ...yomiOf(n.name)].map(norm) });
  }
  return out;
}

// 空の入力では全件（一覧表示）。入力があれば前方一致を先に、部分一致を後に、各グループ最大 limit 件
export function searchPlaces(places, query, limit = 6) {
  const q = norm(query).replace(/駅$/, "");
  if (!q) return { now: places.filter((p) => p.group === "now"), old: places.filter((p) => p.group === "old") };
  const score = (p) => (p.keys.some((k) => k.startsWith(q)) ? 0 : p.keys.some((k) => k.includes(q)) ? 1 : -1);
  const pick = (g) => places.filter((p) => p.group === g).map((p) => [score(p), p]).filter(([s]) => s >= 0)
    .sort((a, b) => a[0] - b[0]).slice(0, limit).map(([, p]) => p);
  return { now: pick("now"), old: pick("old") };
}
