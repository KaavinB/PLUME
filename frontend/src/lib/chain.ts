/**
 * Direct, read-only chain access from the browser (viem). Used by "View Proof" to check the
 * contract state and settlement transaction independently of the PLUME backend.
 */
import { createPublicClient, defineChain, http, type Hex } from "viem";

const RPC = process.env.NEXT_PUBLIC_CHAIN_RPC_URL ?? "http://127.0.0.1:8545";

export const CHAIN_STATES = [
  "None", "Open", "Funded", "Assigned", "Submitted", "Verified", "Rejected", "Inconclusive",
  "EvidenceRequested", "Disputed", "Paid", "Cancelled", "Refunded",
] as const;

export const repairEscrowAbi = [
  {
    type: "function",
    name: "getProject",
    stateMutability: "view",
    inputs: [{ name: "projectId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "sponsor", type: "address" },
          { name: "amount", type: "uint96" },
          { name: "provider", type: "address" },
          { name: "expiresAt", type: "uint64" },
          { name: "round", type: "uint32" },
          { name: "state", type: "uint8" },
          { name: "verifier", type: "address" },
          { name: "verifiedAt", type: "uint64" },
          { name: "disputeWindow", type: "uint32" },
          { name: "termsHash", type: "bytes32" },
          { name: "evidenceHash", type: "bytes32" },
          { name: "lastDecisionDigest", type: "bytes32" },
        ],
      },
    ],
  },
] as const;

export function publicClient(chainId: number, name: string) {
  const chain = defineChain({
    id: chainId,
    name,
    nativeCurrency: { name: "Test Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  });
  return createPublicClient({ chain, transport: http(RPC) });
}

export interface ChainProof {
  state: string;
  round: number;
  amount: bigint;
  evidenceHash: Hex;
  termsHash: Hex;
  lastDecisionDigest: Hex;
  provider: string;
  verifier: string;
  settlement: { status: string; blockNumber: bigint; from: string; to: string | null; gasUsed: bigint } | null;
}

export async function readProof(
  chainId: number,
  name: string,
  contract: Hex,
  onchainId: number,
  settlementTx: Hex,
): Promise<ChainProof> {
  const client = publicClient(chainId, name);
  const p = await client.readContract({ address: contract, abi: repairEscrowAbi, functionName: "getProject", args: [BigInt(onchainId)] });
  let settlement: ChainProof["settlement"] = null;
  try {
    const r = await client.getTransactionReceipt({ hash: settlementTx });
    settlement = { status: r.status, blockNumber: r.blockNumber, from: r.from, to: r.to, gasUsed: r.gasUsed };
  } catch {
    settlement = null;
  }
  return {
    state: CHAIN_STATES[p.state] ?? String(p.state),
    round: p.round,
    amount: p.amount,
    evidenceHash: p.evidenceHash,
    termsHash: p.termsHash,
    lastDecisionDigest: p.lastDecisionDigest,
    provider: p.provider,
    verifier: p.verifier,
    settlement,
  };
}
