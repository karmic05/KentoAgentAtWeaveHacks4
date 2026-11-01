"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import { type ChatAction, HELP, parseCommand } from "../lib/commands";
import { type GridState, isActive } from "../lib/kento";

type Message = { id: number; role: "user" | "bot"; text: string; source?: string; pending?: boolean };

const SUGGESTIONS = ["Assign B to S-01", "Start", "Trigger an aftershock", "What is agent A doing?", "Status"];

/** Compact live state for the AI's system prompt. */
function context(state: GridState | null) {
  if (!state) return null;
  return {
    tick: state.metrics.tick,
    autopilot: state.sim.running ? "running" : "paused",
    agents: state.agents.map((a) => ({
      id: a.id, x: a.x, y: a.y, status: a.status, target: a.target_survivor_id || null, thought: a.thought,
    })),
    survivors: state.survivors
      .filter((s) => isActive(s.status))
      .map((s) => ({ id: s.id, x: s.x, y: s.y, status: s.status, health: Math.round(Number(s.data.health)) })),
    rescued: state.metrics.rescued,
    lost: state.metrics.lost,
  };
}

export function ChatPanel({
  state,
  execute,
}: {
  state: GridState | null;
  execute: (actions: ChatAction[]) => Promise<string[]>;
}) {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 0,
      role: "bot",
      text: "Rescue Command online. Give orders in plain English: assign agents, start or pause the mission, trigger aftershocks, or ask what an agent is doing.",
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const nextId = useRef(1);
  const list = useRef<HTMLOListElement>(null);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const push = (message: Omit<Message, "id">) => {
    const id = nextId.current++;
    setMessages((m) => [...m, { ...message, id }]);
    return id;
  };
  const replace = (id: number, message: Omit<Message, "id">) =>
    setMessages((m) => m.map((item) => (item.id === id ? { ...message, id } : item)));

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setInput("");
    push({ role: "user", text: message });

    const parsed = parseCommand(message, state);
    if (parsed) {
      const results = await execute(parsed.actions);
      push({ role: "bot", text: [parsed.reply, ...results].filter(Boolean).join(" ") || "Done.", source: "instant" });
      return;
    }

    setBusy(true);
    const pending = push({ role: "bot", text: "Thinking… (free hosted AI, usually 5–20 s)", pending: true });
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, context: context(state) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const results = await execute(data.actions ?? []);
      replace(pending, {
        role: "bot",
        // The panel renders plain text, so drop markdown emphasis the model adds.
        text: [String(data.reply ?? "").replace(/\*\*?([^*]+)\*\*?/g, "$1"), ...results].filter(Boolean).join(" ")
          || "I couldn't find anything to do with that.",
        source: data.model,
      });
    } catch (error) {
      replace(pending, {
        role: "bot",
        text: `The AI model didn't answer (${error instanceof Error ? error.message : "unavailable"}). These always work instantly: ${HELP.slice(0, 5).join(" · ")}.`,
        source: "offline",
      });
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    send(input);
  }

  return (
    <div className="flex flex-col">
      <ol ref={list} className="scroll-thin max-h-64 min-h-32 space-y-2 overflow-y-auto pr-1" aria-live="polite">
        {messages.map((m) => (
          <li key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[88%] rounded-lg px-3 py-2 text-xs leading-relaxed ${
                m.role === "user" ? "bg-accent text-[#04121c]" : "border border-line bg-panel-2 text-text/90"
              } ${m.pending ? "animate-pulse" : ""}`}
            >
              {m.text}
              {m.source && <span className="mt-1 block font-mono text-[9px] text-faint">{m.source}</span>}
            </div>
          </li>
        ))}
      </ol>
      {messages.length < 3 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => send(s)}
              className="rounded-full border border-line-strong px-2.5 py-1 text-[11px] text-muted hover:border-accent hover:text-accent"
            >
              {s}
            </button>
          ))}
        </div>
      )}
      <form onSubmit={onSubmit} className="mt-3 flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. send agent C to S-02 and start"
          aria-label="Message Rescue Command"
          className="min-w-0 flex-1 rounded-lg border border-line-strong bg-panel-2 px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-accent"
        />
        <button type="submit" className="btn btn-primary" disabled={busy || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
