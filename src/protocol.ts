// Agent-to-agent protocol (spec section 4). Every message is typed, logged to agent_messages and streamed to /demo.
import { db, schema } from "./db/index.ts";

export type ConstraintRequest = {
  planId: string;
  window: { earliest: string; latest: string };
};

export type Constraints = {
  planId: string;
  userId: string;
  freeAt: string;
  maxPrice: number;
  dietTags: string[];
  /** Rounded to 0.02° (about 2 km). Exact location never leaves the personal agent. */
  area: { lat: number; lng: number };
};

export type ProposalCandidate = {
  placeId: string;
  name: string;
  lat: number;
  lng: number;
  priceEach: number;
  cuisine: string;
  tags: string[];
};

export type Proposal = { planId: string; meetCandidates: ProposalCandidate[] };

export type Evaluation = {
  planId: string;
  userId: string;
  perCandidate: { placeId: string; travelMin: number; mode: "walk" | "drive"; fit: number; veto: boolean }[];
};

export type ConstraintsUpdate = Constraints;

export type AgentMessageType = "ConstraintRequest" | "Constraints" | "Proposal" | "Evaluation" | "ConstraintsUpdate";

export type AgentMessageEvent = { id: number; planId: string; from: string; to: string; type: AgentMessageType; payload: unknown; at: string };

const subscribers = new Set<(e: AgentMessageEvent) => void>();

export function subscribeAgentMessages(fn: (e: AgentMessageEvent) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export const agentAddress = (userId: string) => `agent:${userId}`;
export const coordinatorAddress = (planId: string) => `coordinator:${planId}`;

export async function logAgentMessage(planId: string, from: string, to: string, type: AgentMessageType, payload: unknown): Promise<void> {
  const [row] = await db.insert(schema.agentMessages).values({ planId, from, to, type, payload }).returning();
  const event: AgentMessageEvent = { id: row!.id, planId, from, to, type, payload, at: row!.at.toISOString() };
  for (const fn of subscribers) {
    try {
      fn(event);
    } catch {
      // A broken subscriber never blocks the protocol.
    }
  }
}

export const roundArea = (v: number) => Number((Math.round(v / 0.02) * 0.02).toFixed(2));
