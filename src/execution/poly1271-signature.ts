import { concat, encodeAbiParameters, keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export interface Poly1271OrderForSigning {
  salt: string | number | bigint;
  maker: string;
  signer: string;
  tokenId: string | number | bigint;
  makerAmount: string | number | bigint;
  takerAmount: string | number | bigint;
  side: "BUY" | "SELL" | 0 | 1;
  signatureType: string | number | bigint;
  timestamp: string | number | bigint;
  metadata?: string | undefined;
  builder?: string | undefined;
}

export interface SignPoly1271OrderArgs {
  privateKey: string;
  chainId: number;
  exchangeAddress: string;
  order: Poly1271OrderForSigning;
}

const ORDER_TYPE_STRING =
  "Order(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder)";
const SOLADY_TYPE_STRING =
  `TypedDataSign(Order contents,string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)${ORDER_TYPE_STRING}`;
const DOMAIN_TYPE_STRING = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";

const ORDER_TYPE_HASH = keccak256(toHex(ORDER_TYPE_STRING));
const SOLADY_TYPE_HASH = keccak256(toHex(SOLADY_TYPE_STRING));
const DOMAIN_TYPE_HASH = keccak256(toHex(DOMAIN_TYPE_STRING));
const DEPOSIT_WALLET_NAME_HASH = keccak256(toHex("DepositWallet"));
const DEPOSIT_WALLET_VERSION_HASH = keccak256(toHex("1"));
const CTF_EXCHANGE_V2_DOMAIN_NAME_HASH = keccak256(toHex("Polymarket CTF Exchange"));
const CTF_EXCHANGE_V2_DOMAIN_VERSION_HASH = keccak256(toHex("2"));
const BYTES32_ZERO = `0x${"0".repeat(64)}` as Hex;

export async function signPoly1271Order(args: SignPoly1271OrderArgs): Promise<Hex> {
  const account = privateKeyToAccount(normalizePrivateKey(args.privateKey));
  const appDomainSeparator = buildAppDomainSeparator(args.chainId, args.exchangeAddress);
  const contentsHash = buildOrderContentsHash(args.order);
  const typedDataSignStructHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "bytes32" }
      ],
      [
        SOLADY_TYPE_HASH,
        contentsHash,
        DEPOSIT_WALLET_NAME_HASH,
        DEPOSIT_WALLET_VERSION_HASH,
        BigInt(args.chainId),
        args.order.signer as Hex,
        BYTES32_ZERO
      ]
    )
  );
  const digest = keccak256(concat(["0x1901", appDomainSeparator, typedDataSignStructHash]));
  const innerSignature = await account.sign({ hash: digest });
  const contentsType = toHex(ORDER_TYPE_STRING);
  const contentsTypeLength = ORDER_TYPE_STRING.length.toString(16).padStart(4, "0");

  return `0x${innerSignature.slice(2)}${appDomainSeparator.slice(2)}${contentsHash.slice(2)}${contentsType.slice(2)}${contentsTypeLength}`;
}

function buildAppDomainSeparator(chainId: number, exchangeAddress: string): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [
        DOMAIN_TYPE_HASH,
        CTF_EXCHANGE_V2_DOMAIN_NAME_HASH,
        CTF_EXCHANGE_V2_DOMAIN_VERSION_HASH,
        BigInt(chainId),
        exchangeAddress as Hex
      ]
    )
  );
}

function buildOrderContentsHash(order: Poly1271OrderForSigning): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint8" },
        { type: "uint8" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" }
      ],
      [
        ORDER_TYPE_HASH,
        BigInt(order.salt),
        order.maker as Hex,
        order.signer as Hex,
        BigInt(order.tokenId),
        BigInt(order.makerAmount),
        BigInt(order.takerAmount),
        sideValue(order.side),
        Number(order.signatureType),
        BigInt(order.timestamp),
        (order.metadata ?? BYTES32_ZERO) as Hex,
        (order.builder ?? BYTES32_ZERO) as Hex
      ]
    )
  );
}

function sideValue(side: Poly1271OrderForSigning["side"]): 0 | 1 {
  if (side === "BUY" || side === 0) return 0;
  return 1;
}

function normalizePrivateKey(privateKey: string): Hex {
  return (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex;
}
