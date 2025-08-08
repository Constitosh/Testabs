require('dotenv').config();
const express = require('express');
const getTokenTrades = require('./getTokenTrades');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.static('public'));
app.use(express.json());

app.get('/api/pnl', async (req, res) => {
  const address = req.query.address?.toLowerCase();
  if (!address) return res.status(400).json({ error: 'No address provided' });

  try {
    const txs = await getTokenTrades(address);
    const grouped = {};

    txs.forEach(tx => {
      if (
        !tx.token ||
        !tx.tokenAddress ||
        typeof tx.amount !== 'number' ||
        typeof tx.ethValue !== 'number' ||
        !tx.type
      ) return;

      const key = tx.tokenAddress.toLowerCase();

      if (!grouped[key]) {
        grouped[key] = {
          token: tx.token,
          tokenAddress: tx.tokenAddress,
          buys: [],
          sells: []
        };
      }

      grouped[key][tx.type === 'buy' ? 'buys' : 'sells'].push(tx);
    });

    const summary = Object.values(grouped).map(group => {
      const totalBuyETH = group.buys.reduce((sum, t) => sum + t.ethValue, 0);
      const totalSellETH = group.sells.reduce((sum, t) => sum + t.ethValue, 0);
      const totalTokensBought = group.buys.reduce((sum, t) => sum + t.amount, 0);
      const totalTokensSold = group.sells.reduce((sum, t) => sum + t.amount, 0);

      const avgBuyPrice = totalTokensBought > 0 ? totalBuyETH / totalTokensBought : 0;
      const avgSellPrice = totalTokensSold > 0 ? totalSellETH / totalTokensSold : 0;

      const pnl = totalSellETH - totalBuyETH;
      const pct = totalBuyETH > 0 ? (pnl / totalBuyETH) * 100 : 0;

      return {
        token: group.token,
        tokenAddress: group.tokenAddress,
        totalTokensBought,
        totalTokensSold,
        totalBuyETH,
        totalSellETH,
        avgBuyPrice,
        avgSellPrice,
        pnl,
        pct
      };
    });

    res.json(summary);
  } catch (err) {
    console.error('PNL error:', err.message);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});


app.listen(PORT, '0.0.0.0', () =>
  console.log(`Server running on http://0.0.0.0:${PORT}`)
);

