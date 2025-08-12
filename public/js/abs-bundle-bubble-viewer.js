/*
  Totally ABS Bundle Bubble Viewer — multi-LP, robust decimals, precise math, bundle/insider flags
  -----------------------------------------------------------------------------------------------
  - BigInt math for all token units; convert only for UI.
  - Robust decimals:
      1) mode(tokenDecimal) over txs; fallback
      2) infer by trailing-zeros histogram on raw values (0..18); choose modal bin.
  - LP: collect ALL Dexscreener pairs for the token; show each LP as a purple bubble; stats sum across LPs.
  - Percentages:
      • Burn % vs MINTED
      • LP % vs CURRENT (minted − burned)
  - Circulating (tracked): excludes ALL LPs, contract, burn sinks, detected proxies. Clamped ≤ current supply.
  - Bundle/Insider detection:
      • Find first liquidity add: earliest transfer TO any LP address
      • Launch window (default 180s) = early buys (from LP → buyer)
      • Snipe = size ≥ EARLY_SNIPE_MIN_PCT of supply OR in top EARLY_TOP_K by size
      • Insider = funded by creator OR a funder who bankrolled ≥ INSIDER_FUNDER_MIN distinct early buyers
      • Distributor = address with ≥ PROXY_MIN_DISTINCT_RECIPIENTS unique recipients and near-zero end balance
  - Visual rings priority: red (snipe) > orange (insider) > gold (TG recipient) > lilac (LP)
*/

