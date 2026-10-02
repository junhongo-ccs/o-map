// AI出力の機械的チェック。AI要件「根拠不明の所要時間・歴史の推測を出さない」を、入力にない数値の混入として検出する。
// 対象：算用数字（全角を含む）と、助数詞が続く漢数字（例：十里、明治十八年）。
// 「十分（じゅうぶん）」は読みが区別できないため対象外。助数詞の続かない漢数字（例：一般、四谷）も対象外。

const KANJI_DIGIT = { "〇": 0, "零": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };
const KANJI_UNIT = { "十": 10, "百": 100, "千": 1000 };
const KANJI_NUM = /[〇零一二三四五六七八九十百千万]+(?=年|か月|ヶ月|ケ月|月|日|時間|分|秒|里|町|丁|キロ|km|メートル|円|銭|厘|両|人|本|駅|倍|割|回|歳)/g;

// 「十八」→18、「一八八五」→1885、「二万」→20000
export function kanjiToNumber(s) {
  if (!/[十百千万]/.test(s)) return Number([...s].map((c) => KANJI_DIGIT[c]).join(""));
  let total = 0, section = 0, cur = 0;
  for (const c of s) {
    if (c in KANJI_DIGIT) cur = KANJI_DIGIT[c];
    else if (c in KANJI_UNIT) { section += (cur || 1) * KANJI_UNIT[c]; cur = 0; }
    else if (c === "万") { total += (section + cur || 1) * 10000; section = 0; cur = 0; }
  }
  return total + section + cur;
}

export function numbersIn(s) {
  // 全角数字を半角に、桁区切りのカンマを除去してから数える
  const t = s.normalize("NFKC").replace(/(\d),(?=\d{3}(?!\d))/g, "$1");
  return (t.match(/\d+(?:\.\d+)?/g) || []).map((x) => String(Number(x)));
}

function kanjiNumbersIn(s, inputText) {
  return [...s.matchAll(KANJI_NUM)]
    .filter((m) => !(m[0] === "十" && s.startsWith("分", m.index + 1)))
    // 入力にそのまま書かれている語（地名など）はそのまま使ってよい
    .filter((m) => !inputText.includes(s.slice(m.index, m.index + m[0].length + 1)))
    .map((m) => String(kanjiToNumber(m[0])));
}

// out: {sections:[{heading,text,factIds}]}、input: AIに渡したJSON
// 戻り値: 入力に存在しない数値の配列（空なら合格）。factIds は入力にあるidだけに絞り込む
export function validate(out, input) {
  const inputText = JSON.stringify(input);
  const allowed = new Set(numbersIn(inputText));
  const factIds = new Set(input.facts.map((f) => f.id));
  const bad = [];
  for (const s of out.sections) {
    for (const n of [...numbersIn(s.text), ...kanjiNumbersIn(s.text, inputText)]) if (!allowed.has(n)) bad.push(n);
    s.factIds = s.factIds.filter((id) => factIds.has(id));
  }
  return [...new Set(bad)];
}

const MAX_FACTS = 40;

// /api/explain の入力を検査し、事実カードはサーバー側のデータ（facts）から引き直す。
// クライアントが送った本文を信用すると、AIに任意の「事実」を書かせられてしまうため。
export function sanitizeInput(input, facts) {
  const fail = (m) => { throw Object.assign(new Error(m), { status: 400 }); };
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("入力が不正です");
  if (!input.route || typeof input.route !== "object") fail("route がありません");
  if (!Array.isArray(input.facts)) fail("facts がありません");
  const ids = [...new Set(input.facts.map((f) => (typeof f === "string" ? f : f?.id)))]
    .filter((id) => typeof id === "string" && Object.hasOwn(facts, id))
    .slice(0, MAX_FACTS);
  return {
    ...input,
    facts: ids.map((id) => ({ id, title: facts[id].title, body: facts[id].body, status: facts[id].status })),
  };
}
