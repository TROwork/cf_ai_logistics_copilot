// Minimal chat client. The session id is kept in localStorage so the Durable
// Object (memory) survives page reloads.
const $ = (id) => document.getElementById(id);

function newSession() {
  const id = crypto.randomUUID();
  try { localStorage.setItem("session", id); } catch {}
  return id;
}
let session;
try { session = localStorage.getItem("session") || newSession(); } catch { session = crypto.randomUUID(); }

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function addMessage(role, content, applied) {
  const m = el("div", `msg ${role}`, content);
  if (applied && applied.length) m.appendChild(el("span", "applied", applied.join(" · ")));
  $("messages").appendChild(m);
  $("messages").scrollTop = $("messages").scrollHeight;
}

function renderState(state) {
  const items = $("items");
  items.replaceChildren();
  if (!state.items.length) items.appendChild(el("p", "muted", "Nothing logged yet."));
  for (const it of state.items) {
    const card = el("div", `item ${it.status === "closed" ? "closed" : ""}`);
    card.appendChild(el("b", "", `#${it.id} ${it.kind.replace("_", " ")} · ${it.status}`));
    const parts = [
      it.reference && `ref ${it.reference}`,
      it.counterparty && `with ${it.counterparty}`,
      it.site && `site ${it.site}`,
      it.eta && `ETA ${it.eta}`,
    ].filter(Boolean);
    if (parts.length) card.appendChild(el("div", "", parts.join(" · ")));
    if (it.notes) card.appendChild(el("div", "muted", it.notes));
    items.appendChild(card);
  }

  const rem = $("reminders");
  if (state.reminders.length) {
    rem.replaceChildren();
    for (const r of state.reminders) {
      const card = el("div", "reminder");
      card.appendChild(el("b", "", `Follow-up due on #${r.item_id}: ${r.note}`));
      if (r.draft) card.appendChild(el("div", "", r.draft));
      card.appendChild(el("div", "muted", new Date(r.created_at).toLocaleString()));
      rem.appendChild(card);
    }
  }
}

async function loadState(withMessages) {
  const res = await fetch(`/api/state?session=${encodeURIComponent(session)}`);
  if (!res.ok) return;
  const state = await res.json();
  if (withMessages) {
    $("messages").replaceChildren();
    for (const m of state.messages) addMessage(m.role, m.content);
  }
  renderState(state);
}

$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = $("input").value.trim();
  if (!message) return;
  $("input").value = "";
  addMessage("user", message);
  $("send").disabled = true;
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session, message }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    addMessage("assistant", data.reply, data.applied);
    renderState(data.state);
  } catch (err) {
    addMessage("assistant", `Error: ${err.message}`);
  } finally {
    $("send").disabled = false;
    $("input").focus();
  }
});

$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("composer").requestSubmit(); }
});

$("reset").addEventListener("click", () => {
  session = newSession();
  $("messages").replaceChildren();
  loadState(false);
});

loadState(true);
// Poll so reminders posted by the Workflow appear without a reload.
setInterval(() => loadState(false), 15000);
