const axios = require('axios');

const ETHERSCAN_API = "H13F5VZ64YYK4M21QMPEW78SIKJS85UTWT";
const BASE_URL = 'https://api.etherscan.io/v2/api';
const WETH_CONTRACT = '0x000000000000000000000000000000000000800a';

async function getTokenTrades(address) {
  const result = [];
  const lowerAddress = address.toLowerCase();
  const tokenTransfers = [];
  const ethTransfers = [];
  const wethTransfers = [];

  try {
    // 1. Get token transfers (all tokens including WETH)
    const tokenResp = await axios.get(BASE_URL, {
      params: {
        chainid: 2741,
        module: 'account',
        action: 'tokentx',
        address,
        startblock: 0,
        endblock: 99999999,
        sort: 'asc',
        apikey: ETHERSCAN_API
      }
    });
    const txs = tokenResp.data.result;
    if (!Array.isArray(txs)) return result;

    for (const tx of txs) {
      const decimals = parseInt(tx.tokenDecimal) || 18;
      const amount = parseFloat(tx.value) / Math.pow(10, decimals);
      const entry = {
        hash: tx.hash,
        token: tx.tokenSymbol || tx.tokenName || 'UNKNOWN',
        tokenAddress: tx.contractAddress,
        timestamp: parseInt(tx.timeStamp),
        amount,
        from: tx.from.toLowerCase(),
        to: tx.to.toLowerCase()
      };
      if (entry.tokenAddress === WETH_CONTRACT) wethTransfers.push(entry);
      else tokenTransfers.push(entry);
    }

    // 2. Get ETH txs
    const ethResp = await axios.get(BASE_URL, {
      params: {
        chainid: 2741,
        module: 'account',
        action: 'txlist',
        address,
        startblock: 0,
        endblock: 99999999,
        sort: 'asc',
        apikey: ETHERSCAN_API
      }
    });

    const ethTxs = ethResp.data.result;
    ethTxs.forEach(tx => {
      ethTransfers.push({
        hash: tx.hash,
        timestamp: parseInt(tx.timeStamp),
        from: tx.from.toLowerCase(),
        to: tx.to.toLowerCase(),
        value: parseFloat(tx.value) / 1e18
      });
    });

    // 3. Match token txs with ETH/WETH txs
    for (const ttx of tokenTransfers) {
      const isBuy = ttx.to === lowerAddress;
      const isSell = ttx.from === lowerAddress;
      const type = isBuy ? 'buy' : isSell ? 'sell' : null;
      if (!type) continue;

      let ethValue = 0;
      const matchHash = (tx) => tx.hash === ttx.hash;
      const matchTime = (tx) => Math.abs(tx.timestamp - ttx.timestamp) <= 5;

      if (type === 'buy') {
        const ethTx = ethTransfers.find(matchHash) || ethTransfers.find(matchTime);
        if (ethTx && ethTx.from === lowerAddress) ethValue = ethTx.value;
      }

      if (type === 'sell') {
        const matchingWETH = wethTransfers.filter(t => t.to === lowerAddress && Math.abs(t.timestamp - ttx.timestamp) <= 5);
        ethValue = matchingWETH.reduce((sum, tx) => sum + tx.amount, 0);
      }

      const isoDate = new Date(ttx.timestamp * 1000).toISOString();
      result.push({
        token: ttx.token,
        tokenAddress: ttx.tokenAddress,
        timestamp: isoDate,
        amount: ttx.amount,
        ethValue,
        type
      });
    }

    return result.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  } catch (err) {
    console.error('Error fetching or processing trades:', err.message);
    return result;
  }
}

module.exports = getTokenTrades;
