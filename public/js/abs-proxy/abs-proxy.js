// abs-proxy.js
const express = require("express");
const path = require("path");

// Load .env next to this file, regardless of CWD
require("dotenv").config({ path: path.join(__dirname, ".env") });

// Use native fetch on Node 18+, fallback to node-fetch on older Node
let fetchFn = global.fetch;
if (!fetchFn) {
  try { fetchFn = require("node-fetch"); }
  catch {
    console.error("Install node-fetch or upgrade Node to v18+: `npm i node-fetch@2`");
    process.exit(1);
  }
}

const app = express();
const PORT = process.env.PORT || 8787;
const UPSTREAM = "https://api.etherscan.io/v2/api";
const ABS_API_KEY = process.env.ABS_API_KEY;

if (!ABS_API_KEY) {
  console.error("ABS_API_KEY missing in .env"); process.exit(1);
}

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

app.get("/api/abs", async (req, res) => {
  try {
    const url = new URL(UPSTREAM);
    for (const [k, v] of Object.entries(req.query || {})) {
      if (String(k).toLowerCase() !== "apikey") url.searchParams.append(k, v);
    }
    url.searchParams.set("apikey", ABS_API_KEY);

    const r = await fetchFn(url.toString(), {
      headers: { "accept": "application/json", "user-agent": "abs-proxy/1.0" }
    });

    res.setHeader("Cache-Control", "public, max-age=0, s-maxage=30, stale-while-revalidate=60");
    res.status(r.status).send(await r.text());
  } catch (e) {
    console.error(e);
    res.status(502).json({ status: "error", message: "upstream error" });
  }
});

app.listen(PORT, () => {
  console.log(`ABS proxy listening on http://127.0.0.1:${PORT}/api/abs`);
});
