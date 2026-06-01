import { FormEvent, useState } from "react";
import { Send, Trash2, X, Square } from "lucide-react";
import { type AppSnapshot } from "../../shared/types";

interface ChatPanelProps {
  snapshot: AppSnapshot;
  onClose: () => void;
}

export function ChatPanel({ snapshot, onClose }: ChatPanelProps) {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

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

  return (
    <section className="panel chat-panel" data-interactive="true">
      <header className="panel-header">
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
