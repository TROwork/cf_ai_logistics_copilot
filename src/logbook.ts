// Memory / state: one SQLite-backed Durable Object per chat session holds the
// conversation, the logistics items and the reminders fired by the Workflow.
import { DurableObject } from "cloudflare:workers";
import { runTurn, type Action, type ChatMessage, type Item } from "./llm";

export interface Reminder {
  id: number;
  item_id: number;
  note: string;
  draft: string;
  created_at: string;
}

const HISTORY_TURNS = 16;

export class Logbook extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        reference TEXT,
        site TEXT,
        counterparty TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        eta TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS followups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL,
        workflow_id TEXT NOT NULL,
        note TEXT NOT NULL,
        due_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL,
        note TEXT NOT NULL,
        draft TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  private now(): string {
    return new Date().toISOString();
  }

  private openItems(): Item[] {
    return this.sql
      .exec("SELECT * FROM items WHERE status != 'closed' ORDER BY id")
      .toArray() as unknown as Item[];
  }

  getItem(id: number): Item | null {
    const rows = this.sql.exec("SELECT * FROM items WHERE id = ?", id).toArray();
    return rows.length ? (rows[0] as unknown as Item) : null;
  }

  async chat(sessionId: string, text: string) {
    const now = this.now();
    this.sql.exec("INSERT INTO messages (role, content, created_at) VALUES ('user', ?, ?)", text, now);

    const history = (
      this.sql
        .exec("SELECT role, content FROM messages ORDER BY id DESC LIMIT ?", HISTORY_TURNS)
        .toArray() as unknown as ChatMessage[]
    ).reverse();

    const { reply, actions } = await runTurn(this.env.AI, history, this.openItems());
    const applied: string[] = [];
    for (const action of actions) {
      const result = await this.apply(sessionId, action);
      if (result) applied.push(result);
    }

    this.sql.exec(
      "INSERT INTO messages (role, content, created_at) VALUES ('assistant', ?, ?)",
      reply,
      this.now(),
    );
    return { reply, applied, state: this.state() };
  }

  private async apply(sessionId: string, a: Action): Promise<string | null> {
    const now = this.now();
    switch (a.type) {
      case "create_item": {
        const row = this.sql
          .exec(
            `INSERT INTO items (kind, reference, site, counterparty, status, eta, notes, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
            a.kind,
            a.reference ?? null,
            a.site ?? null,
            a.counterparty ?? null,
            a.status ?? "open",
            a.eta ?? null,
            a.notes ?? null,
            now,
            now,
          )
          .one();
        return `created #${row.id} (${a.kind})`;
      }
      case "update_item": {
        if (!this.getItem(a.id)) return `skipped update: no item #${a.id}`;
        const fields = (["status", "eta", "notes", "site", "counterparty", "reference"] as const).filter(
          (f) => a[f] !== undefined,
        );
        if (!fields.length) return null;
        const sets = fields.map((f) => `${f} = ?`).join(", ");
        this.sql.exec(
          `UPDATE items SET ${sets}, updated_at = ? WHERE id = ?`,
          ...fields.map((f) => a[f] as string),
          now,
          a.id,
        );
        return `updated #${a.id} (${fields.join(", ")})`;
      }
      case "close_item": {
        if (!this.getItem(a.id)) return `skipped close: no item #${a.id}`;
        this.sql.exec(
          "UPDATE items SET status = 'closed', notes = COALESCE(?, notes), updated_at = ? WHERE id = ?",
          a.notes ?? null,
          now,
          a.id,
        );
        return `closed #${a.id}`;
      }
      case "schedule_followup": {
        if (!this.getItem(a.id)) return `skipped follow-up: no item #${a.id}`;
        const instance = await this.env.FOLLOWUP.create({
          params: { sessionId, itemId: a.id, note: a.note, minutes: a.minutes },
        });
        const due = new Date(Date.now() + a.minutes * 60_000).toISOString();
        this.sql.exec(
          "INSERT INTO followups (item_id, workflow_id, note, due_at, created_at) VALUES (?, ?, ?, ?, ?)",
          a.id,
          instance.id,
          a.note,
          due,
          now,
        );
        return `follow-up on #${a.id} due ${due}`;
      }
    }
  }

  /** Called by FollowupWorkflow when a follow-up comes due. */
  addReminder(itemId: number, note: string, draft: string): void {
    this.sql.exec(
      "INSERT INTO reminders (item_id, note, draft, created_at) VALUES (?, ?, ?, ?)",
      itemId,
      note,
      draft,
      this.now(),
    );
  }

  state() {
    return {
      items: this.sql
        .exec("SELECT * FROM items ORDER BY (status = 'closed'), id DESC")
        .toArray() as unknown as Item[],
      followups: this.sql
        .exec("SELECT * FROM followups ORDER BY due_at DESC LIMIT 20")
        .toArray(),
      reminders: this.sql
        .exec("SELECT * FROM reminders ORDER BY id DESC LIMIT 20")
        .toArray() as unknown as Reminder[],
      messages: this.sql
        .exec("SELECT role, content, created_at FROM messages ORDER BY id DESC LIMIT 50")
        .toArray()
        .reverse(),
    };
  }

  reset(): void {
    this.sql.exec("DELETE FROM messages; DELETE FROM items; DELETE FROM followups; DELETE FROM reminders;");
  }
}
