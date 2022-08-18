import * as _ from "lodash";
import { BigNumber, Contract, Wallet } from "ethers";
import { FlashbotsBundleProvider } from "@flashbots/ethers-provider-bundle";
import { WETH_ADDRESS } from "./addresses";
import { EthMarket } from "./EthMarket";
import { ETHER, bigNumberToDecimal } from "./utils";

export interface CrossedMarketDetails {
  profit: BigNumber,
  volume: BigNumber,
  tokenAddress: string,
  buyFromMarket: EthMarket,
  sellToMarket: EthMarket,
}

export type MarketsByToken = { [tokenAddress: string]: Array<EthMarket> }

// TODO: implement binary search (assuming linear/exponential global maximum profitability)
// @audit from small to big
const TEST_VOLUMES = [
  ETHER.div(100),
  ETHER.div(10),
  ETHER.div(6),
  ETHER.div(4),
  ETHER.div(2),
  ETHER.div(1),
  ETHER.mul(2),
  ETHER.mul(5),
  ETHER.mul(10),
]

//@audit find out the profit begins to decline when the size increases
// @audit once try, if cannot find the best size, just break, use the last bestmarket as the final bestmarket
// for one token, the optimal market pair for every market, use the liquidity to get just one best market pair for one token
export function getBestCrossedMarket(crossedMarkets: Array<EthMarket>[], tokenAddress: string): CrossedMarketDetails | undefined {
  let bestCrossedMarket: CrossedMarketDetails | undefined = undefined;
  for (const crossedMarket of crossedMarkets) {
    const sellToMarket = crossedMarket[0]
    const buyFromMarket = crossedMarket[1]
    for (const size of TEST_VOLUMES) {
      //@audit to calculate the profit for two EthMarket
      const tokensOutFromBuyingSize = buyFromMarket.getTokensOut(WETH_ADDRESS, tokenAddress, size);
      const proceedsFromSellingTokens = sellToMarket.getTokensOut(tokenAddress, WETH_ADDRESS, tokensOutFromBuyingSize)
      const profit = proceedsFromSellingTokens.sub(size);
      // if this is not the first time to set the bestMarket, or 
      // @audit find out the profit begins to decline when the size increases
      // @audit we need to use 2 divide size to try to find the best size
      // @audit once try, if cannot find the best size, just break, use the last bestmarket as the final bestmarket
      if (bestCrossedMarket !== undefined && profit.lt(bestCrossedMarket.profit)) {
        // If the next size up lost value, meet halfway. TODO: replace with real binary search
        const trySize = size.add(bestCrossedMarket.volume).div(2)
        const tryTokensOutFromBuyingSize = buyFromMarket.getTokensOut(WETH_ADDRESS, tokenAddress, trySize);
        const tryProceedsFromSellingTokens = sellToMarket.getTokensOut(tokenAddress, WETH_ADDRESS, tryTokensOutFromBuyingSize)
        const tryProfit = tryProceedsFromSellingTokens.sub(trySize);
        if (tryProfit.gt(bestCrossedMarket.profit)) {
          bestCrossedMarket = {
            volume: trySize,
            profit: tryProfit,
            tokenAddress,
            sellToMarket,
            buyFromMarket
          }
        }
        break;
      }
      bestCrossedMarket = {
        volume: size,
        profit: profit,
        tokenAddress,
        sellToMarket,
        buyFromMarket
      }
    }
  }
  return bestCrossedMarket;
}

export class Arbitrage {
  private flashbotsProvider: FlashbotsBundleProvider;
  private bundleExecutorContract: Contract;
  private executorWallet: Wallet;

  constructor(executorWallet: Wallet, flashbotsProvider: FlashbotsBundleProvider, bundleExecutorContract: Contract) {
    this.executorWallet = executorWallet;
    this.flashbotsProvider = flashbotsProvider;
    this.bundleExecutorContract = bundleExecutorContract;
  }

  // @audit to print the cross market info
  static printCrossedMarket(crossedMarket: CrossedMarketDetails): void {
    const buyTokens = crossedMarket.buyFromMarket.tokens
    const sellTokens = crossedMarket.sellToMarket.tokens
    console.log(
      `Profit: ${bigNumberToDecimal(crossedMarket.profit)} Volume: ${bigNumberToDecimal(crossedMarket.volume)}\n` +
      `${crossedMarket.buyFromMarket.protocol} (${crossedMarket.buyFromMarket.marketAddress})\n` +
      `  ${buyTokens[0]} => ${buyTokens[1]}\n` +
      `${crossedMarket.sellToMarket.protocol} (${crossedMarket.sellToMarket.marketAddress})\n` +
      `  ${sellTokens[0]} => ${sellTokens[1]}\n` +
      `\n`
    )
  }


