import { createPublicClient, erc20Abi, formatUnits, http, type Address } from "viem";
import { SPORTS_TAKER_FEE_RATE } from "../domain/fees.js";
import { polygon } from "viem/chains";
import type { NoTradeReason } from "../domain/types.js";

export const POLYMARKET_PUSD_ADDRESS = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
export const DEFAULT_POLYGON_RPC_URL = "https://polygon-bor-rpc.publicnode.com";

export interface BalanceReadClient {
  readContract(request: {
    address: Address;
    abi: typeof erc20Abi;
    functionName: "balanceOf";
    args: [Address];
  }): Promise<unknown>;
}

export type BalanceStakeDecision =
  | { action: "USE_STAKE"; stake: number }
  | { action: "NO_TRADE"; reason: Extract<NoTradeReason, "INSUFFICIENT_BALANCE">; details: string };

export function capStakeToAvailableBalance(
  requestedStake: number | undefined,
  balance: number,
  options: { minimumNotional: number; buffer?: number; feeReserveRate?: number }
): BalanceStakeDecision {
  const buffer = options.buffer ?? 0;
  // Polymarket charges the taker fee on top of a market BUY's notional
  // (`amount` is pre-fee), so a stake equal to the balance is rejected for
  // insufficient funds once the fee is added. Fee per notional for a BUY is
  // feeRate * (1 - price), which is bounded by feeRate as price approaches 0.
  const feeReserveRate = options.feeReserveRate ?? SPORTS_TAKER_FEE_RATE;
  const available = roundDownMoney(balance - buffer);
  const spendable = roundDownMoney(available / (1 + Math.max(0, feeReserveRate)));
  if (!Number.isFinite(spendable) || spendable < options.minimumNotional) {
    return {
      action: "NO_TRADE",
      reason: "INSUFFICIENT_BALANCE",
      details: `pUSD balance ${balance} minus buffer ${buffer} minus fee reserve ${feeReserveRate} is below minimum ${options.minimumNotional}`
    };
  }

  return { action: "USE_STAKE", stake: requestedStake === undefined ? spendable : Math.min(requestedStake, spendable) };
}

export async function readPusdBalance(
  walletAddress: string,
  rpcUrl = DEFAULT_POLYGON_RPC_URL,
  client: BalanceReadClient = createBalanceClient(rpcUrl)
): Promise<number> {
  const raw = await client.readContract({
    address: POLYMARKET_PUSD_ADDRESS as Address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [walletAddress as Address]
  });
  if (typeof raw !== "bigint") throw new Error("PUSD_BALANCE_READ_INVALID");
  return Number(formatUnits(raw, 6));
}

function createBalanceClient(rpcUrl: string): BalanceReadClient {
  return createPublicClient({
    chain: polygon,
    transport: http(rpcUrl)
  });
}

function roundDownMoney(value: number): number {
  return Math.floor(value * 1_000_000) / 1_000_000;
}
