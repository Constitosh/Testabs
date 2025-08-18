// abs-proxy.js
const express = require("express");
const fetch = require("node-fetch");         // npm i node-fetch
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3002;
const UPSTREAM = "https://api.etherscan.io/v2/api";
const ABS_API_KEY = process.env.ABS_API_KEY;

if (!ABS_API_KEY) {
  console.error("ABS_API_KEY is missing in .env");
  process.exit(1);
}

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

app.get("/api/abs", async (req, res) => {
  try {
    const url = new URL(UPSTREAM);
    for (const [k, v] of Object.entries(req.query || {})) {
      if (String(k).toLowerCase() !== "apikey") url.searchParams.append(k, v);
    }
    url.searchParams.set("apikey", ABS_API_KEY);

    const upstream = await fetch(url.toString(), {
      headers: { "accept": "application/json", "user-agent": "abs-proxy/1.0" },
    });

    res.setHeader("Cache-Control", "public, max-age=0, s-maxage=30, stale-while-revalidate=60");
    res.status(upstream.status).send(await upstream.text());
  } catch (e) {
    console.error(e);
    res.status(502).json({ status: "error", message: "upstream error" });
  }
});

app.listen(PORT, () => {
  console.log(`ABS proxy listening on http://127.0.0.1:${PORT}/api/abs`);
});
