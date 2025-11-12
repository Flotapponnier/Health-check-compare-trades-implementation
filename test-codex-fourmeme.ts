import WebSocket from 'ws';

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  CODEX_API_KEY: process.env['CODEX_API_KEY'] || 'dd557cf093a0db2991bab723320924632270098b',
  CODEX_WSS_URL: 'wss://graph.codex.io/graphql',
  TIMEOUT_MS: 60000, // 60 seconds
  FOURMEME: {
    factoryAddress: '0x5c952063c7fc8610ffdb798152d69f0b9550762b', // Four.meme factory
    networkId: 56, // BSC network ID for Codex
    chainName: 'BSC',
    // Tous les tokens Four.meme ont une adresse qui finit par "4444"
    addressPattern: '4444',
  },
};

// ============================================================================
// Types
// ============================================================================

interface TokenData {
  address: string;
  networkId: number;
  symbol?: string;
  name?: string;
  pairAddress?: string;
  createdAt?: number;
}

interface TradeData {
  pairAddress: string;
  networkId: number;
  type: string;
  amountUsd?: number;
  priceUsd?: number;
  timestamp?: number;
}

interface HealthCheckResults {
  newMarkets: TokenData[]; // Nouveaux tokens/pairs Four.meme
  trades: TradeData[]; // Trades détectés
  fourMemeTokens: TokenData[]; // Tous les tokens Four.meme détectés
  totalTrades: number;
  duration: number;
}

// ============================================================================
// Codex WebSocket Client
// ============================================================================

class CodexWebSocketClient {
  private ws: WebSocket | null = null;
  private newMarkets: TokenData[] = [];
  private trades: TradeData[] = [];
  private fourMemeTokens: Map<string, TokenData> = new Map();
  private subscriptionId = 0;
  private connectionAcked = false;

