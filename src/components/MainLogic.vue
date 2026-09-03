<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'

const TARGET_PAIRS = [
  'BTC',
  'ETH',
  'SOL',
  'XRP',
  'DOGE',
  'BNB',
  'HYPE'
]

const CYCLE_SECONDS = 900 
const CYCLE_MINUTES = CYCLE_SECONDS / 60
const secondsRemaining = ref(CYCLE_SECONDS)
const lastUpdated = ref('')
const marketStatus = ref('SYNCING MARKET CLOCK')

let timerId = null
let flushTimerId = null
let rolloverCheckId = null
let pingIntervalId = null
let ws = null
let tokenToPairMap = {}
let serverTimeOffset = 0

const pendingPriceBuffer = {}

function getCycleWindow() {
  const now = Date.now() + serverTimeOffset
  const cycleMs = CYCLE_SECONDS * 1000
  const startMs = Math.floor(now / cycleMs) * cycleMs
  const endMs = startMs + cycleMs
  return { startMs, endMs }
}

const initialWindow = getCycleWindow()
const marketStartAt = ref(new Date(initialWindow.startMs))
const marketEndAt = ref(new Date(initialWindow.endMs))

const pairMarkets = ref({
  BTC: { up: null, down: null },
  ETH: { up: null, down: null },
  SOL: { up: null, down: null },
  XRP: { up: null, down: null },
  DOGE: { up: null, down: null },
  BNB: { up: null, down: null },
  HYPE: { up: null, down: null }
})

const formattedCountdown = computed(() => {
  const minutes = Math.floor(secondsRemaining.value / 60)
  const seconds = secondsRemaining.value % 60
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
})

function updateClock() {
  lastUpdated.value = new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })

  if (!marketEndAt.value) {
    marketStatus.value = 'SYNCING MARKET CLOCK'
    return
  }

  const now = Date.now() + serverTimeOffset
  const remainingMs = marketEndAt.value.getTime() - now
  secondsRemaining.value = Math.max(0, Math.ceil(remainingMs / 1000))

  if (remainingMs <= 0) {
    marketStatus.value = 'MARKET RESETTING'
  } else {
    marketStatus.value = 'LIVE MARKET SESSION'
  }
}

function startPing() {
  if (pingIntervalId) clearInterval(pingIntervalId)
  pingIntervalId = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send('PING') } catch (e) {}
    }
  }, 15000)
}

function stopPing() {
  if (pingIntervalId) {
    clearInterval(pingIntervalId)
    pingIntervalId = null
  }
}

function connectWebSocket(assetIds) {
  if (ws) {
    stopPing()
    try { ws.close() } catch (e) {}
    ws = null
  }

  if (!assetIds || assetIds.length === 0) return

  ws = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market')

  ws.onopen = () => {
    startPing()
    ws.send(JSON.stringify({
      type: 'market',
      assets_ids: assetIds
    }))
  }

  ws.onmessage = (event) => {
    if (event.data === 'PONG') return
    try {
      const parsed = JSON.parse(event.data)
      const messages = Array.isArray(parsed) ? parsed : [parsed]
      for (const msg of messages) {
        if (msg.event_type === 'price_change' && Array.isArray(msg.price_changes)) {
          for (const change of msg.price_changes) {
            const info = tokenToPairMap[change.asset_id]
            if (!info) continue

            const rawAsk = change.best_ask !== undefined ? (typeof change.best_ask === 'string' ? parseFloat(change.best_ask) : change.best_ask) : undefined
            const rawBid = change.best_bid !== undefined ? (typeof change.best_bid === 'string' ? parseFloat(change.best_bid) : change.best_bid) : undefined

            // Polymarket UI displays best_ask (execution buy price) or best_bid.
            // We ignore change.price as it represents individual depth limit orders rather than the top-of-book market price.
            const marketPrice = rawAsk ?? (rawBid !== undefined ? Number((rawBid + 0.01).toFixed(2)) : undefined)
            if (marketPrice === undefined || isNaN(marketPrice)) continue

            if (!pendingPriceBuffer[info.pair]) pendingPriceBuffer[info.pair] = {}
            pendingPriceBuffer[info.pair][info.side] = marketPrice
          }
        }
      }
    } catch (e) {}
  }

  ws.onerror = (err) => {
    console.error('Polymarket WebSocket error:', err)
  }

  ws.onclose = () => {
    stopPing()
  }
}

