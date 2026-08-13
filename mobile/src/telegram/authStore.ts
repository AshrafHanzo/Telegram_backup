import { create } from "zustand";
import * as TdClient from "./client";
import { loadCredentials, saveCredentials, TelegramCredentials } from "./credentials";
import * as googleSignin from "../google/signin";
import * as Drive from "../google/drive";
import * as appLock from "../security/appLock";

export type AuthStateKind =
  | "idle"
  | "needsCredentials"
  | "waitPhoneNumber"
  | "waitCode"
  | "waitPassword"
  | "ready"
  | "closed"
  | "unsupported";

interface AuthStore {
  kind: AuthStateKind;
  error: string | null;
  unsupportedType: string | null;
  submitting: boolean;
  init: () => Promise<void>;
  setCredentials: (creds: TelegramCredentials) => Promise<void>;
  submitPhone: (countryCode: string, phoneNumber: string) => Promise<void>;
  submitCode: (code: string) => Promise<void>;
  submitPassword: (password: string) => Promise<void>;
  logout: () => Promise<void>;
}

let unsubscribe: (() => void) | null = null;

function mapAuthorizationStateType(type: string): AuthStateKind {
  switch (type) {
    case "authorizationStateWaitPhoneNumber":
      return "waitPhoneNumber";
    case "authorizationStateWaitCode":
      return "waitCode";
    case "authorizationStateWaitPassword":
      return "waitPassword";
    case "authorizationStateReady":
      return "ready";
    case "authorizationStateClosed":
      return "closed";
    default:
      return "unsupported";
  }
}

async function runGuarded(
  set: (partial: Partial<AuthStore>) => void,
  action: () => Promise<void>,
) {
  set({ submitting: true, error: null });
  try {
    await action();
  } catch (e: any) {
    set({ error: e?.message ?? String(e) });
  } finally {
    set({ submitting: false });
  }
}

export const useAuthStore = create<AuthStore>((set) => ({
  kind: "idle",
  error: null,
  unsupportedType: null,
  submitting: false,

  init: async () => {
    if (!unsubscribe) {
      unsubscribe = TdClient.subscribeTo("updateAuthorizationState", (data) => {
        const type = data?.authorization_state?.["@type"] as string | undefined;
        if (!type) return;
        const kind = mapAuthorizationStateType(type);
        set({ kind, unsupportedType: kind === "unsupported" ? type : null, error: null });

        // TDLib requires startTdLib to be called again after it fully closes
        // (e.g. following logout) before it will accept new requests.
        if (kind === "closed") {
          loadCredentials().then((creds) => {
            if (creds) {
              TdClient.startClient(creds).catch((e: any) => {
                // Surface the failure instead of swallowing it — otherwise
                // `kind` stays stuck at "closed" with no way for the UI to
                // know something went wrong or to offer a retry.
                set({ error: e?.message ?? String(e) });
              });
            }
          });
        }
      });
    }

    let creds = await loadCredentials();
    if (!creds) {
      // Best-effort: if this device is already signed into the same Google
      // account the desktop app synced credentials from, pull them
      // automatically instead of making the user open Settings and press
      // "Sync now" themselves before they can see anything.
      try {
        if (googleSignin.getCurrentAccount()) {
          const payload = await Drive.pull();
          const apiId = Number(payload?.api_id);
          if (payload?.api_hash && Number.isFinite(apiId) && apiId > 0) {
            creds = { apiId, apiHash: payload.api_hash };
            await saveCredentials(creds);
          }
        }
      } catch {
        // Offline, not signed in, or Drive read failed — fall through to
        // manual entry same as before.
      }
    }
    if (!creds) {
      set({ kind: "needsCredentials" });
      return;
    }
    try {
      await TdClient.startClient(creds);
    } catch (e: any) {
      set({ error: e?.message ?? String(e) });
    }
    // Also opportunistically refresh App Lock from Drive in the background
    // — never blocks reaching the ready state, just keeps it current
    // without a manual sync for the common "already signed into Google"
    // case.
    if (googleSignin.getCurrentAccount()) {
      appLock.syncFromDrive().catch(() => {});
    }
  },

  setCredentials: async (creds) => {
    await saveCredentials(creds);
    await runGuarded(set, () => TdClient.startClient(creds));
  },

  submitPhone: (countryCode, phoneNumber) =>
    runGuarded(set, () => TdClient.submitPhone(countryCode, phoneNumber)),

  submitCode: (code) => runGuarded(set, () => TdClient.submitCode(code)),

  submitPassword: (password) => runGuarded(set, () => TdClient.submitPassword(password)),

  logout: async () => {
    await TdClient.logout();
  },
}));
