async function checkLive15mSlugs() {
  const nowMs = Date.now();
  const windowMs = 15 * 60 * 1000;
  const startTsSec = Math.floor(nowMs / windowMs) * 900;
  const endTsSec = startTsSec + 900;

  console.log('Current Date:', new Date(nowMs).toISOString());
  console.log('startTsSec (window start):', startTsSec, new Date(startTsSec * 1000).toISOString());
  console.log('endTsSec (window end):', endTsSec, new Date(endTsSec * 1000).toISOString());

  // Search Polymarket Gamma API for active up or down markets
  try {
    const res = await fetch('https://gamma-api.polymarket.com/events?limit=50&active=true&closed=false');
    const events = await res.json();
    console.log('\nSearching events for "Up or Down" or "15m"...');

    const matched = events.filter(e => {
      const title = (e.title || '').toLowerCase();
      const slug = (e.slug || '').toLowerCase();
      return title.includes('up or down') || title.includes('15m') || slug.includes('updown');
    });

    console.log(`Found ${matched.length} matching events:`);
    matched.forEach(e => {
      console.log('--- Event ---');
      console.log('  Slug:', e.slug);
      console.log('  Title:', e.title);
      console.log('  Markets count:', e.markets?.length);
      if (e.markets && e.markets.length > 0) {
        const m = e.markets[0];
        console.log('  Market question:', m.question);
        console.log('  Market outcomePrices:', m.outcomePrices);
        console.log('  Market outcomes:', m.outcomes);
        console.log('  Market clobTokenIds:', m.clobTokenIds);
        console.log('  Market bestBid:', m.bestBid, 'bestAsk:', m.bestAsk);
      }
    });
  } catch (e) {
    console.error('Error fetching events:', e);
  }

  // Also query specifically with q=BTC
  try {
    const res2 = await fetch('https://gamma-api.polymarket.com/events?q=BTC&active=true&closed=false');
    const events2 = await res2.json();
    console.log('\nSearching events q=BTC:');
    events2.forEach(e => {
      if (e.title?.toLowerCase().includes('up or down') || e.slug?.includes('btc-updown')) {
        console.log('  Slug:', e.slug, '| Title:', e.title);
        if (e.markets?.length > 0) {
          console.log('    outcomePrices:', e.markets[0].outcomePrices);
          console.log('    clobTokenIds:', e.markets[0].clobTokenIds);
        }
      }
    });
  } catch (e) {
    console.error(e);
  }
}

checkLive15mSlugs();
