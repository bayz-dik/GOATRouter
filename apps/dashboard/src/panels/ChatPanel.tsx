import { useCallback, useState } from "react";
import type { ChatRequestBody, ChatResult } from "../api/types";
import { PanelError, useAsync } from "./shared";

export type ChatApi = {
  listModels(): Promise<string[]>;
  chat(body: ChatRequestBody): Promise<ChatResult>;
};

type Turn = {
  prompt: string;
  reply: ChatResult;
};

/**
 * A one-shot test chat.
 *
 * The transcript lives in component state and nowhere else — not in
 * `localStorage`, not on the server. Persisting prompts is exactly what the router
 * refuses to do, and the dashboard must not undo that from the other side.
 *
 * There is no streaming control: the API rejects `stream`, so offering one would
 * advertise a capability that does not exist.
 */
export function ChatPanel({ api }: { api: ChatApi }) {
  const models = useAsync(() => api.listModels());
  const [model, setModel] = useState("");
  const [message, setMessage] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState<unknown>(undefined);
  const [sending, setSending] = useState(false);

  const available = models.value ?? [];
  const selected = model.length > 0 ? model : (available[0] ?? "");

  const send = useCallback(() => {
    const prompt = message.trim();
    if (prompt.length === 0) {
      setError(new Error("Enter a message before sending."));
      return;
    }
    if (selected.length === 0) {
      setError(new Error("Select a model before sending."));
      return;
    }
    void (async () => {
      setError(undefined);
      setSending(true);
      try {
        const reply = await api.chat({
          model: selected,
          messages: [{ role: "user", content: prompt }],
        });
        setTurns((current) => [...current, { prompt, reply }]);
        setMessage("");
      } catch (failure) {
        setError(failure);
      } finally {
        setSending(false);
      }
    })();
  }, [api, message, selected]);

  return (
    <section className="bayz-panel" aria-labelledby="chat-heading">
      <h2 id="chat-heading">Test chat</h2>

      {error !== undefined && <PanelError error={error} />}
      {models.error !== undefined && <PanelError error={models.error} />}

      <form
        className="bayz-form"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <label htmlFor="chat-model">Model</label>
        <select
          id="chat-model"
          value={selected}
          onChange={(event) => setModel(event.target.value)}
        >
          {available.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>

        <label htmlFor="chat-message">Message</label>
        <textarea
          id="chat-message"
          rows={3}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />

        <button type="submit" disabled={sending}>
          Send
        </button>
      </form>

      <ol className="bayz-transcript">
        {turns.map((turn, index) => (
          <li key={index}>
            {/* React escapes both sides, so upstream text is never markup. */}
            <p className="bayz-prompt">{turn.prompt}</p>
            <p className="bayz-reply">{turn.reply.content}</p>
            <p data-testid="chat-routing" className="bayz-routing">
              route {turn.reply.routeId ?? "unknown"} · provider{" "}
              {turn.reply.providerId ?? "unknown"}
              {turn.reply.proxyId !== undefined ? ` · proxy ${turn.reply.proxyId}` : ""}
            </p>
          </li>
        ))}
      </ol>

      <p className="bayz-note">
        This transcript is kept in memory for the current view only and is never
        saved.
      </p>
    </section>
  );
}
