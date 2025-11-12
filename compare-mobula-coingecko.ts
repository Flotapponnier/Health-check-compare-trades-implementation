import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import WebSocket from 'ws';

const gunzipAsync = promisify(gunzip);

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  MOBULA_API_KEY: process.env['MOBULA_API_KEY'] || '886fb20c-17ea-42ea-b09a-9cde244cdf00',
  COINGECKO_API_KEY: process.env['COINGECKO_API_KEY'] || 'CG-NbNcM6XZ31JfeNd68nYaMMCT',
  MOBULA_WSS_URL: 'wss://pulse-v2-api.mobula.io',
  COINGECKO_API_URL: 'https://pro-api.coingecko.com/api/v3',
  TIMEOUT_MS: 5000, // 5 seconds to collect Mobula data
  FOURMEME: {
    factoryAddress: '0x5c952063c7fc8610ffdb798152d69f0b9550762b',
    chainId: 'evm:56', // BSC for Mobula
    chainName: 'binance-smart-chain', // BSC for CoinGecko
    addressPattern: '4444',
  },
};

// ============================================================================
// Types
// ============================================================================

interface TokenData {
  address: string;
  symbol?: string;
  name?: string;
  price?: number;
  volume_1h?: number;
  volume_24h?: number;
  trades_1h?: number;
  source: 'mobula' | 'coingecko';
}

interface ComparisonResult {
  token: TokenData;
  existsInMobula: boolean;
  existsInCoinGecko: boolean;
  coinGeckoData?: any;
  match: boolean;
}

// ============================================================================
// Mobula Pulse Client
// ============================================================================

class MobulaPulseClient {
  private ws: WebSocket | null = null;
  private fourMemeTokens: Map<string, TokenData> = new Map();

