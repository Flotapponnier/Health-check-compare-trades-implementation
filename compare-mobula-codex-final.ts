import WebSocket from 'ws';
import { createClient, Client } from 'graphql-ws';
import dotenv from 'dotenv';

dotenv.config();

// ============================================================================
// Configuration
// ============================================================================

if (!process.env['MOBULA_API_KEY']) {
  console.error('❌ MOBULA_API_KEY not found in environment');
  process.exit(1);
}
if (!process.env['CODEX_API_KEY']) {
  console.error('❌ CODEX_API_KEY not found in environment');
  process.exit(1);
}

const CONFIG = {
  MOBULA_API_KEY: process.env['MOBULA_API_KEY'],
  CODEX_API_KEY: process.env['CODEX_API_KEY'],
  MOBULA_WSS_URL: 'wss://api.mobula.io',
  CODEX_WSS_URL: 'wss://graph.codex.io/graphql',
  COLLECTION_TIME_MS: 30000, // 30 seconds
  FOURMEME: {
    chainId: 'evm:56', // BSC
    codexNetworkId: 56,
    addressPattern: '4444',
  },
};

// Hardcoded Four.meme pools (manually found via DexScreener)
const FOURMEME_POOLS = [
  {
    poolAddress: '0x66f289De31EEF70d52186729d2637Ac978CFC56B',
    tokenAddress: '0x924fa68a0fc644485b8df8abfa0a41c2e7744444',
    symbol: '币安人生',
    name: 'BinanceLife',
  },
  {
    poolAddress: '0xc33bACFf9141Da689875e6381c1932348aB4c5CB',
    tokenAddress: '0x82ec31d69b3c289e541b50e30681fd1acad24444',
    symbol: '哈基米',
    name: 'Hajimi',
  },
  {
    poolAddress: '0x28a79b44AA17cb82f2bD8d0E39c8f575B8eD28A7',
    tokenAddress: '0x501797b4733a055ac37a12b0f3101212fd6f4444',
    symbol: 'HEYTEA',
    name: 'HEYTEA',
  },
  {
    poolAddress: '0x87659d5Be1D7A54EB4F543Fa7647a53C7A5a303b',
    tokenAddress: '0x730e9b7091258cdf578136ec8394daea2db84444',
    symbol: '马到成功',
    name: 'Success',
  },
  {
    poolAddress: '0x6354AA3963eFe7C68E35ea801Fd5D010b42e9901',
    tokenAddress: '0x444452418bd7719f4447a92c36c82ea7442a4444',
    symbol: '修仙人生',
    name: '修仙人生',
  },
];

// ============================================================================
// Mobula Fast-Trade WebSocket Client
// ============================================================================

class MobulaFastTradeClient {
  private ws: WebSocket | null = null;
  private detectedTokens: Set<string> = new Set();
  private detectedTxHashes: Set<string> = new Set();
  private poolToTokenMap: Map<string, string> = new Map();
  private totalTrades: number = 0;
  private buyCount: number = 0;
  private sellCount: number = 0;

