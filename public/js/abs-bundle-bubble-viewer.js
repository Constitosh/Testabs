/*
  Totally ABS Bubble Viewer — v5
  ------------------------------------------------------------------
  NEW
    • Account-proxy SPLIT: don’t show proxy as a big holder; expand to leaf holders instead (depth ≤ 2).
    • Deeper Bundle clusters: scan top buyers by balance; funder via native (and optional WETH) funding before first buy.
    • First-20 status MATRIX: compact 5×4 grid with colored dots + tooltips.

  KEPT
    • BigInt math, robust decimals inference, full pagination
    • Multi-LP via Dexscreener, LP balances via tokenbalance (fallback to net)
    • VESTED bubbles (teal) excluded from holders & circulating
    • “Circulating (tracked)” computed from full filtered balances (pre-verify) + reconciliation line (supply − LP − VESTED)
    • Early snipe / insider / TG rings, bundle color groups
    • Top-holder verification via tokenbalance (override on success; no drop on timeout)

  Bubble fills:
    LP      = purple  (#8B5CF6)
    VESTED  = teal    (#14B8A6)

  Ring colors (priority):
    red (snipe) > orange (insider) > cyan (split-from-proxy) > gold (TG) > lilac (LP) > mint (VESTED)
*/

(() => {
  // ===== CONFIG =====
  const API_KEY   = "H13F5VZ64YYK4M21QMPEW78SIKJS85UTWT";
  const BASE      = "https://api.etherscan.io/v2/api"; // ABS-compatible
  const CHAIN_ID  = 2741;
  const EXPLORER  = "https://explorer.mainnet.abs.xyz";

  // Optional WETH token contract(s) on this chain — leave empty if not applicable
  const WETH_CONTRACTS = [
    "0x3439153eb7af838ad19d56e1571fbd09333c2809".toLowerCase(),
    // "0xWETH...".toLowerCase(),
  ];

  const TG_BOT_ADDRESS = "0x1c4ae91dfa56e49fca849ede553759e1f5f04d9f".toLowerCase();

  // Known system/router/aggregator/factory contracts to ignore as holders
  const KNOWN_SYSTEM_ADDRESSES = new Set([
    TG_BOT_ADDRESS,
    "0xcca5047e4c9f9d72f11c199b4ff1960f88a4748d".toLowerCase(), // router-like/system
  ]);

  // Always exclude (never count as holder/circulating)
  const ALWAYS_EXCLUDE_ADDRESSES = new Set([
    // add any hard exclusions, e.g. permanent forwarders
  ]);

  // VESTED addresses — excluded from holders/circulating; shown as teal bubbles
  const VESTED_ADDRESSES_GLOBAL = new Set([
    // global vesting vaults across tokens (if any)
  ]);
  const VESTED_ADDRESSES_BY_TOKEN = {
    // example from earlier discussion
    "0xd5cc17f92b41d57a4b34d4b08587bf55342d4bc1": [
      "0x1d48d1cb9b51dbed2443d7451eae1060ccc27ba8",
    ],
  };

  // Distributor / proxy heuristics
  const PROXY_MIN_DISTINCT_RECIPIENTS = 8;
  const PROXY_END_BALANCE_EPS = 0n;
  const PROXY_OUTFLOW_SHARE_NUM = 90n; // 90%
  const PROXY_OUTFLOW_SHARE_DEN = 100n;

  // Account-proxy SPLIT controls
  const PROXY_SPLIT_CHECK_TOP_N   = 60;   // test top N holders for proxy split
  const PROXY_SPLIT_MIN_PCT       = 1.0;  // only consider holders >= 1% for proxy split
  const PROXY_SPLIT_MAX_DEPTH     = 2;    // BFS depth for leaf expansion
  const PROXY_SPLIT_FANOUT_LIMIT  = 300;  // safety cap per proxy

  // Bundle discovery (deeper)
  const BUNDLE_SCAN_TOP_BUYERS    = 300;  // top buyers by current balance to analyze
  const FUNDING_LOOKBACK_SECS     = 4 * 3600;  // inbound funding window before first buy
  const FUNDING_LOOKAHEAD_SECS    = 60;        // small grace after first buy

  // Verify top N holders via explorer tokenbalance (override if available)
  const VERIFY_TOP_N         = 150;
  const VERIFY_CONCURRENCY   = 3;  // be gentle
  const VERIFY_RETRIES       = 2;  // retry nulls

  // Burns / mints
  const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
  const DEAD_ADDR = "0x000000000000000000000000000000000000dead";
  const burnAddresses = new Set([ZERO_ADDR, DEAD_ADDR]);

  // Render cap
  const RENDER_TOP_N = 500;

  // ===== HELPERS =====
  const toBI = s => BigInt(s);
  function scaleToDecimalStr(unitsBI, decimals) {
    const neg = unitsBI < 0n;
    const u = neg ? -unitsBI : unitsBI;
    const base = 10n ** BigInt(decimals);
    const intPart = u / base;
    const fracPart = u % base;
    if (fracPart === 0n) return (neg ? "-" : "") + intPart.toString();
    let frac = fracPart.toString().padStart(decimals, "0").replace(/0+$/, "");
    return (neg ? "-" : "") + intPart.toString() + "." + frac;
  }
  const toNum = (u, d) => parseFloat(scaleToDecimalStr(u, d));
  function pctUnits(numBI, denBI) {
    if (denBI === 0n) return 0;
    const SCALE = 1_000_000n;
    const q = (numBI * SCALE) / denBI;
    return Number(q) / 10_000;
  }
  function countTrailingZeros10(u) {
    let n = 0;
    while (u !== 0n && (u % 10n === 0n) && n < 18) { u /= 10n; n++; }
    return n;
  }
  function chooseDecimals(txs) {
    const freq = new Map();
    for (const t of txs) {
      const raw = t.tokenDecimal;
      if (raw == null || raw === "") continue;
      const d = parseInt(String(raw), 10);
      if (Number.isFinite(d) && d >= 0 && d <= 18) {
        freq.set(d, (freq.get(d) || 0) + 1);
      }
    }
    if (freq.size) {
      let best = 18, bestCnt = -1;
      for (const [d,cnt] of freq.entries()) {
        if (cnt > bestCnt || (cnt === bestCnt && d > best)) { best = d; bestCnt = cnt; }
      }
      return best;
    }
    const vals = txs.map(t => toBI(t.value)).filter(v => v > 0n)
      .sort((a,b)=> a>b?-1:a<b?1:0).slice(0,500);
    const hist = new Array(19).fill(0);
    for (const v of vals) hist[countTrailingZeros10(v)]++;
    let mode = 18, cnt = -1;
    for (let z=0; z<=18; z++) if (hist[z] > cnt || (hist[z]===cnt && z>mode)) { mode=z; cnt=hist[z]; }
    return mode;
  }

  // ===== API helpers =====
  async function fetchAllTokenTx(contract) {
    const all = [];
    const offset = 10000;
    let page = 1;
    while (true) {
      const url = `${BASE}?chainid=${CHAIN_ID}&module=account&action=tokentx&contractaddress=${contract}&page=${page}&offset=${offset}&sort=asc&apikey=${API_KEY}`;
      const r = await fetch(url);
      const j = await r.json();
      const arr = Array.isArray(j?.result) ? j.result : [];
      if (!arr.length) break;
      all.push(...arr);
      if (arr.length < offset) break;
      page++;
      if (page > 200) break;
    }
    if (!all.length) {
      const url = `${BASE}?chainid=${CHAIN_ID}&module=account&action=tokentx&contractaddress=${contract}&startblock=0&endblock=99999999&sort=asc&apikey=${API_KEY}`;
      const r = await fetch(url);
      const j = await r.json();
      const arr = Array.isArray(j?.result) ? j.result : [];
      all.push(...arr);
    }
    return all;
  }
  async function fetchAllNativeTx(address, untilTs) {
    const all = [];
    const offset = 10000;
    let page = 1;
    while (true) {
      const url = `${BASE}?chainid=${CHAIN_ID}&module=account&action=txlist&address=${address}&page=${page}&offset=${offset}&sort=asc&apikey=${API_KEY}`;
      const r = await fetch(url);
      const j = await r.json();
      const arr = Array.isArray(j?.result) ? j.result : [];
      if (!arr.length) break;
      all.push(...arr);
      if (arr.length < offset) break;
      page++;
      if (page > 200) break;
    }
    return untilTs ? all.filter(t => Number(t.timeStamp) <= untilTs) : all;
  }
  async function tokenBalanceOf(contract, holder) {
    try {
      const u = `${BASE}?chainid=${CHAIN_ID}&module=account&action=tokenbalance&address=${holder}&contractaddress=${contract}&tag=latest&apikey=${API_KEY}`;
      const r = await fetch(u);
      const j = await r.json();
      const raw = j?.result;
      if (raw != null && /^[0-9]+$/.test(String(raw))) return BigInt(raw);
    } catch {}
    return null;
  }
  async function getSourceCode(addr) {
    try {
      const u = `${BASE}?chainid=${CHAIN_ID}&module=contract&action=getsourcecode&address=${addr}&apikey=${API_KEY}`;
      const r = await fetch(u);
      const j = await r.json();
      if (Array.isArray(j?.result) && j.result[0]) return j.result[0];
    } catch {}
    return null;
  }

  // ===== classifiers =====
  function looksLikePairABI(abiText) {
    if (!abiText) return false;
    return /\btoken0\b/.test(abiText) && /\btoken1\b/.test(abiText) && /\bgetReserves\b/.test(abiText);
  }
  function looksLikeProxyABI(abiText) {
    if (!abiText) return false;
    // delegatecall/upgrades/EIP-1967 footprints
    return /\bdelegatecall\b/i.test(abiText) ||
           /\bimplementation\b/i.test(abiText) ||
           /\bupgradeTo\b/i.test(abiText) ||
           /\badmin\b/i.test(abiText) ||
           /\bproxy\b/i.test(abiText);
  }
  function behaviorLooksLikeProxy({recipients, endBal, inflow, outflow}) {
    const flow = inflow + outflow;
    const outShareOK = flow === 0n ? false : (outflow * PROXY_OUTFLOW_SHARE_DEN) >= (PROXY_OUTFLOW_SHARE_NUM * flow);
    return recipients >= PROXY_MIN_DISTINCT_RECIPIENTS &&
           endBal === PROXY_END_BALANCE_EPS &&
           outShareOK;
  }

  // ===== verify top balances (override if possible, no-drop on null) =====
  async function verifyTopBalances(contract, addresses) {
    const out = {};
    let idx = 0;
    async function worker() {
      while (idx < addresses.length) {
        const i = idx++;
        const addr = addresses[i];
        let v = null;
        for (let attempt=0; attempt<=VERIFY_RETRIES; attempt++) {
          v = await tokenBalanceOf(contract, addr);
          if (v !== null) break;
          await new Promise(res => setTimeout(res, 250 * (attempt+1)));
        }
        out[addr] = v; // BigInt or null
      }
    }
    const workers = Array.from({length:VERIFY_CONCURRENCY}, worker);
    await Promise.all(workers);
    return out;
  }

  // ===== proxy split discovery =====
  function collectTokenRecipientsFrom(txs, proxyAddr) {
    const set = new Set();
    for (const t of txs) {
      const from = (t.from || t.fromAddress).toLowerCase();
      const to   = (t.to   || t.toAddress).toLowerCase();
      if (from === proxyAddr) set.add(to);
    }
    return Array.from(set);
  }
  async function isLikelyAccountProxy(addr, flowStats) {
    if (KNOWN_SYSTEM_ADDRESSES.has(addr) || ALWAYS_EXCLUDE_ADDRESSES.has(addr)) return true;
    try {
      const src = await getSourceCode(addr);
      if (src && src.Proxy === "1") return true;
      const abi = (src?.ABI || src?.abi || "");
      if (looksLikeProxyABI(abi)) return true;
    } catch {}
    if (flowStats) {
      if (behaviorLooksLikeProxy(flowStats)) return true;
    }
    return false;
  }
  function bfsExpandLeafHolders({txs, startAddr, balances, isExcluded, depthLimit, fanoutLimit}) {
    const queue = [{addr:startAddr, depth:0}];
    const seen = new Set([startAddr]);
    const leaves = new Set();
    let fan = 0;

    while (queue.length) {
      const {addr, depth} = queue.shift();
      // take immediate recipients of 'addr' (token transfers)
      const outs = [];
      for (const t of txs) {
        const f = (t.from || t.fromAddress).toLowerCase();
        const to = (t.to || t.toAddress).toLowerCase();
        if (f === addr) outs.push(to);
      }
      for (const to of outs) {
        if (seen.has(to)) continue;
        seen.add(to);
        if (isExcluded(to)) continue;

        const bal = balances[to] || 0n;
        const isLeaf = (bal > 0n);
        if (isLeaf) {
          leaves.add(to);
        }

        if (depth + 1 < depthLimit) {
          queue.push({addr:to, depth:depth+1});
        }

        fan++;
        if (fan >= fanoutLimit) break;
      }
      if (fan >= fanoutLimit) break;
    }
    return Array.from(leaves);
  }

  // ===== MAIN =====
  window.showTokenHolders = async function showTokenHolders() {
    const elAddr = document.getElementById('tokenAddr');
    const elInfo = document.getElementById('pair-info');
    const elMap  = document.getElementById('bubble-map');

    if (!elAddr || !elInfo || !elMap) {
      alert('Missing required elements (#tokenAddr, #pair-info, #bubble-map).');
      return;
    }
    const contract = elAddr.value.trim().toLowerCase();
    if (!/^0x[a-fA-F0-9]{40}$/.test(contract)) {
      alert("Invalid contract address.");
      return;
    }

    elInfo.innerHTML = '';
    elMap.innerHTML = '<p>Loading data...</p>';

    // Dexscreener pairs (ALL)
    let pairAddresses = [];
    try {
      const r = await fetch(`https://api.dexscreener.com/token-pairs/v1/abstract/${contract}`);
      const d = await r.json();
      if (Array.isArray(d)) {
        for (const p of d) {
          let pa = (p?.pairAddress || "").toLowerCase();
          if (!pa) continue;
          if (pa.includes(":")) pa = pa.split(":")[0];
          if (/^0x[a-f0-9]{40}$/.test(pa)) pairAddresses.push(pa);
        }
      }
    } catch(e){ console.warn('DexScreener fetch error:', e); }
    pairAddresses = Array.from(new Set(pairAddresses));
    const pairSet = new Set(pairAddresses);

    // VESTED set for this token
    const vestedSet = new Set([
      ...VESTED_ADDRESSES_GLOBAL,
      ...(VESTED_ADDRESSES_BY_TOKEN[contract]?.map(a => a.toLowerCase()) || []),
    ]);

    try {
      // All token transfers
      const txs = await fetchAllTokenTx(contract);
      if (!txs.length) throw new Error('No transactions found.');
      const tokenDecimals = chooseDecimals(txs);

      // Creator
      let creatorAddress = '';
      try {
        const cUrl = `${BASE}?chainid=${CHAIN_ID}&module=contract&action=getcontractcreation&contractaddresses=${contract}&apikey=${API_KEY}`;
        const cRes = await fetch(cUrl);
        const cData = await cRes.json();
        creatorAddress = (Array.isArray(cData?.result) && cData.result[0]?.contractCreator)
          ? cData.result[0].contractCreator.toLowerCase() : '';
      } catch {}

      // Balances & flows
      const balances = {};
      const inflow = {};
      const outflow = {};
      const sendRecipients = {};
      const tgRecipients = new Set();

      let mintedUnits = 0n, burnedUnits = 0n, firstLiquidityTs = null;

      for (const tx of txs) {
        const from = (tx.from || tx.fromAddress).toLowerCase();
        const to   = (tx.to || tx.toAddress).toLowerCase();
        const units = toBI(tx.value);

        if (from === TG_BOT_ADDRESS) tgRecipients.add(to);

        if (!sendRecipients[from]) sendRecipients[from] = new Set();
        sendRecipients[from].add(to);
        inflow[to]    = (inflow[to]    || 0n) + units;
        outflow[from] = (outflow[from] || 0n) + units;

        if (from === ZERO_ADDR) mintedUnits += units;
        if (burnAddresses.has(to)) burnedUnits += units;

        if (firstLiquidityTs == null && pairSet.has(to)) {
          firstLiquidityTs = Number(tx.timeStamp);
        }

        if (from === contract || to === contract) continue;
        if (!burnAddresses.has(from)) balances[from] = (balances[from] || 0n) - units;
        if (!burnAddresses.has(to))   balances[to]   = (balances[to]   || 0n) + units;
      }

      // Base exclusions
      const excluded = new Set([
        ...KNOWN_SYSTEM_ADDRESSES,
        ...ALWAYS_EXCLUDE_ADDRESSES,
        ...vestedSet,
      ]);

      // Auto distributor/proxy detection (flow-based)
      for (const addr of Object.keys(sendRecipients)) {
        const recipients = sendRecipients[addr]?.size || 0;
        const endBal = balances[addr] || 0n;
        const out = outflow[addr] || 0n;
        const inn = inflow[addr] || 0n;
        const flow = out + inn;
        const outShareOK = flow === 0n ? false : (out * PROXY_OUTFLOW_SHARE_DEN) >= (PROXY_OUTFLOW_SHARE_NUM * flow);
        if (recipients >= PROXY_MIN_DISTINCT_RECIPIENTS &&
            endBal === PROXY_END_BALANCE_EPS &&
            outShareOK) {
          excluded.add(addr);
        }
      }

      // Supply
      const minted = mintedUnits;
      const burned = burnedUnits;
      const currentSupply = minted >= burned ? (minted - burned) : 0n;

      // LP balances
      const lpPerPair = [];
      let lpUnitsSum = 0n;
      for (const pa of pairSet) {
        let units = await tokenBalanceOf(contract, pa);
        if (units == null) {
          units = balances[pa] || 0n;
          if (units < 0n) units = 0n;
        }
        lpPerPair.push({ address: pa, units });
        lpUnitsSum += units;
      }
      const lpPct = currentSupply > 0n ? pctUnits(lpUnitsSum, currentSupply) : 0;

      // VESTED balances
      const vestedPerAddr = [];
      let vestedUnitsSum = 0n;
      for (const va of vestedSet) {
        let units = await tokenBalanceOf(contract, va);
        if (units == null) {
          units = balances[va] || 0n;
          if (units < 0n) units = 0n;
        }
        vestedPerAddr.push({ address: va, units });
        vestedUnitsSum += units;
      }
      const vestedPct = currentSupply > 0n ? pctUnits(vestedUnitsSum, currentSupply) : 0;

      // === Account-proxy SPLIT discovery on top holders ===
      // Build quick flowStats per address for classifier
      const flowStats = {};
      for (const addr of Object.keys(sendRecipients)) {
        flowStats[addr] = {
          recipients: sendRecipients[addr]?.size || 0,
          endBal: balances[addr] || 0n,
          inflow: inflow[addr] || 0n,
          outflow: outflow[addr] || 0n,
        };
      }
      const isExcluded = (a)=> excluded.has(a) || pairSet.has(a) || burnAddresses.has(a) || a === contract;

      // Initial holder candidates (before proxy split)
      let holderEntries = Object.entries(balances)
        .filter(([addr, bal]) =>
          bal > 0n &&
          !isExcluded(addr)
        )
        .map(([address, units]) => ({ address, units }));

      // rank by size (% of supply) to decide which to attempt splitting
      holderEntries.sort((a,b)=> (b.units > a.units) ? 1 : (b.units < a.units) ? -1 : 0);
      const splitTargets = holderEntries.slice(0, PROXY_SPLIT_CHECK_TOP_N);

      // set to capture recipients “via proxy”
      const viaProxyOf = {}; // recipient -> proxyAddr

      // For top holders over threshold, check if they are account-proxies and expand leaves
      for (const h of splitTargets) {
        const pct = currentSupply > 0n ? pctUnits(h.units, currentSupply) : 0;
        if (pct < PROXY_SPLIT_MIN_PCT) break;

        const addr = h.address;
        const st = flowStats[addr] || {recipients:0, endBal:balances[addr]||0n, inflow:0n, outflow:0n};
        const likelyProxy = await isLikelyAccountProxy(addr, st);

        if (!likelyProxy) continue;

        // Expand to leaf holders (depth-limited BFS)
        const leaves = bfsExpandLeafHolders({
          txs,
          startAddr: addr,
          balances,
          isExcluded,
          depthLimit: PROXY_SPLIT_MAX_DEPTH,
          fanoutLimit: PROXY_SPLIT_FANOUT_LIMIT
        });

        if (leaves.length) {
          // mark recipients
          for (const leaf of leaves) {
            if (!viaProxyOf[leaf]) viaProxyOf[leaf] = addr;
          }
          // exclude the proxy from holders
          excluded.add(addr);
        }
      }

      // Holders (rebuild after proxy exclusions)
      holderEntries = Object.entries(balances)
        .filter(([addr, bal]) =>
          bal > 0n &&
          !isExcluded(addr)
        )
        .map(([address, units]) => ({ address, units }));

      // Circulating (tracked) before verification
      let circulatingTrackedUnits = holderEntries.reduce((s, h) => s + h.units, 0n);
      if (circulatingTrackedUnits > currentSupply) circulatingTrackedUnits = currentSupply;
      const circulatingReconUnits = currentSupply - lpUnitsSum - vestedUnitsSum;
      const circulatingRecon = circulatingReconUnits < 0n ? 0n : circulatingReconUnits;

      // Verify top holders (override only)
      holderEntries.sort((a,b)=> (b.units > a.units) ? 1 : (b.units < a.units) ? -1 : 0);
      const toVerify = holderEntries.slice(0, VERIFY_TOP_N).map(h => h.address);
      const verified = await verifyTopBalances(contract, toVerify);
      const verifiedSet = new Set(toVerify);
      const corrected = [];
      for (const h of holderEntries) {
        if (verifiedSet.has(h.address)) {
          const v = verified[h.address];
          if (v === null) {
            corrected.push(h);
          } else if (v === 0n) {
            continue;
          } else {
            corrected.push({ address: h.address, units: v });
          }
        } else {
          corrected.push(h);
        }
      }
      holderEntries = corrected;

      // Final holders to render
      holderEntries.sort((a,b)=> (b.units > a.units) ? 1 : (b.units < a.units) ? -1 : 0);
      const holders = holderEntries.slice(0, RENDER_TOP_N)
        .map(h => ({ ...h, pct: currentSupply > 0n ? pctUnits(h.units, currentSupply) : 0 }));

      const fullHoldersCount = holderEntries.length;
      const burnPctVsMinted   = minted > 0n ? pctUnits(burned, minted) : 0;

      // Buyers + first-buy time for bundle discovery
      // Build per address first time it received tokens *from any LP*
      const firstBuyTs = {};
      for (const t of txs) {
        const from = (t.from || t.fromAddress).toLowerCase();
        const to   = (t.to   || t.toAddress).toLowerCase();
        if (!pairSet.has(from)) continue; // buy => token leaves LP
        if (pairSet.has(to) || burnAddresses.has(to)) continue;
        const ts = Number(t.timeStamp);
        if (firstBuyTs[to] == null || ts < firstBuyTs[to]) firstBuyTs[to] = ts;
      }

      // First 20 (ordered by time) + status
      const seen = new Set(); const first20 = [];
      for (const t of txs) {
        const from = (t.from || t.fromAddress).toLowerCase();
        const to   = (t.to   || t.toAddress).toLowerCase();
        if (from === ZERO_ADDR) continue;
        if (!seen.has(to)) { seen.add(to); first20.push(t); }
        if (first20.length >= 20) break;
      }
      const tokenTxCount = {};
      for (const t of txs) {
        const f = (t.from || t.fromAddress).toLowerCase();
        const to = (t.to || t.toAddress).toLowerCase();
        tokenTxCount[f] = (tokenTxCount[f] || 0) + 1;
        tokenTxCount[to] = (tokenTxCount[to] || 0) + 1;
      }
      const first20Enriched = [];
      let lt10Count = 0;
      for (const t of first20) {
        const addr = (t.to || t.toAddress).toLowerCase();
        const initialUnits = toBI(t.value);
        const currentUnits = (balances[addr] || 0n);
        const txCount = tokenTxCount[addr] || 0;
        if (txCount < 10) lt10Count++;
        let status = 'hold';
        if (currentUnits === 0n) status = 'soldAll';
        else if (currentUnits > initialUnits) status = 'more';
        else if (currentUnits < initialUnits) status = 'soldPart';
        first20Enriched.push({ address: addr, status, ts: Number(t.timeStamp) });
      }
      first20Enriched.sort((a,b)=> a.ts - b.ts);

      // Deeper bundle clusters — analyze top buyers by current balance
      const buyersByBal = holderEntries
        .filter(h => firstBuyTs[h.address] != null)
        .sort((a,b)=> (b.units > a.units) ? 1 : (b.units < a.units) ? -1 : 0)
        .slice(0, BUNDLE_SCAN_TOP_BUYERS)
        .map(h => h.address);

      // For each buyer: find inbound funder in window (native first; then WETH tokentransfer)
      const funderByBuyer = {};
      const funderCounts  = {};
      for (const buyer of buyersByBal) {
        const t0 = firstBuyTs[buyer];
        if (!t0) continue;

        // Native funding
        const native = await fetchAllNativeTx(buyer, t0 + FUNDING_LOOKAHEAD_SECS);
        let best = null;
        const fromTs = t0 - FUNDING_LOOKBACK_SECS;
        for (const tx of native) {
          const ts = Number(tx.timeStamp);
          if (ts > t0 + FUNDING_LOOKAHEAD_SECS) break;
          if ((tx.to || '').toLowerCase() === buyer && BigInt(tx.value || "0") > 0n) {
            if (ts >= fromTs && ts <= t0 + FUNDING_LOOKAHEAD_SECS) { best = tx; break; }
          }
        }

        // Optional: WETH (if configured)
        if (!best && WETH_CONTRACTS.length) {
          // we already have all token txs for this token, but not for WETH;
          // light heuristic: scan global token txs we fetched and pick ERC-20 transfers for any WETH contract into buyer near t0
          for (const w of WETH_CONTRACTS) {
            for (const t of txs) {
              if ((t.contractAddress || t.contract) && (t.contractAddress || t.contract).toLowerCase() !== w) continue;
              const to = (t.to || t.toAddress).toLowerCase();
              if (to !== buyer) continue;
              const ts = Number(t.timeStamp);
              if (ts >= fromTs && ts <= t0 + FUNDING_LOOKAHEAD_SECS) { best = { from: (t.from || t.fromAddress), timeStamp: t.timeStamp }; break; }
            }
            if (best) break;
          }
        }

        if (best) {
          const f = (best.from || '').toLowerCase();
          funderByBuyer[buyer] = f;
          funderCounts[f] = (funderCounts[f] || 0) + 1;
        }
      }

      // Flags: early/snipe/insider
      const addrFlags = {};
      if (firstLiquidityTs) {
        const launchStart = firstLiquidityTs;
        const launchEnd = launchStart + 180;
        const earlyBuysByAddrUnits = {};
        for (const t of txs) {
          const ts = Number(t.timeStamp);
          if (ts < launchStart || ts > launchEnd) continue;
          const from = (t.from || t.fromAddress).toLowerCase();
          const to   = (t.to   || t.toAddress).toLowerCase();
          if (!pairSet.has(from)) continue;
          if (pairSet.has(to) || burnAddresses.has(to)) continue;
          const units = toBI(t.value);
          earlyBuysByAddrUnits[to] = (earlyBuysByAddrUnits[to] || 0n) + units;
        }
        const ranked = Object.entries(earlyBuysByAddrUnits)
          .map(([addr, units]) => ({ addr, units }))
          .sort((a,b)=> (b.units > a.units) ? 1 : (b.units < a.units) ? -1 : 0);

        const topCut = new Set(ranked.slice(0, 10).map(x => x.addr));
        for (const {addr, units} of ranked) {
          if (!addrFlags[addr]) addrFlags[addr] = {};
          addrFlags[addr].early = true;
          if (currentSupply > 0n) {
            const pr = pctUnits(units, currentSupply);
            if (pr >= 0.20 || topCut.has(addr)) addrFlags[addr].snipe = true;
          }
        }
      }

      // add insider flag for bundle clusters with strong funders
      for (const [buyer, funder] of Object.entries(funderByBuyer)) {
        if (!addrFlags[buyer]) addrFlags[buyer] = {};
        addrFlags[buyer].fundedBy = funder;
      }
      for (const [funder, count] of Object.entries(funderCounts)) {
        if (count >= 3) {
          for (const [buyer, f] of Object.entries(funderByBuyer)) {
            if (f === funder) {
              if (!addrFlags[buyer]) addrFlags[buyer] = {};
              addrFlags[buyer].insider = true;
            }
          }
        }
      }

      // Stats
      const top10Pct = holders.slice(0,10).reduce((s,h)=>s+h.pct,0);
      const creatorPct = creatorAddress
        ? (holders.find(h => h.address.toLowerCase() === creatorAddress)?.pct || 0)
        : 0;

      // Bundle color groups (by funder)
      const addrToBundle = {};
      for (const [buyer, funder] of Object.entries(funderByBuyer)) {
        addrToBundle[buyer] = funder;
      }

      // LP & VESTED render nodes
      const lpNodes = lpPerPair.map((p, i) => ({
        address: p.address,
        balance: toNum(p.units, tokenDecimals),
        pct: currentSupply > 0n ? pctUnits(p.units, currentSupply) : 0,
        __type: 'lp',
        __label: `LP-${i+1}`
      }));
      const vestedNodes = vestedPerAddr.map((v, i) => ({
        address: v.address,
        balance: toNum(v.units, tokenDecimals),
        pct: currentSupply > 0n ? pctUnits(v.units, currentSupply) : 0,
        __type: 'vested',
        __label: vestedPerAddr.length === 1 ? 'VESTED' : `VESTED-${i+1}`
      }));

      // Render
      renderBubbleMap({
        tokenDecimals,
        holders: holders.map(h => ({ address: h.address, balance: toNum(h.units, tokenDecimals), pct: h.pct })),
        extras: [...lpNodes, ...vestedNodes],
        mintedUnits, burnedUnits, currentSupply,
        circulatingTrackedUnits, circulatingRecon,
        addrToBundle, tgRecipients, addrFlags,
        lpPerPair, vestedPerAddr,
        viaProxyOf, // <-- mark recipients “via proxy”
        stats: {
          holdersCount: fullHoldersCount,
          top10Pct, creatorPct, creatorAddress,
          lpUnitsSum, lpPct,
          burnedUnits, burnPctVsMinted,
          vestedUnitsSum, vestedPct,
          first20Enriched, lt10Count
        }
      });

      // Burn banner
      if (burned > 0n) {
        elInfo.innerHTML = `<span style="color:#ff4e4e">🔥 Burn — ${toNum(burned, tokenDecimals).toLocaleString(undefined,{maximumFractionDigits:18})} tokens (${burnPctVsMinted.toFixed(4)}% of minted)</span>`;
      } else {
        elInfo.innerHTML = '';
      }
    } catch (err) {
      console.error(err);
      elMap.innerHTML = '<p>Error loading holders.</p>';
    }
  };

  // ===== RENDERER =====
  function renderBubbleMap({
    tokenDecimals, holders, extras = [],
    mintedUnits, burnedUnits, currentSupply,
    circulatingTrackedUnits, circulatingRecon,
    addrToBundle, tgRecipients, addrFlags,
    lpPerPair, vestedPerAddr, viaProxyOf, stats
  }) {
    const mapEl = document.getElementById('bubble-map');
    mapEl.innerHTML = '';

    const width = mapEl.offsetWidth || 960;
    const height = 640;
    const data = holders.concat(extras);

    const svg = d3.select('#bubble-map').append('svg')
      .attr('width', width)
      .attr('height', height);

    const pack = d3.pack().size([width, height]).padding(3);
    const root = d3.hierarchy({ children: data }).sum(d => d.balance);
    const nodes = pack(root).leaves();

    const distinctBundles = Array.from(new Set(Object.values(addrToBundle)));
    const bundleColor = d3.scaleOrdinal(d3.schemeTableau10).domain(distinctBundles);

    let tip = d3.select('#bubble-tip');
    if (tip.empty()) {
      tip = d3.select('body').append('div').attr('id','bubble-tip')
        .style('position','fixed').style('background','#111').style('color','#fff')
        .style('padding','8px 10px').style('border','1px solid #333').style('border-radius','8px')
        .style('pointer-events','none').style('opacity',0).style('z-index',9999);
    }

    function ringColorFor(addr, type) {
      if (addrFlags[addr]?.snipe)   return '#ff4e4e';  // red
      if (addrFlags[addr]?.insider) return '#ff9f3c';  // orange
      if (viaProxyOf[addr])         return '#22d3ee';  // cyan for “via proxy”
      if (tgRecipients.has(addr))   return '#FFD700';  // gold
      if (type === 'lp')            return '#C4B5FD';  // lilac
      if (type === 'vested')        return '#6EE7B7';  // mint
      return null;
    }
    function fillFor(d) {
      if (d.data.__type === 'lp')     return '#8B5CF6';
      if (d.data.__type === 'vested') return '#14B8A6';
      const bundle = addrToBundle[d.data.address];
      return bundle ? bundleColor(bundle) : '#4b5563';
    }

    const g = svg.selectAll('g')
      .data(nodes)
      .enter()
      .append('g')
      .attr('transform', d => `translate(${d.x},${d.y})`);

    g.append('circle')
      .attr('r', d => d.r)
      .attr('fill', fillFor)
      .attr('stroke', d => ringColorFor(d.data.address, d.data.__type))
      .attr('stroke-width', d => ringColorFor(d.data.address, d.data.__type) ? 2.5 : null)
      .on('mouseover', function (event, d) {
        const addr = d.data.address;
        const bundle = addrToBundle[addr];
        const flags = addrFlags[addr] || {};
        const isTG = tgRecipients.has(addr);
        const isLP = d.data.__type === 'lp';
        const isVested = d.data.__type === 'vested';

        if (!isLP && !isVested) {
          g.selectAll('circle')
            .attr('opacity', node => bundle ? (addrToBundle[node.data.address] === bundle ? 1 : 0.15) : 1)
            .attr('stroke', node => ringColorFor(node.data.address, node.data.__type))
            .attr('stroke-width', node => ringColorFor(node.data.address, node.data.__type) ? 2.5 : null);
        }

        tip.html(
          isLP
            ? `<div><strong>${d.data.__label || 'LP'}</strong> — ${d.data.balance.toLocaleString()} tokens</div>
               <div>${d.data.pct.toFixed(4)}% of current supply</div>
               <div style="opacity:.8;margin-top:6px">Click to open in explorer ↗</div>`
          : isVested
            ? `<div><strong>${d.data.__label || 'VESTED'}</strong> — ${d.data.balance.toLocaleString()} tokens</div>
               <div>${d.data.pct.toFixed(4)}% of current supply</div>
               <div style="opacity:.8;margin-top:6px">Click to open in explorer ↗</div>`
            : `<div><strong>${d.data.pct.toFixed(4)}% of current supply</strong></div>
               <div>${d.data.balance.toLocaleString()} tokens</div>
               <div>${addr.slice(0,6)}...${addr.slice(-4)}</div>
               ${bundle ? `<div style="opacity:.8">Bundle funder: ${bundle.slice(0,6)}...${bundle.slice(-4)}</div>` : ''}
               ${viaProxyOf[addr] ? `<div style="opacity:.8">via proxy: ${viaProxyOf[addr].slice(0,6)}...${viaProxyOf[addr].slice(-4)}</div>` : ''}
               <div style="opacity:.8">Flags: ${[
                    flags.snipe ? 'snipe' : null,
                    flags.insider ? 'insider' : null,
                    isTG ? 'TG' : null
                  ].filter(Boolean).join(', ') || '—'}</div>
               <div style="opacity:.8;margin-top:6px">Click to open in explorer ↗</div>`
        )
        .style('left', (event.clientX + 12) + 'px')
        .style('top', (event.clientY + 12) + 'px')
        .style('opacity', 1);
      })
      .on('mousemove', function (event) {
        tip.style('left', (event.clientX + 12) + 'px').style('top', (event.clientY + 12) + 'px');
      })
      .on('mouseout', function () {
        tip.style('opacity', 0);
        g.selectAll('circle').attr('opacity', 1)
          .attr('stroke', d => ringColorFor(d.data.address, d.data.__type))
          .attr('stroke-width', d => ringColorFor(d.data.address, d.data.__type) ? 2.5 : null);
      })
      .on('click', (event, d) => {
        window.open(`${EXPLORER}/address/${d.data.address}`, '_blank');
      });

    g.append('text')
      .attr('dy', '.35em')
      .style('text-anchor', 'middle')
      .style('font-size', d => Math.min(d.r * 0.5, 16))
      .style('fill', '#fff')
      .style('pointer-events', 'none')
      .text(d => d.data.__type === 'lp'
                  ? (d.data.__label || 'LP')
                  : d.data.__type === 'vested'
                    ? (d.data.__label || 'VESTED')
                    : `${d.data.pct.toFixed(2)}%`);

    // === Stats & First-20 MATRIX ===
    const statsDiv = document.createElement('div');
    statsDiv.style.marginTop = '10px';

    const lpLines = lpPerPair.map((p, i) =>
      `<div>LP-${i+1} (${p.address.slice(0,6)}...${p.address.slice(-4)}): <strong>${(Number(p.units / (10n ** BigInt(tokenDecimals)))).toLocaleString()}</strong> tokens</div>`
    ).join('');
    const vestedLines = vestedPerAddr.map((v, i) =>
      `<div>${vestedPerAddr.length===1 ? 'VESTED' : `VESTED-${i+1}`} (${v.address.slice(0,6)}...${v.address.slice(-4)}): <strong>${(Number(v.units / (10n ** BigInt(tokenDecimals)))).toLocaleString()}</strong> tokens</div>`
    ).join('');

    const legendMatrix = buildFirst20Matrix(stats.first20Enriched);

    statsDiv.innerHTML = `
      <div class="section-title" style="padding-left:0">Stats</div>
      <div>Minted: <strong>${(Number(mintedUnits / (10n ** BigInt(tokenDecimals)))).toLocaleString()}</strong> tokens</div>
      <div>🔥 Burn: <strong>${(Number(burnedUnits / (10n ** BigInt(tokenDecimals)))).toLocaleString()}</strong> tokens
        (<strong>${stats.burnPctVsMinted.toFixed(4)}%</strong> of minted)</div>
      <div>Current supply (minted − burned): <strong>${(Number(currentSupply / (10n ** BigInt(tokenDecimals)))).toLocaleString()}</strong> tokens</div>

      <div>Circulating (tracked)*: <strong>${(Number(circulatingTrackedUnits / (10n ** BigInt(tokenDecimals)))).toLocaleString()}</strong> tokens</div>
      <div style="opacity:.8">Circulating (supply − LP − VESTED): <strong>${(Number(circulatingRecon / (10n ** BigInt(tokenDecimals)))).toLocaleString()}</strong> tokens</div>

      <div>Holders (displayed / total): <strong>${holders.length}</strong> / <strong>${stats.holdersCount}</strong></div>
      <div>Top 10 holders: <strong>${stats.top10Pct.toFixed(4)}%</strong> (of current supply)</div>
      <div>Creator (${stats.creatorAddress ? stats.creatorAddress.slice(0,6)+'...'+stats.creatorAddress.slice(-4) : 'n/a'}) holding:
        <strong>${stats.creatorPct.toFixed(4)}%</strong></div>

      <div style="margin-top:10px"><strong>LP totals</strong> (sum across pools):
        <strong>${(Number(stats.lpUnitsSum / (10n ** BigInt(tokenDecimals)))).toLocaleString()}</strong> tokens
        (<strong>${stats.lpPct.toFixed(4)}%</strong> of current supply)</div>
      ${lpLines}

      <div style="margin-top:10px"><strong>Vested totals</strong>:
        <strong>${(Number(stats.vestedUnitsSum / (10n ** BigInt(tokenDecimals)))).toLocaleString()}</strong> tokens
        (<strong>${stats.vestedPct.toFixed(4)}%</strong> of current supply)</div>
      ${vestedLines}

      <div style="margin-top:12px"><strong>First 20 buyers (status)</strong></div>
      ${legendMatrix}

      <div style="opacity:.8;margin-top:10px">Rings — <span style="color:#ff4e4e">red</span>: snipe • <span style="color:#ff9f3c">orange</span>: insider • <span style="color:#22d3ee">cyan</span>: via proxy • <span style="color:#FFD700">gold</span>: TelegramBot • <span style="color:#C4B5FD">lila</span>: LP • <span style="color:#6EE7B7">mint</span>: VESTED</div>
      <div style="opacity:.6;margin-top:6px;font-size:.9em">*Circulating (tracked) excludes LPs, VESTED wallets, contract, burn sinks, detected distributors/proxies/known system contracts. Proxies are split to leaf holders when identified.</div>
    `;
    mapEl.appendChild(statsDiv);
  }

  function buildFirst20Matrix(list) {
    // 5 x 4 grid, ordered by timestamp
    const colorFor = s =>
      s === 'hold' ? '#00ff9c' :
      s === 'soldPart' ? '#4ea3ff' :
      s === 'soldAll' ? '#ff4e4e' : '#ffd84e'; // 'more'

    const cells = list.map((b, idx) => {
      const clr = colorFor(b.status);
      const short = b.address.slice(0,6)+'...'+b.address.slice(-4);
      return `
        <div class="cell" title="${short} — ${b.status}">
          <span class="dot" style="background:${clr}"></span>
          <span class="idx">${idx+1}</span>
        </div>
      `;
    }).join('');

    return `
      <style>
        #first20-matrix {
          display:grid;
          grid-template-columns: repeat(5, minmax(40px, 1fr));
          grid-auto-rows: 32px;
          gap: 8px;
          max-width: 360px;
          margin-top: 6px;
        }
        #first20-matrix .cell {
          display:flex; align-items:center; justify-content:center;
          border:1px solid #333; border-radius:6px; padding:2px 4px;
          background:#0b0b0b;
          font-size:12px; color:#ddd;
        }
        #first20-matrix .dot {
          width:10px; height:10px; border-radius:50%; display:inline-block; margin-right:6px;
        }
        #first20-matrix .idx { opacity:.85; }
      </style>
      <div id="first20-matrix">${cells}</div>
    `;
  }
})();
