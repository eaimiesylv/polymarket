<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'

// --- CONSTANTS & CONFIGURATION ---
const MAX_TOTAL_CAPITAL = 10.00 // Strictly enforced maximum total capital ($10)
const CYCLE_DURATION_SEC = 900 // 15 minutes = 900 seconds
const TARGET_PAIRS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE']
const STORAGE_KEY_TRADES = 'arbitrage_lab_trades_v1'
const STORAGE_KEY_CONFIG = 'arbitrage_lab_config_v1'

const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY || ''

// --- REACTIVE STATE & PERSISTENCE ---
const isRunning = ref(true)
const trades = ref([])
const activeTrades = ref([])
const spotPrices = ref({})
const polymarketData = ref({})
const isPollingPolymarket = ref(false)
const isWsConnected = ref(false)
const wsStatusText = ref('CONNECTING...')
const tokenToPairMap = new Map()
const flashTickMap = ref({})
let polyWs = null
let wsPingInterval = null
let wsReconnectTimer = null
const subscribedTokenIds = new Set()
const latestSignals = ref([])
const secondsRemaining = ref(900)
const cycleExpiry = ref(new Date())
const windowTs = ref(0)
const currentPage = ref(1)
const itemsPerPage = ref(6)
const isEvaluating = ref(false)

// Initial state recovery from localStorage
onMounted(() => {
  try {
    const savedTrades = localStorage.getItem(STORAGE_KEY_TRADES)
    if (savedTrades) {
      trades.value = JSON.parse(savedTrades)
    }
    const savedConfig = localStorage.getItem(STORAGE_KEY_CONFIG)
    if (savedConfig) {
      const cfg = JSON.parse(savedConfig)
      if (typeof cfg.isRunning === 'boolean') isRunning.value = cfg.isRunning
    }
  } catch (e) {
    console.error('Failed to load storage:', e)
  }

  connectPolymarketWs()
  startOrchestrator()
})

// Sync trades to reactive localStorage whenever trades update
watch(
  trades,
  (newTrades) => {
    try {
      localStorage.setItem(STORAGE_KEY_TRADES, JSON.stringify(newTrades))
    } catch (e) {
      console.error('Storage write error:', e)
    }
  },
  { deep: true }
)

watch(isRunning, (val) => {
  try {
    localStorage.setItem(STORAGE_KEY_CONFIG, JSON.stringify({ isRunning: val }))
  } catch (e) {
    console.error('Config write error:', e)
  }
})

// --- COMPUTED FINANCIAL & PAGINATION METRICS ---
const totalCommittedCapital = computed(() => {
  return activeTrades.value.reduce((sum, t) => sum + (t.stakeUsd || 0), 0)
})

const availableCapital = computed(() => {
  return Math.max(0, Number((MAX_TOTAL_CAPITAL - totalCommittedCapital.value).toFixed(2)))
})

const totalRealizedPnl = computed(() => {
  return trades.value.reduce((sum, t) => sum + (t.realizedPnl || 0), 0)
})

const winCount = computed(() => {
  return trades.value.filter((t) => t.status === 'WON' || t.status === 'HEDGED_WIN').length
})

const totalResolved = computed(() => {
  return trades.value.filter((t) => t.status !== 'OPEN').length
})

const winRate = computed(() => {
  if (totalResolved.value === 0) return 0
  return Math.round((winCount.value / totalResolved.value) * 100)
})

// Paginated trade log calculation
const totalPages = computed(() => {
  return Math.max(1, Math.ceil(trades.value.length / itemsPerPage.value))
})

const paginatedTrades = computed(() => {
  const sorted = [...trades.value].reverse()
  const start = (currentPage.value - 1) * itemsPerPage.value
  return sorted.slice(start, start + itemsPerPage.value)
})

const formattedCountdown = computed(() => {
  const m = Math.floor(secondsRemaining.value / 60)
  const s = secondsRemaining.value % 60
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
})

// --- BLACK-SCHOLES & MATHEMATICAL PROBABILITY MODEL ---
function calculateLognormalProbability(spot, strike, minutesLeft, vol = 1.5) {
  const t = Math.max(1, minutesLeft) / (365 * 24 * 60)
  const sigma = Math.max(0.2, (vol / 100) * Math.sqrt(365 * 24 * 4))
  const d2 = (Math.log(spot / strike) - 0.5 * Math.pow(sigma, 2) * t) / (sigma * Math.sqrt(t))

  // Cumulative Normal Distribution (CDF) Approximation
  const cdf = (x) => {
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911
    const sign = x < 0 ? -1 : 1
    const absX = Math.abs(x) / Math.sqrt(2)
    const tConst = 1.0 / (1.0 + p * absX)
    const y = 1.0 - (((((a5 * tConst + a4) * tConst + a3) * tConst + a2) * tConst + a1) * tConst) * Math.exp(-absX * absX)
    return 0.5 * (1.0 + sign * y)
  }

  const probAbove = Math.max(0.05, Math.min(0.95, cdf(d2)))
  return Number(probAbove.toFixed(3))
}



// --- POLYMARKET SERVER TIME SYNC & EXACT 15M CYCLE CALCULATION ---
let polymarketTimeOffset = 0 // Offset between Polymarket server UTC & browser local clock
const userClockOffsetSec = ref(-2) // Calibrated -2s offset to match Polymarket Web UI display (05:40)

function adjustClockOffset(deltaSec) {
  userClockOffsetSec.value += deltaSec
  updateClock()
}

async function syncPolymarketTime() {
  try {
    const reqStart = Date.now()
    const res = await fetch('https://gamma-api.polymarket.com/events?limit=1')
    const reqEnd = Date.now()
    const serverHeader = res.headers.get('date')
    if (serverHeader) {
      const rtt = reqEnd - reqStart
      const polymarketServerMs = new Date(serverHeader).getTime() + Math.round(rtt / 2)
      polymarketTimeOffset = polymarketServerMs - Date.now()
    }
  } catch (e) {}
}