  constructor(private apiKey: string) {
    // Create mapping from pool address to token address
    FOURMEME_POOLS.forEach(pool => {
      this.poolToTokenMap.set(pool.poolAddress.toLowerCase(), pool.tokenAddress.toLowerCase());
    });
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(CONFIG.MOBULA_WSS_URL);

      this.ws.on('open', () => {
        console.log('✅ Mobula fast-trade WebSocket connected');

        const items = FOURMEME_POOLS.map(pool => ({
          blockchain: CONFIG.FOURMEME.chainId,
          address: pool.poolAddress,
        }));

        const subscribeMsg = {
          type: 'fast-trade',
          authorization: this.apiKey,
          payload: {
            assetMode: false,
            items,
          },
        };

        this.ws?.send(JSON.stringify(subscribeMsg));
        console.log(`📡 Mobula: Subscribed to ${items.length} Four.meme pools\n`);
        resolve();
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch (error) {
          // Ignore parse errors
        }
      });

      this.ws.on('error', (error: any) => {
        reject(error);
      });

      this.ws.on('close', () => {
        console.log('🔌 Mobula WebSocket closed');
      });
    });
  }

  private handleMessage(message: any) {
    // Check for subscription confirmation or errors
    if (message.status === 'success') {
      console.log('[MOBULA] ✅ Subscription confirmed');
      return;
    }

    if (message.error) {
      console.log('[MOBULA] ⚠️  Error:', message.error);
      return;
    }

    // Mobula fast-trade messages contain trade data
    if (message.hash && message.blockchain && message.pair) {
      const poolAddress = message.pair.toLowerCase();

      // Look up the token address from the pool address
      const tokenAddress = this.poolToTokenMap.get(poolAddress);

      if (tokenAddress) {
        console.log(`[MOBULA] ✅ Trade detected for Four.meme token: ${tokenAddress}`);
        console.log(`   Pool: ${poolAddress}, Type: ${message.type}, Amount: $${message.tokenAmountUsd?.toFixed(2)}, Tx: ${message.hash.substring(0, 10)}...`);

        this.detectedTokens.add(tokenAddress);
        this.detectedTxHashes.add(message.hash.toLowerCase());
        this.totalTrades++;

        if (message.type === 'buy') {
          this.buyCount++;
        } else if (message.type === 'sell') {
          this.sellCount++;
        }
      }
    }
  }

  getTokens(): string[] {
    return Array.from(this.detectedTokens);
  }

  getTxHashes(): string[] {
    return Array.from(this.detectedTxHashes);
  }

  getStats() {
    return {
      totalTrades: this.totalTrades,
      uniqueTxHashes: this.detectedTxHashes.size,
      uniqueTokens: this.detectedTokens.size,
      buyCount: this.buyCount,
      sellCount: this.sellCount,
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
// Codex GraphQL WebSocket Client
// ============================================================================

class CodexWebSocketClient {
  private client: Client | null = null;
  private detectedTokens: Set<string> = new Set();
  private detectedTxHashes: Set<string> = new Set();
  private subscriptions: Array<() => void> = [];
  private totalEvents: number = 0;
  private swapCount: number = 0;
  private mintCount: number = 0;
  private burnCount: number = 0;
  private eventTypeCounts: Map<string, number> = new Map();

  constructor(private apiKey: string) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client = createClient({
        url: CONFIG.CODEX_WSS_URL,
        webSocketImpl: WebSocket,
        connectionParams: {
          Authorization: this.apiKey,
        },
      });

      console.log('✅ Codex WebSocket connected');

      // Subscribe to all pools
      FOURMEME_POOLS.forEach((pool, index) => {
        const unsubscribe = this.client!.subscribe(
          {
            query: `
              subscription OnPoolEvents($address: String!, $networkId: Int!) {
                onEventsCreated(address: $address, networkId: $networkId) {
                  address
                  networkId
                  events {
                    eventType
                    token0Address
                    token1Address
                    transactionHash
                  }
                }
              }
            `,
            variables: {
              address: pool.poolAddress,
              networkId: CONFIG.FOURMEME.codexNetworkId,
            },
          },
          {
            next: (data) => this.handleMessage(data, pool),
            error: (error) => {
              console.error(`[CODEX] ❌ Subscription error for ${pool.symbol}:`, error);
            },
            complete: () => {
              console.log(`[CODEX] Subscription completed for ${pool.symbol}`);
            },
          }
        );

        this.subscriptions.push(unsubscribe);
      });

      console.log(`📡 Codex: Subscribed to ${FOURMEME_POOLS.length} Four.meme pools\n`);
      resolve();
    });
  }

  private handleMessage(data: any, pool: any) {
    const events = data?.data?.onEventsCreated?.events || [];

    if (events.length > 0) {
      console.log(`[CODEX] 📊 Received ${events.length} events for ${pool.symbol}`);
    }

    events.forEach((event: any) => {
      this.totalEvents++;

      // Track event types
      const eventType = event.eventType || 'Unknown';
      this.eventTypeCounts.set(eventType, (this.eventTypeCounts.get(eventType) || 0) + 1);

      if (eventType === 'Swap') {
        this.swapCount++;
        console.log(`[CODEX] 🔄 Swap detected in ${pool.symbol} pool, Tx: ${event.transactionHash?.substring(0, 10)}...`);
      } else if (eventType === 'Mint') {
        this.mintCount++;
      } else if (eventType === 'Burn') {
        this.burnCount++;
      }

      // Track transaction hash
      if (event.transactionHash) {
        this.detectedTxHashes.add(event.transactionHash.toLowerCase());
      }

      // Check if token0 or token1 is a Four.meme token
      const token0 = event.token0Address?.toLowerCase();
      const token1 = event.token1Address?.toLowerCase();

      if (token0 && token0.endsWith(CONFIG.FOURMEME.addressPattern.toLowerCase())) {
        console.log(`[CODEX] ✅ Four.meme token detected (token0): ${token0}`);
        this.detectedTokens.add(token0);
      }
      if (token1 && token1.endsWith(CONFIG.FOURMEME.addressPattern.toLowerCase())) {
        console.log(`[CODEX] ✅ Four.meme token detected (token1): ${token1}`);
        this.detectedTokens.add(token1);
      }
    });
  }

  getTokens(): string[] {
    return Array.from(this.detectedTokens);
  }

  getTxHashes(): string[] {
    return Array.from(this.detectedTxHashes);
  }

  getStats() {
    return {
      totalEvents: this.totalEvents,
      uniqueTxHashes: this.detectedTxHashes.size,
      uniqueTokens: this.detectedTokens.size,
      swapCount: this.swapCount,
      mintCount: this.mintCount,
      burnCount: this.burnCount,
      eventTypeCounts: Object.fromEntries(this.eventTypeCounts),
    };
  }

  close() {
    this.subscriptions.forEach(unsubscribe => unsubscribe());
    this.client?.dispose();
  }
}