async function syncMarketsAndConnectWS() {
  const { startMs, endMs } = getCycleWindow()
  const eventTime = startMs / 1000
  const timeFrame = `${CYCLE_MINUTES}m`

  marketStartAt.value = new Date(startMs)
  marketEndAt.value = new Date(endMs)
  updateClock()

  tokenToPairMap = {}
  const assetIds = []
  let clockSyncedWithApi = false

  await Promise.all(
    TARGET_PAIRS.map(async (pair) => {
      const slug = `${pair.toLowerCase()}-updown-${timeFrame}-${eventTime}`
      const url = `https://gamma-api.polymarket.com/events?slug=${slug}`
      try {
        const t0 = Date.now()
        const res = await fetch(url, { cache: 'no-store' })
        const t1 = Date.now()
        if (!res.ok) return

        const dateHeader = res.headers.get('date')
        if (dateHeader) {
          const serverMs = new Date(dateHeader).getTime() + ((t1 - t0) / 2)
          serverTimeOffset = serverMs - t1
        }

        const data = await res.json()
        const event = Array.isArray(data) ? data[0] : data
        const market = event?.markets?.[0]
        if (!market) return

        const authoritativeEndDate = event?.endDate || market?.endDate
        if (!clockSyncedWithApi && authoritativeEndDate) {
          marketStartAt.value = market?.eventStartTime ? new Date(market.eventStartTime) : new Date(startMs)
          marketEndAt.value = new Date(authoritativeEndDate)
          clockSyncedWithApi = true
        }

        const outcomes = typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : market.outcomes
        const outcomePrices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices
        const clobTokenIds = typeof market.clobTokenIds === 'string' ? JSON.parse(market.clobTokenIds) : market.clobTokenIds

        let upIdx = outcomes?.findIndex(o => String(o).toLowerCase() === 'up') ?? 0
        let downIdx = outcomes?.findIndex(o => String(o).toLowerCase() === 'down') ?? 1
        if (upIdx === -1) upIdx = 0
        if (downIdx === -1) downIdx = 1

        const rawYes = outcomePrices?.[upIdx] !== undefined ? parseFloat(outcomePrices[upIdx]) : (market.bestBid ? parseFloat(market.bestBid) : 0.50)
        const rawNo = outcomePrices?.[downIdx] !== undefined ? parseFloat(outcomePrices[downIdx]) : (market.bestAsk ? parseFloat(market.bestAsk) : (1 - rawYes))

        const upPrice = Number((Math.max(0.01, Math.min(0.99, isNaN(rawYes) ? 0.50 : rawYes))).toFixed(2))
        const downPrice = Number((Math.max(0.01, Math.min(0.99, isNaN(rawNo) ? 0.50 : rawNo))).toFixed(2))

        pairMarkets.value[pair] = {
          up: upPrice,
          down: downPrice
        }
        if (!pendingPriceBuffer[pair]) pendingPriceBuffer[pair] = {}
        pendingPriceBuffer[pair].up = upPrice
        pendingPriceBuffer[pair].down = downPrice

        const upToken = clobTokenIds?.[upIdx]
        const downToken = clobTokenIds?.[downIdx]

        if (upToken) {
          assetIds.push(upToken)
          tokenToPairMap[upToken] = { pair, side: 'up' }
        }
        if (downToken) {
          assetIds.push(downToken)
          tokenToPairMap[downToken] = { pair, side: 'down' }
        }
      } catch (err) {
        console.error(`Error fetching market data for ${pair}:`, err)
      }
    })
  )

  updateClock()
  connectWebSocket(assetIds)
}

onMounted(() => {
  updateClock()
  syncMarketsAndConnectWS()

  timerId = setInterval(() => {
    updateClock()
  }, 1000)

  flushTimerId = setInterval(() => {
    for (const pair of TARGET_PAIRS) {
      if (pendingPriceBuffer[pair]) {
        if (pendingPriceBuffer[pair].up !== undefined && pairMarkets.value[pair].up !== pendingPriceBuffer[pair].up) {
          pairMarkets.value[pair].up = pendingPriceBuffer[pair].up
        }
        if (pendingPriceBuffer[pair].down !== undefined && pairMarkets.value[pair].down !== pendingPriceBuffer[pair].down) {
          pairMarkets.value[pair].down = pendingPriceBuffer[pair].down
        }
      }
    }
  }, 300)

  rolloverCheckId = setInterval(() => {
    const now = Date.now() + serverTimeOffset
    if (marketEndAt.value && now >= marketEndAt.value.getTime()) {
      syncMarketsAndConnectWS()
    }
  }, 1000)
})

onUnmounted(() => {
  if (timerId) clearInterval(timerId)
  if (flushTimerId) clearInterval(flushTimerId)
  if (rolloverCheckId) clearInterval(rolloverCheckId)
  stopPing()
  if (ws) {
    try { ws.close() } catch (e) {}
  }
})
</script>

<template>
  <div>
    <div>{{ formattedCountdown }}</div>
    <div v-for="pair in TARGET_PAIRS" :key="pair">
      <div>{{ pair }}: Up {{ pairMarkets[pair]?.up ?? '...' }} | Down {{ pairMarkets[pair]?.down ?? '...' }}</div>
    </div>
  </div>
</template>