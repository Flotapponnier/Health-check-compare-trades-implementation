# Health Check - Mobula vs Codex WebSocket Comparison

Health check system comparing real-time swap/trade detection between Mobula and Codex WebSocket APIs for Four.meme tokens on BSC.

## Features

- **Real-time swap detection** via WebSocket (30 seconds collection)
- **Mobula fast-trade WebSocket**: Detects buy/sell trades with volume data
- **Codex GraphQL WebSocket**: Detects swap/mint/burn events
- **Transaction-level comparison**: Matches swaps by transaction hash
- **15% error margin**: Health check passes if Mobula detects ≥85% of Codex's transactions
- **Comprehensive metrics**: Tracks trades, swaps, unique tokens, and transaction coverage

## Requirements

- Node.js 18+
- Mobula API key
- Codex API key

## Installation

```bash
npm install
```

## Configuration

Copy `.env.example` to `.env` and fill in your API keys:

```bash
cp .env.example .env
```

Required environment variables:
- `MOBULA_API_KEY`: Your Mobula API key
- `CODEX_API_KEY`: Your Codex API key

## Usage

Run the health check:

```bash
npm start
```

Watch mode (auto-reload on file changes):

```bash
npm run dev
```

## How It Works

### Monitored Pools

The script monitors 5 Four.meme token pools on BSC:
- 币安人生 (BinanceLife)
- 哈基米 (Hajimi)
- HEYTEA
- 马到成功 (Success)
- 修仙人生

### Process

1. **Connect** to both Mobula and Codex WebSockets
2. **Subscribe** to the 5 Four.meme pool addresses
3. **Collect** swap/trade data for 30 seconds
4. **Compare** results:
   - Total swaps/trades detected
   - Unique transaction hashes
   - Unique tokens detected
   - Match by transaction hash

### Health Check Logic

- **PASS**: Mobula detects ≥85% of Codex's transactions
- **FAIL**: Mobula detects <85% of Codex's transactions

The 15% error margin accounts for potential timing differences and edge cases.

## Example Output

```
================================================================================
📊 FINAL SCORE PANEL
================================================================================

🔄 SWAP/TRADE COMPARISON:
   Mobula Trades (Swaps): 27
   Codex Swap Events: 27
   Coverage: 100.00% (threshold: 85%)
   Difference: 0 (Mobula ahead)

📈 MOBULA DETAILED STATISTICS:
   Total Trades/Swaps: 27
   Unique Transactions: 27
   Unique Tokens: 3
   Buy Trades: 12
   Sell Trades: 15

📈 CODEX DETAILED STATISTICS:
   Total Events: 27
   Swap Events: 27
   Mint Events: 0
   Burn Events: 0
   Unique Transactions: 27
   Unique Tokens: 3

================================================================================
🔍 TRANSACTION COMPARISON
================================================================================

📊 Transaction Hash Matching:
   Total unique transactions: 27
   Found by BOTH: 27
   Only Mobula: 0
   Only Codex: 0

================================================================================

📊 HEALTH CHECK RESULT:

✅ HEALTH CHECK PASSED
   Mobula coverage meets the 85% threshold
   - Mobula: 27 transactions
   - Codex: 27 transactions
   - Coverage: 100.00%
   - Common transactions: 27
```

## What Gets Compared

### Swap/Trade Count
- Mobula: Total number of trades detected (buy + sell)
- Codex: Total number of swap events detected

### Transaction Hashes
- Compares if the **same transactions** are detected by both services
- Identifies transactions found only by Mobula or only by Codex

### Token Detection
- Lists which Four.meme tokens had trading activity
- Shows which tokens were detected by both vs. only one service

## License

MIT