  constructor(private apiKey: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Codex requires 'graphql-transport-ws' subprotocol
        this.ws = new WebSocket(CONFIG.CODEX_WSS_URL, 'graphql-transport-ws');

        const connectionTimeout = setTimeout(() => {
          console.error('❌ Codex: Connection timeout after 10s');
          reject(new Error('Codex connection timeout'));
        }, 10000);

        this.ws.on('open', () => {
          clearTimeout(connectionTimeout);
          console.log('✅ Codex WebSocket connected\n');

          // Send connection_init with authorization
          const initMessage = {
            type: 'connection_init',
            payload: {
              Authorization: this.apiKey,
            },
          };

          this.ws?.send(JSON.stringify(initMessage));
        });

        this.ws.on('message', (data: Buffer) => {
          try {
            const message = JSON.parse(data.toString());

            if (message.type === 'connection_ack') {
              console.log('✅ Codex: Connection acknowledged');
              this.connectionAcked = true;
              this.subscribeToNewPairs();
              resolve();
            } else {
              this.handleMessage(message);
            }
          } catch (error) {
            console.error('❌ Codex: Failed to parse message', error);
          }
        });

        this.ws.on('error', (error: any) => {
          clearTimeout(connectionTimeout);
          console.error('❌ Codex WebSocket error:', error.message || error);
          reject(error);
        });

        this.ws.on('close', (code: number, reason: Buffer) => {
          clearTimeout(connectionTimeout);
          console.log(`\n🔌 Codex WebSocket closed (code: ${code}, reason: ${reason?.toString() || 'N/A'})`);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  private subscribeToNewPairs() {
    if (!this.connectionAcked) return;

    // Subscribe to new pairs on BSC for Four.meme tokens
    const subscriptionMessage = {
      id: `new-pairs-bsc-${this.subscriptionId++}`,
      type: 'subscribe',
      payload: {
        query: `
          subscription OnLatestPairUpdated($networkId: Int!) {
            onLatestPairUpdated(networkId: $networkId) {
              address
              networkId
              liquidAt
              newToken
              token0 {
                address
                name
                symbol
              }
              token1 {
                address
                name
                symbol
              }
            }
          }
        `,
        variables: {
          networkId: CONFIG.FOURMEME.networkId,
        },
        operationName: 'OnLatestPairUpdated',
      },
    };

    this.ws?.send(JSON.stringify(subscriptionMessage));
    console.log(`📡 Codex: Subscribed to new pairs on ${CONFIG.FOURMEME.chainName} (network ${CONFIG.FOURMEME.networkId})`);
    console.log(`   - Watching for Four.meme tokens (ending in "${CONFIG.FOURMEME.addressPattern}")`);
    console.log(`   - Monitoring new markets\n`);
  }

  private handleMessage(message: any) {
    if (message.type === 'next' && message.payload?.data) {
      const data = message.payload.data;

      // Handle new pair updates
      if (data.onLatestPairUpdated) {
        const pair = data.onLatestPairUpdated;
        this.processPair(pair);
      }

      // Handle trade events (if subscribed)
      if (data.onEventsCreated) {
        const events = Array.isArray(data.onEventsCreated) ? data.onEventsCreated : [data.onEventsCreated];
        events.forEach((event: any) => {
          this.processTrade(event);
        });
      }
    }

    if (message.type === 'error') {
      console.error('❌ Codex subscription error:', message.payload);
    }
  }

  private processPair(pair: any) {
    if (!pair) return;

    const token0Address = (pair.token0?.address || '').toLowerCase();
    const token1Address = (pair.token1?.address || '').toLowerCase();

    // Check si un des tokens est un token Four.meme (finit par "4444")
    const isFourMemeToken0 = token0Address.endsWith(CONFIG.FOURMEME.addressPattern.toLowerCase());
    const isFourMemeToken1 = token1Address.endsWith(CONFIG.FOURMEME.addressPattern.toLowerCase());

    if (isFourMemeToken0 || isFourMemeToken1) {
      const fourMemeToken = isFourMemeToken0 ? pair.token0 : pair.token1;
      const otherToken = isFourMemeToken0 ? pair.token1 : pair.token0;

      const tokenData: TokenData = {
        address: fourMemeToken.address,
        networkId: pair.networkId,
        symbol: fourMemeToken.symbol,
        name: fourMemeToken.name,
        pairAddress: pair.address, // use pair.address not pair.pairAddress
        createdAt: pair.liquidAt, // use liquidAt timestamp
      };

      // Ajouter à la map des tokens Four.meme
      const addressKey = fourMemeToken.address.toLowerCase();
      if (!this.fourMemeTokens.has(addressKey)) {
        this.fourMemeTokens.set(addressKey, tokenData);
        this.newMarkets.push(tokenData);

        console.log('🎯 Four.meme token detected on Codex!');
        console.log(`   - Symbol: ${tokenData.symbol}`);
        console.log(`   - Name: ${tokenData.name}`);
        console.log(`   - Address: ${tokenData.address}`);
        console.log(`   - Pair: ${tokenData.symbol}/${otherToken.symbol}`);
        console.log(`   - Pair Address: ${tokenData.pairAddress}`);
        console.log(`   - Liquidity added: ${tokenData.createdAt ? new Date(tokenData.createdAt * 1000).toISOString() : 'Unknown'}`);
        console.log('');
      }
    }
  }

  private processTrade(event: any) {
    if (!event) return;

    const tradeData: TradeData = {
      pairAddress: event.pairAddress || event.address,
      networkId: event.networkId,
      type: event.type || event.eventType,
      amountUsd: event.amountUSD || event.valueUSD,
      priceUsd: event.priceUsd,
      timestamp: event.timestamp || event.blockTimestamp,
    };

    this.trades.push(tradeData);
    console.log(`💱 Codex: Trade detected - ${tradeData.type} $${tradeData.amountUsd?.toFixed(2) || 'N/A'}`);
  }

  getResults(): {
    newMarkets: TokenData[];
    trades: TradeData[];
    fourMemeTokens: TokenData[];
  } {
    return {
      newMarkets: this.newMarkets,
      trades: this.trades,
      fourMemeTokens: Array.from(this.fourMemeTokens.values()),
    };
  }

  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// ============================================================================
// Health Check
// ============================================================================

async function runHealthCheck(): Promise<HealthCheckResults> {
  const startTime = Date.now();

  console.log('🚀 Starting Codex Health Check - Four.meme Platform\n');
  console.log('=' .repeat(80));
  console.log('📋 Configuration:');
  console.log(`   - Platform: Four.meme`);
  console.log(`   - Chain: ${CONFIG.FOURMEME.chainName} (Network ID: ${CONFIG.FOURMEME.networkId})`);
  console.log(`   - Factory: ${CONFIG.FOURMEME.factoryAddress}`);
  console.log(`   - Duration: ${CONFIG.TIMEOUT_MS / 1000}s`);
  console.log(`   - Tracking: New pairs/markets`);
  console.log('=' .repeat(80) + '\n');

  const codexClient = new CodexWebSocketClient(CONFIG.CODEX_API_KEY);

  try {
    await codexClient.connect();

    console.log(`⏳ Listening for ${CONFIG.TIMEOUT_MS / 1000} seconds...\n`);

    // Wait for the specified timeout
    await new Promise((resolve) => setTimeout(resolve, CONFIG.TIMEOUT_MS));

    // Get results
    const results = codexClient.getResults();
    const duration = Date.now() - startTime;

    console.log('\n' + '='.repeat(80));
    console.log('📊 CODEX HEALTH CHECK RESULTS');
    console.log('='.repeat(80) + '\n');

    console.log('🎯 Four.meme Tokens Found:', results.fourMemeTokens.length);
    console.log('🆕 New Markets Detected:', results.newMarkets.length);
    console.log('💱 Trades Detected:', results.trades.length);

    if (results.fourMemeTokens.length > 0) {
      console.log('\n📈 Four.meme Tokens Detected:');
      results.fourMemeTokens.forEach((token, i) => {
        console.log(`   ${i + 1}. ${token.symbol || 'Unknown'} - ${token.name}`);
        console.log(`      Address: ${token.address}`);
        console.log(`      Pair: ${token.pairAddress}`);
      });
    }

    if (results.newMarkets.length > 0) {
      console.log('\n🆕 New Four.meme Tokens/Pairs:');
      results.newMarkets.forEach((market, i) => {
        console.log(`   ${i + 1}. ${market.symbol} - ${market.name}`);
        console.log(`      Address: ${market.address}`);
        console.log(`      Created: ${market.createdAt ? new Date(market.createdAt * 1000).toISOString() : 'Unknown'}`);
      });
    } else {
      console.log('\n   (No new Four.meme tokens/pairs detected during monitoring period)');
    }

    console.log('\n⏱️  Duration:', (duration / 1000).toFixed(2), 'seconds');
    console.log('='.repeat(80) + '\n');

    return {
      newMarkets: results.newMarkets,
      trades: results.trades,
      fourMemeTokens: results.fourMemeTokens,
      totalTrades: results.trades.length,
      duration,
    };
  } catch (error) {
    console.error('❌ Health check failed:', error);
    throw error;
  } finally {
    codexClient.close();
  }
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main() {
  try {
    const results = await runHealthCheck();

    // Exit with appropriate status code
    if (results.fourMemeTokens.length > 0 || results.newMarkets.length > 0) {
      console.log(`✅ Health check passed`);
      console.log(`   ${results.fourMemeTokens.length} Four.meme tokens found`);
      console.log(`   ${results.newMarkets.length} new markets detected`);
      process.exit(0);
    } else {
      console.log('⚠️  No Four.meme activity detected (may indicate low activity or issue)');
      process.exit(0);
    }
  } catch (error) {
    console.error('💥 Fatal error during health check:', error);
    process.exit(1);
  }
}

// Run if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
