<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { GoogleGenAI } from '@google/genai'

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
let aiEvalTimerId = null
let ws = null
let tokenToPairMap = {}
let serverTimeOffset = 0
let genAI = null

const pendingPriceBuffer = {}

const INITIAL_BALANCE = 30.00
const walletBalance = ref(parseFloat(localStorage.getItem('paper_wallet_balance') || String(INITIAL_BALANCE)))
const transactionLogs = ref(JSON.parse(localStorage.getItem('paper_transaction_logs') || '[]'))
const activePositions = ref(JSON.parse(localStorage.getItem('paper_active_positions') || '[]'))


function getGeminiClient() {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY
  if (!apiKey || apiKey.includes('your_gemini')) return null
  if (!genAI) {
    genAI = new GoogleGenAI({ apiKey })
  }
  return genAI
}

function saveWalletState() {
  localStorage.setItem('paper_wallet_balance', walletBalance.value.toFixed(2))
  localStorage.setItem('paper_transaction_logs', JSON.stringify(transactionLogs.value))
  localStorage.setItem('paper_active_positions', JSON.stringify(activePositions.value))
}

function resetWallet() {
  walletBalance.value = INITIAL_BALANCE
  transactionLogs.value = []
  activePositions.value = []
  saveWalletState()
}

function recordTransactionLog(currency, amount, status, rationale = '') {
  const logEntry = {
    id: 'tx_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
    currency,
    amount: typeof amount === 'number' ? `$${amount.toFixed(2)}` : amount,
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    status,
    walletBalance: `$${walletBalance.value.toFixed(2)}`,
    rationale
  }
  transactionLogs.value.unshift(logEntry)
  if (transactionLogs.value.length > 50) transactionLogs.value.pop()
  saveWalletState()
}

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
  BTC: { up: null, down: null, strike: null, yesToken: null, noToken: null, marketId: null, question: null },
  ETH: { up: null, down: null, strike: null, yesToken: null, noToken: null, marketId: null, question: null },
  SOL: { up: null, down: null, strike: null, yesToken: null, noToken: null, marketId: null, question: null },
  XRP: { up: null, down: null, strike: null, yesToken: null, noToken: null, marketId: null, question: null },
  DOGE: { up: null, down: null, strike: null, yesToken: null, noToken: null, marketId: null, question: null },
  BNB: { up: null, down: null, strike: null, yesToken: null, noToken: null, marketId: null, question: null },
  HYPE: { up: null, down: null, strike: null, yesToken: null, noToken: null, marketId: null, question: null }
})

const spotData = ref({
  BTC: { price: 79500, rsi: 50, momentum: 'NEUTRAL', volatility: 1.5 },
  ETH: { price: 2500, rsi: 50, momentum: 'NEUTRAL', volatility: 1.5 },
  SOL: { price: 104, rsi: 50, momentum: 'NEUTRAL', volatility: 1.5 },
  XRP: { price: 1.43, rsi: 50, momentum: 'NEUTRAL', volatility: 1.5 },
  DOGE: { price: 0.088, rsi: 50, momentum: 'NEUTRAL', volatility: 1.5 },
  BNB: { price: 707, rsi: 50, momentum: 'NEUTRAL', volatility: 1.5 },
  HYPE: { price: 82, rsi: 50, momentum: 'NEUTRAL', volatility: 1.5 }
})

const aiSignals = ref({
  BTC: { action: 'HOLD', edge: 0, prob: 0.5, rationale: 'Syncing AI signal...' },
  ETH: { action: 'HOLD', edge: 0, prob: 0.5, rationale: 'Syncing AI signal...' },
  SOL: { action: 'HOLD', edge: 0, prob: 0.5, rationale: 'Syncing AI signal...' },
  XRP: { action: 'HOLD', edge: 0, prob: 0.5, rationale: 'Syncing AI signal...' },
  DOGE: { action: 'HOLD', edge: 0, prob: 0.5, rationale: 'Syncing AI signal...' },
  BNB: { action: 'HOLD', edge: 0, prob: 0.5, rationale: 'Syncing AI signal...' },
  HYPE: { action: 'HOLD', edge: 0, prob: 0.5, rationale: 'Syncing AI signal...' }
})

const formattedCountdown = computed(() => {
  const minutes = Math.floor(secondsRemaining.value / 60)
  const seconds = secondsRemaining.value % 60
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
})

