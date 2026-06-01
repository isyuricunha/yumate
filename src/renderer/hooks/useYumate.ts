import { useEffect, useState } from "react";
import { type AppSnapshot, type BehaviorState } from "../../shared/types";

export function useYumate() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [state, setState] = useState<BehaviorState>("idle");
  const [loadingError, setLoadingError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    window.yumate
      .getSnapshot()
      .then((next) => {
        if (!mounted) {
          return;
        }
        setSnapshot(next);
        setState(next.activeInstance.currentState);
      })
      .catch((error: unknown) => {
        if (mounted) {
          setLoadingError(error instanceof Error ? error.message : "Failed to load Yumate.");
        }
      });

    const unsubscribeSnapshot = window.yumate.on("snapshot:changed", (next) => {
      setSnapshot(next);
      setState(next.activeInstance.currentState);
    });
    const unsubscribeState = window.yumate.on("state:changed", (payload) => {
      setState(payload.state);
    });

    return () => {
      mounted = false;
      unsubscribeSnapshot();
      unsubscribeState();
    };
  }, []);

  return { snapshot, state, setState, loadingError };
}
