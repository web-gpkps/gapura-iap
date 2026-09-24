"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Safety net for a websocket that is blocked by a proxy or dropped silently.
 * With the broadcast working this should never be the path that shows a change.
 */
const FALLBACK_MS = 120_000;
/** Offline mode has no Supabase to listen to, so it keeps the old poll rate. */
const POLL_ONLY_MS = 60_000;
/** One burst of imported rows fires several statements, so pings are coalesced. */
const DEBOUNCE_MS = 300;
/**
 * Every write pings every open tab, and each refresh is a full server render. A
 * per-tab floor and a random spread keep a busy hour from turning into one render
 * per tab per write, all landing in the same instant. The editor's own tab is
 * updated by its action's response, so only other people's changes wait.
 */
const MIN_GAP_MS = 10_000;
const JITTER_MS = 2_000;

/**
 * Refreshes the dashboard the moment the tracker changes, whether the edit came
 * from the app or straight from Google Sheets.
 *
 * The broadcast carries no row data — only the fact that something changed. The
 * refresh itself re-renders on the server, which is what applies the branch
 * filtering, so a user never receives another station's rows over the socket.
 */
export function useLiveRefresh(paused: boolean) {
  const router = useRouter();

  useEffect(() => {
    // A refresh under an open dialog would discard what the user is typing.
    if (paused) return;

    let cancelled = false;
    let pending: ReturnType<typeof setTimeout> | undefined;
    let last = 0;

    const refresh = () => {
      if (pending || document.visibilityState !== "visible") return;
      const wait = Math.max(DEBOUNCE_MS, last + MIN_GAP_MS - Date.now());
      pending = setTimeout(() => {
        pending = undefined;
        last = Date.now();
        if (!cancelled) router.refresh();
      }, wait + Math.random() * JITTER_MS);
    };

    // DATA_BACKEND=memory runs without Supabase at all; there is nothing to
    // subscribe to and constructing the client would throw.
    const live = Boolean(
      process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    );
    // Loaded after hydration: supabase-js is the largest dependency on the page and
    // only this socket needs it, so it no longer delays the first paint.
    let unsubscribe: (() => void) | undefined;
    if (live) {
      void import("@/lib/supabase/client")
        .then(async ({ supabaseBrowser }) => {
          if (cancelled) return;
          const supabase = supabaseBrowser();
          const channel = supabase
            .channel("iap-tracker", { config: { private: true } })
            .on("broadcast", { event: "changed" }, refresh);
          unsubscribe = () => void supabase.removeChannel(channel);
          // The topic is private, so the socket has to carry the signed-in session.
          await supabase.realtime.setAuth();
          if (!cancelled) channel.subscribe();
        })
        .catch(() => {
          // Falls back to the interval below rather than breaking the dashboard.
        });
    }

    const timer = setInterval(refresh, live ? FALLBACK_MS : POLL_ONLY_MS);
    // Pings that arrived while the tab was hidden were dropped; catch up once.
    const onVisible = () => refresh();
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      if (pending) clearTimeout(pending);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      unsubscribe?.();
    };
  }, [router, paused]);
}
