import { useEffect, useRef, useState } from "react";
import {
  MessageCircle,
  Settings,
  Volume2,
  VolumeX,
  Square,
  X,
} from "lucide-react";
import { useYumate } from "../hooks/useYumate";
import { PetCanvas } from "./PetCanvas";
import { ChatPanel } from "./ChatPanel";
import { SettingsPanel } from "./SettingsPanel";
import { type BehaviorState } from "../../shared/types";
import { translate, type TranslationKey } from "../../shared/i18n";

export function App() {
  const { snapshot, state, setState, loadingError } = useYumate();
  const [chatOpen, setChatOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bubble, setBubble] = useState<{ text: string; tone: "neutral" | "thinking" | "error" } | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const bubbleTimeout = useRef<number | null>(null);
  const locale = snapshot?.settings.locale;
  const t = (key: TranslationKey) => translate(locale, key);

  useEffect(() => {
    const cleanups = [
      window.yumate.on("bubble:show", (payload) => {
        setBubble({ text: payload.text, tone: payload.tone });
        if (bubbleTimeout.current) {
          window.clearTimeout(bubbleTimeout.current);
        }
        if (payload.timeoutMs !== 0) {
          bubbleTimeout.current = window.setTimeout(() => setBubble(null), payload.timeoutMs ?? 8000);
        }
      }),
      window.yumate.on("state:changed", (payload) => {
        if (payload.bubble) {
          setBubble({ text: payload.bubble, tone: payload.state === "error" ? "error" : "neutral" });
        }
      }),
      window.yumate.on("ui:toggle-chat", (payload) => {
        setChatOpen(payload.open ?? true);
      }),
      window.yumate.on("ui:open-settings", () => {
        setSettingsOpen(true);
      }),
      window.yumate.on("tts:play", (payload) => {
        const audio = audioRef.current;
        if (!audio) {
          return;
        }
        audio.pause();
        audio.src = payload.audioUrl;
        audio.volume = payload.volume;
        void audio.play().catch(() => {
          setBubble({ text: translate(locale, "app.audioError"), tone: "error" });
          void window.yumate.notifyTtsEnded();
        });
      }),
      window.yumate.on("tts:stop", () => {
        const audio = audioRef.current;
        if (audio) {
          audio.pause();
          audio.removeAttribute("src");
        }
      }),
    ];
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [locale]);

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const interactive = Boolean(target?.closest("[data-interactive='true']"));
      void window.yumate.setClickThrough(snapshot?.settings.clickThroughEnabled ? !interactive : false);
    };

    const handleMouseLeave = () => {
      void window.yumate.setClickThrough(Boolean(snapshot?.settings.clickThroughEnabled));
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseleave", handleMouseLeave);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseleave", handleMouseLeave);
    };
  }, [snapshot?.settings.clickThroughEnabled]);

  useEffect(() => {
    void window.yumate.setPanelState({ chatOpen, settingsOpen });
  }, [chatOpen, settingsOpen]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      if (settingsOpen) {
        event.preventDefault();
        setSettingsOpen(false);
        return;
      }

      if (chatOpen) {
        event.preventDefault();
        setChatOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [chatOpen, settingsOpen]);

  if (loadingError) {
    return <div className="boot-error">{loadingError}</div>;
  }

  if (!snapshot) {
    return <div className="boot-error">{translate(undefined, "app.loading")}</div>;
  }

  const muted = snapshot.tts.muted;

  const setPetBehaviorState = (nextState: BehaviorState) => {
    setState(nextState);
    void window.yumate.setPetState(nextState);
  };

  const saveMuted = async (nextMuted: boolean) => {
    await window.yumate.saveSettings({
      provider: snapshot.providers[0],
      tts: { ...snapshot.tts, muted: nextMuted },
      instance: {
        id: snapshot.activeInstance.id,
        name: snapshot.activeInstance.name,
        scale: snapshot.activeInstance.scale,
        persona: snapshot.activeInstance.persona,
        systemPrompt: snapshot.activeInstance.systemPrompt,
        voice: snapshot.activeInstance.voice,
        model: snapshot.activeInstance.model,
        providerId: snapshot.activeInstance.providerId,
        effort: snapshot.activeInstance.effort,
        ttsEnabled: snapshot.activeInstance.ttsEnabled,
        movementEnabled: snapshot.activeInstance.movementEnabled,
      },
      global: snapshot.settings,
      hotkeys: snapshot.hotkeys,
    });
  };

  const handlePetClick = () => {
    setPetBehaviorState("clicked");
    setBubble({ text: t("app.petClicked"), tone: "neutral" });
    window.setTimeout(() => {
      setPetBehaviorState("idle");
    }, 900);
  };

  return (
    <main className="window-shell">
      <section className="pet-layer">
        <div className="bubble-row" data-interactive="true">
          {bubble && !chatOpen && !settingsOpen && (
            <button
              className={`speech-bubble ${bubble.tone}`}
              title={t("app.openChat")}
              type="button"
              onClick={() => setChatOpen(true)}
            >
              {bubble.text}
            </button>
          )}
        </div>

        <PetCanvas
          pack={snapshot.activePetPack}
          state={state}
          scale={snapshot.activeInstance.scale}
          onClick={handlePetClick}
        />

        <div className="quickbar" data-interactive="true">
          <button title={t("app.chat")} type="button" onClick={() => setChatOpen((open) => !open)}>
            <MessageCircle size={18} />
          </button>
          <button title={muted ? t("app.unmute") : t("app.mute")} type="button" onClick={() => saveMuted(!muted)}>
            {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </button>
          <button title={t("app.stopSpeech")} type="button" onClick={() => window.yumate.stopTts()}>
            <Square size={16} />
          </button>
          <button title={t("app.settings")} type="button" onClick={() => setSettingsOpen((open) => !open)}>
            <Settings size={18} />
          </button>
          <button title={t("app.hide")} type="button" onClick={() => window.yumate.toggleVisibility()}>
            <X size={18} />
          </button>
        </div>
      </section>

      {chatOpen && (
        <ChatPanel
          snapshot={snapshot}
          onClose={() => setChatOpen(false)}
        />
      )}

      {settingsOpen && (
        <SettingsPanel
          snapshot={snapshot}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      <audio
        ref={audioRef}
        onEnded={() => window.yumate.notifyTtsEnded()}
        onError={() => window.yumate.notifyTtsEnded()}
      />
    </main>
  );
}
