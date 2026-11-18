# cf_ai_logistics_copilot

An AI logistics copilot built on Cloudflare. A coordinator types what is happening in plain language:
hardware shipments to data center sites, RMAs going back to vendors, spare parts on order. The copilot
keeps a structured log of open items. When asked for a follow-up, it schedules a durable reminder. If the
item is still open when the reminder comes due, it drafts a nudge for the vendor or forwarder.

> "12 servers from the rack integrator ship to the Frankfurt site, ETA Friday, ref PO-4471. Remind me in 2 minutes."
>
> → creates item #1 (shipment), schedules a follow-up. Two minutes later a reminder appears with a
> drafted status request to the rack integrator, unless you closed the item first ("PO-4471 delivered").

**Live demo:** https://cf-ai-logistics-copilot.cf-ai-logistics-copilot.workers.dev

## How it meets the assignment

| Component | Implementation |
|---|---|
| **LLM** | Llama 3.3 70B on Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) in JSON-schema mode. It returns a reply plus typed actions (`create_item`, `update_item`, `close_item`, `schedule_followup`). The actions are validated in code before anything is written ([src/llm.ts](src/llm.ts)). The same model drafts follow-up messages. |
| **Workflow / coordination** | A Worker routes the API ([src/index.ts](src/index.ts)). Each follow-up is a **Cloudflare Workflow** instance ([src/followup.ts](src/followup.ts)). It sleeps durably until the follow-up is due, re-checks the item, drafts a nudge with retries, and posts it as a reminder. |
| **User input (chat)** | A static chat UI served by Workers static assets ([public/](public/)). Enter sends; the item list and reminders refresh live. |
| **Memory / state** | One SQLite-backed **Durable Object** per chat session ([src/logbook.ts](src/logbook.ts)). It stores the conversation (the last 16 turns are fed back to the model), the items, the scheduled follow-ups and the fired reminders. The session id is kept in the browser, so state survives reloads. |

```
browser (public/) ──► Worker /api/* ──► Logbook Durable Object (SQLite: messages, items, followups, reminders)
                                            │  ├─ Workers AI: Llama 3.3 → {reply, actions}
                                            │  └─ FOLLOWUP.create() ──► FollowupWorkflow
                                            │                             sleep → check item → draft nudge → addReminder()
                                            ◄─────────────────────────────────────────────────────────┘
```

### Design choices

- **The model proposes, code decides.** The LLM never writes to storage directly. Its JSON actions go
  through `sanitizeActions`: unknown types are dropped, ids must exist, and follow-up delays are clamped
  between 1 minute and 30 days. The prompt forbids inventing tracking numbers, dates or vendors, and
  tells the model to ask when a reference is ambiguous.
- **Durable timers over cron.** A follow-up is its own Workflow instance, so it survives deploys and
  restarts and retries its LLM step. It is also visible in the dashboard with per-step status.
- **Re-check before nudging.** The Workflow reads the item state at fire time. Closing an item cancels
  the effect of its pending follow-ups without having to track them down.

## Run it

Requirements: Node 18+ and a Cloudflare account (Workers AI, Durable Objects and Workflows all work on the free plan).

```bash
npm install
npx wrangler login          # Workers AI runs remotely, even in local dev
npm run dev                 # http://localhost:8787
npm run deploy              # publish to <name>.<subdomain>.workers.dev
```

`npm run check` typechecks and does a dry-run build. After changing `wrangler.jsonc`, run `npm run types`.

### Try it

1. `RMA-2231: two failed PSUs going back to the vendor from the Ashburn site via the freight forwarder, pickup tomorrow.`
2. `Also 40 SSD spares on order for Singapore, ETA Nov 28. Remind me about the RMA in 1 minute.`
3. `What's open?`
4. Wait a minute: a reminder with a drafted vendor message appears under **Reminders**.
5. `The SSDs arrived` closes the item. Follow-ups on closed items are skipped.

## API

| Method | Path | Body / query | Returns |
|---|---|---|---|
| POST | `/api/chat` | `{session, message}` | `{reply, applied[], state}` |
| GET | `/api/state` | `?session=` | `{items, followups, reminders, messages}` |
| POST | `/api/reset` | `{session}` | `{ok}` |

## AI assistance

The code was written with an AI coding assistant (Claude Code). The prompt history is in [PROMPTS.md](PROMPTS.md).