// ============================================================================
// Comparison Logic
// ============================================================================

function compareResults(
  mobulaTokens: string[],
  codexTokens: string[],
  mobulaTxHashes: string[],
  codexTxHashes: string[]
) {
  // Compare tokens
  const mobulaTokenSet = new Set(mobulaTokens.map(t => t.toLowerCase()));
  const codexTokenSet = new Set(codexTokens.map(t => t.toLowerCase()));

  const commonTokens = new Set<string>();
  const uniqueTokensToMobula = new Set<string>();
  const uniqueTokensToCodex = new Set<string>();

  mobulaTokenSet.forEach(token => {
    if (codexTokenSet.has(token)) {
      commonTokens.add(token);
    } else {
      uniqueTokensToMobula.add(token);
    }
  });

  codexTokenSet.forEach(token => {
    if (!mobulaTokenSet.has(token)) {
      uniqueTokensToCodex.add(token);
    }
  });

  // Compare transaction hashes
  const mobulaTxSet = new Set(mobulaTxHashes.map(h => h.toLowerCase()));
  const codexTxSet = new Set(codexTxHashes.map(h => h.toLowerCase()));

  const commonTxHashes = new Set<string>();
  const uniqueTxToMobula = new Set<string>();
  const uniqueTxToCodex = new Set<string>();

  mobulaTxSet.forEach(hash => {
    if (codexTxSet.has(hash)) {
      commonTxHashes.add(hash);
    } else {
      uniqueTxToMobula.add(hash);
    }
  });

  codexTxSet.forEach(hash => {
    if (!mobulaTxSet.has(hash)) {
      uniqueTxToCodex.add(hash);
    }
  });

  return {
    tokens: {
      total: mobulaTokenSet.size + codexTokenSet.size - commonTokens.size,
      mobula: { count: mobulaTokenSet.size, items: mobulaTokenSet },
      codex: { count: codexTokenSet.size, items: codexTokenSet },
      common: { count: commonTokens.size, items: commonTokens },
      uniqueToMobula: { count: uniqueTokensToMobula.size, items: uniqueTokensToMobula },
      uniqueToCodex: { count: uniqueTokensToCodex.size, items: uniqueTokensToCodex },
    },
    transactions: {
      total: mobulaTxSet.size + codexTxSet.size - commonTxHashes.size,
      mobula: { count: mobulaTxSet.size, items: mobulaTxSet },
      codex: { count: codexTxSet.size, items: codexTxSet },
      common: { count: commonTxHashes.size, items: commonTxHashes },
      uniqueToMobula: { count: uniqueTxToMobula.size, items: uniqueTxToMobula },
      uniqueToCodex: { count: uniqueTxToCodex.size, items: uniqueTxToCodex },
    },
  };
}

// ============================================================================
// Main Health Check
// ============================================================================

