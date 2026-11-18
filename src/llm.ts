// LLM layer: Llama 3.3 on Workers AI, used in JSON mode so the model returns
// a reply plus a list of structured actions that the Durable Object applies.

export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export const ITEM_KINDS = ["shipment", "rma", "spare_part", "other"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export interface Item {
  id: number;
  kind: ItemKind;
  reference: string | null;
  site: string | null;
  counterparty: string | null;
  status: string;
  eta: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export type Action =
  | {
      type: "create_item";
      kind: ItemKind;
      reference?: string;
      site?: string;
      counterparty?: string;
      status?: string;
      eta?: string;
      notes?: string;
    }
  | {
      type: "update_item";
      id: number;
      status?: string;
      eta?: string;
      notes?: string;
      site?: string;
      counterparty?: string;
      reference?: string;
    }
  | { type: "close_item"; id: number; notes?: string }
  | { type: "schedule_followup"; id: number; minutes: number; note: string };

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["create_item", "update_item", "close_item", "schedule_followup"],
          },
          id: { type: "integer" },
          kind: { type: "string", enum: [...ITEM_KINDS] },
          reference: { type: "string" },
          site: { type: "string" },
          counterparty: { type: "string" },
          status: { type: "string" },
          eta: { type: "string" },
          notes: { type: "string" },
          minutes: { type: "integer" },
          note: { type: "string" },
        },
        required: ["type"],
      },
    },
  },
  required: ["reply", "actions"],
};

function systemPrompt(openItems: Item[], now: Date): string {
  return `You are a logistics operations copilot for a data center hardware team.
The user coordinates hardware deliveries, reverse logistics (RMAs) and spare parts with
vendors, freight forwarders, customs brokers and data center sites.

Your job: keep an accurate log of open items and follow-ups from what the user tells you.

Current time (UTC): ${now.toISOString()}
Open items (JSON, use these ids when updating):
${JSON.stringify(openItems)}

Respond ONLY with JSON: {"reply": string, "actions": Action[]}.
Action types:
- create_item: kind (shipment | rma | spare_part | other), plus any of reference, site,
  counterparty, status, eta, notes. Use it when the user reports a NEW shipment, RMA or part.
- update_item: id plus the fields that changed (status, eta, notes, site, counterparty, reference).
- close_item: id, optional notes. Use when something is delivered, received, resolved or cancelled.
- schedule_followup: id, minutes (from now), note. ONLY when the user asks for a reminder or
  follow-up. Convert "tomorrow" to 1440, "in 2 hours" to 120, and so on.

Rules:
- Never invent tracking numbers, dates, vendors or sites. Record only what the user said.
- If the user refers to an item ambiguously, ask which one instead of guessing, and return no action.
- If the user just asks a question (status, what is late, summary), answer from the open items
  and return an empty actions list.
- Keep the reply short and operational: what you logged, what is at risk, what to do next.`;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 500) : undefined;
}

function asInt(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? Math.round(n) : undefined;
}

/** Validate model output; drop anything malformed rather than trusting it. */
export function sanitizeActions(raw: unknown): Action[] {
  if (!Array.isArray(raw)) return [];
  const out: Action[] = [];
  for (const a of raw.slice(0, 10)) {
    if (!a || typeof a !== "object") continue;
    const r = a as Record<string, unknown>;
    const id = asInt(r.id);
    const common = {
      reference: asString(r.reference),
      site: asString(r.site),
      counterparty: asString(r.counterparty),
      status: asString(r.status),
      eta: asString(r.eta),
      notes: asString(r.notes),
    };
    switch (r.type) {
      case "create_item": {
        const kind = (ITEM_KINDS as readonly string[]).includes(String(r.kind))
          ? (r.kind as ItemKind)
          : "other";
        out.push({ type: "create_item", kind, ...common });
        break;
      }
      case "update_item":
        if (id !== undefined) out.push({ type: "update_item", id, ...common });
        break;
      case "close_item":
        if (id !== undefined) out.push({ type: "close_item", id, notes: common.notes });
        break;
      case "schedule_followup": {
        const minutes = asInt(r.minutes);
        const note = asString(r.note) ?? "Follow up";
        if (id !== undefined && minutes !== undefined) {
          // 1 minute (demo) to 30 days
          out.push({ type: "schedule_followup", id, minutes: Math.min(Math.max(minutes, 1), 43200), note });
        }
        break;
      }
    }
  }
  return out;
}

function parseModelJson(response: unknown): { reply: string; actions: Action[] } {
  let obj: unknown = response;
  if (typeof response === "string") {
    const match = response.match(/\{[\s\S]*\}/);
    try {
      obj = match ? JSON.parse(match[0]) : null;
    } catch {
      obj = null;
    }
    if (!obj) return { reply: response.trim() || "Sorry, I could not process that.", actions: [] };
  }
  const o = (obj ?? {}) as Record<string, unknown>;
  return {
    reply: asString(o.reply) ?? "Done.",
    actions: sanitizeActions(o.actions),
  };
}

export async function runTurn(
  ai: Ai,
  history: ChatMessage[],
  openItems: Item[],
  now = new Date(),
): Promise<{ reply: string; actions: Action[] }> {
  const result = (await ai.run(MODEL as any, {
    messages: [{ role: "system", content: systemPrompt(openItems, now) }, ...history],
    response_format: { type: "json_schema", json_schema: RESPONSE_SCHEMA },
    max_tokens: 1024,
    temperature: 0.2,
  } as any)) as { response?: unknown };
  return parseModelJson(result?.response);
}

/** Short follow-up message the user can send to the counterparty. */
export async function draftNudge(ai: Ai, item: Item, note: string): Promise<string> {
  const result = (await ai.run(MODEL as any, {
    messages: [
      {
        role: "system",
        content:
          "Write a brief, polite follow-up message (under 90 words) from a data center logistics " +
          "coordinator to the counterparty about the item below. Ask for a concrete status and date. " +
          "Use only the facts given; do not invent tracking numbers or dates. Plain text, no subject line.",
      },
      { role: "user", content: JSON.stringify({ item, reminder: note }) },
    ],
    max_tokens: 256,
    temperature: 0.3,
  } as any)) as { response?: unknown };
  return typeof result?.response === "string" ? result.response.trim() : "";
}
