import * as _ from "lodash";
import { BigNumber, Contract, providers } from "ethers";
import { UNISWAP_PAIR_ABI, UNISWAP_QUERY_ABI } from "./abi";
import { UNISWAP_LOOKUP_CONTRACT_ADDRESS, WETH_ADDRESS } from "./addresses";
import { CallDetails, EthMarket, MultipleCallData, TokenBalances } from "./EthMarket";
import { ETHER } from "./utils";
import { MarketsByToken } from "./Arbitrage";

// batch count limit helpful for testing, loading entire set of uniswap markets takes a long time to load
const BATCH_COUNT_LIMIT = 100;
const UNISWAP_BATCH_SIZE = 1000

// Not necessary, slightly speeds up loading initialization when we know tokens are bad
// Estimate gas will ensure we aren't submitting bad bundles, but bad tokens waste time
const blacklistTokens = [
  '0xD75EA151a61d06868E31F8988D28DFE5E9df57B4'
]

//@audit MarketsBytoken: token address to map the Array of EthMarket
interface GroupedMarkets {  
  marketsByToken: MarketsByToken;
  allMarketPairs: Array<UniswappyV2EthPair>;
}

export class UniswappyV2EthPair extends EthMarket {
  //@audit use for swap transaction
  static uniswapInterface = new Contract(WETH_ADDRESS, UNISWAP_PAIR_ABI);
  private _tokenBalances: TokenBalances

  constructor(marketAddress: string, tokens: Array<string>, protocol: string) {
    super(marketAddress, tokens, protocol);
    this._tokenBalances = _.zipObject(tokens,[BigNumber.from(0), BigNumber.from(0)])
  }

  //@audit to check tokenAddress is in _tokenBalances{address:balance, }
  receiveDirectly(tokenAddress: string): boolean {
    return tokenAddress in this._tokenBalances
  }

  async prepareReceive(tokenAddress: string, amountIn: BigNumber): Promise<Array<CallDetails>> {
    if (this._tokenBalances[tokenAddress] === undefined) {
      throw new Error(`Market does not operate on token ${tokenAddress}`)
    }
    if (! amountIn.gt(0)) {
      throw new Error(`Invalid amount: ${amountIn.toString()}`)
    }
    // No preparation necessary
    return []
  }

  //@audit given the provider and factoryAddresss, to recode every WETH-X/X-WETH pair in marketpair
  static async getUniswappyMarkets(provider: providers.JsonRpcProvider, factoryAddress: string): Promise<Array<UniswappyV2EthPair>> {
    const uniswapQuery = new Contract(UNISWAP_LOOKUP_CONTRACT_ADDRESS, UNISWAP_QUERY_ABI, provider);

    const marketPairs = new Array<UniswappyV2EthPair>()
    //@audit get the pair address and token address in batch
    for (let i = 0; i < BATCH_COUNT_LIMIT * UNISWAP_BATCH_SIZE; i += UNISWAP_BATCH_SIZE) {
      const pairs: Array<Array<string>> = (await uniswapQuery.functions.getPairsByIndexRange(factoryAddress, i, i + UNISWAP_BATCH_SIZE))[0];
      for (let i = 0; i < pairs.length; i++) {
        const pair = pairs[i];
        const marketAddress = pair[2];
        let tokenAddress: string;

        //@audit to find all WETH-X pair, and record it, otherwise continue not record it
        if (pair[0] === WETH_ADDRESS) {
          tokenAddress = pair[1]
        } else if (pair[1] === WETH_ADDRESS) {
          tokenAddress = pair[0]
        } else {
          continue;
        }
        //@audit to record this tokenAddress, and push the pair into marketPairs
        if (!blacklistTokens.includes(tokenAddress)) {
          const uniswappyV2EthPair = new UniswappyV2EthPair(marketAddress, [pair[0], pair[1]], "");
          marketPairs.push(uniswappyV2EthPair);
        }
      }
      //@audit if pairs.length < batch-size, it seems to the end of uniswap list
      if (pairs.length < UNISWAP_BATCH_SIZE) {
        break
      }
    }

    return marketPairs
  }