async function runHealthCheck() {
  const startTime = Date.now();

  console.log('🚀 Mobula vs Codex WebSocket Health Check - Four.meme Platform\n');
  console.log('='.repeat(80));
  console.log('📋 Configuration:');
  console.log(`   - Platform: Four.meme`);
  console.log(`   - Chain: BSC`);
  console.log(`   - Monitored pools: ${FOURMEME_POOLS.length}`);
  console.log(`   - Collection time: ${CONFIG.COLLECTION_TIME_MS / 1000}s`);
  console.log('='.repeat(80) + '\n');

  console.log('📊 Monitored Pools:\n');
  FOURMEME_POOLS.forEach((pool, i) => {
    console.log(`   ${i + 1}. ${pool.symbol} - ${pool.name}`);
    console.log(`      Token: ${pool.tokenAddress}`);
    console.log(`      Pool: ${pool.poolAddress}\n`);
  });

  console.log('📊 Connecting to WebSockets...\n');

  const mobulaClient = new MobulaFastTradeClient(CONFIG.MOBULA_API_KEY!);
  const codexClient = new CodexWebSocketClient(CONFIG.CODEX_API_KEY!);

  await Promise.all([mobulaClient.connect(), codexClient.connect()]);

  console.log(`⏳ Collecting data for ${CONFIG.COLLECTION_TIME_MS / 1000} seconds...\n`);
  await new Promise((resolve) => setTimeout(resolve, CONFIG.COLLECTION_TIME_MS));

  const mobulaTokens = mobulaClient.getTokens();
  const codexTokens = codexClient.getTokens();
  const mobulaTxHashes = mobulaClient.getTxHashes();
  const codexTxHashes = codexClient.getTxHashes();
  const mobulaStats = mobulaClient.getStats();
  const codexStats = codexClient.getStats();

  mobulaClient.close();
  codexClient.close();

  console.log(`\n✅ Collection complete\n`);

  const comparison = compareResults(mobulaTokens, codexTokens, mobulaTxHashes, codexTxHashes);
  const duration = Date.now() - startTime;

  console.log('='.repeat(80));
  console.log('📊 FINAL SCORE PANEL');
  console.log('='.repeat(80) + '\n');

  // Calculate coverage percentage for display
  const tempCoveragePercentage = codexStats.swapCount > 0 ? (mobulaStats.totalTrades / codexStats.swapCount) * 100 : 100;

  // Display comprehensive statistics with swap comparison
  console.log('🔄 SWAP/TRADE COMPARISON:');
  console.log(`   Mobula Trades (Swaps): ${mobulaStats.totalTrades}`);
  console.log(`   Codex Swap Events: ${codexStats.swapCount}`);
  console.log(`   Coverage: ${tempCoveragePercentage.toFixed(2)}% (threshold: 85%)`);
  console.log(`   Difference: ${mobulaStats.totalTrades - codexStats.swapCount} (${mobulaStats.totalTrades >= codexStats.swapCount ? 'Mobula ahead' : 'Codex ahead'})\n`);

  console.log('📈 MOBULA DETAILED STATISTICS:');
  console.log(`   Total Trades/Swaps: ${mobulaStats.totalTrades}`);
  console.log(`   Unique Transactions: ${mobulaStats.uniqueTxHashes}`);
  console.log(`   Unique Tokens: ${mobulaStats.uniqueTokens}`);
  console.log(`   Buy Trades: ${mobulaStats.buyCount}`);
  console.log(`   Sell Trades: ${mobulaStats.sellCount}\n`);

  console.log('📈 CODEX DETAILED STATISTICS:');
  console.log(`   Total Events: ${codexStats.totalEvents}`);
  console.log(`   Swap Events: ${codexStats.swapCount}`);
  console.log(`   Mint Events: ${codexStats.mintCount}`);
  console.log(`   Burn Events: ${codexStats.burnCount}`);
  console.log(`   Unique Transactions: ${codexStats.uniqueTxHashes}`);
  console.log(`   Unique Tokens: ${codexStats.uniqueTokens}`);
  if (Object.keys(codexStats.eventTypeCounts).length > 0) {
    console.log(`   Event Types Breakdown:`, codexStats.eventTypeCounts);
  }
  console.log();

  console.log('='.repeat(80));
  console.log('🔍 TRANSACTION COMPARISON');
  console.log('='.repeat(80) + '\n');

  console.log('📊 Transaction Hash Matching:');
  console.log(`   Total unique transactions: ${comparison.transactions.total}`);
  console.log(`   Found by BOTH: ${comparison.transactions.common.count}`);
  console.log(`   Only Mobula: ${comparison.transactions.uniqueToMobula.count}`);
  console.log(`   Only Codex: ${comparison.transactions.uniqueToCodex.count}\n`);

  if (comparison.transactions.common.count > 0) {
    console.log(`✅ Transactions found by BOTH (${comparison.transactions.common.count}):`);
    Array.from(comparison.transactions.common.items).slice(0, 5).forEach((hash, i) => {
      console.log(`   ${i + 1}. ${hash.substring(0, 16)}...`);
    });
    if (comparison.transactions.common.count > 5) {
      console.log(`   ... and ${comparison.transactions.common.count - 5} more`);
    }
    console.log();
  }

  if (comparison.transactions.uniqueToMobula.count > 0) {
    console.log(`🔷 Transactions ONLY by Mobula (${comparison.transactions.uniqueToMobula.count}):`);
    Array.from(comparison.transactions.uniqueToMobula.items).slice(0, 5).forEach((hash, i) => {
      console.log(`   ${i + 1}. ${hash.substring(0, 16)}...`);
    });
    if (comparison.transactions.uniqueToMobula.count > 5) {
      console.log(`   ... and ${comparison.transactions.uniqueToMobula.count - 5} more`);
    }
    console.log();
  }

  if (comparison.transactions.uniqueToCodex.count > 0) {
    console.log(`🔶 Transactions ONLY by Codex (${comparison.transactions.uniqueToCodex.count}):`);
    Array.from(comparison.transactions.uniqueToCodex.items).slice(0, 5).forEach((hash, i) => {
      console.log(`   ${i + 1}. ${hash.substring(0, 16)}...`);
    });
    if (comparison.transactions.uniqueToCodex.count > 5) {
      console.log(`   ... and ${comparison.transactions.uniqueToCodex.count - 5} more`);
    }
    console.log();
  }

  console.log('='.repeat(80));
  console.log('🪙 TOKEN COMPARISON');
  console.log('='.repeat(80) + '\n');

  console.log('📊 Token Detection:');
  console.log(`   Total unique tokens: ${comparison.tokens.total}`);
  console.log(`   Found by BOTH: ${comparison.tokens.common.count}`);
  console.log(`   Only Mobula: ${comparison.tokens.uniqueToMobula.count}`);
  console.log(`   Only Codex: ${comparison.tokens.uniqueToCodex.count}\n`);

  // Helper to get token info
  const getTokenInfo = (address: string) => {
    const pool = FOURMEME_POOLS.find(p => p.tokenAddress.toLowerCase() === address.toLowerCase());
    return pool ? `${pool.symbol} (${pool.name})` : address;
  };

  if (comparison.tokens.common.count > 0) {
    console.log(`✅ Tokens found by BOTH (${comparison.tokens.common.count}):`);
    Array.from(comparison.tokens.common.items).forEach((token, i) => {
      console.log(`   ${i + 1}. ${getTokenInfo(token)}`);
    });
    console.log();
  }

  if (comparison.tokens.uniqueToMobula.count > 0) {
    console.log(`🔷 Tokens ONLY by Mobula (${comparison.tokens.uniqueToMobula.count}):`);
    Array.from(comparison.tokens.uniqueToMobula.items).forEach((token, i) => {
      console.log(`   ${i + 1}. ${getTokenInfo(token)}`);
    });
    console.log();
  }

  if (comparison.tokens.uniqueToCodex.count > 0) {
    console.log(`🔶 Tokens ONLY by Codex (${comparison.tokens.uniqueToCodex.count}):`);
    Array.from(comparison.tokens.uniqueToCodex.items).forEach((token, i) => {
      console.log(`   ${i + 1}. ${getTokenInfo(token)}`);
    });
    console.log();
  }

  console.log(`⏱️  Total duration: ${(duration / 1000).toFixed(2)} seconds`);
  console.log('='.repeat(80) + '\n');

  // Health check with 15% margin of error
  // Mobula must detect at least 85% of Codex's transactions to pass
  const codexCount = comparison.transactions.codex.count;
  const mobulaCount = comparison.transactions.mobula.count;
  const threshold = codexCount * 0.85;
  const coveragePercentage = codexCount > 0 ? (mobulaCount / codexCount) * 100 : 100;
  const healthStatus = mobulaCount >= threshold ? 'PASS' : 'FAIL';

  return {
    comparison,
    mobulaStats,
    codexStats,
    healthStatus,
    mobulaCount,
    codexCount,
    coveragePercentage,
    threshold,
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

    console.log('📊 HEALTH CHECK RESULT:\n');

    if (results.healthStatus === 'FAIL') {
      console.log(`❌ HEALTH CHECK FAILED`);
      console.log(`   Mobula coverage is below the 85% threshold!`);
      console.log(`   - Mobula: ${results.mobulaCount} transactions`);
      console.log(`   - Codex: ${results.codexCount} transactions`);
      console.log(`   - Coverage: ${results.coveragePercentage.toFixed(2)}% (minimum required: 85.00%)`);
      console.log(`   - Missing: ${Math.ceil(results.threshold - results.mobulaCount)} transactions to pass\n`);
      process.exit(1);
    } else {
      console.log(`✅ HEALTH CHECK PASSED`);
      console.log(`   Mobula coverage meets the 85% threshold`);
      console.log(`   - Mobula: ${results.mobulaCount} transactions`);
      console.log(`   - Codex: ${results.codexCount} transactions`);
      console.log(`   - Coverage: ${results.coveragePercentage.toFixed(2)}%`);
      console.log(`   - Common transactions: ${results.comparison.transactions.common.count}\n`);
      process.exit(0);
    }
  } catch (error) {
    console.error('💥 Fatal error:', error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
