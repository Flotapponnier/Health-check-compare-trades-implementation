# Health Check - Compare Trades Implementation

Health check system to compare token detection and data between Mobula and CoinGecko APIs, focused on Four.meme platform tokens on BSC.

## Features

- **Real-time token detection** via Mobula Pulse V2 WebSocket
- **Token verification** on CoinGecko Pro API
- **Comparison metrics**: Match rate, price differences, volume data
- **Four.meme focus**: Tracks tokens ending in "4444" on BSC

## Requirements

- Node.js 18+ or Bun
- Mobula API key
- CoinGecko Pro/Enterprise API key

## Installation

```bash
npm install
# or
bun install
```

## Configuration

Copy `.env.example` to `.env` and fill in your API keys:

```bash
cp .env.example .env
```

Required environment variables:
- `MOBULA_API_KEY`: Your Mobula API key
- `COINGECKO_API_KEY`: Your CoinGecko Pro/Enterprise API key

## Usage

### Test Mobula Only
```bash
bun scripts/src/healthcheck/test-mobula-fourmeme.ts
```

### Test CoinGecko Only
```bash
bun scripts/src/healthcheck/test-codex-fourmeme.ts
```

### Compare Both APIs
```bash
bun scripts/src/healthcheck/compare-mobula-coingecko.ts
```

## How It Works

1. **Step 1**: Connects to Mobula Pulse V2 WebSocket and collects Four.meme tokens for 5 seconds
2. **Step 2**: Waits 30 seconds for potential CoinGecko indexation
3. **Step 3**: Searches each token on CoinGecko Pro API
4. **Step 4**: Compares results and displays match rate

## Expected Results

- **Match rate**: Typically 25-35% for newly launched tokens
- **Why low?**: CoinGecko takes hours/days to index new tokens, while Mobula detects them instantly
- **Established tokens**: Higher match rates (80%+) for tokens launched days/weeks ago

## Example Output

```
🚀 Mobula vs CoinGecko Health Check - Four.meme Platform

✅ Mobula collected 11 Four.meme tokens

📊 COMPARISON RESULTS

📈 Summary:
   - Total tokens checked: 11
   - Found on both APIs: 3 (27.3%)
   - Only on Mobula: 8 (72.7%)

✅ Top 3 tokens found on BOTH APIs:
   1. 11.11 - 11.11
      Mobula Price: $0.04243477
      CoinGecko Price: $0.04186919
```

## License

MIT
