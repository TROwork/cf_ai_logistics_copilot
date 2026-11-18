# Prompt history

The project was built with Claude Code (Anthropic, model Claude Opus 5.5) as the coding assistant.
Below are my prompts in order, verbatim, with the assistant's clarifying question where it asked one.
Prompts about unrelated work in the same session are left out.

---

**1. The assignment, pasted in**

> Optional Assignment: Please share GitHub repo URL for the project here
> We plan to fast track candidates who complete an assignment to build a type of AI-powered application on Cloudflare. An AI-powered application should include the following components:
> LLM (recommend using Llama 3.3 on Workers AI), or an external LLM of your choice
> Workflow / coordination (recommend using Workflows, Workers or Durable Objects)
> User input via chat or voice (recommend using Pages or Realtime)
> Memory or state
> Find additional documentation here.
> Note: AI-assisted coding is encouraged, but you have to submit prompt history.

**2.**

> So cloudflare we can next - it was just more elaborate that is why I didn't do it during the apply workflow

**Assistant's question:** What should we build? It proposed a logistics copilot tied to the role:
chat with Llama 3.3 on Workers AI to log hardware shipments and RMAs, a Durable Object holding the open
items, and a Workflow sending follow-up reminders. The other options were updating an existing project
or a different concept.

**My answer:** New logistics copilot, as a new standalone repo.

---

From these prompts the assistant chose the stack (Workers AI with JSON-schema output, a SQLite-backed
Durable Object per session, one Workflow instance per follow-up, a static-assets chat UI) and wrote the
code, README and this file. Typecheck and `wrangler deploy --dry-run` were run before the first commit.
Later prompts are appended below.