function get15mCycleTimes() {
  const nowMs = Date.now() + polymarketTimeOffset + (userClockOffsetSec.value * 1000)
  const windowMs = 15 * 60 * 1000 // 900,000 ms
  const windowTsSec = Math.floor(nowMs / windowMs) * 900 // Epoch seconds of 15m start
  const cycleExpiryMs = (windowTsSec + 900) * 1000
  const cycleExpiry = new Date(cycleExpiryMs)
  // Polymarket Web UI countdown uses Math.floor
  const secondsRemaining = Math.max(0, Math.floor((cycleExpiryMs - nowMs) / 1000))
  return { cycleExpiry, secondsRemaining, windowTsSec }
}

// --- FAST NON-BLOCKING SPOT MARKET DATA TICKER ---
let isPollingPrices = false

async function pollSpotPrices() {
  if (isPollingPrices) return
  isPollingPrices = true

  try {
    // Sync Polymarket time in parallel with ticker fetch
    syncPolymarketTime()

    // Strategy 1: Binance batch ticker (Ultra-fast <100ms response)
    const res = await fetch('https://api.binance.com/api/v3/ticker/price')
    if (res.ok) {
      const data = await res.json()
      const prices = { ...spotPrices.value }
      data.forEach((item) => {
        if (item.symbol === 'BTCUSDT') prices.BTC = parseFloat(item.price)
        if (item.symbol === 'ETHUSDT') prices.ETH = parseFloat(item.price)
        if (item.symbol === 'SOLUSDT') prices.SOL = parseFloat(item.price)
        if (item.symbol === 'XRPUSDT') prices.XRP = parseFloat(item.price)
        if (item.symbol === 'DOGEUSDT') prices.DOGE = parseFloat(item.price)
        if (item.symbol === 'BNBUSDT') prices.BNB = parseFloat(item.price)
      })
      if (!prices.HYPE) prices.HYPE = 24.5
      spotPrices.value = prices
      isPollingPrices = false
      return
    }
  } catch (e) {
    // Fallback to CoinGecko below
  }

  try {
    // Strategy 2: Fast CoinGecko batch price
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,ripple,dogecoin,binancecoin,hyperliquid&vs_currencies=usd')
    if (res.ok) {
      const data = await res.json()
      spotPrices.value = {
        BTC: data.bitcoin?.usd || spotPrices.value.BTC || 89450.0,
        ETH: data.ethereum?.usd || spotPrices.value.ETH || 2620.0,
        SOL: data.solana?.usd || spotPrices.value.SOL || 185.5,
        XRP: data.ripple?.usd || spotPrices.value.XRP || 1.45,
        DOGE: data.dogecoin?.usd || spotPrices.value.DOGE || 0.185,
        BNB: data.binancecoin?.usd || spotPrices.value.BNB || 640.0,
        HYPE: data.hyperliquid?.usd || spotPrices.value.HYPE || 24.5,
      }
    }
  } catch (e) {
    // Retain existing in-memory spot prices
  } finally {
    isPollingPrices = false
  }

  if (Object.keys(spotPrices.value).length === 0) {
    spotPrices.value = {
      BTC: 89450.0,
      ETH: 2620.0,
      SOL: 185.5,
      XRP: 1.45,
      DOGE: 0.185,
      BNB: 640.0,
      HYPE: 24.5
    }
  }
}

// --- LIVE POLYMARKET 15M UP / DOWN ODDS TICKER ---
function connectPolymarketWs() {
  if (polyWs && (polyWs.readyState === WebSocket.OPEN || polyWs.readyState === WebSocket.CONNECTING)) {
    return
  }

  wsStatusText.value = 'CONNECTING...'
  try {
    polyWs = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market')

    polyWs.onopen = () => {
      isWsConnected.value = true
      wsStatusText.value = 'WS LIVE STREAMING'
      console.log('⚡ Connected to Polymarket WebSocket feed')

      if (wsPingInterval) clearInterval(wsPingInterval)
      wsPingInterval = setInterval(() => {
        if (polyWs && polyWs.readyState === WebSocket.OPEN) {
          polyWs.send('PING')
        }
      }, 15000)

      sendWsSubscription()
    }

    polyWs.onmessage = (event) => {
      if (event.data === 'PONG') return

      try {
        const parsed = JSON.parse(event.data)
        const messages = Array.isArray(parsed) ? parsed : [parsed]

        for (const msg of messages) {
          if (msg.event_type === 'price_change' && Array.isArray(msg.price_changes)) {
            for (const change of msg.price_changes) {
              handleWsPriceChange(change)
            }
          }
          if (msg.event_type === 'book' && msg.asset_id) {
            handleWsBookUpdate(msg)
          }
        }
      } catch (e) {
        // Ignore JSON parse errors on ping/pong frames
      }
    }

    polyWs.onerror = (err) => {
      console.warn('Polymarket WebSocket error:', err)
      wsStatusText.value = 'WS RECONNECTING'
    }

    polyWs.onclose = () => {
      isWsConnected.value = false
      wsStatusText.value = 'WS DISCONNECTED'
      if (wsPingInterval) clearInterval(wsPingInterval)
      polyWs = null
      clearTimeout(wsReconnectTimer)
      wsReconnectTimer = setTimeout(() => connectPolymarketWs(), 3000)
    }
  } catch (err) {
    console.error('Failed to create Polymarket WebSocket:', err)
    wsStatusText.value = 'WS DISCONNECTED'
  }
}

function sendWsSubscription() {
  if (polyWs && polyWs.readyState === WebSocket.OPEN && subscribedTokenIds.size > 0) {
    try {
      polyWs.send(
        JSON.stringify({
          type: 'market',
          assets_ids: Array.from(subscribedTokenIds)
        })
      )
    } catch (e) {
      console.warn('Failed to send WS subscription:', e)
    }
  }
}