  //@audit params token's market address
  //@audit return to get the detail of cross market detail
  async evaluateMarkets(marketsByToken: MarketsByToken): Promise<Array<CrossedMarketDetails>> {
    const bestCrossedMarkets = new Array<CrossedMarketDetails>()

    // every token will have one best market pair
    for (const tokenAddress in marketsByToken) {
      const markets = marketsByToken[tokenAddress]
      // to get the market's buy price and sell price for one token(just FLX)'s market
      // then arrange in one array
      const pricedMarkets = _.map(markets, (ethMarket: EthMarket) => {
        return {
          ethMarket: ethMarket,
          buyTokenPrice: ethMarket.getTokensIn(tokenAddress, WETH_ADDRESS, ETHER.div(100)),
          sellTokenPrice: ethMarket.getTokensOut(WETH_ADDRESS, tokenAddress, ETHER.div(100)),
        }
      });

      const crossedMarkets = new Array<Array<EthMarket>>()
      // compare two market for just one token
      // for each market, get the optimal pair market; maybe sell and buy in one market.
      for (const pricedMarket of pricedMarkets) {
        // to get the optimal price market pair
        _.forEach(pricedMarkets, pm => {
          // sell price is gt buy price, gain more token, if we have the same WETH token
          if (pm.sellTokenPrice.gt(pricedMarket.buyTokenPrice)) {
            crossedMarkets.push([pricedMarket.ethMarket, pm.ethMarket])
          }
        })
      }

      const bestCrossedMarket = getBestCrossedMarket(crossedMarkets, tokenAddress);
      // @audit we need the market has at least ETHER.div(1000) profit
      if (bestCrossedMarket !== undefined && bestCrossedMarket.profit.gt(ETHER.div(1000))) {
        bestCrossedMarkets.push(bestCrossedMarket)
      }
    }
    // sort the bestCrossedMarkets by profit.
    bestCrossedMarkets.sort((a, b) => a.profit.lt(b.profit) ? 1 : a.profit.gt(b.profit) ? -1 : 0)
    return bestCrossedMarkets
  }

  // TODO: take more than 1
  //@audit for every bestcrossmarket, to execute both buy and sell transactions
  //@audit 1. get transaction data and target; 2. estimate gas; 3. signbundle; 4. simulate; 5. sendbundle.
  async takeCrossedMarkets(bestCrossedMarkets: CrossedMarketDetails[], blockNumber: number, minerRewardPercentage: number): Promise<void> {
    for (const bestCrossedMarket of bestCrossedMarkets) {

      console.log("Send this much WETH", bestCrossedMarket.volume.toString(), "get this much profit", bestCrossedMarket.profit.toString())
      // to return swap() data and target address
      const buyCalls = await bestCrossedMarket.buyFromMarket.sellTokensToNextMarket(WETH_ADDRESS, bestCrossedMarket.volume, bestCrossedMarket.sellToMarket);
      const inter = bestCrossedMarket.buyFromMarket.getTokensOut(WETH_ADDRESS, bestCrossedMarket.tokenAddress, bestCrossedMarket.volume)
      // to return swap() data
      const sellCallData = await bestCrossedMarket.sellToMarket.sellTokens(bestCrossedMarket.tokenAddress, inter, this.bundleExecutorContract.address);

      const targets: Array<string> = [...buyCalls.targets, bestCrossedMarket.sellToMarket.marketAddress]
      const payloads: Array<string> = [...buyCalls.data, sellCallData]
      console.log({targets, payloads})
      const minerReward = bestCrossedMarket.profit.mul(minerRewardPercentage).div(100);
      //contract.populateTransaction.METHOD_NAME
      //Returns an UnsignedTransaction which represents the transaction that would need to be signed and submitted to the network to execute METHOD_NAME with args and overrides.
      //@audit to bundle two transactions in one execution: including buy token and sell token
      //@audit targets and payloads includes all execuation information
      const transaction = await this.bundleExecutorContract.populateTransaction.uniswapWeth(bestCrossedMarket.volume, minerReward, targets, payloads, {
        gasPrice: BigNumber.from(0),
        gasLimit: BigNumber.from(1000000),
      });


      try {
        //estimateGas
        //Returns an estimate of the amount of gas that would be required to submit transaction to the network.
        const estimateGas = await this.bundleExecutorContract.provider.estimateGas(
          {
            ...transaction,
            from: this.executorWallet.address
          })
        if (estimateGas.gt(1400000)) {
          console.log("EstimateGas succeeded, but suspiciously large: " + estimateGas.toString())
          continue
        }
        transaction.gasLimit = estimateGas.mul(2)
      } catch (e) {
        console.warn(`Estimate gas failure for ${JSON.stringify(bestCrossedMarket)}`)
        continue
      }
      const bundledTransactions = [
        {
          signer: this.executorWallet,
          transaction: transaction
        }
      ];
      console.log(bundledTransactions)
      const signedBundle = await this.flashbotsProvider.signBundle(bundledTransactions)
      //
      const simulation = await this.flashbotsProvider.simulate(signedBundle, blockNumber + 1 )
      if ("error" in simulation || simulation.firstRevert !== undefined) {
        console.log(`Simulation Error on token ${bestCrossedMarket.tokenAddress}, skipping`)
        continue
      }
      console.log(`Submitting bundle, profit sent to miner: ${bigNumberToDecimal(simulation.coinbaseDiff)}, effective gas price: ${bigNumberToDecimal(simulation.coinbaseDiff.div(simulation.totalGasUsed), 9)} GWEI`)
      //@audit why does it need to try 2 blocks for the sendRawBundle()
      //@audit if one block is ok, then the bundle will end???????
      const bundlePromises =  _.map([blockNumber + 1, blockNumber + 2], targetBlockNumber =>
        this.flashbotsProvider.sendRawBundle(
          signedBundle,
          targetBlockNumber
        ))
      await Promise.all(bundlePromises)
      return
    }
    throw new Error("No arbitrage submitted to relay")
  }
}
