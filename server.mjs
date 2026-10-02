// 静的ファイル配信 + AI解説API（/api/explain）。依存は @anthropic-ai/sdk のみ。
// 認証情報（ANTHROPIC_API_KEY など）が無い場合、/api/explain は 503 を返し、画面側は事実カードからの定型解説に切り替わる。
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { validate, sanitizeInput } from "./ai-guard.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, "public");
const PORT = Number(process.env.PORT || 8787);
const MODEL = "claude-opus-5-5";
const MAX_BODY = 64 * 1024;
// 事実カードの本文はクライアントから受け取らず、サーバー側のファイルから引き直す
const FACTS = JSON.parse(await fs.readFile(path.join(PUBLIC, "data", "facts.json"), "utf8")).facts;

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg" };

let client = null;
try { client = new Anthropic(); } catch (e) { console.warn("[ai] Anthropic クライアントを初期化できません。定型解説のみで動作します:", e.message); }

const SYSTEM = `あなたは「今昔東京往来便覧」の解説担当です。明治18年（1885）の東京と現在の移動経路を比べ、利用者向けに短い解説を書きます。

守ること:
- 使ってよい情報は、入力JSONの route（経路計算の結果）、assumptions（計算の前提）、facts（出典付きの事実カード）だけです。一般知識で補わないでください。
- 数値（年・分・km・金額など）は入力JSONに書かれているものだけを、そのままの表記で使ってください。換算・合算・丸めはしないでください。
- 経路・所要時間は計算結果をそのまま説明し、別の経路や所要時間を推測で示さないでください。
- 所要時間が仮定（status が「仮定」）に依存する場合は、そのことを一言添えてください。
- 事実カードを根拠にした文には、その sections 要素の factIds にカードのidを入れてください。
- 入力から言えないことは書かないでください。各セクションは2〜4文、です・ます調。`;

const SCHEMA = {
  type: "object",
  properties: {
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          heading: { type: "string", enum: ["なぜこの経路か", "当時の交通事情", "沿線の見どころ"] },
          text: { type: "string" },
          factIds: { type: "array", items: { type: "string" } },
        },
        required: ["heading", "text", "factIds"],
        additionalProperties: false,
      },
    },
  },
  required: ["sections"],
  additionalProperties: false,
};

async function explain(input) {
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: "user", content: JSON.stringify(input) }],
  });
  if (response.stop_reason === "refusal") throw Object.assign(new Error("refusal"), { status: 502 });
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const out = JSON.parse(text);
  const bad = validate(out, input);
  if (bad.length) throw Object.assign(new Error(`入力にない数値を含むため破棄: ${bad.join(", ")}`), { status: 422 });
  return { ...out, model: response.model };
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw httpError(413, "リクエストが大きすぎます");
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "リクエストのJSONを読み取れません");
  }
}

const send = (res, status, body, type = "application/json; charset=utf-8") => {
  res.writeHead(status, { "content-type": type });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/explain" && req.method === "POST") {
    if (!client) return send(res, 503, { error: "AIが未設定です（ANTHROPIC_API_KEY 等）" });
    try {
      return send(res, 200, await explain(sanitizeInput(await readBody(req), FACTS)));
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) return send(res, 503, { error: "AIの認証に失敗しました" });
      if (e instanceof Anthropic.RateLimitError) return send(res, 503, { error: "AIの利用上限に達しました" });
      if (e instanceof Anthropic.APIConnectionError) return send(res, 503, { error: "AIに接続できません" });
      if (e instanceof Anthropic.APIError) return send(res, 502, { error: `AIの呼び出しに失敗しました（${e.status}）` });
      if (/authentication method/i.test(e.message)) return send(res, 503, { error: "AIが未設定です（ANTHROPIC_API_KEY 等）" });
      return send(res, e.status || 500, { error: e.message });
    }
  }
  if (url.pathname === "/api/status") return send(res, 200, { ai: !!client });

  let rel;
  try { rel = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname); } catch { return send(res, 400, "bad request", "text/plain"); }
  const file = path.normalize(path.join(PUBLIC, rel));
  // PUBLIC + 区切り文字で比較しないと、隣の「public-xxx」ディレクトリまで読めてしまう
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, "forbidden", "text/plain");
  try {
    send(res, 200, await fs.readFile(file), TYPES[path.extname(file)] || "application/octet-stream");
  } catch {
    send(res, 404, "not found", "text/plain");
  }
}).listen(PORT, () => console.log(`今昔東京往来便覧: http://localhost:${PORT}`));
