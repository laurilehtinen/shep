import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  githubAuthStatus,
  githubAuthLogin,
  githubAuthLogout,
  githubSetupGit,
} from "../lib/tauri";
import type { GhAuthStatus } from "../lib/types";
import { getErrorMessage } from "../lib/errors";

type SignInPhase = "idle" | "waiting" | "complete" | "error";

interface GithubStore {
  status: GhAuthStatus | null;
  loading: boolean;
  error: string | null;
  signInPhase: SignInPhase;
  oneTimeCode: string | null;
  verificationUrl: string | null;
  signInLog: string[];
  refresh: () => Promise<void>;
  signIn: () => Promise<void>;
  logout: () => Promise<void>;
  setupGit: () => Promise<void>;
  resetSignIn: () => void;
}

const MAX_LOG_LINES = 40;

export const useGithubStore = create<GithubStore>((set, get) => ({
  status: null,
  loading: false,
  error: null,
  signInPhase: "idle",
  oneTimeCode: null,
  verificationUrl: null,
  signInLog: [],

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const status = await githubAuthStatus();
      set({ status, loading: false });
    } catch (e) {
      set({ error: getErrorMessage(e), loading: false });
    }
  },

  signIn: async () => {
    set({
      signInPhase: "waiting",
      oneTimeCode: null,
      verificationUrl: null,
      signInLog: [],
      error: null,
    });

    // Subscribe to the backend's streaming events for the duration of the
    // sign-in. Tauri's unlisten handles are explicit, not ref-counted, so we
    // collect both and release them in the finally block.
    const unlisteners: UnlistenFn[] = [];
    try {
      unlisteners.push(
        await listen<string>("gh-auth-line", (event) => {
          set((state) => ({
            signInLog: [...state.signInLog, event.payload].slice(-MAX_LOG_LINES),
          }));
        }),
      );
      unlisteners.push(
        await listen<string>("gh-auth-code", (event) => {
          set({ oneTimeCode: event.payload });
        }),
      );
      unlisteners.push(
        await listen<string>("gh-auth-url", (event) => {
          set({ verificationUrl: event.payload });
        }),
      );

      await githubAuthLogin();

      // Post-login: wire git's credential helper. Without this, HTTPS push
      // will fail because the OS credential helper (macOS osxkeychain)
      // doesn't know about gh's token. Idempotent — safe to re-run.
      try {
        await githubSetupGit("github.com");
      } catch (setupErr) {
        if (import.meta.env.DEV) console.error("setup-git failed", setupErr);
      }

      await get().refresh();
      set({ signInPhase: "complete" });
    } catch (e) {
      set({ signInPhase: "error", error: getErrorMessage(e) });
    } finally {
      for (const off of unlisteners) off();
    }
  },

  logout: async () => {
    const host = get().status?.hostname ?? "github.com";
    set({ loading: true, error: null });
    try {
      await githubAuthLogout(host);
      await get().refresh();
    } catch (e) {
      set({ error: getErrorMessage(e), loading: false });
    }
  },

  setupGit: async () => {
    const host = get().status?.hostname ?? "github.com";
    try {
      await githubSetupGit(host);
    } catch (e) {
      set({ error: getErrorMessage(e) });
    }
  },

  resetSignIn: () => {
    set({
      signInPhase: "idle",
      oneTimeCode: null,
      verificationUrl: null,
      signInLog: [],
      error: null,
    });
  },
}));