function handleWsPriceChange(change) {
  const assetId = change.asset_id
  if (!assetId) return

  const pairMeta = tokenToPairMap.get(assetId)
  if (!pairMeta) return

  const rawAsk = change.best_ask !== undefined ? (typeof change.best_ask === 'string' ? parseFloat(change.best_ask) : change.best_ask) : (change.price !== undefined ? (typeof change.price === 'string' ? parseFloat(change.price) : change.price) : undefined)
  const rawBid = change.best_bid !== undefined ? (typeof change.best_bid === 'string' ? parseFloat(change.best_bid) : change.best_bid) : undefined
  const marketPrice = rawAsk ?? (rawBid !== undefined ? Number((rawBid + 0.01).toFixed(3)) : undefined)

  if (marketPrice === undefined || isNaN(marketPrice)) return

  const priceNum = Number(Math.max(0.01, Math.min(0.99, marketPrice)).toFixed(3))
  const oppPriceNum = Number((1.0 - priceNum).toFixed(3))
  const symbol = pairMeta.symbol

  if (!polymarketData.value[symbol]) {
    polymarketData.value[symbol] = {
      symbol,
      upPrice: 0.50,
      downPrice: 0.50,
      title: `${symbol} Up or Down 15m`,
      updatedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    }
  }

  const current = polymarketData.value[symbol]
  if (pairMeta.outcome === 'UP') {
    current.upPrice = priceNum
    current.downPrice = oppPriceNum
    triggerFlashTick(symbol, 'up')
  } else {
    current.downPrice = priceNum
    current.upPrice = oppPriceNum
    triggerFlashTick(symbol, 'down')
  }
  current.updatedAt = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function handleWsBookUpdate(msg) {
  const assetId = msg.asset_id
  if (!assetId) return
  const pairMeta = tokenToPairMap.get(assetId)
  if (!pairMeta) return

  const bestAsk = msg.asks && msg.asks.length > 0 ? parseFloat(msg.asks[0].price) : undefined
  const bestBid = msg.bids && msg.bids.length > 0 ? parseFloat(msg.bids[0].price) : undefined
  const price = bestAsk ?? bestBid

  if (price !== undefined && !isNaN(price)) {
    handleWsPriceChange({ asset_id: assetId, best_ask: bestAsk, best_bid: bestBid, price })
  }
}

function triggerFlashTick(symbol, direction) {
  if (!flashTickMap.value[symbol]) {
    flashTickMap.value[symbol] = { up: false, down: false }
  }
  flashTickMap.value[symbol][direction] = true
  setTimeout(() => {
    if (flashTickMap.value[symbol]) {
      flashTickMap.value[symbol][direction] = false
    }
  }, 400)
}

async function fetchPolymarketDataForPair(symbol, windowTsSec) {
  const slug = `${symbol.toLowerCase()}-updown-15m-${windowTsSec}`
  try {
    const res = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`)
    if (res.ok) {
      const data = await res.json()
      if (data && data.length > 0 && data[0].markets && data[0].markets.length > 0) {
        const m = data[0].markets[0]
        let prices = m.outcomePrices
        if (typeof prices === 'string') {
          try { prices = JSON.parse(prices) } catch (e) { prices = [] }
        }
        let outcomes = m.outcomes
        if (typeof outcomes === 'string') {
          try { outcomes = JSON.parse(outcomes) } catch (e) { outcomes = [] }
        }

        let clobTokens = m.clobTokenIds
        if (typeof clobTokens === 'string') {
          try { clobTokens = JSON.parse(clobTokens) } catch (e) { clobTokens = [] }
        }

        if (Array.isArray(clobTokens) && clobTokens.length >= 2) {
          const upTokenId = clobTokens[0]
          const downTokenId = clobTokens[1]

          tokenToPairMap.set(upTokenId, { symbol, outcome: 'UP' })
          tokenToPairMap.set(downTokenId, { symbol, outcome: 'DOWN' })
          subscribedTokenIds.add(upTokenId)
          subscribedTokenIds.add(downTokenId)
          sendWsSubscription()
        }

        let upPrice = 0.50
        let downPrice = 0.50

        if (Array.isArray(prices) && prices.length >= 2) {
          const p0 = parseFloat(prices[0])
          const p1 = parseFloat(prices[1])
          const o0 = (outcomes && outcomes[0]) ? String(outcomes[0]).toLowerCase() : 'up'

          if (o0 === 'up' || o0 === 'yes') {
            upPrice = isNaN(p0) ? 0.50 : p0
            downPrice = isNaN(p1) ? 0.50 : p1
          } else {
            downPrice = isNaN(p0) ? 0.50 : p0
            upPrice = isNaN(p1) ? 0.50 : p1
          }
        }

        return {
          symbol,
          upPrice: Number(upPrice.toFixed(3)),
          downPrice: Number(downPrice.toFixed(3)),
          title: data[0].title || m.question || `${symbol} Up or Down 15m`,
          updatedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        }
      }
    }
  } catch (e) {
    // Retain existing
  }
  return null
}

async function pollPolymarketData() {
  if (isPollingPolymarket.value) return
  isPollingPolymarket.value = true

  try {
    const { windowTsSec } = get15mCycleTimes()
    const promises = TARGET_PAIRS.map((sym) => fetchPolymarketDataForPair(sym, windowTsSec))
    const results = await Promise.all(promises)

    const newData = { ...polymarketData.value }
    results.forEach((res, i) => {
      const pair = TARGET_PAIRS[i]
      if (res) {
        // If WS has already updated with newer live ticks, keep the live WS price
        const current = polymarketData.value[pair]
        if (!current) {
          newData[pair] = res
        }
      } else if (!newData[pair]) {
        newData[pair] = {
          symbol: pair,
          upPrice: 0.50,
          downPrice: 0.50,
          title: `${pair} Up or Down 15m`,
          updatedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        }
      }
    })
    polymarketData.value = newData
  } catch (e) {
    console.error('Polymarket poll error:', e)
  } finally {
    isPollingPolymarket.value = false
  }
}

// --- ZERO-LATENCY GEMINI / QUANT EVALUATION SERVICE ---
async function evaluatePairWithGemini(pair, spot, strike, minutesLeft, mathProb, marketOdds) {
  if (GEMINI_API_KEY && GEMINI_API_KEY.length > 10) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 800) // 800ms strict timeout to eliminate API wait delay

    try {
      const promptText = `
You are a quantitative crypto trader analyzing 15-minute Polymarket prediction markets.
Market: Will ${pair} spot price be ABOVE $${strike} at end of 15m cycle?
Current Spot: $${spot} | Strike: $${strike} | Time Left: ${minutesLeft} mins
Polymarket Implied YES Odds: ${(marketOdds.yes * 100).toFixed(1)}% | NO Odds: ${(marketOdds.no * 100).toFixed(1)}%
Mathematical Baseline Probability: ${(mathProb * 100).toFixed(1)}%

Evaluate the probability of YES ending above strike. Return ONLY a JSON object:
{
  "calculatedProbability": 0.58,
  "recommendedAction": "BUY_YES",
  "confidenceScore": 82,
  "rationale": "${pair} spot is $${spot} vs strike $${strike} with bullish 15m order flow."
}
`
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptText }] }],
          generationConfig: { temperature: 0.2 }
        }),
        signal: controller.signal
      })
      clearTimeout(timeoutId)

      if (res.ok) {
        const data = await res.json()
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
        const cleanJson = text.replace(/```json/g, '').replace(/```/g, '').trim()
        const parsed = JSON.parse(cleanJson)

        const calculatedProb = Math.max(0.05, Math.min(0.95, parseFloat(parsed.calculatedProbability || mathProb)))
        const action = parsed.recommendedAction || (calculatedProb >= 0.53 ? 'BUY_YES' : calculatedProb <= 0.47 ? 'BUY_NO' : 'HOLD')
        const marketProb = action === 'BUY_NO' ? marketOdds.no : marketOdds.yes
        const rawEdge = action === 'BUY_NO' ? (1 - calculatedProb) - marketOdds.no : calculatedProb - marketOdds.yes

        return {
          symbol: pair,
          action,
          calculatedProbability: calculatedProb,
          marketProbability: marketProb,
          edgePercent: Number((rawEdge * 100).toFixed(1)),
          confidence: parsed.confidenceScore || 80,
          rationale: parsed.rationale || `15m momentum & spot vs strike signal ${action}.`
        }
      }
    } catch (e) {
      clearTimeout(timeoutId)
      // Fall through to instant Quantitative Engine
    }
  }

  // --- INSTANT QUANTITATIVE ENGINE FALLBACK ---
  const calculatedProb = mathProb
  const yesEdge = Number(((calculatedProb - marketOdds.yes) * 100).toFixed(1))
  const noEdge = Number((((1 - calculatedProb) - marketOdds.no) * 100).toFixed(1))

  let action = 'HOLD'
  let edgePercent = 0
  let marketProb = marketOdds.yes

  if (yesEdge >= 4.0) {
    action = 'BUY_YES'
    edgePercent = yesEdge
    marketProb = marketOdds.yes
  } else if (noEdge >= 4.0) {
    action = 'BUY_NO'
    edgePercent = noEdge
    marketProb = marketOdds.no
  }

  return {
    symbol: pair,
    action,
    calculatedProbability: calculatedProb,
    marketProbability: marketProb,
    edgePercent,
    confidence: Math.min(95, Math.max(60, Math.round(50 + Math.abs(edgePercent) * 3))),
    rationale: `Quantitative Math Engine: Spot $${spot} vs Strike $${strike} gives ${(calculatedProb * 100).toFixed(1)}% probability vs market ${(marketOdds.yes * 100).toFixed(1)}%.`
  }
}

// --- CORE STRATEGY & ORCHESTRATION LOOP ---
let timerInterval = null
let pollInterval = null
let lastEvaluatedSec = -1

function startOrchestrator() {
  pollSpotPrices()
  pollPolymarketData()
  updateClock()
  runStrategyCycle()

  // Background ticker poll every 2s
  pollInterval = setInterval(() => {
    pollSpotPrices()
    pollPolymarketData()
  }, 2000)

  // Run high-precision timer tick every 100ms for instant 0s clock update
  timerInterval = setInterval(() => {
    updateClock()
  }, 100)
}

onUnmounted(() => {
  if (timerInterval) clearInterval(timerInterval)
  if (pollInterval) clearInterval(pollInterval)
  if (wsPingInterval) clearInterval(wsPingInterval)
  clearTimeout(wsReconnectTimer)
  if (polyWs) {
    polyWs.close()
    polyWs = null
  }
})

function updateClock() {
  const { cycleExpiry: expiry, secondsRemaining: rem, windowTsSec: wTs } = get15mCycleTimes()
  secondsRemaining.value = rem
  cycleExpiry.value = expiry

  // 15-minute window rollover detection
  if (windowTs.value !== 0 && windowTs.value !== wTs) {
    settleExpiredTrades()
    if (isRunning.value) {
      runStrategyCycle()
    }
  }
  windowTs.value = wTs

  // Run strategy evaluation every 10 seconds immediately on second boundary
  if (isRunning.value && !isEvaluating.value && rem % 10 === 0 && rem !== lastEvaluatedSec) {
    lastEvaluatedSec = rem
    runStrategyCycle()
  }
}

async function runStrategyCycle() {
  if (isEvaluating.value) return
  isEvaluating.value = true

  try {
    // Read cached spot prices and polymarket odds synchronously (0ms delay)
    const prices = spotPrices.value
    const polyData = polymarketData.value
    const minutesLeft = Math.max(1, Math.floor(secondsRemaining.value / 60))

    // Parallel evaluation of all 7 target pairs for zero-latency execution
    const evaluationPromises = TARGET_PAIRS.map(async (pair) => {
      const spot = prices[pair] || 100.0
      const poly = polyData[pair] || { upPrice: 0.50, downPrice: 0.50 }

      const strike = spot
      const yesOdds = Number(Math.max(0.01, Math.min(0.99, poly.upPrice)).toFixed(2))
      const noOdds = Number(Math.max(0.01, Math.min(0.99, poly.downPrice)).toFixed(2))

      const mathProb = calculateLognormalProbability(spot, strike, minutesLeft)
      const signal = await evaluatePairWithGemini(pair, spot, strike, minutesLeft, mathProb, { yes: yesOdds, no: noOdds })
      
      return { signal, pair, spot, strike, yesOdds, noOdds }
    })

    const results = await Promise.all(evaluationPromises)
    const validSignals = []

    for (const item of results) {
      if (!item) continue
      const { signal, pair, spot, strike, yesOdds, noOdds } = item
      validSignals.push({ ...signal, spot, strike, yesOdds, noOdds })

      if (isRunning.value) {
        dispatchTradeForPair(signal, pair, spot, strike, yesOdds, noOdds)
      }
    }

    latestSignals.value = validSignals
  } catch (e) {
    console.error('Cycle error:', e)
  } finally {
    isEvaluating.value = false
  }
}

// Enforces $10 Maximum Capital & Arbitrage Hedging
function dispatchTradeForPair(signal, pair, spot, strike, yesOdds, noOdds) {
  // Check existing active trades for this pair in current window
  const existingTradesForPair = activeTrades.value.filter(
    (t) => t.pair === pair && t.windowTs === windowTs.value && t.status === 'OPEN'
  )

  const hasYes = existingTradesForPair.some((t) => t.outcome === 'YES')
  const hasNo = existingTradesForPair.some((t) => t.outcome === 'NO')

  // CASE 1: Both legs acquired -> fully hedged!
  if (hasYes && hasNo) return

  // CASE 2: Leg 1 exists; evaluate Leg 2 Arbitrage Hedge (Max combined pair cost <= $0.95)
  if (existingTradesForPair.length === 1) {
    const leg1 = existingTradesForPair[0]
    const oppositeOutcome = leg1.outcome === 'YES' ? 'NO' : 'YES'
    const oppositePrice = oppositeOutcome === 'YES' ? yesOdds : noOdds
    const combinedCost = Number((leg1.entryPrice + oppositePrice).toFixed(2))

    // Check if combined pair cost guarantees profit (<= $0.95)
    if (combinedCost <= 0.95 && availableCapital.value >= leg1.stakeUsd) {
      const stake = leg1.stakeUsd
      const shares = Number((stake / oppositePrice).toFixed(2))
      const spread = Number(((1.0 - combinedCost) * 100).toFixed(1))

      const leg2Trade = {
        id: `trade_${Date.now()}_${Math.random().toString(36).substring(5)}`,
        timestamp: new Date().toISOString(),
        pair,
        outcome: oppositeOutcome,
        type: 'DUAL_HEDGE',
        entryPrice: oppositePrice,
        stakeUsd: stake,
        shares,
        strike,
        spotAtEntry: spot,
        windowTs: windowTs.value,
        expiryTime: cycleExpiry.value.toISOString(),
        status: 'OPEN',
        isHedgedPair: true,
        aiEdge: spread,
        rationale: `🔒 Arbitrage Lock: Paired ${oppositeOutcome} @ $${oppositePrice} with ${leg1.outcome} @ $${leg1.entryPrice} (Combined cost $${combinedCost}, Guaranteed spread +${spread}%)`
      }

      activeTrades.value.push(leg2Trade)
      trades.value.push(leg2Trade)
      leg1.isHedgedPair = true
    }
    return
  }

  // CASE 3: Leg 1 Entry -> Recommends trade if Edge >= 4% & remaining runway >= 180s (3m)
  if (signal.action === 'HOLD' || signal.edgePercent < 4.0 || secondsRemaining.value < 180) return

  // Check available budget under $10 max capital limit
  // Stake per trade = $2.50 (budgeting for up to 4 pairs or 2 dual-legged pairs)
  const tradeStake = 2.50
  if (availableCapital.value < tradeStake) return // Capital limit reached!

  const outcome = signal.action === 'BUY_YES' ? 'YES' : 'NO'
  const entryPrice = outcome === 'YES' ? yesOdds : noOdds
  const shares = Number((tradeStake / entryPrice).toFixed(2))

  const newTrade = {
    id: `trade_${Date.now()}_${Math.random().toString(36).substring(5)}`,
    timestamp: new Date().toISOString(),
    pair,
    outcome,
    type: 'AI_ENTRY',
    entryPrice,
    stakeUsd: tradeStake,
    shares,
    strike,
    spotAtEntry: spot,
    windowTs: windowTs.value,
    expiryTime: cycleExpiry.value.toISOString(),
    status: 'OPEN',
    isHedgedPair: false,
    aiEdge: signal.edgePercent,
    rationale: signal.rationale
  }

  activeTrades.value.push(newTrade)
  trades.value.push(newTrade)
}

// Settle trades at 15-minute expiry ($1.00 win, $0.00 loss)
async function settleExpiredTrades() {
  const prices = spotPrices.value

  activeTrades.value.forEach((trade) => {
    if (trade.status !== 'OPEN') return

    const finalSpot = prices[trade.pair] || trade.spotAtEntry
    const isWon = trade.outcome === 'YES' ? finalSpot >= trade.strike : finalSpot < trade.strike

    if (isWon) {
      trade.status = trade.isHedgedPair ? 'HEDGED_WIN' : 'WON'
      const payout = Number((trade.shares * 1.0).toFixed(2))
      trade.realizedPnl = Number((payout - trade.stakeUsd).toFixed(2))
    } else {
      trade.status = trade.isHedgedPair ? 'HEDGED_COVER' : 'LOST'
      trade.realizedPnl = -trade.stakeUsd
    }
  })

  // Clear active trades list for next 15m cycle
  activeTrades.value = []
}

// Manual trigger for instant re-evaluation
function manualEvaluate() {
  runStrategyCycle()
}

// Toggle strategy ON/OFF
function toggleRun() {
  isRunning.value = !isRunning.value
}

// Clear local history
function clearHistory() {
  if (confirm('Are you sure you want to clear your trade history?')) {
    trades.value = []
    activeTrades.value = []
    localStorage.removeItem(STORAGE_KEY_TRADES)
  }
}
</script>

<template>
  <section class="dashboard">
    <!-- Header Controls & Status -->
    <div class="dashboard-heading">
      <div>
        <p class="eyebrow">15-MINUTE CRYPTO QUANT ENGINE</p>
        <h1>Arbitrage & AI Trading</h1>
        <p class="muted">
          Autonomous Gemini AI & Black-Scholes strategy capped at <strong>${{ MAX_TOTAL_CAPITAL.toFixed(2) }}</strong> maximum capital.
        </p>
      </div>

      <div class="header-actions">
        <button
          class="run-toggle"
          :class="{ paused: !isRunning }"
          @click="toggleRun"
        >
          <span class="status-dot" :class="{ inactive: !isRunning }"></span>
          {{ isRunning ? 'STRATEGY RUNNING' : 'STRATEGY PAUSED' }}
        </button>

        <button
          class="secondary-button eval-btn"
          :disabled="isEvaluating"
          @click="manualEvaluate"
        >
          {{ isEvaluating ? 'EVALUATING...' : 'FORCE CYCLE EVAL' }}
        </button>
      </div>
    </div>

    <!-- Metric Cards Grid -->
    <div class="metric-grid">
      <div class="metric">
        <span>STRATEGY CAPITAL CAP</span>
        <strong>${{ MAX_TOTAL_CAPITAL.toFixed(2) }}</strong>
        <em>Committed: ${{ totalCommittedCapital.toFixed(2) }} | Avail: ${{ availableCapital.toFixed(2) }}</em>
      </div>

      <div class="metric">
        <span>REALIZED PROFIT / LOSS</span>
        <strong :class="totalRealizedPnl >= 0 ? 'positive' : 'negative'">
          {{ totalRealizedPnl >= 0 ? '+' : '' }}${{ totalRealizedPnl.toFixed(2) }}
        </strong>
        <em>Cumulative PnL in reactive storage</em>
      </div>

      <div class="metric">
        <span>WIN RATE & RESOLVED</span>
        <strong class="positive">{{ winRate }}%</strong>
        <em>{{ winCount }} won / {{ totalResolved }} resolved trades</em>
      </div>

      <div class="metric">
        <span>15M CYCLE COUNTDOWN</span>
        <strong>{{ formattedCountdown }}</strong>
        <em class="nudge-row">
          <span>Synced to Polymarket</span>
          <span class="nudge-controls">
            <button class="nudge-btn" title="Shift clock -1s" @click="adjustClockOffset(-1)">-1s</button>
            <button class="nudge-btn" title="Shift clock +1s" @click="adjustClockOffset(1)">+1s</button>
          </span>
        </em>
      </div>
    </div>

    <!-- Polymarket Live Up & Down Crypto Pairs Grid -->
    <div class="panel polymarket-panel">
      <div class="panel-title">
        <div>
          <p class="eyebrow">POLYMARKET 15M WEBSOCKET FEED</p>
          <h2>Live Crypto Pair Up &amp; Down Odds</h2>
        </div>
        <div class="poly-feed-status" :class="{ connected: isWsConnected }">
          <span class="live-pulse" :class="{ disconnected: !isWsConnected }"></span>
          <span class="poly-feed-text">⚡ {{ wsStatusText }}</span>
        </div>
      </div>

      <div class="poly-cards-grid">
        <div v-for="pair in TARGET_PAIRS" :key="pair" class="poly-card">
          <div class="poly-card-header">
            <div class="poly-pair-info">
              <span class="poly-pair-symbol">{{ pair }}</span>
              <span class="poly-spot-val">${{ spotPrices[pair] ? spotPrices[pair].toLocaleString() : '...' }}</span>
            </div>
            <span class="poly-cycle-badge">15m</span>
          </div>

          <div class="poly-odds-row">
            <!-- UP Box -->
            <div class="poly-odd-box up-box" :class="{ 'flash-up': flashTickMap[pair]?.up }">
              <div class="odd-label">
                <span class="direction-icon">▲</span>
                <span>UP</span>
              </div>
              <div class="odd-price">
                ${{ (polymarketData[pair]?.upPrice ?? 0.50).toFixed(3) }}
              </div>
              <div class="odd-percent">
                {{ Math.round((polymarketData[pair]?.upPrice ?? 0.50) * 100) }}%
              </div>
            </div>

            <!-- DOWN Box -->
            <div class="poly-odd-box down-box" :class="{ 'flash-down': flashTickMap[pair]?.down }">
              <div class="odd-label">
                <span class="direction-icon">▼</span>
                <span>DOWN</span>
              </div>
              <div class="odd-price">
                ${{ (polymarketData[pair]?.downPrice ?? 0.50).toFixed(3) }}
              </div>
              <div class="odd-percent">
                {{ Math.round((polymarketData[pair]?.downPrice ?? 0.50) * 100) }}%
              </div>
            </div>
          </div>

          <!-- Distribution Bar -->
          <div class="poly-bar-wrapper">
            <div
              class="poly-bar-fill up-bar"
              :style="{ width: `${Math.round((polymarketData[pair]?.upPrice ?? 0.50) * 100)}%` }"
            ></div>
            <div
              class="poly-bar-fill down-bar"
              :style="{ width: `${Math.round((polymarketData[pair]?.downPrice ?? 0.50) * 100)}%` }"
            ></div>
          </div>
        </div>
      </div>
    </div>

    <!-- Workspace Main Grid -->
    <div class="workspace-grid">

      <!-- LEFT: Currently Running Trades & Signals -->
      <article class="panel signal-panel">
        <div class="panel-title">
          <div>
            <p class="eyebrow">ACTIVE POSITIONS</p>
            <h2>Currently Running Trades</h2>
          </div>
          <span class="pulse-label" :class="{ 'pulse-active': activeTrades.length > 0 }">
            {{ activeTrades.length }} ACTIVE
          </span>
        </div>

        <div v-if="activeTrades.length === 0" class="empty-state">
          <p>No active trades running in the current 15-minute window.</p>
          <small class="muted" v-if="isRunning">
            The strategy will automatically enter when an AI edge &ge; 4.0% or Arbitrage Pair Cost &le; $0.95 is detected.
          </small>
          <small class="muted" v-else>
            Strategy is currently PAUSED. Click "STRATEGY PAUSED" above to resume.
          </small>
        </div>

        <div v-else class="running-trades-list">
          <div v-for="trade in activeTrades" :key="trade.id" class="running-trade-card">
            <div class="trade-card-header">
              <div class="symbol-badge">
                <strong>{{ trade.pair }}</strong>
                <span class="outcome-pill" :class="trade.outcome.toLowerCase()">
                  {{ trade.outcome }}
                </span>
              </div>
              <span class="stake-tag">${{ trade.stakeUsd.toFixed(2) }} Stake</span>
            </div>

            <div class="trade-card-body">
              <div class="card-stat">
                <span>Entry Price</span>
                <b>${{ trade.entryPrice.toFixed(2) }}</b>
              </div>
              <div class="card-stat">
                <span>Shares</span>
                <b>{{ trade.shares }}</b>
              </div>
              <div class="card-stat">
                <span>Target Strike</span>
                <b>${{ trade.strike }}</b>
              </div>
              <div class="card-stat">
                <span>AI Edge</span>
                <b class="positive">+{{ trade.aiEdge }}%</b>
              </div>
            </div>

            <div class="trade-rationale">
              <small>{{ trade.rationale }}</small>
            </div>
          </div>
        </div>

        <!-- Latest Multi-Pair Telemetry Stream -->
        <div class="telemetry-box" v-if="latestSignals.length > 0">
          <p class="eyebrow">LIVE PAIR EVALUATIONS</p>
          <div class="telemetry-grid">
            <div v-for="sig in latestSignals" :key="sig.symbol" class="telemetry-item">
              <div class="telemetry-item-top">
                <span class="pair-name">{{ sig.symbol }}</span>
                <span class="spot-price">${{ sig.spot }}</span>
              </div>
              <div class="telemetry-odds-row">
                <span class="telemetry-up">▲ ${{ (sig.yesOdds || 0.5).toFixed(2) }}</span>
                <span class="telemetry-down">▼ ${{ (sig.noOdds || 0.5).toFixed(2) }}</span>
              </div>
              <div class="telemetry-item-bottom">
                <span class="action-tag" :class="sig.action.toLowerCase()">{{ sig.action }}</span>
                <span class="edge-val">{{ sig.edgePercent > 0 ? '+' : '' }}{{ sig.edgePercent }}%</span>
              </div>
            </div>
          </div>
        </div>
      </article>

      <!-- RIGHT: Paginated Trade History Table & Local Storage Log -->
      <article class="panel log-panel">
        <div class="panel-title">
          <div>
            <p class="eyebrow">REACTIVE PERSISTENCE</p>
            <h2>Trade History Log</h2>
          </div>
          <button v-if="trades.length > 0" class="clear-btn" @click="clearHistory">Clear Log</button>
        </div>

        <div v-if="trades.length === 0" class="empty-state">
          No trade history saved in local storage yet.
        </div>

        <div v-else class="history-table-container">
          <div class="log-list">
            <div v-for="trade in paginatedTrades" :key="trade.id" class="log-entry">
              <time>{{ new Date(trade.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }}</time>
              
              <div>
                <strong>
                  {{ trade.pair }} — BUY {{ trade.outcome }}
                  <span class="type-tag">{{ trade.type }}</span>
                </strong>
                <span class="rationale-text">{{ trade.rationale }}</span>
              </div>

              <div class="log-right">
                <b :class="trade.status.includes('WON') ? 'positive' : trade.status === 'LOST' ? 'negative' : ''">
                  {{ trade.status === 'OPEN' ? 'RUNNING' : trade.realizedPnl >= 0 ? '+' + '$' + trade.realizedPnl.toFixed(2) : '-$' + Math.abs(trade.realizedPnl).toFixed(2) }}
                </b>
                <small :class="trade.status.includes('WON') ? 'positive' : trade.status === 'LOST' ? 'negative' : 'muted'">
                  {{ trade.status }}
                </small>
              </div>
            </div>
          </div>

          <!-- Pagination Controls -->
          <div class="pagination-footer" v-if="totalPages > 1">
            <button
              class="page-btn"
              :disabled="currentPage === 1"
              @click="currentPage--"
            >
              &larr; Prev
            </button>
            <span class="page-info">Page {{ currentPage }} of {{ totalPages }}</span>
            <button
              class="page-btn"
              :disabled="currentPage === totalPages"
              @click="currentPage++"
            >
              Next &rarr;
            </button>
          </div>
        </div>

        <p class="paper-notice">
          Strict $10 max total capital strategy. LocalStorage reactively synced.
        </p>
      </article>

    </div>
  </section>
</template>

<style scoped>
.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.status-dot.inactive {
  background: var(--muted);
  box-shadow: none;
}

.pulse-active {
  background: #1e3820 !important;
  border-color: var(--lime) !important;
}

.eval-btn {
  border: 1px solid var(--line);
  background: transparent;
  color: var(--ink);
  padding: 10px 14px;
  cursor: pointer;
  font-family: var(--mono);
  font-size: 11px;
}

.running-trades-list {
  display: grid;
  gap: 14px;
  margin-bottom: 24px;
}

.running-trade-card {
  background: #131a17;
  border: 1px solid var(--line);
  padding: 14px;
  border-radius: 4px;
}

.trade-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}

.symbol-badge {
  display: flex;
  align-items: center;
  gap: 8px;
}

.symbol-badge strong {
  font-size: 16px;
}

.outcome-pill {
  font-family: var(--mono);
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 2px;
  font-weight: bold;
}
.outcome-pill.yes { background: #1c3d26; color: var(--lime); }
.outcome-pill.no { background: #421e1a; color: var(--orange); }

.stake-tag {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
}

.trade-card-body {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  padding: 8px 0;
  border-top: 1px solid #1f2924;
  border-bottom: 1px solid #1f2924;
  margin-bottom: 8px;
}

.card-stat span {
  display: block;
  font-size: 9px;
  color: var(--muted);
  font-family: var(--mono);
}
.card-stat b {
  font-size: 11px;
  font-family: var(--mono);
}

.trade-rationale small {
  font-size: 11px;
  color: var(--muted);
  line-height: 1.3;
  display: block;
}

.telemetry-box {
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid var(--line);
}

.telemetry-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: 8px;
  margin-top: 10px;
}

.telemetry-item {
  background: #111714;
  border: 1px solid #202b25;
  padding: 8px;
  font-family: var(--mono);
  font-size: 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.pair-name { font-weight: bold; color: var(--ink); }
.spot-price { color: var(--muted); }
.action-tag.buy_yes { color: var(--lime); }
.action-tag.buy_no { color: var(--orange); }
.action-tag.hold { color: var(--muted); }
.edge-val { font-size: 9px; color: var(--lime); }

.history-table-container {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  min-height: 320px;
}

.type-tag {
  font-size: 9px;
  color: var(--muted);
  border: 1px solid var(--line);
  padding: 1px 4px;
  margin-left: 6px;
}

.rationale-text {
  display: block;
  font-size: 10px;
  color: var(--muted);
  margin-top: 2px;
}

.clear-btn {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--muted);
  font-family: var(--mono);
  font-size: 10px;
  padding: 4px 8px;
  cursor: pointer;
}
.clear-btn:hover { color: var(--orange); border-color: var(--orange); }

.pagination-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
}

.page-btn {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--ink);
  font-family: var(--mono);
  font-size: 11px;
  padding: 6px 12px;
  cursor: pointer;
}
.page-btn:disabled { opacity: 0.35; cursor: not-allowed; }

.page-info {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
}

.nudge-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

.nudge-controls {
  display: flex;
  gap: 4px;
}

.nudge-btn {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--lime);
  font-family: var(--mono);
  font-size: 9px;
  padding: 1px 5px;
  cursor: pointer;
  border-radius: 2px;
}
.nudge-btn:hover {
  border-color: var(--lime);
  background: #1a271c;
}

/* Polymarket Live Panel Styles */
.polymarket-panel {
  margin-bottom: 24px;
}

.poly-feed-status {
  display: flex;
  align-items: center;
  gap: 8px;
  background: #111a14;
  border: 1px solid #1f3826;
  padding: 4px 10px;
  border-radius: 20px;
}

.poly-feed-text {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--lime);
  font-weight: 600;
  letter-spacing: 0.5px;
}

.live-pulse {
  width: 8px;
  height: 8px;
  background: #22c55e;
  border-radius: 50%;
  box-shadow: 0 0 8px #22c55e;
  animation: pulse-glow 1.5s infinite alternate;
}

@keyframes pulse-glow {
  0% { opacity: 0.4; transform: scale(0.9); }
  100% { opacity: 1; transform: scale(1.1); box-shadow: 0 0 12px #22c55e; }
}

.poly-cards-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 12px;
  margin-top: 14px;
}

.poly-card {
  background: #121915;
  border: 1px solid #202e26;
  border-radius: 6px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  transition: border-color 0.2s;
}

.poly-card:hover {
  border-color: #2e4738;
}

.poly-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.poly-pair-info {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.poly-pair-symbol {
  font-size: 15px;
  font-weight: 800;
  color: var(--ink);
  letter-spacing: 0.5px;
}

.poly-spot-val {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
}

.poly-cycle-badge {
  font-family: var(--mono);
  font-size: 9px;
  background: #1a2720;
  color: var(--lime);
  padding: 2px 6px;
  border-radius: 3px;
  border: 1px solid #273e30;
}

.poly-odds-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.poly-odd-box {
  padding: 8px;
  border-radius: 4px;
  font-family: var(--mono);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.up-box {
  background: #11281a;
  border: 1px solid #1b452b;
}

.down-box {
  background: #2b1715;
  border: 1px solid #4a211b;
}

.odd-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 9px;
  font-weight: bold;
}

.up-box .odd-label { color: #4ade80; }
.down-box .odd-label { color: #f97316; }

.direction-icon {
  font-size: 8px;
}

.odd-price {
  font-size: 13px;
  font-weight: bold;
  color: #ffffff;
}

.odd-percent {
  font-size: 10px;
}
.up-box .odd-percent { color: #86efac; }
.down-box .odd-percent { color: #fdba74; }

.poly-bar-wrapper {
  display: flex;
  height: 4px;
  width: 100%;
  background: #1c2721;
  border-radius: 2px;
  overflow: hidden;
}

.poly-bar-fill {
  height: 100%;
  transition: width 0.3s ease;
}

.up-bar { background: #22c55e; }
.down-bar { background: #f97316; }

.telemetry-item-top, .telemetry-item-bottom {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.telemetry-odds-row {
  display: flex;
  justify-content: space-between;
  font-size: 9px;
  margin: 3px 0;
  padding: 2px 4px;
  background: #0d1410;
  border-radius: 2px;
}

.telemetry-up { color: #4ade80; font-weight: bold; }
.telemetry-down { color: #f97316; font-weight: bold; }

.poly-feed-status.connected {
  background: #0f2d19;
  border-color: #22c55e;
}

.live-pulse.disconnected {
  background: #f97316;
  box-shadow: 0 0 8px #f97316;
  animation: none;
}

.poly-odd-box {
  transition: background-color 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
}

.up-box.flash-up {
  background-color: #1a4d2c !important;
  border-color: #22c55e !important;
  box-shadow: 0 0 10px rgba(34, 197, 94, 0.5);
}

.down-box.flash-down {
  background-color: #522019 !important;
  border-color: #f97316 !important;
  box-shadow: 0 0 10px rgba(249, 115, 22, 0.5);
}
</style>