  constructor(private apiKey: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(CONFIG.MOBULA_WSS_URL);

        const connectionTimeout = setTimeout(() => {
          reject(new Error('Mobula connection timeout'));
        }, 10000);

        this.ws.on('open', () => {
          clearTimeout(connectionTimeout);
          console.log('✅ Mobula Pulse WebSocket connected');

          const subscriptionMessage = {
            type: 'pulse-v2',
            authorization: this.apiKey,
            payload: {
              assetMode: true,
              views: [
                {
                  name: 'bsc-tokens',
                  chainId: ['evm:56'],
                  poolTypes: ['pancakeswap-v2', 'pancakeswap-v3', 'uniswap-v2'],
                  sortBy: 'volume_1h',
                  sortOrder: 'desc',
                  limit: 100,
                  filters: { volume_1h: { gte: 10 } },
                },
              ],
            },
          };

          this.ws?.send(JSON.stringify(subscriptionMessage));
          console.log('📡 Mobula: Subscribed to BSC tokens\n');
          resolve();
        });

        this.ws.on('message', async (data: Buffer) => {
          try {
            const message = await this.parseMessage(data);
            if (message) this.handleMessage(message);
          } catch (error) {
            // Ignore parse errors
          }
        });

        this.ws.on('error', (error: any) => {
          clearTimeout(connectionTimeout);
          reject(error);
        });

        this.ws.on('close', () => {
          console.log('🔌 Mobula WebSocket closed\n');
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  private async parseMessage(data: Buffer): Promise<any | null> {
    try {
      try {
        return JSON.parse(data.toString());
      } catch {
        const decompressed = await gunzipAsync(data);
        return JSON.parse(decompressed.toString('utf8'));
      }
    } catch {
      return null;
    }
  }

  private handleMessage(message: any) {
    if (message.type === 'init' && message.payload) {
      for (const [viewName, viewData] of Object.entries(message.payload)) {
        const tokens = (viewData as any).data || [];
        tokens.forEach((token: any) => this.processToken(token));
      }
    }

    if (message.type === 'new-token' && message.payload) {
      this.processToken(message.payload.token);
    }

    if (message.type === 'update-token' && message.payload) {
      this.processToken(message.payload.token);
    }
  }

  private processToken(token: any) {
    if (!token) return;

    const addressLower = (token.address || '').toLowerCase();
    const isFourMeme = addressLower.endsWith(CONFIG.FOURMEME.addressPattern.toLowerCase());

    if (isFourMeme && token.chainId === CONFIG.FOURMEME.chainId) {
      const tokenData: TokenData = {
        address: token.address,
        symbol: token.symbol,
        name: token.name,
        price: token.price,
        volume_1h: token.volume_1h,
        trades_1h: token.trades_1h,
        source: 'mobula',
      };

      if (!this.fourMemeTokens.has(addressLower)) {
        this.fourMemeTokens.set(addressLower, tokenData);
        console.log(`🎯 Four.meme token: ${tokenData.symbol} (...${addressLower.slice(-8)})`);
      }
    }
  }

  getTokens(): TokenData[] {
    return Array.from(this.fourMemeTokens.values());
  }

  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// ============================================================================
// CoinGecko REST Client
// ============================================================================

class CoinGeckoRestClient {
  constructor(private apiKey: string) {}

  async searchToken(address: string): Promise<any> {
    // CoinGecko API endpoint to get token info by contract address
    const url = `${CONFIG.COINGECKO_API_URL}/coins/${CONFIG.FOURMEME.chainName}/contract/${address}`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'x-cg-pro-api-key': this.apiKey,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          // Token not found
          return null;
        }
        console.error(`❌ CoinGecko API error for ${address}: ${response.status}`);
        return null;
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error(`❌ CoinGecko fetch error for ${address}:`, error);
      return null;
    }
  }
}

// ============================================================================
// Comparison Logic
// ============================================================================

async function compareTokens(
  mobulaTokens: TokenData[],
  coinGeckoClient: CoinGeckoRestClient,
): Promise<ComparisonResult[]> {
  console.log('\n🔍 Starting comparison with CoinGecko...\n');

  const results: ComparisonResult[] = [];

  for (const token of mobulaTokens) {
    console.log(`   Checking ${token.symbol} (${token.address})...`);

    // Search on CoinGecko
    const coinGeckoData = await coinGeckoClient.searchToken(token.address);

    const result: ComparisonResult = {
      token,
      existsInMobula: true,
      existsInCoinGecko: coinGeckoData !== null,
      coinGeckoData,
      match: coinGeckoData !== null,
    };

    results.push(result);

    if (coinGeckoData) {
      console.log(`      ✅ Found on CoinGecko`);
    } else {
      console.log(`      ❌ NOT found on CoinGecko`);
    }

    // Delay to avoid rate limiting (1 second between requests)
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return results;
}

// ============================================================================
// Main Health Check
// ============================================================================

async function runHealthCheck() {
  const startTime = Date.now();

  console.log('🚀 Mobula vs CoinGecko Health Check - Four.meme Platform\n');
  console.log('='.repeat(80));
  console.log('📋 Configuration:');
  console.log(`   - Platform: Four.meme`);
  console.log(`   - Chain: BSC (${CONFIG.FOURMEME.chainId})`);
  console.log(`   - Pattern: Tokens ending in "${CONFIG.FOURMEME.addressPattern}"`);
  console.log(`   - Mobula collection time: ${CONFIG.TIMEOUT_MS / 1000}s`);
  console.log('='.repeat(80) + '\n');

  // Step 1: Collect tokens from Mobula
  console.log('📊 Step 1: Collecting Four.meme tokens from Mobula Pulse...\n');

  const mobulaClient = new MobulaPulseClient(CONFIG.MOBULA_API_KEY);
  await mobulaClient.connect();

  console.log(`⏳ Collecting data for ${CONFIG.TIMEOUT_MS / 1000} seconds...\n`);
  await new Promise((resolve) => setTimeout(resolve, CONFIG.TIMEOUT_MS));

  const mobulaTokens = mobulaClient.getTokens();
  mobulaClient.close();

  console.log(`\n✅ Mobula collected ${mobulaTokens.length} Four.meme tokens\n`);

  if (mobulaTokens.length === 0) {
    console.log('⚠️  No Four.meme tokens found on Mobula. Exiting.\n');
    return;
  }

  // Wait 30 seconds to give CoinGecko time to index
  console.log('⏳ Waiting 30 seconds for CoinGecko indexation...\n');
  await new Promise((resolve) => setTimeout(resolve, 30000));

  // Step 2: Search each token on CoinGecko
  console.log('📊 Step 2: Searching tokens on CoinGecko...\n');

  const coinGeckoClient = new CoinGeckoRestClient(CONFIG.COINGECKO_API_KEY);
  const results = await compareTokens(mobulaTokens, coinGeckoClient);

  // Step 3: Display results
  const duration = Date.now() - startTime;

  console.log('\n' + '='.repeat(80));
  console.log('📊 COMPARISON RESULTS');
  console.log('='.repeat(80) + '\n');

  const foundOnBoth = results.filter((r) => r.match).length;
  const onlyOnMobula = results.filter((r) => !r.match).length;

  console.log('📈 Summary:');
  console.log(`   - Total tokens checked: ${results.length}`);
  console.log(`   - Found on both APIs: ${foundOnBoth} (${((foundOnBoth / results.length) * 100).toFixed(1)}%)`);
  console.log(`   - Only on Mobula: ${onlyOnMobula} (${((onlyOnMobula / results.length) * 100).toFixed(1)}%)`);

  if (onlyOnMobula > 0) {
    console.log('\n⚠️  Tokens found ONLY on Mobula (missing from CoinGecko):');
    results
      .filter((r) => !r.match)
      .slice(0, 10)
      .forEach((r, i) => {
        console.log(`   ${i + 1}. ${r.token.symbol} - ${r.token.name}`);
        console.log(`      Address: ${r.token.address}`);
        console.log(`      Volume 1h: $${r.token.volume_1h?.toFixed(2) || 'N/A'}`);
      });
  }

  if (foundOnBoth > 0) {
    console.log('\n✅ Top 5 tokens found on BOTH APIs:');
    results
      .filter((r) => r.match)
      .slice(0, 5)
      .forEach((r, i) => {
        console.log(`   ${i + 1}. ${r.token.symbol} - ${r.token.name}`);
        console.log(`      Mobula Price: $${r.token.price?.toFixed(8) || 'N/A'}`);
        console.log(`      CoinGecko Price: $${r.coinGeckoData?.market_data?.current_price?.usd?.toFixed(8) || 'N/A'}`);
        console.log(`      Mobula Volume 24h: $${r.token.volume_24h?.toFixed(2) || 'N/A'}`);
        console.log(`      CoinGecko Volume 24h: $${r.coinGeckoData?.market_data?.total_volume?.usd?.toFixed(2) || 'N/A'}`);
      });
  }

  console.log('\n⏱️  Total duration:', (duration / 1000).toFixed(2), 'seconds');
  console.log('='.repeat(80) + '\n');

  // Return results
  return {
    total: results.length,
    foundOnBoth,
    onlyOnMobula,
    matchRate: (foundOnBoth / results.length) * 100,
    results,
  };
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main() {
  try {
    const results = await runHealthCheck();

    if (!results) {
      console.log('⚠️  Health check completed with no data');
      process.exit(0);
    }

    // Exit with status based on match rate
    if (results.matchRate >= 80) {
      console.log(`✅ Health check PASSED - ${results.matchRate.toFixed(1)}% match rate`);
      process.exit(0);
    } else if (results.matchRate >= 50) {
      console.log(`⚠️  Health check WARNING - ${results.matchRate.toFixed(1)}% match rate`);
      process.exit(0);
    } else {
      console.log(`❌ Health check FAILED - Only ${results.matchRate.toFixed(1)}% match rate`);
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
