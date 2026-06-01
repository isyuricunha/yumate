import { FormEvent, type PointerEvent, useRef, useState } from "react";
import { Send, Trash2, X, Square } from "lucide-react";
import { type AppSnapshot } from "../../shared/types";

interface ChatPanelProps {
  snapshot: AppSnapshot;
  onClose: () => void;
}

export function ChatPanel({ snapshot, onClose }: ChatPanelProps) {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const dragRef = useRef<{ x: number; y: number } | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const content = message.trim();
    if (!content || sending) {
      return;
    }
    setMessage("");
    setSending(true);
    try {
      await window.yumate.sendMessage(content);
    } finally {
      setSending(false);
    }
  }

  function startPanelDrag(event: PointerEvent<HTMLElement>) {
    if ((event.target as HTMLElement | null)?.closest("button, input, textarea, select")) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.screenX, y: event.screenY };
  }

  function movePanel(event: PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }

    const delta = { x: event.screenX - drag.x, y: event.screenY - drag.y };
    dragRef.current = { x: event.screenX, y: event.screenY };
    if (delta.x !== 0 || delta.y !== 0) {
      void window.yumate.moveWindowBy(delta);
    }
  }

  function endPanelDrag(event: PointerEvent<HTMLElement>) {
    if (!dragRef.current) {
      return;
    }

    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be gone after cancellation.
    }
    void window.yumate.saveWindowPosition();
  }

  return (
    <section className="panel chat-panel" data-interactive="true">
      <header
        className="panel-header"
        onPointerCancel={endPanelDrag}
        onPointerDown={startPanelDrag}
        onPointerMove={movePanel}
        onPointerUp={endPanelDrag}
      >
        <div>
          <strong>{snapshot.activeInstance.name}</strong>
          <span>{snapshot.providers[0]?.model || "Modelo nao configurado"}</span>
        </div>
        <button title="Close" type="button" onClick={onClose}>
          <X size={18} />
        </button>
      </header>

      <div className="messages">
        {snapshot.messages.length === 0 ? (
          <p className="empty-state">Sem historico.</p>
        ) : (
          snapshot.messages.map((chatMessage) => (
            <article key={chatMessage.id} className={`message ${chatMessage.role} ${chatMessage.status}`}>
              <span>{chatMessage.role === "assistant" ? snapshot.activeInstance.name : "Voce"}</span>
              <p>{chatMessage.content}</p>
            </article>
          ))
        )}
      </div>

      <form className="composer" onSubmit={handleSubmit}>
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Mensagem"
          rows={2}
        />
        <div className="composer-actions">
          <button title="Clear history" type="button" onClick={() => window.yumate.clearHistory()}>
            <Trash2 size={17} />
          </button>
          <button title="Cancel" type="button" disabled={!sending} onClick={() => window.yumate.cancelChat()}>
            <Square size={15} />
          </button>
          <button title="Send" type="submit" disabled={!message.trim() || sending}>
            <Send size={17} />
          </button>
        </div>
      </form>
    </section>
  );
}
