import { type AppDatabase } from "./database";
import { type WindowsContextService } from "./windowsContextService";
import {
  type AiProvider,
  type ChatMessage,
  type PetInstance,
  type SendMessageResult,
} from "../shared/types";

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
    delta?: {
      content?: string;
    };
  }>;
  output_text?: string;
  error?: {
    message?: string;
  };
}

export class AiService {
  private activeController: AbortController | null = null;

  constructor(
    private readonly database: AppDatabase,
    private readonly windowsContextService: WindowsContextService,
  ) {}

  cancel(): void {
    this.activeController?.abort();
    this.activeController = null;
  }

  async sendMessage(instance: PetInstance, content: string): Promise<SendMessageResult> {
    const conversation = this.database.ensureConversation(instance.id);
    const provider = this.database.getProvider(instance.providerId);
    const model = instance.model || provider.model;

    this.database.addMessage({
      conversationId: conversation.id,
      role: "user",
      content,
      model,
      providerId: provider.id,
      status: "sent",
      error: null,
      spoken: false,
      metadata: {},
    });

    try {
      const responseText = await this.requestChatCompletion(instance, provider, content);
      const assistantMessage = this.database.addMessage({
        conversationId: conversation.id,
        role: "assistant",
        content: responseText,
        model,
        providerId: provider.id,
        status: "sent",
        error: null,
        spoken: false,
        metadata: {},
      });
      return { ok: true, assistantMessage };
    } catch (error) {
      const friendly = formatProviderError(error);
      this.database.addMessage({
        conversationId: conversation.id,
        role: "assistant",
        content: friendly,
        model,
        providerId: provider.id,
        status: "error",
        error: friendly,
        spoken: false,
        metadata: {},
      });
      return { ok: false, error: friendly };
    }
  }

  private async requestChatCompletion(instance: PetInstance, provider: AiProvider, userContent: string): Promise<string> {
    const baseUrl = provider.baseUrl.replace(/\/+$/, "");
    if (!baseUrl) {
      throw new Error("Configure an OpenAI-compatible base URL before chatting.");
    }

    if (!provider.apiKey && !isLocalEndpoint(baseUrl)) {
      throw new Error("Configure an API key or use a local endpoint before chatting.");
    }

    const snapshot = this.database.getSnapshot();
    const windowsContext = await this.windowsContextService.capture(snapshot.settings);
    const contextMessage = formatWindowsContext(windowsContext);
    const recentMessages = snapshot.messages.slice(-16).map((message) => ({
      role: message.role === "assistant" || message.role === "user" ? message.role : "user",
      content: message.content,
    }));

    const payload: Record<string, unknown> = {
      model: instance.model || provider.model,
      messages: [
        {
          role: "system",
          content: [instance.systemPrompt || instance.persona, contextMessage].filter(Boolean).join("\n\n"),
        },
        ...recentMessages,
        {
          role: "user",
          content: userContent,
        },
      ],
      temperature: provider.temperature,
      stream: false,
    };

    if (provider.supportsEffort) {
      payload.reasoning_effort = instance.effort || provider.defaultEffort;
    }

    if (provider.supportsReasoning && !provider.supportsEffort) {
      payload.reasoning = {};
    }

    this.activeController = new AbortController();
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: this.activeController.signal,
    });
    this.activeController = null;

    const text = await response.text();
    let data: ChatCompletionResponse | null = null;
    try {
      data = text ? (JSON.parse(text) as ChatCompletionResponse) : null;
    } catch {
      data = null;
    }

    if (!response.ok) {
      const detail = data?.error?.message || text.slice(0, 500) || response.statusText;
      throw new Error(`API ${response.status}: ${detail}`);
    }

    const message = data?.choices?.[0]?.message?.content || data?.output_text;
    if (!message) {
      throw new Error("The provider returned no assistant message.");
    }

    return message.trim();
  }
}

function isLocalEndpoint(baseUrl: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?/i.test(baseUrl);
}

function formatProviderError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return "A resposta foi interrompida.";
    }
    return error.message;
  }
  return "Falha ao chamar o provedor de IA.";
}

function formatWindowsContext(context: Awaited<ReturnType<WindowsContextService["capture"]>>): string | null {
  if (!context.enabled || context.error) {
    return null;
  }

  const parts = [
    context.activeProcessName ? `processo ativo: ${context.activeProcessName}` : null,
    context.activeWindowTitle ? `titulo da janela ativa: ${context.activeWindowTitle}` : null,
    context.capturedAt ? `capturado em: ${context.capturedAt}` : null,
  ].filter(Boolean);

  if (parts.length === 0) {
    return null;
  }

  return `Contexto local autorizado pelo usuario. Use apenas se for relevante: ${parts.join("; ")}.`;
}