  //@audit to get the pair address on factoryAddress
  //then to keep the pair address meet the following requirements: length>1; WETH balance > ETHER;
  static async getUniswapMarketsByToken(provider: providers.JsonRpcProvider, factoryAddresses: Array<string>): Promise<GroupedMarkets> {
    const allPairs = await Promise.all(
      _.map(factoryAddresses, factoryAddress => UniswappyV2EthPair.getUniswappyMarkets(provider, factoryAddress))
    )

    //@audit market by token, the key is token in pair(not weth), and the value of key is an array includes all market pairs
    const marketsByTokenAll = _.chain(allPairs)
      .flatten()
      .groupBy(pair => pair.tokens[0] === WETH_ADDRESS ? pair.tokens[1] : pair.tokens[0])
      .value()

    // pick up the length of pair is more than 1
    const allMarketPairs = _.chain(
      _.pickBy(marketsByTokenAll, a => a.length > 1) // weird TS bug, chain'd pickBy is Partial<>
    )
      .values()
      .flatten()
      .value()

    await UniswappyV2EthPair.updateReserves(provider, allMarketPairs);

    //@audit to pick up the pair which has WETH balance is more than ETHER
    //@audit group by pair.token
    const marketsByToken = _.chain(allMarketPairs)
      .filter(pair => (pair.getBalance(WETH_ADDRESS).gt(ETHER)))
      .groupBy(pair => pair.tokens[0] === WETH_ADDRESS ? pair.tokens[1] : pair.tokens[0])
      .value()

    return {
      marketsByToken,
      allMarketPairs
    }
  }

  //@audit to update the pair reserve in token 0 and token 1
  static async updateReserves(provider: providers.JsonRpcProvider, allMarketPairs: Array<UniswappyV2EthPair>): Promise<void> {
    const uniswapQuery = new Contract(UNISWAP_LOOKUP_CONTRACT_ADDRESS, UNISWAP_QUERY_ABI, provider);
    const pairAddresses = allMarketPairs.map(marketPair => marketPair.marketAddress);
    console.log("Updating markets, count:", pairAddresses.length)
    //@audit get the updated token reserve
    const reserves: Array<Array<BigNumber>> = (await uniswapQuery.functions.getReservesByPairs(pairAddresses))[0];
    for (let i = 0; i < allMarketPairs.length; i++) {
      const marketPair = allMarketPairs[i];
      const reserve = reserves[i]
      marketPair.setReservesViaOrderedBalances([reserve[0], reserve[1]])
    }
  }

  //@audit get the balance of some token address
  getBalance(tokenAddress: string): BigNumber {
    const balance = this._tokenBalances[tokenAddress]
    if (balance === undefined) throw new Error("bad token")
    return balance;
  }

  //@audit set the balance for every token
  setReservesViaOrderedBalances(balances: Array<BigNumber>): void {
    this.setReservesViaMatchingArray(this._tokens, balances)
  }

  //@audit set the balance for every token, if present tokenBalances is noe equal to the new tokenBalances
  //renew it
  setReservesViaMatchingArray(tokens: Array<string>, balances: Array<BigNumber>): void {
    const tokenBalances = _.zipObject(tokens, balances)
    if (!_.isEqual(this._tokenBalances, tokenBalances)) {
      this._tokenBalances = tokenBalances
    }
  }

  //@audit given the tokenIn address and tokenOut address and the amount needed to out
  //@audit give the amount of tokenIn I need
  getTokensIn(tokenIn: string, tokenOut: string, amountOut: BigNumber): BigNumber {
    const reserveIn = this._tokenBalances[tokenIn]
    const reserveOut = this._tokenBalances[tokenOut]
    return this.getAmountIn(reserveIn, reserveOut, amountOut);
  }

