import { randomUUID } from "node:crypto";
import { type AppDatabase } from "./database";
import { type WindowsContextService } from "./windowsContextService";
import {
  type AiProvider,
  type ChatMessage,
  type PetInstance,
  type SendMessageResult,
  type WindowsContext,
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
    const persistHistory = this.database.getGlobalSettings().chatHistoryEnabled;

    const userMessage = {
      conversationId: conversation.id,
      role: "user",
      content,
      model,
      providerId: provider.id,
      status: "sent",
      error: null,
      spoken: false,
      metadata: {},
    } satisfies Omit<ChatMessage, "id" | "createdAt">;

    if (persistHistory) {
      this.database.addMessage(userMessage);
    }

    try {
      const responseText = await this.requestChatCompletion(instance, provider, {
        userContent: content,
      });
      const assistantMessageInput = {
        conversationId: conversation.id,
        role: "assistant",
        content: responseText,
        model,
        providerId: provider.id,
        status: "sent",
        error: null,
        spoken: false,
        metadata: {},
      } satisfies Omit<ChatMessage, "id" | "createdAt">;
      const assistantMessage = persistHistory
        ? this.database.addMessage(assistantMessageInput)
        : createTransientMessage(assistantMessageInput);
      return { ok: true, assistantMessage };
    } catch (error) {
      const friendly = formatProviderError(error);
      const assistantMessage = {
        conversationId: conversation.id,
        role: "assistant",
        content: friendly,
        model,
        providerId: provider.id,
        status: "error",
        error: friendly,
        spoken: false,
        metadata: {},
      } satisfies Omit<ChatMessage, "id" | "createdAt">;
      if (persistHistory) {
        this.database.addMessage(assistantMessage);
      }
      return { ok: false, error: friendly };
    }
  }

  async sendAutomaticContext(instance: PetInstance, context: WindowsContext): Promise<SendMessageResult> {
    const conversation = this.database.ensureConversation(instance.id);
    const provider = this.database.getProvider(instance.providerId);
    const model = instance.model || provider.model;
    const content = formatAutomaticContextUserMessage(context);
    const persistHistory = this.database.getGlobalSettings().chatHistoryEnabled;

    const userMessage = {
      conversationId: conversation.id,
      role: "user",
      content,
      model,
      providerId: provider.id,
      status: "sent",
      error: null,
      spoken: false,
      metadata: {
        source: "automatic-context",
        context,
      },
    } satisfies Omit<ChatMessage, "id" | "createdAt">;

    if (persistHistory) {
      this.database.addMessage(userMessage);
    }

    try {
      const responseText = await this.requestChatCompletion(instance, provider, {
        userContent: content,
        context,
        effortOverride: "low",
        includeHistory: false,
        maxTokens: 120,
        timeoutMs: 30_000,
        systemAddendum:
          "Chamadas automaticas foram ativadas pelo usuario. Analise o contexto local autorizado e responda em portugues brasileiro com no maximo uma frase curta, util e nao invasiva. Quando o contexto mudou para um app, site ou titulo reconhecivel, ofereca ajuda curta relacionada ao que esta visivel. Responda exatamente [silent] apenas se o contexto estiver vazio, for o proprio Yumate, for uma tela transitoria de troca de tarefas, ou for claramente repetido/sem utilidade. Nao invente detalhes que nao estejam no contexto.",
      });

      if (isSilentResponse(responseText)) {
        return { ok: true, silent: true };
      }

      const assistantMessageInput = {
        conversationId: conversation.id,
        role: "assistant",
        content: responseText,
        model,
        providerId: provider.id,
        status: "sent",
        error: null,
        spoken: false,
        metadata: {
          source: "automatic-context",
          context,
        },
      } satisfies Omit<ChatMessage, "id" | "createdAt">;
      const assistantMessage = persistHistory
        ? this.database.addMessage(assistantMessageInput)
        : createTransientMessage(assistantMessageInput);
      return { ok: true, assistantMessage };
    } catch (error) {
      const friendly = formatProviderError(error);
      const assistantMessage = {
        conversationId: conversation.id,
        role: "assistant",
        content: friendly,
        model,
        providerId: provider.id,
        status: "error",
        error: friendly,
        spoken: false,
        metadata: {
          source: "automatic-context",
          context,
        },
      } satisfies Omit<ChatMessage, "id" | "createdAt">;
      if (persistHistory) {
        this.database.addMessage(assistantMessage);
      }
      return { ok: false, error: friendly };
    }
  }

  private async requestChatCompletion(
    instance: PetInstance,
    provider: AiProvider,
    options: {
      userContent: string;
      systemAddendum?: string;
      context?: WindowsContext;
      effortOverride?: PetInstance["effort"];
      includeHistory?: boolean;
      maxTokens?: number;
      timeoutMs?: number;
    },
  ): Promise<string> {
    const baseUrl = provider.baseUrl.replace(/\/+$/, "");
    if (!baseUrl) {
      throw new Error("Configure an OpenAI-compatible base URL before chatting.");
    }

    if (!provider.apiKey && !isLocalEndpoint(baseUrl)) {
      throw new Error("Configure an API key or use a local endpoint before chatting.");
    }

    const snapshot = this.database.getSnapshot();
    const windowsContext = options.context ?? (await this.windowsContextService.capture(snapshot.settings));
    const contextMessage = formatWindowsContext(windowsContext);
    const includeHistory = options.includeHistory !== false && snapshot.settings.chatHistoryEnabled;
    const recentMessages =
      !includeHistory
        ? []
        : snapshot.messages.slice(-16).map((message) => ({
            role: message.role === "assistant" || message.role === "user" ? message.role : "user",
            content: message.content,
          }));
    const lastMessage = snapshot.messages[snapshot.messages.length - 1];
    const shouldAppendUser =
      !includeHistory ||
      !lastMessage ||
      lastMessage.role !== "user" ||
      lastMessage.content !== options.userContent;

    const payload: Record<string, unknown> = {
      model: instance.model || provider.model,
      messages: [
        {
          role: "system",
          content: [instance.systemPrompt || instance.persona, contextMessage, options.systemAddendum]
            .filter(Boolean)
            .join("\n\n"),
        },
        ...recentMessages,
        ...(shouldAppendUser
          ? [
              {
                role: "user",
                content: options.userContent,
              },
            ]
          : []),
      ],
      temperature: provider.temperature,
      stream: false,
      ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
    };

    const effort = options.effortOverride || instance.effort || provider.defaultEffort;
    if (provider.supportsReasoning) {
      payload.reasoning = provider.supportsEffort ? { effort } : {};
    } else if (provider.supportsEffort) {
      payload.reasoning_effort = effort;
    }

    this.activeController = new AbortController();
    const timeoutMs = options.timeoutMs ?? 90_000;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      this.activeController?.abort();
    }, timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}`, "x-bf-vk": provider.apiKey } : {}),
        },
        body: JSON.stringify(payload),
        signal: this.activeController.signal,
      });
    } catch (error) {
      if (timedOut) {
        throw new Error(`A chamada de IA excedeu ${Math.round(timeoutMs / 1000)}s e foi cancelada.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      this.activeController = null;
    }

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

function createTransientMessage(input: Omit<ChatMessage, "id" | "createdAt">): ChatMessage {
  return {
    ...input,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  };
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

function formatAutomaticContextUserMessage(context: WindowsContext): string {
  const parts = [
    context.activeProcessName ? `processo ativo: ${context.activeProcessName}` : null,
    context.activeWindowTitle ? `titulo da janela ativa: ${context.activeWindowTitle}` : null,
    context.capturedAt ? `capturado em: ${context.capturedAt}` : null,
  ].filter(Boolean);

  return `Contexto local mudou. ${parts.join("; ")}.`;
}

function isSilentResponse(text: string): boolean {
  return text.trim().toLowerCase().replace(/[.。!¡?¿"']/g, "") === "[silent]";
}
