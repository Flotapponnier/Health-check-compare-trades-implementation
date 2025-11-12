import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import WebSocket from 'ws';

const gunzipAsync = promisify(gunzip);

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  MOBULA_API_KEY: process.env['MOBULA_API_KEY'] || '886fb20c-17ea-42ea-b09a-9cde244cdf00',
  MOBULA_WSS_URL: 'wss://pulse-v2-api.mobula.io',
  TIMEOUT_MS: 60000, // 60 seconds
  FOURMEME: {
    factoryAddress: '0x5c952063c7fc8610ffdb798152d69f0b9550762b', // Four.meme factory
    chainId: 'evm:56', // BSC
    name: 'Four.meme Platform',
    // Tous les tokens Four.meme ont une adresse qui finit par "4444"
    addressPattern: '4444',
  },
};

// ============================================================================
// Types
// ============================================================================

interface TokenData {
  address: string;
  chainId: string;
  symbol?: string;
  name?: string;
  price?: number;
  volume_1h?: number;
  volume_24h?: number;
  trades_1h?: number;
  createdAt?: string;
}

interface HealthCheckResults {
  newMarkets: TokenData[]; // Nouveaux tokens Four.meme
  fourMemeTokens: TokenData[]; // Tous les tokens Four.meme détectés
  totalTrades: number; // Total des trades sur tous les tokens Four.meme
  totalVolume: number; // Volume total
  duration: number;
}

// ============================================================================
// Mobula Pulse Client
// ============================================================================

class MobulaPulseClient {
  private ws: WebSocket | null = null;
  private newMarkets: TokenData[] = [];
  private fourMemeTokens: Map<string, TokenData> = new Map(); // Map par adresse
  private totalTrades = 0;
  private totalVolume = 0;