function calculateBlackScholesProb(spot, strike, minutesToExpiry, volatility) {
  if (!spot || !strike) return 0.5
  const t = Math.max(1, minutesToExpiry) / (365 * 24 * 60)
  const sigma = Math.max(0.2, (volatility / 100) * Math.sqrt(365 * 24 * 4))
  const d2 = (Math.log(spot / strike) - 0.5 * Math.pow(sigma, 2) * t) / (sigma * Math.sqrt(t))
  
  const cdf = (x) => {
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911
    const sign = x < 0 ? -1 : 1
    const absX = Math.abs(x) / Math.sqrt(2)
    const tConst = 1.0 / (1.0 + p * absX)
    const y = 1.0 - (((((a5 * tConst + a4) * tConst + a3) * tConst + a2) * tConst + a1) * tConst) * Math.exp(-absX * absX)
    return 0.5 * (1.0 + sign * y)
  }
  const prob = cdf(d2)
  return Number(Math.max(0.05, Math.min(0.95, prob)).toFixed(2))
}

async function evaluateAllGeminiAI() {
  for (const pair of TARGET_PAIRS) {
    const market = pairMarkets.value[pair]
    const spot = spotData.value[pair]
    if (!market || !spot || !market.up || !market.down) continue

    const strike = market.strike || spot.price
    const minutesToExpiry = Math.max(1, Math.floor(secondsRemaining.value / 60))
    const mathProb = calculateBlackScholesProb(spot.price, strike, minutesToExpiry, spot.volatility)

    const yesEdge = Number(((mathProb - market.up) * 100).toFixed(1))
    const noEdge = Number((((1 - mathProb) - market.down) * 100).toFixed(1))

    let action = 'HOLD'
    if (yesEdge >= 5.0) action = 'BUY_YES'
    else if (noEdge >= 5.0) action = 'BUY_NO'

    const edgeVal = action === 'BUY_YES' ? yesEdge : (action === 'BUY_NO' ? noEdge : 0)
    aiSignals.value[pair] = {
      action,
      edge: edgeVal,
      prob: mathProb,
      rationale: `15m volatility ${spot.volatility}% & Black-Scholes model signal ${(mathProb * 100).toFixed(0)}% fair prob vs Polymarket's ${(market.up * 100).toFixed(0)}% (Edge: ${edgeVal > 0 ? '+' : ''}${edgeVal}%).`
    }
  }

  const client = getGeminiClient()
  if (client) {
    const pairsInfo = TARGET_PAIRS.map(pair => {
      const m = pairMarkets.value[pair]
      const s = spotData.value[pair]
      if (!m || !s || !m.up || !m.down) return null
      return `${pair}: Spot=$${s.price}, Strike=$${m.strike || s.price}, UpPrice=$${m.up}, DownPrice=$${m.down}`
    }).filter(Boolean)

    if (pairsInfo.length > 0) {
      const promptText = `You are an autonomous quantitative crypto trader specializing in 15-minute prediction markets.
Analyze these live target pairs and return your evaluation in strict JSON format:
${pairsInfo.join('\n')}
Time Remaining: ${Math.floor(secondsRemaining.value / 60)} minutes (${secondsRemaining.value} seconds)

Return ONLY valid JSON mapping pair to signal:
{
  "BTC": { "calculatedProbability": 0.58, "recommendedAction": "BUY_YES", "rationale": "Spot crossing strike." },
  "ETH": { "calculatedProbability": 0.50, "recommendedAction": "HOLD", "rationale": "Fairly priced." },
  "SOL": { "calculatedProbability": 0.51, "recommendedAction": "HOLD", "rationale": "Neutral momentum." },
  "XRP": { "calculatedProbability": 0.48, "recommendedAction": "HOLD", "rationale": "Fairly priced." },
  "DOGE": { "calculatedProbability": 0.53, "recommendedAction": "HOLD", "rationale": "Slight upward bias." },
  "BNB": { "calculatedProbability": 0.50, "recommendedAction": "HOLD", "rationale": "Neutral." },
  "HYPE": { "calculatedProbability": 0.65, "recommendedAction": "BUY_YES", "rationale": "Strong 15m momentum." }
}`

    const candidateModels = ['gemini-flash-latest', 'gemini-3.6-flash', 'gemini-2.5-flash']
for (const modelName of candidateModels) {
  try {
    const result = await client.models.generateContent({
      model: modelName,
      contents: promptText,
      config: { temperature: 0.2 }
    })
    let rawText = result.text.trim()
          if (rawText.startsWith('```json')) rawText = rawText.replace(/^```json/, '').replace(/```$/, '').trim()
          if (rawText.startsWith('```')) rawText = rawText.replace(/^```/, '').replace(/```$/, '').trim()
          const parsed = JSON.parse(rawText)

          for (const pair of TARGET_PAIRS) {
            if (parsed[pair] && pairMarkets.value[pair] && pairMarkets.value[pair].up) {
              const item = parsed[pair]
              const calcProb = Math.max(0.05, Math.min(0.95, parseFloat(item.calculatedProbability || 0.5)))
              const recAction = item.recommendedAction || 'HOLD'
              const yesEdge = Number(((calcProb - pairMarkets.value[pair].up) * 100).toFixed(1))
              const noEdge = Number((((1 - calcProb) - pairMarkets.value[pair].down) * 100).toFixed(1))
              const edgePercent = recAction === 'BUY_NO' ? noEdge : yesEdge

              aiSignals.value[pair] = {
                action: recAction,
                edge: edgePercent,
                prob: calcProb,
                rationale: item.rationale || aiSignals.value[pair].rationale
              }
            }
          }
          break
        } catch (e) {}
      }
    }
  }

  for (const pair of TARGET_PAIRS) {
    const sig = aiSignals.value[pair]
    const m = pairMarkets.value[pair]
    if (sig && m && sig.action !== 'HOLD' && sig.edge >= 5.0 && secondsRemaining.value >= 180) {
      const tradeOutcome = sig.action === 'BUY_YES' ? 'YES' : 'NO'
      const entryPrice = tradeOutcome === 'YES' ? m.up : m.down
      const currentWindowTs = getCycleWindow().startMs
      const existing = activePositions.value.find(p => p.pair === pair && p.windowTs === currentWindowTs && p.status === 'OPEN')
      if (!existing && entryPrice) {
        executePaperTrade(pair, 'BUY', tradeOutcome, entryPrice, 5.00, sig.rationale)
      }
    }
    checkDualLegArbitrage(pair)
  }
}

