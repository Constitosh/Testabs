/*
  Totally ABS Bubble Viewer — v5.5 (no .env)
  ------------------------------------------------------------
  Changes vs your v5.3:
    • First 20 real buyers:
       - Scans every tx that has LP→* transfers
       - Considers ALL LP→X seeds in a tx (largest first)
       - Resolves router/aggregator hops within the tx to the final wallet
       - Adds unique buyers until 20 (not just 1 per tx)
       - Strict chronological order by block/time/logIndex
    • First-20 matrix: status + rich hover preserved; click opens in explorer
    • UI: two collapsible dropdowns — Bubble Map and Stats
    • Stats order updated:
       Pool info
       Minted Tokens
       Burned Tokens
       (removed: Current supply, Circulating (tracked))
       Holders
       Creator
       Top 10 Holders
       LP Totals
       Vested Tokens
       First 20 buyers (Status)
*/

(() => {
  // ===== CONFIG =====
  const API_KEY   = "H13F5VZ64YYK4M21QMPEW78SIKJS85UTWT";
  const BASE      = "https://api.etherscan.io/v2/api"; // ABS-compatible
  const CHAIN_ID  = 2741;
  const EXPLORER  = "https://explorer.mainnet.abs.xyz";

  const TG_BOT_ADDRESS = "0x1c4ae91dfa56e49fca849ede553759e1f5f04d9f".toLowerCase();

  // Known system/router/aggregator/factory contracts to ignore as holders & first-buyer recipients
  const KNOWN_SYSTEM_ADDRESSES = new Set([
    TG_BOT_ADDRESS,
    "0xcca5047e4c9f9d72f11c199b4ff1960f88a4748d".toLowerCase(), // router-like
  ]);

  // Always exclude (never count as holder/circulating)
  const ALWAYS_EXCLUDE_ADDRESSES = new Set([]);

  // VESTED addresses — excluded from holders/circulating; shown as teal bubbles
  const VESTED_ADDRESSES_GLOBAL = new Set([]);
  const VESTED_ADDRESSES_BY_TOKEN = {
    // "0xd5cc17f92b41d57a4b34d4b08587bf55342d4bc1": ["0x1d48d1cb9b51dbed2443d7451eae1060ccc27ba8"]
  };

  // Proxy heuristics
  const PROXY_MIN_DISTINCT_RECIPIENTS = 8;
  const PROXY_END_BALANCE_EPS = 0n;
  const PROXY_OUTFLOW_SHARE_NUM = 90n; // 90%
  const PROXY_OUTFLOW_SHARE_DEN = 100n;

  // Holders verification
  const VERIFY_TOP_N         = 150;
  const VERIFY_CONCURRENCY   = 3;
  const VERIFY_RETRIES       = 2;

  // First-20 matrix rendering
  const FIRST20_MATRIX_COLS = 5; // 5x4 grid

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

  // ===== API =====
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

  // ===== FIRST 20 REAL BUYS (improved) =====
  function groupByHashAscending(txs) {
    const groups = new Map();
    for (const t of txs) {
      const h = String(t.hash || t.transactionHash || "");
      if (!groups.has(h)) groups.set(h, []);
      groups.get(h).push(t);
    }
    const arr = Array.from(groups.values());
    // sort groups by (time, block, logIndex)
    arr.sort((A, B) => {
      const aT = Number(A[0].timeStamp), bT = Number(B[0].timeStamp);
      if (aT !== bT) return aT - bT;
      const aB = Number(A[0].blockNumber || 0), bB = Number(B[0].blockNumber || 0);
      if (aB !== bB) return aB - bB;
      const aL = Number(A[0].logIndex || 0), bL = Number(B[0].logIndex || 0);
      return aL - bL;
    });
    // stabilize inside each group by logIndex
    for (const g of arr) g.sort((x,y)=> Number(x.logIndex||0) - Number(y.logIndex||0));
    return arr;
  }
  function resolveFinalRecipientInTx(group, seed, {excluded, pairSet, maxDepth = 4}) {
    const edges = new Map(); // from -> [to...]
    for (const t of group) {
      const f = (t.from || t.fromAddress).toLowerCase();
      const to = (t.to   || t.toAddress).toLowerCase();
      if (!edges.has(f)) edges.set(f, []);
      edges.get(f).push(to);
    }
    const seen = new Set([seed]);
    let frontier = [seed];
    for (let d = 0; d < maxDepth; d++) {
      const next = [];
      for (const u of frontier) {
        if (!excluded.has(u) && !pairSet.has(u) && !burnAddresses.has(u)) {
          return u;
        }
        const outs = edges.get(u) || [];
        for (const v of outs) {
          if (seen.has(v)) continue;
          seen.add(v);
          next.push(v);
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }
    if (!excluded.has(seed) && !pairSet.has(seed) && !burnAddresses.has(seed)) return seed;
    return null;
  }
  function sumCreditsToInTx(group, addr) {
    let sum = 0n;
    for (const t of group) {
      const to = (t.to || t.toAddress).toLowerCase();
      if (to === addr) sum += toBI(t.value);
    }
    return sum;
  }
  function findFirst20RealBuys({txs, pairSet, excluded}) {
    const groups = groupByHashAscending(txs);
    const buyers = [];
    const seen = new Set();

    outer: for (const group of groups) {
      const lpTransfers = group.filter(t => pairSet.has((t.from || t.fromAddress).toLowerCase()));
      if (!lpTransfers.length) continue;

      // consider ALL LP→X seeds (largest first)
      lpTransfers.sort((a, b) => {
        const av = toBI(a.value), bv = toBI(b.value);
        return (bv > av) ? 1 : (bv < av) ? -1 : 0;
      });

      for (const seedT of lpTransfers) {
        const seed = (seedT.to || seedT.toAddress).toLowerCase();
        const resolved = resolveFinalRecipientInTx(group, seed, {excluded, pairSet, maxDepth: 4});
        if (!resolved || seen.has(resolved)) continue;

        const credit = sumCreditsToInTx(group, resolved);
        if (credit === 0n) continue;

        buyers.push({
          address: resolved,
          initialUnits: credit,
          ts: Number(group[0].timeStamp) || Date.now()/1000
        });
        seen.add(resolved);
        if (buyers.length >= 20) break outer;
      }
    }
    buyers.sort((a,b)=> a.ts - b.ts);
    return buyers;
  }

  // ===== VERIFY TOP HOLDERS =====
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

    // Dexscreener pairs (ALL)
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

      // Creator (optional)
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

      let mintedUnits = 0n, burnedUnits = 0n;

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

        if (from === contract || to === contract) continue;
        if (!burnAddresses.has(from)) balances[from] = (balances[from] || 0n) - units;
        if (!burnAddresses.has(to))   balances[to]   = (balances[to]   || 0n) + units;
      }

      // Exclusion set
      const excluded = new Set([
        ...KNOWN_SYSTEM_ADDRESSES,
        ...ALWAYS_EXCLUDE_ADDRESSES,
        ...vestedSet,
      ]);

      // Auto proxy exclusion (flow-based)
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

      // Holders (pre-verify)
      let holderEntries = Object.entries(balances)
        .filter(([addr, bal]) =>
          bal > 0n &&
          addr !== contract &&
          !burnAddresses.has(addr) &&
          !excluded.has(addr) &&
          !pairSet.has(addr)
        )
        .map(([address, units]) => ({ address, units }));

      // Verify top holders (override if available; do not drop on null)
      holderEntries.sort((a,b)=> (b.units > a.units) ? 1 : (b.units < a.units) ? -1 : 0);
      const toVerify = holderEntries.slice(0, VERIFY_TOP_N).map(h => h.address);
      const verified = await verifyTopBalances(contract, toVerify);
      const verifiedSet = new Set(toVerify);
      const corrected = [];
      for (const h of holderEntries) {
        if (verifiedSet.has(h.address)) {
          const v = verified[h.address];
          if (v === null) corrected.push(h);
          else if (v === 0n) continue;
          else corrected.push({ address: h.address, units: v });
        } else {
          corrected.push(h);
        }
      }
      holderEntries = corrected;

      // Final holders for render
      holderEntries.sort((a,b)=> (b.units > a.units) ? 1 : (b.units < a.units) ? -1 : 0);
      const holders = holderEntries.slice(0, RENDER_TOP_N)
        .map(h => ({ ...h, pct: currentSupply > 0n ? pctUnits(h.units, currentSupply) : 0 }));

      const fullHoldersCount = holderEntries.length;
      const burnPctVsMinted   = minted > 0n ? pctUnits(burned, minted) : 0;

      // ===== First 20 real buys + enriched stats for matrix =====
      const first20 = findFirst20RealBuys({ txs, pairSet, excluded: new Set([...excluded, contract]) });

      const first20Enriched = first20.map((b) => {
        const addr = b.address;
        const initialUnits = b.initialUnits;               // BigInt
        const currentUnits = (balances[addr] || 0n);       // BigInt

        // Status
        let status = 'hold';
        if (currentUnits === 0n) status = 'soldAll';
        else if (currentUnits > initialUnits) status = 'more';
        else if (currentUnits < initialUnits) status = 'soldPart';

        // Deltas
        const soldUnits   = (initialUnits > currentUnits) ? (initialUnits - currentUnits) : 0n;
        const boughtUnits = (currentUnits > initialUnits) ? (currentUnits - initialUnits) : 0n;

        // Pcts (vs current supply)
        const initPct   = currentSupply > 0n ? pctUnits(initialUnits, currentSupply) : 0;
        const soldPct   = currentSupply > 0n ? pctUnits(soldUnits,   currentSupply) : 0;
        const boughtPct = currentSupply > 0n ? pctUnits(boughtUnits, currentSupply) : 0;

        return {
          address: addr,
          status,
          ts: b.ts,
          initialUnits, currentUnits, soldUnits, boughtUnits,
          initPct, soldPct, boughtPct
        };
      });

      // LP & VESTED nodes
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

      renderBubbleMap({
        tokenDecimals,
        holders: holders.map(h => ({ address: h.address, balance: toNum(h.units, tokenDecimals), pct: h.pct })),
        extras: [...lpNodes, ...vestedNodes],
        mintedUnits, burnedUnits, currentSupply,
        addrToBundle: {},         // (optional: funder colors)
        tgRecipients,
        lpPerPair, vestedPerAddr,
        stats: {
          holdersCount: fullHoldersCount,
          top10Pct: holders.slice(0,10).reduce((s,h)=>s+h.pct,0),
          creatorPct: (creatorAddress ? (holders.find(h => h.address.toLowerCase() === creatorAddress)?.pct || 0) : 0),
          creatorAddress,
          lpUnitsSum, lpPct,
          burnedUnits, burnPctVsMinted,
          vestedUnitsSum, vestedPct,
          first20Enriched,
        }
      });

      // Burn banner in the small header (unchanged)
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

  // ===== RENDERER =====
  function renderBubbleMap({
    tokenDecimals, holders, extras = [],
    mintedUnits, burnedUnits, currentSupply,
    addrToBundle, tgRecipients,
    lpPerPair, vestedPerAddr, stats
  }) {
    const mapRoot = document.getElementById('bubble-map');
    mapRoot.innerHTML = '';

    // --- Collapsible containers UI ---
    const ui = document.createElement('div');
    ui.innerHTML = `
      <style>
        .acc { border:1px solid #2a2a2a; border-radius:10px; margin-bottom:12px; overflow:hidden; }
        .acc-h { width:100%; text-align:left; background:#121212; color:#e6e6e6; padding:10px 12px; border:0; cursor:pointer; font-weight:600; display:flex; align-items:center; gap:8px; }
        .acc-h .arrow { transition: transform .2s ease; }
        .acc-b { padding:10px 12px; display:block; background:#0b0b0b; }
        .acc.collapsed .acc-b { display:none; }
        .acc.collapsed .acc-h .arrow { transform: rotate(-90deg); }
      </style>
      <div class="acc" id="acc-bubble">
        <button class="acc-h"><span class="arrow">▾</span> Bubble Map</button>
        <div class="acc-b"><div id="bubble-canvas"></div></div>
      </div>
      <div class="acc" id="acc-stats">
        <button class="acc-h"><span class="arrow">▾</span> Stats</button>
        <div class="acc-b"><div id="stats-body"></div></div>
      </div>
    `;
    mapRoot.appendChild(ui);

    // Toggle handlers
    ui.querySelectorAll('.acc .acc-h').forEach(btn => {
      btn.addEventListener('click', () => btn.parentElement.classList.toggle('collapsed'));
    });

    const bubbleEl = ui.querySelector('#bubble-canvas');
    const statsEl  = ui.querySelector('#stats-body');

    // --- Bubble Map (holders + extras) ---
    const width = mapRoot.offsetWidth || 960;
    const height = 640;
    const data = holders.concat(extras);

    const svg = d3.select(bubbleEl).append('svg')
      .attr('width', width)
      .attr('height', height);

    const pack = d3.pack().size([width, height]).padding(3);
    const root = d3.hierarchy({ children: data }).sum(d => d.balance);
    const nodes = pack(root).leaves();

    const distinctBundles = Array.from(new Set(Object.values(addrToBundle)));
    const bundleColor = d3.scaleOrdinal(d3.schemeTableau10).domain(distinctBundles);

    // Tooltip element (shared)
    let tip = d3.select('#bubble-tip');
    if (tip.empty()) {
      tip = d3.select('body').append('div').attr('id','bubble-tip')
        .style('position','fixed').style('background','#111').style('color','#fff')
        .style('padding','8px 10px').style('border','1px solid #333').style('border-radius','8px')
        .style('pointer-events','none').style('opacity',0).style('z-index',9999);
    }

    function ringColorFor(addr, type) {
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

    // --- Stats body (order updated) ---
    const lpLines = lpPerPair.map((p, i) =>
      `<div>• LP-${i+1} <span style="opacity:.8">(${p.address.slice(0,6)}...${p.address.slice(-4)})</span>: <strong>${(Number(p.units / (10n ** BigInt(tokenDecimals)))).toLocaleString()}</strong> tokens</div>`
    ).join('');
    const vestedLines = vestedPerAddr.map((v, i) =>
      `<div>• ${vestedPerAddr.length===1 ? 'VESTED' : `VESTED-${i+1}`} <span style="opacity:.8">(${v.address.slice(0,6)}...${v.address.slice(-4)})</span>: <strong>${(Number(v.units / (10n ** BigInt(tokenDecimals)))).toLocaleString()}</strong> tokens</div>`
    ).join('');

    const first20Matrix = buildFirst20Matrix(stats.first20Enriched, { tokenDecimals, currentSupply });

    statsEl.innerHTML = `
      <div style="padding-left:0" class="section-title">Stats</div>

      <div style="margin-top:4px"><strong>Pool info</strong></div>
      ${lpLines || '<div style="opacity:.8">No pools found.</div>'}

      <div style="margin-top:10px"><strong>Minted Tokens</strong></div>
      <div>${(Number(mintedUnits / (10n ** BigInt(tokenDecimals)))).toLocaleString()}</div>

      <div style="margin-top:10px"><strong>Burned Tokens</strong></div>
      <div>${(Number(burnedUnits / (10n ** BigInt(tokenDecimals)))).toLocaleString()} (<span>${(stats.burnPctVsMinted||0).toFixed(4)}%</span> of minted)</div>

      <div style="margin-top:10px"><strong>Holders</strong></div>
      <div>Displayed / Total: <strong>${holders.length}</strong> / <strong>${stats.holdersCount}</strong></div>

      <div style="margin-top:10px"><strong>Creator</strong></div>
      <div>${stats.creatorAddress ? `${stats.creatorAddress.slice(0,6)}...${stats.creatorAddress.slice(-4)}` : 'n/a'} — holds <strong>${stats.creatorPct.toFixed(4)}%</strong></div>

      <div style="margin-top:10px"><strong>Top 10 Holders</strong></div>
      <div>${stats.top10Pct.toFixed(4)}%</div>

      <div style="margin-top:10px"><strong>LP Totals</strong></div>
      <div><strong>${(Number(lpPerPair.reduce((s,x)=>s+x.units,0n) / (10n ** BigInt(tokenDecimals)))).toLocaleString()}</strong> tokens (<strong>${(stats.lpPct||0).toFixed(4)}%</strong> of current supply)</div>

      <div style="margin-top:10px"><strong>Vested Tokens</strong></div>
      <div><strong>${(Number(vestedPerAddr.reduce((s,x)=>s+x.units,0n) / (10n ** BigInt(tokenDecimals)))).toLocaleString()}</strong> tokens (<strong>${(stats.vestedPct||0).toFixed(4)}%</strong> of current supply)</div>
      ${vestedLines}

      <div style="margin-top:12px"><strong>First 20 buyers (Status)</strong></div>
      ${first20Matrix}

      <div style="opacity:.8;margin-top:10px">Rings — <span style="color:#FFD700">gold</span>: TG • <span style="color:#C4B5FD">lilac</span>: LP • <span style="color:#6EE7B7">mint</span>: VESTED</div>
      <div style="opacity:.6;margin-top:6px;font-size:.9em">*“First 20 buyers” = first 20 unique wallets to receive tokens from any LP (after router/aggregator hops) in on-chain order.</div>
    `;

    // Wire up matrix hover & click
    wireFirst20MatrixInteractions({ tokenDecimals, currentSupply });
  }

  function buildFirst20Matrix(list, { tokenDecimals, currentSupply }) {
    const colorFor = s =>
      s === 'hold' ? '#00ff9c' :
      s === 'soldPart' ? '#4ea3ff' :
      s === 'soldAll' ? '#ff4e4e' : '#ffd84e'; // 'more'

    const cells = list.map((b, idx) => {
      const short = b.address.slice(0,6)+'...'+b.address.slice(-4);
      const clr = colorFor(b.status);

      // Pre-format strings for dataset
      const initTok   = toNum(b.initialUnits, tokenDecimals).toLocaleString();
      const currTok   = toNum(b.currentUnits, tokenDecimals).toLocaleString();
      const soldTok   = toNum(b.soldUnits,   tokenDecimals).toLocaleString();
      const addTok    = toNum(b.boughtUnits, tokenDecimals).toLocaleString();

      const initPct   = (b.initPct  || 0).toFixed(4);
      const soldPct   = (b.soldPct  || 0).toFixed(4);
      const addPct    = (b.boughtPct|| 0).toFixed(4);

      return `
        <div class="cell"
             data-addr="${b.address}"
             data-status="${b.status}"
             data-init-tok="${initTok}"
             data-init-pct="${initPct}"
             data-curr-tok="${currTok}"
             data-sold-tok="${soldTok}"
             data-sold-pct="${soldPct}"
             data-add-tok="${addTok}"
             data-add-pct="${addPct}"
             title="${short}">
          <span class="dot" style="background:${clr}"></span>
          <span class="idx">${idx+1}</span>
        </div>
      `;
    }).join('');

    return `
      <style>
        #first20-matrix {
          display:grid;
          grid-template-columns: repeat(${FIRST20_MATRIX_COLS}, minmax(42px, 1fr));
          grid-auto-rows: 32px;
          gap: 8px;
          max-width: ${FIRST20_MATRIX_COLS*60}px;
          margin-top: 6px;
        }
        #first20-matrix .cell {
          display:flex; align-items:center; justify-content:center;
          border:1px solid #333; border-radius:6px; padding:2px 4px;
          background:#0b0b0b;
          font-size:12px; color:#ddd;
          cursor:pointer;
        }
        #first20-matrix .cell:hover { border-color:#666; }
        #first20-matrix .dot {
          width:10px; height:10px; border-radius:50%; display:inline-block; margin-right:6px;
        }
        #first20-matrix .idx { opacity:.85; }
      </style>
      <div id="first20-matrix">${cells}</div>
    `;
  }

  function wireFirst20MatrixInteractions({ tokenDecimals, currentSupply }) {
    const container = document.getElementById('first20-matrix');
    if (!container) return;

    // Reuse the shared tooltip
    let tip = d3.select('#bubble-tip');
    if (tip.empty()) {
      tip = d3.select('body').append('div').attr('id','bubble-tip')
        .style('position','fixed').style('background','#111').style('color','#fff')
        .style('padding','8px 10px').style('border','1px solid #333').style('border-radius','8px')
        .style('pointer-events','none').style('opacity',0).style('z-index',9999);
    }

    function showTip(evt, el) {
      const d = el.dataset;
      const addr = d.addr || '';
      const short = addr ? `${addr.slice(0,6)}...${addr.slice(-4)}` : '';
      const statusLabel =
        d.status === 'hold' ? 'Hold' :
        d.status === 'soldPart' ? 'Sold Part' :
        d.status === 'soldAll' ? 'Sold All' : 'Bought More';

      tip.html(`
        <div><strong>${short}</strong> — ${statusLabel}</div>
        <div style="margin-top:6px">
          <div>Initial buy: <strong>${d['initTok'] || d['init-tok']}</strong> (${d['initPct'] || d['init-pct']}%)</div>
          <div>Currently: <strong>${d['currTok'] || d['curr-tok']}</strong></div>
          <div>Sold: <strong>${d['soldTok'] || d['sold-tok']}</strong> (${d['soldPct'] || d['sold-pct']}%)</div>
          <div>Bought more: <strong>${d['addTok'] || d['add-tok']}</strong> (${d['addPct'] || d['add-pct']}%)</div>
        </div>
        <div style="opacity:.8;margin-top:6px">Click to open in explorer ↗</div>
      `)
      .style('left', (evt.clientX + 12) + 'px')
      .style('top', (evt.clientY + 12) + 'px')
      .style('opacity', 1);
    }
    function moveTip(evt) {
      tip.style('left', (evt.clientX + 12) + 'px').style('top', (evt.clientY + 12) + 'px');
    }
    function hideTip() {
      tip.style('opacity', 0);
    }

    container.onmouseover = (e) => {
      const cell = e.target.closest('.cell');
      if (!cell) return;
      showTip(e, cell);
    };
    container.onmousemove = (e) => {
      const cell = e.target.closest('.cell');
      if (!cell) return;
      moveTip(e);
    };
    container.onmouseleave = () => hideTip();
    container.onclick = (e) => {
      const cell = e.target.closest('.cell');
      if (!cell) return;
      const addr = cell.dataset.addr;
      if (addr) window.open(`${EXPLORER}/address/${addr}`, '_blank');
    };
  }
})();
