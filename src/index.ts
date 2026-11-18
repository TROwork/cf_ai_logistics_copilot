// Worker entry: JSON API for the chat UI. Static files in ./public are served
// by Workers static assets; anything else reaches this handler.
export { Logbook } from "./logbook";
export { FollowupWorkflow } from "./followup";

const SESSION_RE = /^[A-Za-z0-9-]{8,64}$/;
const MAX_MESSAGE = 2000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    let sessionId: string | null = url.searchParams.get("session");
    let body: Record<string, unknown> = {};
    if (request.method === "POST") {
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      sessionId = typeof body.session === "string" ? body.session : sessionId;
    }
    if (!sessionId || !SESSION_RE.test(sessionId)) return json({ error: "missing or invalid session" }, 400);

    const logbook = env.LOGBOOK.get(env.LOGBOOK.idFromName(sessionId));

    try {
      if (url.pathname === "/api/chat" && request.method === "POST") {
        const message = typeof body.message === "string" ? body.message.trim() : "";
        if (!message) return json({ error: "empty message" }, 400);
        if (message.length > MAX_MESSAGE) return json({ error: "message too long" }, 413);
        return json(await logbook.chat(sessionId, message));
      }
      if (url.pathname === "/api/state" && request.method === "GET") {
        return json(await logbook.state());
      }
      if (url.pathname === "/api/reset" && request.method === "POST") {
        await logbook.reset();
        return json({ ok: true });
      }
    } catch (err) {
      console.error(err);
      return json({ error: "internal error" }, 500);
    }
    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
