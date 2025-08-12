/*
  ABS Bundle Bubble Viewer — correct supply %, LP bubble, TG + proxy filter
  ------------------------------------------------------------------------
  - Percentages use TRUE current supply: sum(positive balances) + LP + burned
  - LP shows as a purple bubble labeled "LP"
  - TG recipients ringed in gold; proxies auto-filtered from holders
  - Stats: holders count, burn %, LP %, top10, bundles, etc.
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
  const PROXY_END_BALANCE_EPS = 1e-12;
  const PROXY_OUTFLOW_SHARE = 0.90;

  const burnAddresses = new Set([
    "0x0000000000000000000000000000000000000000",
    "0x000000000000000000000000000000000000dead"
  ]);

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

    // 1) LP/Pair address
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
      if (!Array.isArray(txData?.result)) throw new Error('No transactions found for this contract.');
      const txs = txData.result;

      // 3) Creator address
      let creatorAddress = '';
      try {
        const cUrl = `${BASE}?chainid=${CHAIN_ID}&module=contract&action=getcontractcreation&contractaddresses=${contract}&apikey=${API_KEY}`;
        const cRes = await fetch(cUrl);
        const cData = await cRes.json();
        creatorAddress = (Array.isArray(cData?.result) && cData.result[0]?.contractCreator)
          ? cData.result[0].contractCreator.toLowerCase() : '';
      } catch {}

      // 4) Build balances/graph + burn + TG + proxy stats + LP balance
      const balances = {};           // running balances for all addresses (except contract itself)
      const connections = {};
      let burnedAmount = 0;
      let pairTokenBalance = 0;

      // Heuristics
      const sendRecipients = {}; // addr -> Set(to)
      const inflow = {};         // addr -> tokens in
      const outflow = {};        // addr -> tokens out

      // TG recipients
      const tgRecipients = new Set();

      for (const tx of txs) {
        const decimals = parseInt(tx.tokenDecimal) || 18;
        const amount = parseFloat(tx.value) / Math.pow(10, decimals);
        const from = (tx.from || tx.fromAddress).toLowerCase();
        const to   = (tx.to   || tx.toAddress).toLowerCase();

        // Heuristic stats
        if (!sendRecipients[from]) sendRecipients[from] = new Set();
        sendRecipients[from].add(to);
        inflow[to]    = (inflow[to]    || 0) + amount;
        outflow[from] = (outflow[from] || 0) + amount;

        // LP balance tracking
        if (pairAddress) {
          if (to === pairAddress)   pairTokenBalance += amount;
          if (from === pairAddress) pairTokenBalance -= amount;
        }

        // TG: tag recipients only
        if (from === TG_BOT_ADDRESS) tgRecipients.add(to);

        // burn
        if (burnAddresses.has(to)) burnedAmount += amount;

        // skip contract self-moves
        if (from === contract || to === contract) continue;

        // NOTE: we do NOT skip pair here, because we want a truthful global supply later.
        // We'll exclude the pair only when building the "holders" list for display.

        // balances
        if (!burnAddresses.has(from)) balances[from] = (balances[from] || 0) - amount;
        if (!burnAddresses.has(to))   balances[to]   = (balances[to]   || 0) + amount;

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
        const endBal = Math.abs(balances[addr] || 0);
        const out = outflow[addr] || 0;
        const inn = inflow[addr] || 0;
        const flow = out + inn;
        const outShare = flow > 0 ? (out / flow) : 0;

        if (
          recipients >= PROXY_MIN_DISTINCT_RECIPIENTS &&
          endBal <= PROXY_END_BALANCE_EPS &&
          outShare >= PROXY_OUTFLOW_SHARE
        ) {
          proxyAddresses.add(addr);
        }
      }

      // ---------- TRUE current supply ----------
      // Sum of ALL positive balances (including pair/proxies/etc.) + burned
      const sumPosBalances = Object.entries(balances)
        .filter(([addr, bal]) => bal > 0 && addr !== contract)
        .reduce((s, [, bal]) => s + bal, 0);

      const pairBalanceClamped = Math.max(0, pairTokenBalance);
      const trueSupply = sumPosBalances + pairBalanceClamped + burnedAmount;

      // ---------- Build display holders (exclude pair, proxies, burns, contract) ----------
      const holders = Object.entries(balances)
        .filter(([addr, bal]) =>
          bal > 0 &&
          addr !== contract &&
          (!pairAddress || addr !== pairAddress) &&
          !burnAddresses.has(addr) &&
          !proxyAddresses.has(addr)
        )
        .sort((a, b) => b[1] - a[1])
        .slice(0, 500)
        .map(([address, balance]) => ({ address, balance }));

      // LP percent + Burn percent (now based on TRUE supply)
      const lpPct = trueSupply > 0 ? (pairBalanceClamped / trueSupply) * 100 : 0;
      const burnPct = trueSupply > 0 ? (burnedAmount / trueSupply) * 100 : 0;

      if (burnedAmount > 0) {
        pairInfoEl.innerHTML += `<span style="color:#ff4e4e">🔥 Burn — ${burnedAmount.toLocaleString()} tokens (${burnPct.toFixed(4)}% of supply)</span>`;
      }

      // 6) First 20 buyers (exclude mints)
      const buyerSeen = new Set();
      const first20 = [];
      for (const t of txs) {
        const from = (t.from || t.fromAddress).toLowerCase();
        const to   = (t.to   || t.toAddress).toLowerCase();
        if (burnAddresses.has(from)) continue; // mint
        if (!buyerSeen.has(to)) { buyerSeen.add(to); first20.push(t); }
        if (first20.length >= 20) break;
      }

      // Token tx counts per address
      const tokenTxCount = {};
      for (const t of txs) {
        const f = (t.from || t.fromAddress).toLowerCase();
        const to = (t.to || t.toAddress).toLowerCase();
        tokenTxCount[f] = (tokenTxCount[f] || 0) + 1;
        tokenTxCount[to] = (tokenTxCount[to] || 0) + 1;
      }

      // 7) FUNDING-BASED BUNDLES (native transfers)
      const firstBuyMeta = {};
      for (const t of first20) {
        const to = (t.to || t.toAddress).toLowerCase();
        firstBuyMeta[to] = {
          ts: Number(t.timeStamp),
          dec: Number(t.tokenDecimal) || 18,
          raw: Number(t.value)
        };
      }

      const funderByBuyer = {};
      const amountOnFirstBuy = {};
      for (const buyer of Object.keys(firstBuyMeta)) {
        const fm = firstBuyMeta[buyer];
        amountOnFirstBuy[buyer] = fm.raw / Math.pow(10, fm.dec);
        const funder = await findFunderNative(buyer, fm.ts);
        if (funder) funderByBuyer[buyer] = funder;
      }

      const bundles = {};
      for (const [buyer, funder] of Object.entries(funderByBuyer)) {
        if (!bundles[funder]) bundles[funder] = new Set();
        bundles[funder].add(buyer);
      }

      const bundleTotals = Object.entries(bundles).map(([funder, set]) => {
        const buyers = Array.from(set);
        const tokens = buyers.reduce((s, b) => s + (amountOnFirstBuy[b] || 0), 0);
        const pct = trueSupply ? (tokens / trueSupply) * 100 : 0;
        return { funder, buyers, tokens, pct };
      }).sort((a,b) => b.tokens - a.tokens);

      const bundlesAggregateTokens = bundleTotals.reduce((s, b) => s + b.tokens, 0);
      const bundlesAggregatePct = trueSupply ? (bundlesAggregateTokens / trueSupply) * 100 : 0;

      // 8) First 20 buyers statuses (vs current balances)
      const first20Enriched = [];
      let lt10Count = 0;
      for (const t of first20) {
        const addr = (t.to || t.toAddress).toLowerCase();
        const initial = (Number(t.value) / Math.pow(10, Number(t.tokenDecimal) || 18)) || 0;
        const current = balances[addr] || 0;
        const txCount = tokenTxCount[addr] || 0;
        if (txCount < 10) lt10Count++;

        let status = 'hold';
        if (current === 0) status = 'soldAll';
        else if (current > initial) status = 'more';
        else if (current < initial) status = 'soldPart';

        first20Enriched.push({ address: addr, status });
      }

      // 9) Stats & render
      const holdersWithPct = holders.map(h => ({
        ...h,
        pct: trueSupply ? (h.balance / trueSupply) * 100 : 0
      }));

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
        balance: Math.max(pairBalanceClamped, trueSupply * 0.000001 || 0.000001), // tiny if 0
        pct: trueSupply ? (pairBalanceClamped / trueSupply) * 100 : 0,
        __type: 'lp'
      }] : [];

      renderBubbleMap({
        holders: holdersWithPct,
        extras: lpNode,
        trueSupply,
        addrToBundle,
        tgRecipients,
        stats: {
          holdersCount: holdersWithPct.length,
          top10Pct,
          creatorPct,
          creatorAddress,
          lpTokens: pairBalanceClamped,
          lpPct,
          burnedAmount,
          burnPct,
          first20Enriched,
          lt10Count,
          bundlesCount: Object.keys(bundles).length,
          bundlesAggregateTokens,
          bundlesAggregatePct,
          topBundles: bundleTotals.slice(0, 3)
        }
      });
    } catch (err) {
      console.error(err);
      mapEl.innerHTML = '<p>Error loading holders.</p>';
    }
  };

  // Native funder near first buy
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
        if ((t.to || '').toLowerCase() === buyer && Number(t.value) > 0) {
          if (ts >= beforeWindow && ts <= afterWindow) best = t;
          else if (ts < beforeWindow) best = t;
        }
      }
      return best ? (best.from || '').toLowerCase() : null;
    } catch {
      return null;
    }
  }

  // Renderer
  function renderBubbleMap({ holders, extras = [], trueSupply, addrToBundle, tgRecipients, stats }) {
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
            ? `<div><strong>LP</strong> — ${stats.lpTokens.toLocaleString()} tokens</div>
               <div>${stats.lpPct.toFixed(4)}% of supply</div>
               <div style="opacity:.8;margin-top:6px">Click to open in explorer ↗</div>`
            : `<div><strong>${d.data.pct.toFixed(4)}% of supply</strong></div>
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
      `<div>Bundle ${b.funder.slice(0,6)}...${b.funder.slice(-4)}: ${b.tokens.toLocaleString()} tokens (${b.pct.toFixed(4)}%) across ${b.buyers.length} wallets</div>`
    ).join('');

    const statsDiv = document.createElement('div');
    statsDiv.style.marginTop = '10px';
    statsDiv.innerHTML = `
      <div class="section-title" style="padding-left:0">Stats</div>
      <div>Holders: <strong>${stats.holdersCount}</strong></div>
      <div>Top 10 holders: <strong>${stats.top10Pct.toFixed(4)}%</strong></div>
      <div>Creator (${stats.creatorAddress ? stats.creatorAddress.slice(0,6)+'...'+stats.creatorAddress.slice(-4) : 'n/a'}) holding:
        <strong>${stats.creatorPct.toFixed(4)}%</strong></div>
      <div>LP balance: <strong>${stats.lpTokens.toLocaleString()}</strong> tokens
        (<strong>${stats.lpPct.toFixed(4)}%</strong> of supply)</div>
      <div>🔥 Burn: <strong>${stats.burnedAmount.toLocaleString()}</strong> tokens
        (<strong>${stats.burnPct.toFixed(4)}%</strong> of supply)</div>
      <div>Bundles detected: <strong>${stats.bundlesCount}</strong> main funders</div>
      <div>Bundles bought: <strong>${stats.bundlesAggregateTokens.toLocaleString()}</strong> tokens
        (<strong>${stats.bundlesAggregatePct.toFixed(4)}%</strong> of supply)</div>
      ${topBundlesHtml ? `<div style="margin-top:6px">${topBundlesHtml}</div>` : ''}
      <div style="margin-top:10px">Among first 20 buyers, <strong>${stats.lt10Count}</strong> have &lt; 10 token tx.</div>
      <div style="margin-top:8px">First 20 buyers status: ${legend}</div>
      <div style="opacity:.8;margin-top:6px">Purple bubble = LP • Gold ring = received tokens from TG bot</div>
    `;
    mapEl.appendChild(statsDiv);
  }
})();
