// Coordination: a Workflow per follow-up. It sleeps durably until the follow-up
// is due, re-checks the item in the session's Durable Object, and if the item is
// still open, drafts a nudge for the counterparty and posts it as a reminder.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { draftNudge } from "./llm";

export interface FollowupParams {
  sessionId: string;
  itemId: number;
  note: string;
  minutes: number;
}

export class FollowupWorkflow extends WorkflowEntrypoint<Env, FollowupParams> {
  async run(event: WorkflowEvent<FollowupParams>, step: WorkflowStep) {
    const { sessionId, itemId, note, minutes } = event.payload;
    const logbook = () => this.env.LOGBOOK.get(this.env.LOGBOOK.idFromName(sessionId));

    await step.sleep("wait until follow-up is due", minutes * 60_000);

    const item = await step.do("check item status", async () => {
      const found = await logbook().getItem(itemId);
      return found ? { ...found } : null;
    });
    if (!item || item.status === "closed") {
      return { itemId, skipped: true, reason: item ? "item closed" : "item not found" };
    }

    const draft = await step.do(
      "draft follow-up message",
      { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } },
      async () => draftNudge(this.env.AI, item, note),
    );

    await step.do("post reminder", async () => {
      await logbook().addReminder(itemId, note, draft);
    });

    return { itemId, skipped: false };
  }
}