  constructor(private apiKey: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(CONFIG.MOBULA_WSS_URL);

        const connectionTimeout = setTimeout(() => {
          console.error('❌ Mobula: Connection timeout after 10s');
          reject(new Error('Mobula connection timeout'));
        }, 10000);

        this.ws.on('open', () => {
          clearTimeout(connectionTimeout);
          console.log('✅ Mobula Pulse WebSocket connected\n');

          // Subscribe to BSC tokens to track Four.meme platform
          const subscriptionMessage = {
            type: 'pulse-v2',
            authorization: this.apiKey,
            payload: {
              assetMode: true,
              views: [
                {
                  name: 'bsc-tokens',
                  chainId: ['evm:56'], // BSC only for Four.meme
                  poolTypes: ['pancakeswap-v2', 'pancakeswap-v3', 'uniswap-v2'],
                  sortBy: 'volume_1h',
                  sortOrder: 'desc',
                  limit: 100,
                  filters: {
                    volume_1h: { gte: 10 }, // Lower threshold to catch more tokens
                  },
                },
                {
                  name: 'bsc-new-tokens',
                  chainId: ['evm:56'],
                  poolTypes: ['pancakeswap-v2', 'pancakeswap-v3', 'uniswap-v2'],
                  sortBy: 'created_at',
                  sortOrder: 'desc',
                  limit: 50,
                },
              ],
            },
          };

          this.ws?.send(JSON.stringify(subscriptionMessage));
          console.log('📡 Mobula: Subscribed to Pulse V2 stream');
          console.log(`   - Platform: ${CONFIG.FOURMEME.name}`);
          console.log(`   - Chain: BSC (${CONFIG.FOURMEME.chainId})`);
          console.log(`   - Watching for tokens ending in "${CONFIG.FOURMEME.addressPattern}"`);
          console.log(`   - Monitoring new markets and trades\n`);
          resolve();
        });

        this.ws.on('message', async (data: Buffer) => {
          try {
            const message = await this.parseMessage(data);
            if (message) {
              this.handleMessage(message);
            }
          } catch (error) {
            console.error('❌ Mobula: Failed to parse message', error);
          }
        });

        this.ws.on('error', (error: any) => {
          clearTimeout(connectionTimeout);
          console.error('❌ Mobula WebSocket error:', error.message || error);
          reject(error);
        });

        this.ws.on('close', (code: number, reason: Buffer) => {
          clearTimeout(connectionTimeout);
          console.log(`\n🔌 Mobula WebSocket closed (code: ${code}, reason: ${reason?.toString() || 'N/A'})`);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  private async parseMessage(data: Buffer): Promise<any | null> {
    try {
      // Try to parse as JSON first (uncompressed)
      try {
        const message = JSON.parse(data.toString());
        return message;
      } catch (_parseError) {
        // If JSON parsing fails, try to decompress
        try {
          const decompressed = await gunzipAsync(data);
          const jsonString = decompressed.toString('utf8');
          const message = JSON.parse(jsonString);
          return message;
        } catch (decompressError) {
          return null;
        }
      }
    } catch (error) {
      return null;
    }
  }

  private handleMessage(message: any) {
    // Handle init message with all tokens
    if (message.type === 'init' && message.payload) {
      console.log('📋 Mobula: Init message received');
      let totalTokens = 0;

      for (const [viewName, viewData] of Object.entries(message.payload)) {
        const tokens = (viewData as any).data || [];
        totalTokens += tokens.length;
        console.log(`   - View "${viewName}": ${tokens.length} tokens`);

        tokens.forEach((token: any) => {
          this.processToken(token, 'init');
        });
      }
      console.log(`   - Total: ${totalTokens} tokens loaded\n`);
    }

    // Handle new token events
    if (message.type === 'new-token' && message.payload) {
      console.log('🆕 Mobula: New market detected');
      this.processToken(message.payload.token, 'new');
    }

    // Handle token updates (includes trade data)
    if (message.type === 'update-token' && message.payload) {
      this.processToken(message.payload.token, 'update');
    }

    // Handle sync messages
    if (message.type === 'sync') {
      console.log('🔄 Mobula: Sync message received');
    }
  }

  private processToken(token: any, source: 'init' | 'new' | 'update') {
    if (!token) return;

    const tokenData: TokenData = {
      address: token.address || 'unknown',
      chainId: token.chainId || 'unknown',
      symbol: token.symbol,
      name: token.name,
      price: token.price,
      volume_1h: token.volume_1h,
      volume_24h: token.volume_24h,
      trades_1h: token.trades_1h,
      createdAt: token.createdAt,
    };

    // Check si c'est un token Four.meme (adresse finit par "4444")
    const addressLower = tokenData.address.toLowerCase();
    const isFourMemeToken = addressLower.endsWith(CONFIG.FOURMEME.addressPattern.toLowerCase());

    if (isFourMemeToken && tokenData.chainId === CONFIG.FOURMEME.chainId) {
      // Ajouter ou mettre à jour le token Four.meme
      this.fourMemeTokens.set(addressLower, tokenData);

      // Accumuler les stats
      if (tokenData.trades_1h) {
        this.totalTrades += tokenData.trades_1h;
      }
      if (tokenData.volume_1h) {
        this.totalVolume += tokenData.volume_1h;
      }

      if (source === 'init') {
        console.log(`🎯 Four.meme token: ${tokenData.symbol || 'Unknown'}`);
        console.log(`   Address: ...${tokenData.address.slice(-8)}`);
        console.log(`   Volume 1h: $${tokenData.volume_1h?.toFixed(2) || '0'}`);
        console.log(`   Trades 1h: ${tokenData.trades_1h || 0}\n`);
      }

      // Track new markets (from 'new' events)
      if (source === 'new') {
        this.newMarkets.push(tokenData);
        console.log(`🆕 NEW FOUR.MEME TOKEN!`);
        console.log(`   - Symbol: ${tokenData.symbol}`);
        console.log(`   - Name: ${tokenData.name}`);
        console.log(`   - Address: ${tokenData.address}`);
        console.log(`   - Price: $${tokenData.price?.toFixed(8) || 'N/A'}`);
        console.log('');
      }

      // Log trade updates
      if (source === 'update' && tokenData.trades_1h && tokenData.trades_1h > 0) {
        console.log(`💱 ${tokenData.symbol} - ${tokenData.trades_1h} trades ($${tokenData.volume_1h?.toFixed(2) || '0'})`);
      }
    }
  }

  getResults(): {
    newMarkets: TokenData[];
    fourMemeTokens: TokenData[];
    totalTrades: number;
    totalVolume: number;
  } {
    return {
      newMarkets: this.newMarkets,
      fourMemeTokens: Array.from(this.fourMemeTokens.values()),
      totalTrades: this.totalTrades,
      totalVolume: this.totalVolume,
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

  console.log('🚀 Starting Mobula Health Check - Fourmeme Focus\n');
  console.log('=' .repeat(80));
  console.log('📋 Configuration:');
  console.log(`   - Target: fourmeme (${CONFIG.FOURMEME.address})`);
  console.log(`   - Duration: ${CONFIG.TIMEOUT_MS / 1000}s`);
  console.log(`   - Tracking: New markets + Trades`);
  console.log('=' .repeat(80) + '\n');

  const mobulaClient = new MobulaPulseClient(CONFIG.MOBULA_API_KEY);

  try {
    await mobulaClient.connect();

    console.log(`⏳ Listening for ${CONFIG.TIMEOUT_MS / 1000} seconds...\n`);

    // Wait for the specified timeout
    await new Promise((resolve) => setTimeout(resolve, CONFIG.TIMEOUT_MS));

    // Get results
    const results = mobulaClient.getResults();
    const duration = Date.now() - startTime;

    console.log('\n' + '='.repeat(80));
    console.log('📊 FOUR.MEME HEALTH CHECK RESULTS');
    console.log('='.repeat(80) + '\n');

    console.log('🎯 Four.meme Tokens Found:', results.fourMemeTokens.length);
    console.log(`   - Total Trades (1h): ${results.totalTrades.toLocaleString()}`);
    console.log(`   - Total Volume (1h): $${results.totalVolume.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

    if (results.fourMemeTokens.length > 0) {
      console.log('\n📈 Top 10 Four.meme Tokens by Volume:');
      results.fourMemeTokens
        .sort((a, b) => (b.volume_1h || 0) - (a.volume_1h || 0))
        .slice(0, 10)
        .forEach((token, i) => {
          console.log(`   ${i + 1}. ${token.symbol || 'Unknown'} (...${token.address.slice(-8)})`);
          console.log(`      Volume 1h: $${token.volume_1h?.toFixed(2) || '0'}`);
          console.log(`      Trades 1h: ${token.trades_1h || 0}`);
        });
    }

    console.log('\n🆕 New Markets Detected:', results.newMarkets.length);
    if (results.newMarkets.length > 0) {
      console.log('\nNew Four.meme Tokens Launched:');
      results.newMarkets.forEach((market, i) => {
        console.log(`   ${i + 1}. ${market.symbol} - ${market.name}`);
        console.log(`      Address: ${market.address}`);
        console.log(`      Created: ${market.createdAt || 'Unknown'}`);
      });
    } else {
      console.log('   (No new Four.meme tokens launched during monitoring period)');
    }

    console.log('\n⏱️  Duration:', (duration / 1000).toFixed(2), 'seconds');
    console.log('='.repeat(80) + '\n');

    return {
      newMarkets: results.newMarkets,
      fourMemeTokens: results.fourMemeTokens,
      totalTrades: results.totalTrades,
      totalVolume: results.totalVolume,
      duration,
    };
  } catch (error) {
    console.error('❌ Health check failed:', error);
    throw error;
  } finally {
    mobulaClient.close();
  }
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main() {
  try {
    const results = await runHealthCheck();

    // Exit with appropriate status code
    if (results.fourMemeTokens.length > 0) {
      console.log(`✅ Health check passed - ${results.fourMemeTokens.length} Four.meme tokens tracked`);
      console.log(`   ${results.totalTrades} total trades, $${results.totalVolume.toFixed(2)} volume`);
      process.exit(0);
    } else {
      console.log('⚠️  No Four.meme tokens detected (may indicate low activity or configuration issue)');
      process.exit(1);
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