(() => {
  const API_KEY = "H13F5VZ64YYK4M21QMPEW78SIKJS85UTWT";
  const BASE = "https://api.etherscan.io/v2/api"; // ABS-compatible
  const CHAIN_ID = 2741;
  const EXPLORER = "https://explorer.mainnet.abs.xyz";

  // TG bot (recipients only)
  const TG_BOT_ADDRESS = "0x1c4ae91dfa56e49fca849ede553759e1f5f04d9f".toLowerCase();

  // Proxy / distributor detection
  const PROXY_BLOCKLIST = new Set([TG_BOT_ADDRESS]);
  const PROXY_MIN_DISTINCT_RECIPIENTS = 8;
  const PROXY_END_BALANCE_EPS = 0n; // exact zero with BigInt units
  const PROXY_OUTFLOW_SHARE_NUM = 90n; // 90% outflow share
  const PROXY_OUTFLOW_SHARE_DEN = 100n;

  // Bundle & insider heuristics
  const LAUNCH_WINDOW_SECS = 180;         // window after first liquidity add
  const EARLY_SNIPE_MIN_PCT = 0.20;       // ≥ 0.20% of current supply
  const EARLY_TOP_K = 10;                 // or top 10 early buys by size
  const INSIDER_FUNDER_MIN = 3;           // funder bankrolls ≥3 early buyers

  // Burns / mints
  const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
  const DEAD_ADDR = "0x000000000000000000000000000000000000dead";
  const burnAddresses = new Set([ZERO_ADDR, DEAD_ADDR]);

  const RENDER_TOP_N = 500;

  // -------- helpers (BigInt-safe) --------
  function toUnitsBig(s) { return BigInt(s); }

  function countTrailingZeros10(u) {
    // count how many times divisible by 10 (base10), limited to 18
    let n = 0;
    while (u !== 0n && (u % 10n === 0n) && n < 18) { u /= 10n; n++; }
    return n;
  }

  function chooseDecimals(txs) {
    // 1) try mode of tokenDecimal fields
    const freq = new Map();
    for (const t of txs) {
      const dRaw = t.tokenDecimal;
      if (dRaw == null || dRaw === "") continue;
      const d = parseInt(String(dRaw), 10);
      if (Number.isFinite(d) && d >= 0 && d <= 18) {
        freq.set(d, (freq.get(d) || 0) + 1);
      }
    }
    if (freq.size) {
      let best = 18, bestCnt = -1;
      for (const [d, cnt] of freq.entries()) {
        if (cnt > bestCnt || (cnt === bestCnt && d > best)) { best = d; bestCnt = cnt; }
      }
      return best;
    }

    // 2) fallback: trailing-zero histogram on raw values (prefer larger txs)
    const vals = txs
      .map(t => toUnitsBig(t.value))
      .filter(v => v > 0n)
      .sort((a,b) => (a > b ? -1 : a < b ? 1 : 0))
      .slice(0, 500); // sample top values

    const hist = new Array(19).fill(0);
    for (const v of vals) {
      const z = countTrailingZeros10(v);
      hist[z]++;
    }
    let mode = 18, cnt = -1;
    for (let z = 0; z <= 18; z++) {
      if (hist[z] > cnt || (hist[z] === cnt && z > mode)) { mode = z; cnt = hist[z]; }
    }
    return mode; // best-effort
  }

  function scaleToDecimalStr(unitsBI, decimals) {
    const neg = unitsBI < 0n;
    let u = neg ? -unitsBI : unitsBI;
    const base = 10n ** BigInt(decimals);
    const intPart = u / base;
    const fracPart = u % base;
    if (fracPart === 0n) return (neg ? "-" : "") + intPart.toString();
    let frac = fracPart.toString().padStart(decimals, "0").replace(/0+$/, "");
    return (neg ? "-" : "") + intPart.toString() + "." + frac;
  }
  function toNumber(unitsBI, decimals) { return parseFloat(scaleToDecimalStr(unitsBI, decimals)); }
  function pctUnits(numBI, denBI) {
    if (denBI === 0n) return 0;
    const SCALE = 1_000_000n;
    const q = (numBI * SCALE) / denBI;
    return Number(q) / 10_000; // 2dp+ precision
  }

  window.showTokenHolders = async function showTokenHolders() {
    const contractEl = document.getElementById('tokenAddr');
    const pairInfoEl = document.getElementById('pair-info');
    const mapEl = document.getElementById('bubble-map');

    if (!contractEl || !pairInfoEl || !mapEl) {
      alert('Missing required elements (#tokenAddr, #pair-info, #bubble-map).');
      return;
    }

    const contract = contractEl.value.trim().toLowerCase();
    if (!/^0x[a-fA-F0-9]{40}$/.test(contract)) {
      alert("Invalid contract address.");
      return;
    }

    pairInfoEl.innerHTML = '';
    mapEl.innerHTML = '<p>Loading data...</p>';

    // 1) ALL LP/pair addresses from Dexscreener
    let pairAddresses = [];
    try {
      const pairRes = await fetch(`https://api.dexscreener.com/token-pairs/v1/abstract/${contract}`);
      const pairData = await pairRes.json();
      if (Array.isArray(pairData)) {
        const addrs = [];
        for (const p of pairData) {
          let pa = (p?.pairAddress || "").toLowerCase();
          if (!pa) continue;
          // Some DS pair ids carry suffix like ":moon"; strip it
          if (pa.includes(":")) pa = pa.split(":")[0];
          if (/^0x[a-f0-9]{40}$/.test(pa)) addrs.push(pa);
        }
        pairAddresses = Array.from(new Set(addrs));
      }
    } catch (e) {
      console.warn('DexScreener fetch error:', e);
    }
    const pairSet = new Set(pairAddresses);

    try {
      // 2) Token transfers (ascending)
      const txUrl = `${BASE}?chainid=${CHAIN_ID}&module=account&action=tokentx&contractaddress=${contract}&startblock=0&endblock=99999999&sort=asc&apikey=${API_KEY}`;
      const txRes = await fetch(txUrl);
      const txData = await txRes.json();
      const txs = Array.isArray(txData?.result) ? txData.result : [];
      if (!txs.length) throw new Error('No transactions found for this contract.');

      // Robust token decimals
      const tokenDecimals = chooseDecimals(txs);

      // 3) Creator address
      let creatorAddress = '';
      try {
        const cUrl = `${BASE}?chainid=${CHAIN_ID}&module=contract&action=getcontractcreation&contractaddresses=${contract}&apikey=${API_KEY}`;
        const cRes = await fetch(cUrl);
        const cData = await cRes.json();
        creatorAddress = (Array.isArray(cData?.result) && cData.result[0]?.contractCreator)
          ? cData.result[0].contractCreator.toLowerCase() : '';
      } catch {}

      // 4) Build balances + supply + heuristics
      const balances = {};           // address -> BigInt
      const sendRecipients = {};     // addr -> Set(to)
      const inflow = {};             // addr -> BigInt in
      const outflow = {};            // addr -> BigInt out
      const tgRecipients = new Set();

      let burnedUnits = 0n;
      let mintedUnits = 0n;

      // record first liquidity add ts (first transfer TO any LP)
      let firstLiquidityTs = null;

      for (const tx of txs) {
        const from = (tx.from || tx.fromAddress).toLowerCase();
        const to   = (tx.to   || tx.toAddress).toLowerCase();
        const units = toUnitsBig(tx.value);

        // TG recipients
        if (from === TG_BOT_ADDRESS) tgRecipients.add(to);

        // Heuristic stats for proxies/distributors
        if (!sendRecipients[from]) sendRecipients[from] = new Set();
        sendRecipients[from].add(to);
        inflow[to]    = (inflow[to]    || 0n) + units;
        outflow[from] = (outflow[from] || 0n) + units;

        // minted / burned
        if (from === ZERO_ADDR) mintedUnits += units;
        if (burnAddresses.has(to)) burnedUnits += units;

        // first liquidity add time
        if (firstLiquidityTs == null && pairSet.has(to)) {
          firstLiquidityTs = Number(tx.timeStamp);
        }

        // skip contract self-moves from balances
        if (from === contract || to === contract) continue;

        // balances (exclude burn sinks only)
        if (!burnAddresses.has(from)) balances[from] = (balances[from] || 0n) - units;
        if (!burnAddresses.has(to))   balances[to]   = (balances[to]   || 0n) + units;
      }

      // Auto-detect distributors / proxies
      const proxyAddresses = new Set(PROXY_BLOCKLIST);
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
          proxyAddresses.add(addr);
        }
      }

      const minted = mintedUnits;
      const burned = burnedUnits;
      const currentSupply = minted >= burned ? (minted - burned) : 0n;

      // LP balances for ALL pairs
      const lpPerPair = [];
      let lpUnitsSum = 0n;
      for (const pa of pairSet) {
        let u = balances[pa] || 0n;
        if (u < 0n) u = 0n;
        lpPerPair.push({ address: pa, units: u });
        lpUnitsSum += u;
      }
      const lpPct = currentSupply > 0n ? pctUnits(lpUnitsSum, currentSupply) : 0;

      // Circulating (tracked)
      let circulatingTrackedUnits = Object.entries(balances)
        .filter(([addr, bal]) =>
          bal > 0n &&
          addr !== contract &&
          !burnAddresses.has(addr) &&
          !proxyAddresses.has(addr) &&
          !pairSet.has(addr)
        )
        .reduce((s, [, bal]) => s + bal, 0n);

      // Sanity clamp (shouldn't be needed; protects against any upstream oddities)
      if (circulatingTrackedUnits > currentSupply) {
        console.warn('Circulating exceeded supply; clamping.', {
          circulatingTrackedUnits: circulatingTrackedUnits.toString(),
          currentSupply: currentSupply.toString()
        });
        circulatingTrackedUnits = currentSupply;
      }

      // Holders (exclude LP, burn, proxies, contract)
      const allHoldersUnsorted = Object.entries(balances)
        .filter(([addr, bal]) =>
          bal > 0n &&
          addr !== contract &&
          !burnAddresses.has(addr) &&
          !proxyAddresses.has(addr) &&
          !pairSet.has(addr)
        )
        .map(([address, units]) => ({ address, units }));

      const fullHoldersCount = allHoldersUnsorted.length;

      const holders = allHoldersUnsorted
        .sort((a, b) => (b.units > a.units ? 1 : b.units < a.units ? -1 : 0))
        .slice(0, RENDER_TOP_N)
        .map(h => ({
          ...h,
          pct: currentSupply > 0n ? pctUnits(h.units, currentSupply) : 0
        }));

      const burnPctVsMinted = minted > 0n ? pctUnits(burned, minted) : 0;

      // Token tx counts per address (for “<10 tx” stat)
      const tokenTxCount = {};
      for (const t of txs) {
        const f = (t.from || t.fromAddress).toLowerCase();
        const to = (t.to || t.toAddress).toLowerCase();
        tokenTxCount[f] = (tokenTxCount[f] || 0) + 1;
        tokenTxCount[to] = (tokenTxCount[to] || 0) + 1;
      }

      // First 20 buyers (exclude mints) — still useful for quick glance
      const buyerSeen = new Set();
      const first20 = [];
      for (const t of txs) {
        const from = (t.from || t.fromAddress).toLowerCase();
        const to   = (t.to   || t.toAddress).toLowerCase();
        if (from === ZERO_ADDR) continue; // mint
        if (!buyerSeen.has(to)) { buyerSeen.add(to); first20.push(t); }
        if (first20.length >= 20) break;
      }

      // Funder near buy (native)
      async function findFunderNative(buyer, firstBuyTs) {
        const url = `${BASE}?chainid=${CHAIN_ID}&module=account&action=txlist&address=${buyer}&startblock=0&endblock=99999999&sort=asc&apikey=${API_KEY}`;
        try {
          const r = await fetch(url);
          const j = await r.json();
          const list = Array.isArray(j?.result) ? j.result : [];
          let best = null;
          const beforeWindow = firstBuyTs - 3600;
          const afterWindow  = firstBuyTs + 30;
          for (const t of list) {
            const ts = Number(t.timeStamp);
            if (ts > afterWindow) break;
            if ((t.to || '').toLowerCase() === buyer && BigInt(t.value || "0") > 0n) {
              if (ts >= beforeWindow && ts <= afterWindow) best = t;
              else if (ts < beforeWindow) best = t;
            }
          }
          return best ? (best.from || '').toLowerCase() : null;
        } catch {
          return null;
        }
      }

      // --- Launch-window early buys & snipe/insider flags ---
      const addrFlags = {}; // address -> { early, snipe, insider, fundedBy? }
      const earlyBuysByAddrUnits = {}; // sum of LP->addr transfers within window
      let launchStart = firstLiquidityTs;
      let launchEnd = launchStart ? launchStart + LAUNCH_WINDOW_SECS : null;

      if (launchStart) {
        for (const t of txs) {
          const ts = Number(t.timeStamp);
          if (ts < launchStart || ts > launchEnd) continue;
          const from = (t.from || t.fromAddress).toLowerCase();
          const to   = (t.to   || t.toAddress).toLowerCase();
          if (!pairSet.has(from)) continue;             // buy = token leaves LP
          if (pairSet.has(to) || burnAddresses.has(to)) continue;
          const units = toUnitsBig(t.value);
          earlyBuysByAddrUnits[to] = (earlyBuysByAddrUnits[to] || 0n) + units;
        }

        // Rank early buyers
        const rankedEarly = Object.entries(earlyBuysByAddrUnits)
          .map(([addr, units]) => ({ addr, units }))
          .sort((a,b) => (b.units > a.units ? 1 : b.units < a.units ? -1 : 0));

        const thresholdUnits = currentSupply > 0n
          ? (currentSupply * BigInt(Math.round(EARLY_SNIPE_MIN_PCT * 1e6)) / 100000n) // pct with 4 dp
          : 0n;

        const topCut = new Set(rankedEarly.slice(0, EARLY_TOP_K).map(x => x.addr));

        for (const {addr, units} of rankedEarly) {
          if (!addrFlags[addr]) addrFlags[addr] = {};
          addrFlags[addr].early = true;
          if (currentSupply > 0n) {
            const byPct = pctUnits(units, currentSupply) >= EARLY_SNIPE_MIN_PCT;
            const byTop = topCut.has(addr);
            if (byPct || byTop) addrFlags[addr].snipe = true;
          }
        }

        // Funder clustering for early buyers (limit calls to avoid rate limits)
        const earlyAddrs = rankedEarly.slice(0, 150).map(x => x.addr);
        const funderByBuyer = {};
        for (const buyer of earlyAddrs) {
          // find timestamp of buyer's FIRST buy in window for tighter matching
          let firstBuyTs = launchEnd;
          for (const t of txs) {
            const ts = Number(t.timeStamp);
            if (ts < launchStart || ts > launchEnd) continue;
            const from = (t.from || t.fromAddress).toLowerCase();
            const to   = (t.to   || t.toAddress).toLowerCase();
            if (pairSet.has(from) && to === buyer) { firstBuyTs = ts; break; }
          }
          const funder = await findFunderNative(buyer, firstBuyTs);
          if (funder) funderByBuyer[buyer] = funder;
        }

        const funderCounts = {};
        for (const f of Object.values(funderByBuyer)) {
          funderCounts[f] = (funderCounts[f] || 0) + 1;
        }

        for (const [buyer, funder] of Object.entries(funderByBuyer)) {
          if (!addrFlags[buyer]) addrFlags[buyer] = {};
          addrFlags[buyer].fundedBy = funder;
          const insiderByCreator = (funder && creatorAddress && funder.toLowerCase() === creatorAddress.toLowerCase());
          const insiderByCluster = (funder && (funderCounts[funder] || 0) >= INSIDER_FUNDER_MIN);
          if (insiderByCreator || insiderByCluster) addrFlags[buyer].insider = true;
        }
      }

      // First 20 buyers enriched vs current balances
      const first20Enriched = [];
      let lt10Count = 0;
      for (const t of first20) {
        const addr = (t.to || t.toAddress).toLowerCase();
        const initialUnits = toUnitsBig(t.value);
        const currentUnits = balances[addr] || 0n;
        const txCount = tokenTxCount[addr] || 0;
        if (txCount < 10) lt10Count++;

        let status = 'hold';
        if (currentUnits === 0n) status = 'soldAll';
        else if (currentUnits > initialUnits) status = 'more';
        else if (currentUnits < initialUnits) status = 'soldPart';

        first20Enriched.push({ address: addr, status });
      }

      // Stats
      const top10Pct = holders.slice(0,10).reduce((s,h)=>s+h.pct,0);
      const creatorPct = creatorAddress
        ? (holders.find(h => h.address.toLowerCase() === creatorAddress)?.pct || 0)
        : 0;

      // Funder labels for tooltips (for early buyers)
      const addrToBundle = {}; // keep API compatible name
      for (const [addr, flags] of Object.entries(addrFlags)) {
        if (flags.fundedBy) addrToBundle[addr] = flags.fundedBy;
      }

      // LP nodes (one per pool)
      const lpNodes = lpPerPair.map((p, idx) => ({
        address: p.address,
        units: p.units,
        pct: currentSupply > 0n ? pctUnits(p.units, currentSupply) : 0,
        __type: 'lp',
        __label: pairPerLabel(idx)
      }));
      function pairPerLabel(i){ return pairPerLabel.labels?.[i] || `LP-${i+1}`; }

      renderBubbleMap({
        tokenDecimals,
        holders: holders.map(h => ({
          address: h.address,
          balance: toNumber(h.units, tokenDecimals),
          pct: h.pct
        })),
        extras: lpNodes.map(n => ({
          address: n.address,
          balance: toNumber(n.units, tokenDecimals),
          pct: n.pct,
          __type: 'lp',
          __label: n.__label
        })),
        mintedUnits,
        burnedUnits,
        currentSupply,
        circulatingTrackedUnits,
        addrToBundle,
        tgRecipients,
        addrFlags,
        lpPerPair,
        stats: {
          holdersCount: fullHoldersCount,
          top10Pct,
          creatorPct,
          creatorAddress,
          lpUnitsSum,
          lpPct,
          burnedUnits,
          burnPctVsMinted,
          first20Enriched,
          lt10Count,
          launchStart,
          launchWindowSecs: LAUNCH_WINDOW_SECS,
          earlySnipeMinPct: EARLY_SNIPE_MIN_PCT,
          earlyTopK: EARLY_TOP_K
        }
      });

      // burn banner (explicit UI line)
      if (burned > 0n) {
        pairInfoEl.innerHTML = `<span style="color:#ff4e4e">🔥 Burn — ${toNumber(burned, tokenDecimals).toLocaleString(undefined,{maximumFractionDigits:18})} tokens (${burnPctVsMinted.toFixed(4)}% of minted)</span>`;
      } else {
        pairInfoEl.innerHTML = '';
      }
    } catch (err) {
      console.error(err);
      mapEl.innerHTML = '<p>Error loading holders.</p>';
    }
  };

  // ---------------- Renderer ----------------
  function renderBubbleMap({
    tokenDecimals, holders, extras = [],
    mintedUnits, burnedUnits, currentSupply, circulatingTrackedUnits,
    addrToBundle, tgRecipients, addrFlags, lpPerPair, stats
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
    const color = d3.scaleOrdinal(d3.schemeTableau10).domain(distinctBundles);

    let tip = d3.select('#bubble-tip');
    if (tip.empty()) {
      tip = d3.select('body').append('div').attr('id','bubble-tip')
        .style('position','fixed').style('background','#111').style('color','#fff')
        .style('padding','8px 10px').style('border','1px solid #333').style('border-radius','8px')
        .style('pointer-events','none').style('opacity',0).style('z-index',9999);
    }

    const g = svg.selectAll('g')
      .data(nodes)
      .enter()
      .append('g')
      .attr('transform', d => `translate(${d.x},${d.y})`);

    function ringColorFor(addr, isLP) {
      if (isLP) return '#C4B5FD'; // lilac for LP
      const f = addrFlags[addr] || {};
      if (f.snipe)   return '#ff4e4e'; // red
      if (f.insider) return '#ff9f3c'; // orange
      if (tgRecipients.has(addr)) return '#FFD700'; // gold
      return null;
    }

    g.append('circle')
      .attr('r', d => d.r)
      .attr('fill', d => {
        if (d.data.__type === 'lp') return '#8B5CF6'; // purple LP
        const bundle = addrToBundle[d.data.address];
        return bundle ? color(bundle) : '#4b5563';
      })
      .attr('stroke', d => ringColorFor(d.data.address, d.data.__type === 'lp'))
      .attr('stroke-width', d => ringColorFor(d.data.address, d.data.__type === 'lp') ? 2.5 : null)
      .on('mouseover', function (event, d) {
        const isLP = d.data.__type === 'lp';
        const bundle = addrToBundle[d.data.address];
        const flags = addrFlags[d.data.address] || {};
        const isTG = tgRecipients.has(d.data.address);

        if (!isLP) {
          g.selectAll('circle')
            .attr('opacity', node => bundle ? (addrToBundle[node.data.address] === bundle ? 1 : 0.15) : 1)
            .attr('stroke', node => {
              const nodeIsLP = node.data.__type === 'lp';
              return ringColorFor(node.data.address, nodeIsLP);
            })
            .attr('stroke-width', node => ringColorFor(node.data.address, node.data.__type === 'lp') ? 2.5 : null);
        }

        tip.html(
          isLP
            ? `<div><strong>${d.data.__label || 'LP'}</strong> — ${d.data.balance.toLocaleString()} tokens</div>
               <div>${d.data.pct.toFixed(4)}% of current supply</div>
               <div style="opacity:.8;margin-top:6px">Click to open in explorer ↗</div>`
            : `<div><strong>${d.data.pct.toFixed(4)}% of current supply</strong></div>
               <div>${d.data.balance.toLocaleString()} tokens</div>
               <div>${d.data.address.slice(0,6)}...${d.data.address.slice(-4)}</div>
               ${bundle ? `<div style="opacity:.8">Funder: ${bundle.slice(0,6)}...${bundle.slice(-4)}</div>` : ''}
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
          .attr('stroke', d => ringColorFor(d.data.address, d.data.__type === 'lp'))
          .attr('stroke-width', d => ringColorFor(d.data.address, d.data.__type === 'lp') ? 2.5 : null);
      })
      .on('click', (event, d) => {
        window.open(`${EXPLORER}/address/${d.data.address}`, '_blank');
      });

    // Labels: % for holders; "LP-x" for LP nodes
    g.append('text')
      .attr('dy', '.35em')
      .style('text-anchor', 'middle')
      .style('font-size', d => Math.min(d.r * 0.5, 16))
      .style('fill', '#fff')
      .style('pointer-events', 'none')
      .text(d => d.data.__type === 'lp' ? (d.data.__label || 'LP') : `${d.data.pct.toFixed(2)}%`);

    // === Stats panel ===
    const statsDiv = document.createElement('div');
    statsDiv.style.marginTop = '10px';

    const lpLines = lpPerPair.map((p, i) =>
      `<div>${`LP-${i+1}`} (${p.address.slice(0,6)}...${p.address.slice(-4)}): <strong>${(Number(p.units / (10n ** BigInt(tokenDecimals)))).toLocaleString()}</strong> tokens</div>`
    ).join('');

    statsDiv.innerHTML = `
      <div class="section-title" style="padding-left:0">Stats</div>
      <div>Minted: <strong>${(Number(mintedUnits / (10n ** BigInt(tokenDecimals)))).toLocaleString()}</strong> tokens</div>
      <div>🔥 Burn: <strong>${(Number(burnedUnits / (10n ** BigInt(tokenDecimals)))).toLocaleString()}</strong> tokens
        (<strong>${stats.burnPctVsMinted.toFixed(4)}%</strong> of minted)</div>
      <div>Current supply (minted − burned): <strong>${(Number(currentSupply / (10n ** BigInt(tokenDecimals)))).toLocaleString()}</strong> tokens</div>
      <div>Circulating (tracked)*: <strong>${(Number(circulatingTrackedUnits / (10n ** BigInt(tokenDecimals)))).toLocaleString()}</strong> tokens</div>
      <div>Holders (displayed / total): <strong>${holders.length}</strong> / <strong>${stats.holdersCount}</strong></div>
      <div>Top 10 holders: <strong>${stats.top10Pct.toFixed(4)}%</strong> (of current supply)</div>
      <div>Creator (${stats.creatorAddress ? stats.creatorAddress.slice(0,6)+'...'+stats.creatorAddress.slice(-4) : 'n/a'}) holding:
        <strong>${stats.creatorPct.toFixed(4)}%</strong></div>
      <div style="margin-top:8px"><strong>LP totals</strong> (sum across pools): <strong>${(Number(stats.lpUnitsSum / (10n ** BigInt(tokenDecimals)))).toLocaleString()}</strong> tokens
        (<strong>${stats.lpPct.toFixed(4)}%</strong> of current supply)</div>
      ${lpLines}
      <div style="margin-top:8px"><strong>Launch window</strong>: ${stats.launchStart ? `${new Date(stats.launchStart*1000).toLocaleString()} + ${stats.launchWindowSecs}s` : 'n/a'}</div>
      <div>Snipe rule: ≥ ${stats.earlySnipeMinPct}% of supply or Top ${stats.earlyTopK} early buys</div>
      <div style="opacity:.8;margin-top:6px">Ring colors — <span style="color:#ff4e4e">red</span>: snipe • <span style="color:#ff9f3c">orange</span>: insider • <span style="color:#FFD700">gold</span>: TG • <span style="color:#C4B5FD">lilac</span>: LP</div>
      <div style="opacity:.6;margin-top:6px;font-size:.9em">*Circulating (tracked) excludes all LPs, contract, burn sinks, and detected proxies/distributors.</div>
    `;
    mapEl.appendChild(statsDiv);
  }
})();