  //@audit given the tokenIn address and tokenOut address and the amount needed to in
  //@audit give the amount of tokenOut I will have
  getTokensOut(tokenIn: string, tokenOut: string, amountIn: BigNumber): BigNumber {
    const reserveIn = this._tokenBalances[tokenIn]
    const reserveOut = this._tokenBalances[tokenOut]
    return this.getAmountOut(reserveIn, reserveOut, amountIn);
  }

  //@audit count the amountIn
  //@audit amountIn = reIn * amountOut * 1000 / ( (reOut - amountOut) * 997 )
  getAmountIn(reserveIn: BigNumber, reserveOut: BigNumber, amountOut: BigNumber): BigNumber {
    const numerator: BigNumber = reserveIn.mul(amountOut).mul(1000);
    const denominator: BigNumber = reserveOut.sub(amountOut).mul(997);
    return numerator.div(denominator).add(1);
  }

  //@audit count the amountOut
  //@audit amountOut = amountIn * reOut * 997 / ( reIn * 1000 +  amountIn * 997 )
  //@audit divide 1000 on denominator and numerator
  //@audit amountOut = amountInWithFee * reOut / (reIn + amountInWithFee)
  getAmountOut(reserveIn: BigNumber, reserveOut: BigNumber, amountIn: BigNumber): BigNumber {
    const amountInWithFee: BigNumber = amountIn.mul(997);
    const numerator = amountInWithFee.mul(reserveOut);
    const denominator = reserveIn.mul(1000).add(amountInWithFee);
    return numerator.div(denominator);
  }

  //@audit this function seems to have problem????????
  //why duplicate the same code????
  //@audit to return swap() data and target address
  async sellTokensToNextMarket(tokenIn: string, amountIn: BigNumber, ethMarket: EthMarket): Promise<MultipleCallData> {
    if (ethMarket.receiveDirectly(tokenIn) === true) {
      const exchangeCall = await this.sellTokens(tokenIn, amountIn, ethMarket.marketAddress)
      return {
        data: [exchangeCall],
        targets: [this.marketAddress]
      }
    }

    const exchangeCall = await this.sellTokens(tokenIn, amountIn, ethMarket.marketAddress)
    return {
      data: [exchangeCall],
      targets: [this.marketAddress]
    }
  }

  //Returns an UnsignedTransaction which represents the transaction that would need to be signed and submitted to the network to execute METHOD_NAME with args and overrides.
  //@audit just have two tokens in UniswapV2EthPair
  //@audit given the tokenIn address, and tokenIn amount amountIn, return the amountOunt
  //@audit to return swap() data
  async sellTokens(tokenIn: string, amountIn: BigNumber, recipient: string): Promise<string> {
    // function swap(uint amount0Out, uint amount1Out, address to, bytes calldata data) external lock {
    let amount0Out = BigNumber.from(0)
    let amount1Out = BigNumber.from(0)
    let tokenOut: string;
    //to calculate the tokens out
    if (tokenIn === this.tokens[0]) {
      tokenOut = this.tokens[1]
      amount1Out = this.getTokensOut(tokenIn, tokenOut, amountIn)
    } else if (tokenIn === this.tokens[1]) {
      tokenOut = this.tokens[0]
      amount0Out = this.getTokensOut(tokenIn, tokenOut, amountIn)
    } else {
      throw new Error("Bad token input address")
    }
    //@audit uniswapInterface is new Contract by ethers.js
    //@audit so the Contract has the function populateTransaction.method(value)
    const populatedTransaction = await UniswappyV2EthPair.uniswapInterface.populateTransaction.swap(amount0Out, amount1Out, recipient, []);
    if (populatedTransaction === undefined || populatedTransaction.data === undefined) throw new Error("HI")
    return populatedTransaction.data;
  }
}
