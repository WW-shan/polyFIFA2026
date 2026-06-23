import { createPublicClient, erc20Abi, formatUnits, http, type Address } from "viem";
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
  requestedStake: number,
  balance: number,
  options: { minimumNotional: number; buffer?: number }
): BalanceStakeDecision {
  const buffer = options.buffer ?? 0;
  const available = roundDownMoney(balance - buffer);
  if (!Number.isFinite(available) || available < options.minimumNotional) {
    return {
      action: "NO_TRADE",
      reason: "INSUFFICIENT_BALANCE",
      details: `pUSD balance ${balance} minus buffer ${buffer} is below minimum ${options.minimumNotional}`
    };
  }

  return { action: "USE_STAKE", stake: Math.min(requestedStake, available) };
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