function executePaperTrade(pair, side, outcome, price, sizeUSDC, rationale = '') {
  // If balance is insufficient, skip trade silently without logging failure
  if (walletBalance.value < sizeUSDC) {
    return false
  }

  walletBalance.value = Number((walletBalance.value - sizeUSDC).toFixed(2))
  const shares = Number((sizeUSDC / price).toFixed(2))
  const windowTs = getCycleWindow().startMs

  const newPosition = {
    id: 'pos_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
    pair,
    side,
    outcome,
    entryPrice: price,
    shares,
    sizeUSDC,
    windowTs,
    strikePrice: pairMarkets.value[pair]?.strike || spotData.value[pair]?.price,
    cycleEndMs: marketEndAt.value.getTime(),
    status: 'OPEN'
  }

  activePositions.value.push(newPosition)
  recordTransactionLog(pair, sizeUSDC, 'SUCCESS', `Filled ${side} ${outcome} ${shares} shares @ $${price}. ${rationale}`)
  saveWalletState()
  return true
}

function checkDualLegArbitrage(pair) {
  const windowTs = getCycleWindow().startMs
  const market = pairMarkets.value[pair]
  if (!market || !market.up || !market.down) return

  const pairPositions = activePositions.value.filter(p => p.pair === pair && p.windowTs === windowTs && p.status === 'OPEN')
  if (pairPositions.length !== 1) return

  const leg1 = pairPositions[0]
  const oppositeOutcome = leg1.outcome === 'YES' ? 'NO' : 'YES'
  const oppositePrice = oppositeOutcome === 'YES' ? market.up : market.down
  const combinedCost = Number((leg1.entryPrice + oppositePrice).toFixed(2))

  if (combinedCost <= 0.95 && oppositePrice > 0.01) {
    const leg2Cost = Number((leg1.shares * oppositePrice).toFixed(2))
    const spreadPercent = Number(((1.0 - combinedCost) * 100).toFixed(1))
    executePaperTrade(
      pair,
      'BUY',
      oppositeOutcome,
      oppositePrice,
      leg2Cost,
      `Dual-Leg Risk-Free Arbitrage Locked: Matched ${leg1.shares} ${oppositeOutcome} @ $${oppositePrice} with ${leg1.outcome} @ $${leg1.entryPrice}. Combined cost $${combinedCost} (+${spreadPercent}% spread).`
    )
  }
}

async function settleExpiredPositions() {
  const nowMs = Date.now() + serverTimeOffset
  const expiredPositions = activePositions.value.filter(p => p.status === 'OPEN' && p.cycleEndMs <= nowMs)

  if (expiredPositions.length === 0) return

  for (const pos of expiredPositions) {
    const currentSpot = spotData.value[pos.pair]?.price
    if (!currentSpot || !pos.strikePrice) continue

    const isWon = pos.outcome === 'YES' ? currentSpot >= pos.strikePrice : currentSpot < pos.strikePrice

    if (isWon) {
      const payout = Number((pos.shares * 1.00).toFixed(2))
      const pnl = Number((payout - pos.sizeUSDC).toFixed(2))
      walletBalance.value = Number((walletBalance.value + payout).toFixed(2))
      pos.status = 'SETTLED_WON'
      recordTransactionLog(pos.pair, payout, 'SUCCESS', `Settled WIN: Spot $${currentSpot} vs Strike $${pos.strikePrice}. Payout $${payout} (Profit: +$${pnl})`)
    } else {
      pos.status = 'SETTLED_LOST'
      recordTransactionLog(pos.pair, pos.sizeUSDC, 'FAILURE', `Settled LOSS: Spot $${currentSpot} vs Strike $${pos.strikePrice}. Loss -$${pos.sizeUSDC.toFixed(2)}`)
    }
  }

  activePositions.value = activePositions.value.filter(p => p.status === 'OPEN')
  saveWalletState()
}

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

