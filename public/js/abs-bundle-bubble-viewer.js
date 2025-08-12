/*
  Totally ABS Bundle Bubble Viewer — FIXED precision, correct % bases, LP from balances
  -------------------------------------------------------------------------------------
  - All token math in BigInt (raw units). Convert only for UI.
  - Burn % shown vs MINTED supply (correct).
  - LP % shown vs CURRENT supply (minted − burned).
  - LP balance read from final balances map (exact), not re-summed stream.
  - Token decimals treated as constant (taken from first transfer).
  - Bundles computed with exact units; no >100% artifacts.
*/

(() => {
  const API_KEY = "H13F5VZ64YYK4M21QMPEW78SIKJS85UTWT";
  const BASE = "https://api.etherscan.io/v2/api"; // ABS-compatible
  const CHAIN_ID = 2741;
  const EXPLORER = "https://explorer.mainnet.abs.xyz";

  // TG bot (recipients only)
  const TG_BOT_ADDRESS = "0x1c4ae91dfa56e49fca849ede553759e1f5f04d9f".toLowerCase();

  // Proxy detection (auto) + small static list (TG bot included)
  const PROXY_BLOCKLIST = new Set([TG_BOT_ADDRESS]);
  const PROXY_MIN_DISTINCT_RECIPIENTS = 8;
  const PROXY_END_BALANCE_EPS = 0n; // with BigInt units we can require 0 strictly
  const PROXY_OUTFLOW_SHARE_NUM = 90n; // 90%
  const PROXY_OUTFLOW_SHARE_DEN = 100n;

  const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
  const DEAD_ADDR = "0x000000000000000000000000000000000000dead";
  const burnAddresses = new Set([ZERO_ADDR, DEAD_ADDR]);

  const RENDER_TOP_N = 500;

  // ---------- helpers ----------
  function toUnitsBig(valueStr) {
    // value is already in raw smallest units (Etherscan tokentx.value)
    // but it may be a decimal string; use BigInt safely
    return BigInt(valueStr);
  }

  function scaleToDecimalStr(unitsBI, decimals) {
    // Convert BigInt units -> decimal string with up to 18 digits after dot (trimmed)
    const neg = unitsBI < 0n;
    const u = neg ? -unitsBI : unitsBI;
    const base = 10n ** BigInt(decimals);
    const intPart = u / base;
    const fracPart = u % base;
    if (fracPart === 0n) return (neg ? "-" : "") + intPart.toString();

    // pad leading zeros in fractional part to length = decimals
    let frac = fracPart.toString().padStart(decimals, "0");
    // trim trailing zeros
    frac = frac.replace(/0+$/, "");
    return (neg ? "-" : "") + intPart.toString() + "." + frac;
  }

  function toNumber(unitsBI, decimals) {
    // Only for UI and percentage math; safe because we bound precision when displaying
    // Use string conversion to avoid JS float on huge ints, then parseFloat
    return parseFloat(scaleToDecimalStr(unitsBI, decimals));
  }

  function pct(num, den) {
    if (den === 0) return 0;
    return (num / den) * 100;
  }

  // Safe div for ratios with BigInt (returns JS number percentage)
  function pctUnits(numBI, denBI) {
    if (denBI === 0n) return 0;
    // scale to preserve precision
    const SCALE = 1_000_000n;
    const q = (numBI * SCALE) / denBI; // scaled ratio
    return Number(q) / 10_000; // -> percentage with 2 decimals+ precision
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

    // 1) LP/Pair address (Dexscreener)
    let pairAddress = null;
    try {
      const pairRes = await fetch(`https://api.dexscreener.com/token-pairs/v1/abstract/${contract}`);
      const pairData = await pairRes.json();
      if (Array.isArray(pairData) && pairData[0]?.pairAddress) {
        pairAddress = pairData[0].pairAddress.toLowerCase().replace(":moon", "");
      }
    } catch (e) {
      console.warn('DexScreener fetch error:', e);
    }

    try {
      // 2) Token transfers (ascending)
      const txUrl = `${BASE}?chainid=${CHAIN_ID}&module=account&action=tokentx&contractaddress=${contract}&startblock=0&endblock=99999999&sort=asc&apikey=${API_KEY}`;
      const txRes = await fetch(txUrl);
      const txData = await txRes.json();
      if (!Array.isArray(txData?.result) || txData.result.length === 0) {
        throw new Error('No transactions found for this contract.');
      }
      const txs = txData.result;

      // Token decimals (treat as constant per token)
      const tokenDecimals = Math.max(0, parseInt(txs[0].tokenDecimal || "18", 10) || 18);

      // 3) Creator address
      let creatorAddress = '';
      try {
        const cUrl = `${BASE}?chainid=${CHAIN_ID}&module=contract&action=getcontractcreation&contractaddresses=${contract}&apikey=${API_KEY}`;
        const cRes = await fetch(cUrl);
        const cData = await cRes.json();
        creatorAddress = (Array.isArray(cData?.result) && cData.result[0]?.contractCreator)
          ? cData.result[0].contractCreator.toLowerCase() : '';
      } catch {}

      // 4) Build balances + supply + heuristics (BigInt units)
      const balances = {};           // address -> BigInt
      const connections = {};
      let burnedUnits = 0n;
      let mintedUnits = 0n;

      const sendRecipients = {}; // addr -> Set(to)
      const inflow = {};         // addr -> BigInt in
      const outflow = {};        // addr -> BigInt out

      const tgRecipients = new Set();

      for (const tx of txs) {
        const from = (tx.from || tx.fromAddress).toLowerCase();
        const to   = (tx.to   || tx.toAddress).toLowerCase();
        const units = toUnitsBig(tx.value); // raw token units (BigInt)

        // Heuristic stats (BigInt tracked)
        if (!sendRecipients[from]) sendRecipients[from] = new Set();
        sendRecipients[from].add(to);
        inflow[to]    = (inflow[to]    || 0n) + units;
        outflow[from] = (outflow[from] || 0n) + units;

        // TG recipients
        if (from === TG_BOT_ADDRESS) tgRecipients.add(to);

        // minted / burned (units)
        if (from === ZERO_ADDR) mintedUnits += units;
        if (burnAddresses.has(to)) burnedUnits += units;

        // skip contract self-moves from balances
        if (from === contract || to === contract) continue;

        // balances (exclude burn sinks only)
        if (!burnAddresses.has(from)) balances[from] = (balances[from] || 0n) - units;
        if (!burnAddresses.has(to))   balances[to]   = (balances[to]   || 0n) + units;

        // graph
        if (!connections[from]) connections[from] = new Set();
        if (!connections[to])   connections[to]   = new Set();
        connections[from].add(to);
        connections[to].add(from);
      }

      // Auto-detect proxies
      const proxyAddresses = new Set(PROXY_BLOCKLIST);
      for (const addr of Object.keys(sendRecipients)) {
        const recipients = sendRecipients[addr]?.size || 0;
        const endBal = balances[addr] || 0n;
        const out = outflow[addr] || 0n;
        const inn = inflow[addr] || 0n;
        const flow = out + inn;

        // outShare >= 90% ?
        const outShareOK = flow === 0n
          ? false
          : (out * PROXY_OUTFLOW_SHARE_DEN) >= (PROXY_OUTFLOW_SHARE_NUM * flow);

        if (recipients >= PROXY_MIN_DISTINCT_RECIPIENTS &&
            endBal === PROXY_END_BALANCE_EPS &&
            outShareOK) {
          proxyAddresses.add(addr);
        }
      }

      // ---------- SUPPLY ----------
      const minted = mintedUnits;                  // BigInt
      const burned = burnedUnits;                  // BigInt
      const currentSupply = minted >= burned ? (minted - burned) : 0n;

      // ---------- LP balance (from final balances) ----------
      let lpUnits = 0n;
      if (pairAddress) {
        lpUnits = balances[pairAddress] || 0n;
        if (lpUnits < 0n) lpUnits = 0n; // clamp
      }

      // ---------- Circulating (tracked) ----------
      const circulatingTrackedUnits = Object.entries(balances)
        .filter(([addr, bal]) =>
          bal > 0n &&
          addr !== contract &&
          (!pairAddress || addr !== pairAddress) &&
          !burnAddresses.has(addr) &&
          !proxyAddresses.has(addr)
        )
        .reduce((s, [, bal]) => s + bal, 0n);

      // ---------- Holders list (exclude LP, burn, proxies, contract) ----------
      const allHoldersUnsorted = Object.entries(balances)
        .filter(([addr, bal]) =>
          bal > 0n &&
          addr !== contract &&
          (!pairAddress || addr !== pairAddress) &&
          !burnAddresses.has(addr) &&
          !proxyAddresses.has(addr)
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

      // ---------- Percentages ----------
      const lpPct = currentSupply > 0n ? pctUnits(lpUnits, currentSupply) : 0;
      const burnPctVsMinted = minted > 0n ? pctUnits(burned, minted) : 0; // correct base

      if (burned > 0n) {
        pairInfoEl.innerHTML += `<span style="color:#ff4e4e">🔥 Burn — ${toNumber(burned, tokenDecimals).toLocaleString(undefined,{maximumFractionDigits:18})} tokens (${burnPctVsMinted.toFixed(4)}% of minted)</span>`;
      }

      // 6) First 20 buyers (exclude mints)
      const buyerSeen = new Set();
      const first20 = [];
      for (const t of txs) {
        const from = (t.from || t.fromAddress).toLowerCase();
        const to   = (t.to   || t.toAddress).toLowerCase();
        if (from === ZERO_ADDR) continue; // mint
        if (!buyerSeen.has(to)) { buyerSeen.add(to); first20.push(t); }
        if (first20.length >= 20) break;
      }

      const tokenTxCount = {};
      for (const t of txs) {
        const f = (t.from || t.fromAddress).toLowerCase();
        const to = (t.to || t.toAddress).toLowerCase();
        tokenTxCount[f] = (tokenTxCount[f] || 0) + 1;
        tokenTxCount[to] = (tokenTxCount[to] || 0) + 1;
      }

      // 7) FUNDING-BASED BUNDLES (native transfers near first buy)
      //    Store the token UNITS at first buy for each of the first20 buyers
      const amountOnFirstBuyUnits = {};
      const firstBuyTsByBuyer = {};
      for (const t of first20) {
        const to = (t.to || t.toAddress).toLowerCase();
        amountOnFirstBuyUnits[to] = toUnitsBig(t.value); // raw units
        firstBuyTsByBuyer[to] = Number(t.timeStamp);
      }

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

      const funderByBuyer = {};
      for (const buyer of Object.keys(firstBuyTsByBuyer)) {
        const funder = await findFunderNative(buyer, firstBuyTsByBuyer[buyer]);
        if (funder) funderByBuyer[buyer] = funder;
      }

      const bundles = {};
      for (const [buyer, funder] of Object.entries(funderByBuyer)) {
        if (!bundles[funder]) bundles[funder] = new Set();
        bundles[funder].add(buyer);
      }

      const bundlesTotals = Object.entries(bundles).map(([funder, set]) => {
        const buyers = Array.from(set);
        const tokensUnits = buyers.reduce((s, b) => s + (amountOnFirstBuyUnits[b] || 0n), 0n);
        const pctOfCurrent = currentSupply > 0n ? pctUnits(tokensUnits, currentSupply) : 0;
        return { funder, buyers, tokensUnits, pctOfCurrent };
      }).sort((a,b) => (b.tokensUnits > a.tokensUnits ? 1 : b.tokensUnits < a.tokensUnits ? -1 : 0));

      const bundlesAggregateUnits = bundlesTotals.reduce((s, b) => s + b.tokensUnits, 0n);
      const bundlesAggregatePctOfCurrent = currentSupply > 0n ? pctUnits(bundlesAggregateUnits, currentSupply) : 0;

      // 8) First 20 buyers statuses (vs current balances)
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

      // 9) Stats & render
      const holdersWithPct = holders;

      const top10Pct = holdersWithPct.slice().sort((a,b)=>b.pct-a.pct).slice(0,10).reduce((s,h)=>s+h.pct,0);
      const creatorPct = creatorAddress
        ? (holdersWithPct.find(h => h.address.toLowerCase() === creatorAddress)?.pct || 0)
        : 0;

      const addrToBundle = Object.fromEntries(Object.entries(bundles).flatMap(
        ([funder, set]) => Array.from(set).map(buyer => [buyer, funder])
      ));

      const tgInHolders = holdersWithPct.filter(h => tgRecipients.has(h.address)).length;
      const tgInFirst20 = first20Enriched.filter(b => tgRecipients.has(b.address)).length;

      // Synthesize an LP node for display (purple)
      const lpNode = pairAddress ? [{
        address: pairAddress,
        units: lpUnits,
        pct: currentSupply > 0n ? pctUnits(lpUnits, currentSupply) : 0,
        __type: 'lp'
      }] : [];

      renderBubbleMap({
        tokenDecimals,
        holders: holdersWithPct.map(h => ({ address: h.address, balance: toNumber(h.units, tokenDecimals), pct: h.pct })),
        extras: lpNode.map(n => ({ address: n.address, balance: toNumber(n.units, tokenDecimals), pct: n.pct, __type: 'lp' })),
        mintedUnits,
        burnedUnits,
        currentSupply,
        circulatingTrackedUnits,
        addrToBundle,
        tgRecipients,
        stats: {
          holdersCount: fullHoldersCount,
          top10Pct,
          creatorPct,
          creatorAddress,
          lpUnits,
          lpPct,
          burnedUnits,
          burnPctVsMinted,
          first20Enriched,
          lt10Count,
          bundlesCount: Object.keys(bundles).length,
          bundlesAggregateUnits,
          bundlesAggregatePctOfCurrent,
          topBundles: bundlesTotals.slice(0, 3)
        }
      });
    } catch (err) {
      console.error(err);
      mapEl.innerHTML = '<p>Error loading holders.</p>';
    }
  };

  // Renderer (unchanged visually; accepts numbers for balances/pcts and BigInt-derived stats converted inside)
  function renderBubbleMap({ tokenDecimals, holders, extras = [], mintedUnits, burnedUnits, currentSupply, circulatingTrackedUnits, addrToBundle, tgRecipients, stats }) {
    const mapEl = document.getElementById('bubble-map');
    mapEl.innerHTML = '';

    const width = mapEl.offsetWidth || 960;
    const height = 640;

    const data = holders.concat(extras); // include LP node if present

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

    g.append('circle')
      .attr('r', d => d.r)
      .attr('fill', d => {
        if (d.data.__type === 'lp') return '#8B5CF6'; // purple LP
        const bundle = addrToBundle[d.data.address];
        return bundle ? color(bundle) : '#4b5563';
      })
      .attr('stroke', d => {
        if (d.data.__type === 'lp') return '#C4B5FD';
        return tgRecipients.has(d.data.address) ? '#FFD700' : null;
      })
      .attr('stroke-width', d => (d.data.__type === 'lp' || tgRecipients.has(d.data.address)) ? 2.5 : null)
      .on('mouseover', function (event, d) {
        const isLP = d.data.__type === 'lp';
        const bundle = addrToBundle[d.data.address];
        const isTG = tgRecipients.has(d.data.address);

        if (!isLP) {
          g.selectAll('circle')
            .attr('opacity', node => bundle ? (addrToBundle[node.data.address] === bundle ? 1 : 0.15) : 1)
            .attr('stroke', node => {
              if (node.data.__type === 'lp') return '#C4B5FD';
              const inSame = bundle && addrToBundle[node.data.address] === bundle;
              const nodeTG = tgRecipients.has(node.data.address);
              return nodeTG ? '#FFD700' : (inSame ? '#FFD700' : d3.select(this).attr('stroke') || null);
            })
            .attr('stroke-width', node => {
              if (node.data.__type === 'lp') return 2.5;
              return tgRecipients.has(node.data.address) ? 2.5 : (bundle && addrToBundle[node.data.address] === bundle ? 2 : null);
            });
        }

        tip.html(
          isLP
            ? `<div><strong>LP</strong> — ${Number(stats.lpUnits / (10n ** BigInt(tokenDecimals)))} tokens</div>
               <div>${stats.lpPct.toFixed(4)}% of current supply</div>
               <div style="opacity:.8;margin-top:6px">Click to open in explorer ↗</div>`
            : `<div><strong>${d.data.pct.toFixed(4)}% of current supply</strong></div>
               <div>${d.data.balance.toLocaleString()} tokens</div>
               <div>${d.data.address.slice(0,6)}...${d.data.address.slice(-4)}</div>
               ${bundle ? `<div style="opacity:.8">Bundle funder: ${bundle.slice(0,6)}...${bundle.slice(-4)}</div>` : ''}
               <div style="opacity:.8">TG bot: ${isTG ? 'yes' : 'no'}</div>
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
          .attr('stroke', d => d.data.__type === 'lp' ? '#C4B5FD' : (tgRecipients.has(d.data.address) ? '#FFD700' : null))
          .attr('stroke-width', d => (d.data.__type === 'lp' || tgRecipients.has(d.data.address)) ? 2.5 : null);
      })
      .on('click', (event, d) => {
        window.open(`${EXPLORER}/address/${d.data.address}`, '_blank');
      });

    // Labels: % for holders; "LP" for LP node
    g.append('text')
      .attr('dy', '.35em')
      .style('text-anchor', 'middle')
      .style('font-size', d => Math.min(d.r * 0.5, 16))
      .style('fill', '#fff')
      .style('pointer-events', 'none')
      .text(d => d.data.__type === 'lp' ? 'LP' : `${d.data.pct.toFixed(2)}%`);

    // === Stats panel ===
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

    const topBundlesHtml = stats.topBundles.map(b =>
      `<div>Bundle ${b.funder.slice(0,6)}...${b.funder.slice(-4)}: ${(Number(b.tokensUnits / (10n ** BigInt(tokenDecimals)))).toLocaleString()} tokens (${b.pctOfCurrent.toFixed(4)}%) across ${b.buyers.length} wallets</div>`
    ).join('');

    const statsDiv = document.createElement('div');
    statsDiv.style.marginTop = '10px';
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
      <div>LP balance: <strong>${(Number(stats.lpUnits / (10n ** BigInt(tokenDecimals)))).toLocaleString()}</strong> tokens
        (<strong>${stats.lpPct.toFixed(4)}%</strong> of current supply)</div>
      <div>Bundles detected: <strong>${stats.bundlesCount}</strong> main funders</div>
      <div>Bundles bought (first 20): <strong>${(Number(stats.bundlesAggregateUnits / (10n ** BigInt(tokenDecimals)))).toLocaleString()}</strong> tokens
        (<strong>${stats.bundlesAggregatePctOfCurrent.toFixed(4)}%</strong> of current supply)</div>
      ${topBundlesHtml ? `<div style="margin-top:6px">${topBundlesHtml}</div>` : ''}
      <div style="margin-top:10px">Among first 20 buyers, <strong>${stats.lt10Count}</strong> have &lt; 10 token tx.</div>
      <div style="margin-top:8px">First 20 buyers status: ${legend}</div>
      <div style="opacity:.8;margin-top:6px">Purple bubble = LP • Gold ring = received tokens from TG bot</div>
      <div style="opacity:.6;margin-top:6px;font-size:.9em">*Circulating (tracked) excludes LP, contract, burn sinks, and detected proxies.</div>
    `;
    mapEl.appendChild(statsDiv);
  }
})();
