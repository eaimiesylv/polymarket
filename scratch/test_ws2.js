async function testWs() {
  const nowMs = Date.now();
  const windowMs = 15 * 60 * 1000;
  const windowTsSec = Math.floor(nowMs / windowMs) * 900;
  console.log('windowTsSec:', windowTsSec);

  const symbols = ['btc', 'eth', 'sol', 'xrp', 'doge', 'bnb', 'hype'];
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
          console.log(`Found ${sym.toUpperCase()}: UP=${clob[0].slice(0, 10)}..., DOWN=${clob[1].slice(0, 10)}...`);
        }
      }
    } catch (e) {
      console.error(e);
    }
  }

  if (typeof WebSocket !== 'undefined') {
    console.log('\nConnecting to Polymarket WS (wss://ws-subscriptions-clob.polymarket.com/ws/market)...');
    const ws = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');

    ws.onopen = () => {
      console.log('⚡ Connected to Polymarket WebSocket!');
      ws.send(JSON.stringify({
        type: 'market',
        assets_ids: tokenIds
      }));
    };

    ws.onmessage = (event) => {
      if (event.data === 'PONG') return;
      try {
        const parsed = JSON.parse(event.data);
        console.log('🔔 WS Tick Event:', JSON.stringify(parsed).slice(0, 200));
      } catch (e) {
        console.log('WS Msg:', event.data);
      }
    };
  } else {
    console.log('Global WebSocket is available in Browser UI!');
  }
}

testWs();