async function syncSpotPrices() {
  try {
    const res = await fetch('https://api.gateio.ws/api/v4/spot/tickers')
    if (!res.ok) return
    const data = await res.json()
    if (Array.isArray(data)) {
      for (const item of data) {
        for (const sym of TARGET_PAIRS) {
          if (item.currency_pair === `${sym}_USDT`) {
            const price = parseFloat(item.last)
            if (spotData.value[sym]) {
              spotData.value[sym].price = price
            }
          }
        }
      }
    }
  } catch (e) {}
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

  await syncSpotPrices()

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
          down: downPrice,
          strike: spotData.value[pair]?.price || null,
          yesToken: clobTokenIds?.[upIdx],
          noToken: clobTokenIds?.[downIdx],
          marketId: market.id,
          question: market.question
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

  aiEvalTimerId = setInterval(() => {
    syncSpotPrices()
    evaluateAllGeminiAI()
  }, 15000)

  setTimeout(() => {
    evaluateAllGeminiAI()
  }, 3000)

  rolloverCheckId = setInterval(() => {
    const now = Date.now() + serverTimeOffset
    if (marketEndAt.value && now >= marketEndAt.value.getTime()) {
      settleExpiredPositions()
      syncMarketsAndConnectWS()
    }
  }, 1000)
})

onUnmounted(() => {
  if (timerId) clearInterval(timerId)
  if (flushTimerId) clearInterval(flushTimerId)
  if (aiEvalTimerId) clearInterval(aiEvalTimerId)
  if (rolloverCheckId) clearInterval(rolloverCheckId)
  stopPing()
  if (ws) {
    try { ws.close() } catch (e) {}
  }
})
</script>

<template>
  <div>
    <div>Countdown: {{ formattedCountdown }}</div>
    <div>Wallet Balance: ${{ walletBalance.toFixed(2) }}</div>
    <div>
      <button @click="resetWallet">Reset Wallet Balance ($30.00)</button>
    </div>

    <div>Market Prices & AI Signals:</div>
    <div v-for="pair in TARGET_PAIRS" :key="pair">
      <div>
        {{ pair }}: Up {{ pairMarkets[pair]?.up ?? '...' }} | Down {{ pairMarkets[pair]?.down ?? '...' }}
        | Spot: ${{ spotData[pair]?.price ?? '...' }}
        | AI Signal: {{ aiSignals[pair]?.action ?? 'HOLD' }} (Edge: {{ aiSignals[pair]?.edge }}%)
        <button @click="executePaperTrade(pair, 'BUY', 'YES', pairMarkets[pair]?.up || 0.5, 5.00, 'Manual Buy Up')">Buy Up ($5.00)</button>
        <button @click="executePaperTrade(pair, 'BUY', 'NO', pairMarkets[pair]?.down || 0.5, 5.00, 'Manual Buy Down')">Buy Down ($5.00)</button>
      </div>
    </div>

    <div>Active / Running Trades:</div>
    <table>
      <thead>
        <tr>
          <th>Currency</th>
          <th>Outcome</th>
          <th>Entry Price</th>
          <th>Shares</th>
          <th>Amount ($)</th>
          <th>Strike Price</th>
          <th>Cycle End</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="pos in activePositions" :key="pos.id">
          <td>{{ pos.pair }}</td>
          <td>BUY {{ pos.outcome }}</td>
          <td>${{ pos.entryPrice }}</td>
          <td>{{ pos.shares }}</td>
          <td>${{ pos.sizeUSDC.toFixed(2) }}</td>
          <td>${{ pos.strikePrice }}</td>
          <td>{{ new Date(pos.cycleEndMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }}</td>
          <td>{{ pos.status }}</td>
        </tr>
        <tr v-if="activePositions.length === 0">
          <td colspan="8">No active running trades.</td>
        </tr>
      </tbody>
    </table>

    <div>Transaction History:</div>
    <table>
      <thead>
        <tr>
          <th>Currency</th>
          <th>Amount</th>
          <th>Time</th>
          <th>Status</th>
          <th>Wallet Balance</th>
          <th>Rationale</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="log in transactionLogs" :key="log.id">
          <td>{{ log.currency }}</td>
          <td>{{ log.amount }}</td>
          <td>{{ log.time }}</td>
          <td>{{ log.status }}</td>
          <td>{{ log.walletBalance }}</td>
          <td>{{ log.rationale }}</td>
        </tr>
        <tr v-if="transactionLogs.length === 0">
          <td colspan="6">No transactions recorded yet.</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>