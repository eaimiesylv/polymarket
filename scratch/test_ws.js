import WebSocket from 'ws';

async function testWs() {
  const nowMs = Date.now();
  const windowMs = 15 * 60 * 1000;
  const windowTsSec = Math.floor(nowMs / windowMs) * 900;
  console.log('windowTsSec:', windowTsSec);

  const symbols = ['btc', 'eth', 'sol'];
  const tokenIds = [];
  const tokenMap = {};

  for (const sym of symbols) {
    const slug = `${sym}-updown-15m-${windowTsSec}`;
    try {
      const res = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
      const data = await res.json();
      if (data.length > 0 && data[0].markets) {
        const m = data[0].markets[0];
        let clob = m.clobTokenIds;
        if (typeof clob === 'string') clob = JSON.parse(clob);
        if (Array.isArray(clob) && clob.length >= 2) {
          tokenIds.push(clob[0], clob[1]);
          tokenMap[clob[0]] = { sym, outcome: 'UP' };
          tokenMap[clob[1]] = { sym, outcome: 'DOWN' };
          console.log(`Discovered ${sym}: UP token=${clob[0]}, DOWN token=${clob[1]}`);
        }
      }
    } catch (e) {
      console.error(e);
    }
  }

  console.log('Connecting to Polymarket WS with asset_ids:', tokenIds);
  const ws = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');

  ws.on('open', () => {
    console.log('WS Connected!');
    ws.send(JSON.stringify({
      type: 'market',
      assets_ids: tokenIds
    }));
  });

  ws.on('message', (data) => {
    const str = data.toString();
    if (str === 'PONG') return;
    try {
      const parsed = JSON.parse(str);
      console.log('WS MSG Received:', JSON.stringify(parsed, null, 2).slice(0, 300));
    } catch (e) {
      console.log('RAW WS MSG:', str);
    }
  });

  setTimeout(() => {
    ws.close();
    process.exit(0);
  }, 10000);
}

testWs();
