/*
  Totally ABS Bubble Viewer — v3
  ------------------------------------------------------------------
  - BigInt math everywhere; robust decimals inference
  - Dexscreener multi-LP discovery; LP balances via tokenbalance()
  - Full pagination for tokentx
  - Circulating (tracked) clamped ≤ (minted − burned)
  - First 20 buyers legend restored
  - Early snipe / insider / TG / LP rings
  - Top holders verified via explorer tokenbalance (override or drop)
  - Known system/DEX/router contracts excluded from holders & circ

  Color rings priority: red (snipe) > orange (insider) > gold (TG) > lilac (LP)
*/

(() => {
  // ===== CONFIG =====
  const API_KEY = "H13F5VZ64YYK4M21QMPEW78SIKJS85UTWT";
  const BASE = "https://api.etherscan.io/v2/api"; // ABS-compatible
  const CHAIN_ID = 2741;
  const EXPLORER = "https://explorer.mainnet.abs.xyz";

  const TG_BOT_ADDRESS = "0x1c4ae91dfa56e49fca849ede553759e1f5f04d9f".toLowerCase();

  // Known system/router/aggregator/factory contracts on ABS you want to ignore as holders
  const KNOWN_SYSTEM_ADDRESSES = new Set([
    TG_BOT_ADDRESS,
    // Reported router-like/system address (should not appear as holder)
    "0xcca5047e4c9f9d72f11c199b4ff1960f88a4748d".toLowerCase(),
    // Add more if needed:
    // "0x...", "0x..."
  ]);

  // Distributor / proxy detection
  const PROXY_MIN_DISTINCT_RECIPIENTS = 8;
  const PROXY_END_BALANCE_EPS = 0n;
  const PROXY_OUTFLOW_SHARE_NUM = 90n; // 90%
  const PROXY_OUTFLOW_SHARE_DEN = 100n;

  // Early snipe / insider heuristics
  const LAUNCH_WINDOW_SECS = 180;    // seconds after first LP add
  const EARLY_SNIPE_MIN_PCT = 0.20;  // ≥ 0.20% of current supply OR top-K
  const EARLY_TOP_K = 10;            // top 10 early buys by size
  const INSIDER_FUNDER_MIN = 3;      // funder bankrolls ≥3 early buyers

  // Verify top N holders via explorer tokenbalance to override/drop bad classifications
  const VERIFY_TOP_N = 150;
  const VERIFY_CONCURRENCY = 4;

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
    const SCALE = 1_000_000n;               // 1e6
    const q = (numBI * SCALE) / denBI;      // scaled ratio
    return Number(q) / 10_000;              // => percentage with 2+ dp
  }

  function countTrailingZeros10(u) {
    let n = 0;
    while (u !== 0n && (u % 10n === 0n) && n < 18) { u /= 10n; n++; }
    return n;
  }
  function chooseDecimals(txs) {
    // Mode of tokenDecimal across txs (0..18), fallback by trailing-zero histogram
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

  // ===== PAGINATION =====
  async function fetchAllTokenTx(contract) {
    const all = [];
    const offset = 10000;
    let page = 1;
    while (true) {
      const url = `${BASE}?chainid=${CHAIN_ID}&module=account&action=tokentx&contractaddress=${contract}&page=${page}&offset=${offset}&sort=asc&apikey=${API_KEY}`;
      const r = await fetch(url);
      const j = await r.json();
      const arr = Array.isArray(j?.result) ? j.result : [];
      if (arr.length === 0) break;
      all.push(...arr);
      if (arr.length < offset) break;
      page++;
      if (page > 200) break; // safety
    }
    if (all.length === 0) {
      // fallback single-shot
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
      if (arr.length === 0) break;
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

  // ===== MAIN =====
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

    // 1) Dexscreener pairs (ALL)
    let pairAddresses = [];
    try {
      const pairRes = await fetch(`https://api.dexscreener.com/token-pairs/v1/abstract/${contract}`);
      const pairData = await pairRes.json();
      if (Array.isArray(pairData)) {
        for (const p of pairData) {
          let pa = (p?.pairAddress || "").toLowerCase();
          if (!pa) continue;
          if (pa.includes(":")) pa = pa.split(":")[0];
          if (/^0x[a-f0-9]{40}$/.test(pa)) pairAddresses.push(pa);
        }
      }
    } catch(e){ console.warn('DexScreener fetch error:', e); }
    pairAddresses = Array.from(new Set(pairAddresses));
    const pairSet = new Set(pairAddresses);

    try {
      // 2) All token transfers
      const txs = await fetchAllTokenTx(contract);
      if (!txs.length) throw new Error('No transactions found.');

      const tokenDecimals = chooseDecimals(txs);

      // 3) Creator
      let creatorAddress = '';
      try {
        const cUrl = `${BASE}?chainid=${CHAIN_ID}&module=contract&action=getcontractcreation&contractaddresses=${contract}&apikey=${API_KEY}`;
        const cRes = await fetch(cUrl);
        const cData = await cRes.json();
        creatorAddress = (Array.isArray(cData?.result) && cData.result[0]?.contractCreator)
          ? cData.result[0].contractCreator.toLowerCase() : '';
      } catch {}

      // 4) Balances & flows (BigInt)
      const balances = {};  // address -> BigInt
      const inflow = {};
      const outflow = {};
      const sendRecipients = {};
      const tgRecipients = new Set();

      let mintedUnits = 0n;
      let burnedUnits = 0n;
      let firstLiquidityTs = null;

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

      // 5) Distributor/proxy detection
      const proxyAddresses = new Set([...KNOWN_SYSTEM_ADDRESSES]); // start with known systems
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

      // 6) Supply
      const minted = mintedUnits;
      const burned = burnedUnits;
      const currentSupply = minted >= burned ? (minted - burned) : 0n;

      // 7) LP balances (per pair) via tokenbalance (fallback to net)
      const lpPerPair = [];
      let lpUnitsSum = 0n;
      for (let i=0; i<pairAddresses.length; i++) {
        const pa = pairAddresses[i];
        let units = await tokenBalanceOf(contract, pa);
        if (units == null) {
          units = balances[pa] || 0n;
          if (units < 0n) units = 0n;
        }
        lpPerPair.push({ address: pa, units });
        lpUnitsSum += units;
      }
      const lpPct = currentSupply > 0n ? pctUnits(lpUnitsSum, currentSupply) : 0;

      // 8) First pass holders (exclude LPs, contract, burn sinks, proxies/known systems)
      let holderEntries = Object.entries(balances)
        .filter(([addr, bal]) =>
          bal > 0n &&
          addr !== contract &&
          !burnAddresses.has(addr) &&
          !proxyAddresses.has(addr) &&
          !pairSet.has(addr)
        )
        .map(([address, units]) => ({ address, units }));

      // 9) VERIFY TOP HOLDERS via tokenbalance (override/drop)
      holderEntries.sort((a,b)=> (b.units > a.units) ? 1 : (b.units < a.units) ? -1 : 0);
      const toVerify = holderEntries.slice(0, VERIFY_TOP_N).map(h => h.address);
      const verified = await verifyTopBalances(contract, toVerify); // map addr->BigInt|null

      const verifiedSet = new Set(toVerify);
      const corrected = [];
      for (const h of holderEntries) {
        if (verifiedSet.has(h.address)) {
          const v = verified[h.address];
          if (v === null) {
            // explorer didn’t answer -> keep computed
            if (h.units > 0n) corrected.push(h);
          } else if (v === 0n) {
            // explorer says zero -> drop
            continue;
          } else {
            // override with explorer value
            corrected.push({ address: h.address, units: v });
          }
        } else {
          corrected.push(h);
        }
      }
      holderEntries = corrected;

      // 10) Recompute circulating (tracked) after verification, clamp
      let circulatingTrackedUnits = holderEntries.reduce((s, h) => s + h.units, 0n);
      if (circulatingTrackedUnits > currentSupply) {
        console.warn('Circulating > currentSupply; clamping.', {
          circ: circulatingTrackedUnits.toString(),
          supply: currentSupply.toString()
        });
        circulatingTrackedUnits = currentSupply;
      }

      // 11) Final holders (top N to render) + % of CURRENT supply
      holderEntries.sort((a,b)=> (b.units > a.units) ? 1 : (b.units < a.units) ? -1 : 0);
      const holders = holderEntries
        .slice(0, RENDER_TOP_N)
        .map(h => ({ ...h, pct: currentSupply > 0n ? pctUnits(h.units, currentSupply) : 0 }));

      const fullHoldersCount = holderEntries.length;
      const burnPctVsMinted = minted > 0n ? pctUnits(burned, minted) : 0;

      // 12) First 20 buyers (exclude mints) + status legend
      const tokenTxCount = {};
      for (const t of txs) {
        const f = (t.from || t.fromAddress).toLowerCase();
        const to = (t.to || t.toAddress).toLowerCase();
        tokenTxCount[f] = (tokenTxCount[f] || 0) + 1;
        tokenTxCount[to] = (tokenTxCount[to] || 0) + 1;
      }

      const buyerSeen = new Set();
      const first20 = [];
      for (const t of txs) {
        const from = (t.from || t.fromAddress).toLowerCase();
        const to   = (t.to || t.toAddress).toLowerCase();
        if (from === ZERO_ADDR) continue;
        if (!buyerSeen.has(to)) { buyerSeen.add(to); first20.push(t); }
        if (first20.length >= 20) break;
      }

      const first20Enriched = [];
      let lt10Count = 0;
      for (const t of first20) {
        const addr = (t.to || t.toAddress).toLowerCase();
        const initialUnits = toBI(t.value);
        const currentUnits = (balances[addr] || 0n) + 0n; // pre-verify balance view is fine for status
        const txCount = tokenTxCount[addr] || 0;
        if (txCount < 10) lt10Count++;
        let status = 'hold';
        if (currentUnits === 0n) status = 'soldAll';
        else if (currentUnits > initialUnits) status = 'more';
        else if (currentUnits < initialUnits) status = 'soldPart';
        first20Enriched.push({ address: addr, status });
      }

      // 13) Early window snipe / insider
      const addrFlags = {};
      if (firstLiquidityTs) {
        const launchStart = firstLiquidityTs;
        const launchEnd = launchStart + LAUNCH_WINDOW_SECS;

        const earlyBuysByAddrUnits = {};
        for (const t of txs) {
          const ts = Number(t.timeStamp);
          if (ts < launchStart || ts > launchEnd) continue;
          const from = (t.from || t.fromAddress).toLowerCase();
          const to   = (t.to   || t.toAddress).toLowerCase();
          if (!pairSet.has(from)) continue;             // token leaving LP = buy
          if (pairSet.has(to) || burnAddresses.has(to)) continue;
          const units = toBI(t.value);
          earlyBuysByAddrUnits[to] = (earlyBuysByAddrUnits[to] || 0n) + units;
        }

        const ranked = Object.entries(earlyBuysByAddrUnits)
          .map(([addr, units]) => ({ addr, units }))
          .sort((a,b)=> (b.units > a.units) ? 1 : (b.units < a.units) ? -1 : 0);

        const topCut = new Set(ranked.slice(0, EARLY_TOP_K).map(x => x.addr));
        for (const {addr, units} of ranked) {
          if (!addrFlags[addr]) addrFlags[addr] = {};
          addrFlags[addr].early = true;
          if (currentSupply > 0n) {
            const pr = pctUnits(units, currentSupply); // %
            if (pr >= EARLY_SNIPE_MIN_PCT || topCut.has(addr)) addrFlags[addr].snipe = true;
          }
        }

        // Funders for first ~150 early buyers
        const earlyAddrs = ranked.slice(0, 150).map(x => x.addr);
        const funderByBuyer = {};
        const funderCounts = {};
        for (const buyer of earlyAddrs) {
          // fetch native txs up to end of window & pick closest inbound funding
          const list = await fetchAllNativeTx(buyer, launchEnd);
          let best = null;
          const beforeWindow = launchStart - 3600;
          for (const tx of list) {
            const ts = Number(tx.timeStamp);
            if (ts > launchEnd) break;
            if ((tx.to || '').toLowerCase() === buyer && BigInt(tx.value || "0") > 0n) {
              if (ts >= beforeWindow && ts <= launchEnd) best = tx;
              else if (ts < beforeWindow) best = tx;
            }
          }
          if (best) {
            const f = (best.from || '').toLowerCase();
            funderByBuyer[buyer] = f;
            funderCounts[f] = (funderCounts[f] || 0) + 1;
          }
        }
        for (const [buyer, funder] of Object.entries(funderByBuyer)) {
          if (!addrFlags[buyer]) addrFlags[buyer] = {};
          addrFlags[buyer].fundedBy = funder;
          const insiderByCreator = (funder && creatorAddress && funder === creatorAddress);
          const insiderByCluster = (funder && (funderCounts[funder] || 0) >= INSIDER_FUNDER_MIN);
          if (insiderByCreator || insiderByCluster) addrFlags[buyer].insider = true;
        }
      }

      // 14) Stats
      const top10Pct = holders.slice(0,10).reduce((s,h)=>s+h.pct,0);
      const creatorPct = creatorAddress
        ? (holders.find(h => h.address.toLowerCase() === creatorAddress)?.pct || 0)
        : 0;

      // Funder tooltip map (for early buyers)
      const addrToBundle = {};
      for (const [addr, flags] of Object.entries(addrFlags)) {
        if (flags.fundedBy) addrToBundle[addr] = flags.fundedBy;
      }

      // LP nodes (render)
      const lpNodes = lpPerPair.map((p, i) => ({
        address: p.address,
        balance: toNum(p.units, tokenDecimals),
        pct: currentSupply > 0n ? pctUnits(p.units, currentSupply) : 0,
        __type: 'lp',
        __label: `LP-${i+1}`
      }));

      // Render
      renderBubbleMap({
        tokenDecimals,
        holders: holders.map(h => ({ address: h.address, balance: toNum(h.units, tokenDecimals), pct: h.pct })),
        extras: lpNodes,
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
          launchStart: firstLiquidityTs,
          launchWindowSecs: LAUNCH_WINDOW_SECS,
          earlySnipeMinPct: EARLY_SNIPE_MIN_PCT,
          earlyTopK: EARLY_TOP_K
        }
      });

      // Burn banner
      if (burned > 0n) {
        pairInfoEl.innerHTML = `<span style="color:#ff4e4e">🔥 Burn — ${toNum(burned, tokenDecimals).toLocaleString(undefined,{maximumFractionDigits:18})} tokens (${burnPctVsMinted.toFixed(4)}% of minted)</span>`;
      } else {
        pairInfoEl.innerHTML = '';
      }
    } catch (err) {
      console.error(err);
      mapEl.innerHTML = '<p>Error loading holders.</p>';
    }
  };

  // ===== Verify top holders helper =====
  async function verifyTopBalances(contract, addresses) {
    // throttle tokenbalance calls
    const out = {};
    let idx = 0;
    async function worker() {
      while (idx < addresses.length) {
        const i = idx++;
        const addr = addresses[i];
        let v = null;
        try { v = await tokenBalanceOf(contract, addr); }
        catch {}
        out[addr] = v; // v can be BigInt or null
      }
    }
    const workers = Array.from({length:VERIFY_CONCURRENCY}, worker);
    await Promise.all(workers);
    return out;
  }

  // ===== RENDERER =====
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

    function ringColorFor(addr, isLP) {
      if (isLP) return '#C4B5FD';           // lilac LP
      const f = addrFlags[addr] || {};
      if (f.snipe)   return '#ff4e4e';      // red
      if (f.insider) return '#ff9f3c';      // orange
      if (tgRecipients.has(addr)) return '#FFD700'; // gold
      return null;
    }

    const g = svg.selectAll('g')
      .data(nodes)
      .enter()
      .append('g')
      .attr('transform', d => `translate(${d.x},${d.y})`);

    g.append('circle')
      .attr('r', d => d.r)
      .attr('fill', d => {
        if (d.data.__type === 'lp') return '#8B5CF6';
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
            .attr('stroke', node => ringColorFor(node.data.address, node.data.__type === 'lp'))
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

    g.append('text')
      .attr('dy', '.35em')
      .style('text-anchor', 'middle')
      .style('font-size', d => Math.min(d.r * 0.5, 16))
      .style('fill', '#fff')
      .style('pointer-events', 'none')
      .text(d => d.data.__type === 'lp' ? (d.data.__label || 'LP') : `${d.data.pct.toFixed(2)}%`);

    // === Stats (incl. First 20 legend) ===
    const legend = stats.first20Enriched.map(b => {
      const short = b.address.slice(0,6)+'...'+b.address.slice(-4);
      const clr = b.status === 'hold' ? '#00ff9c' :
                  b.status === 'soldPart' ? '#4ea3ff' :
                  b.status === 'soldAll' ? '#ff4e4e' : '#ffd84e';
      const lbl = b.status === 'hold' ? 'Hold' :
                  b.status === 'soldPart' ? 'Sold Part' :
                  b.status === 'soldAll' ? 'Sold All' : 'Bought More';
      return `<span style="display:inline-flex;align-items:center;margin-right:10px;margin-bottom:6px">
        <span style="width:10px;height:10px;border-radius:50%;background:${clr};display:inline-block;margin-right:6px"></span>
        ${short} – ${lbl}
      </span>`;
    }).join('');

    const statsDiv = document.createElement('div');
    statsDiv.style.marginTop = '10px';

    const lpLines = lpPerPair.map((p, i) =>
      `<div>LP-${i+1} (${p.address.slice(0,6)}...${p.address.slice(-4)}): <strong>${(Number(p.units / (10n ** BigInt(tokenDecimals)))).toLocaleString()}</strong> tokens</div>`
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
      <div style="margin-top:10px">Among first 20 buyers, <strong>${stats.lt10Count}</strong> have &lt; 10 token tx.</div>
      <div style="margin-top:8px">First 20 buyers status: ${legend}</div>
      <div style="margin-top:8px"><strong>Launch window</strong>: ${stats.launchStart ? `${new Date(stats.launchStart*1000).toLocaleString()} + ${stats.launchWindowSecs}s` : 'n/a'}</div>
      <div>Snipe rule: ≥ ${stats.earlySnipeMinPct}% of supply or Top ${stats.earlyTopK} early buys</div>
      <div style="opacity:.8;margin-top:6px">Rings — <span style="color:#ff4e4e">red</span>: snipe • <span style="color:#ff9f3c">orange</span>: insider • <span style="color:#FFD700">gold</span>: TG • <span style="color:#C4B5FD">lilac</span>: LP</div>
      <div style="opacity:.6;margin-top:6px;font-size:.9em">*Circulating (tracked) excludes LPs, contract, burn sinks, detected distributors/proxies, and known system/router contracts.</div>
    `;
    mapEl.appendChild(statsDiv);
  }
})();
