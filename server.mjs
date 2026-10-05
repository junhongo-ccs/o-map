// 手元で確かめるための静的ファイル配信（npm start）。公開は GitHub Pages で、サーバーは使わない。
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, "public");
const PORT = Number(process.env.PORT || 8787);

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg" };

const send = (res, status, body, type) => {
  res.writeHead(status, { "content-type": type });
  res.end(body);
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
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
}).listen(PORT, () => console.log(`今昔往来便覧: http://localhost:${PORT}`));
