import { GoogleSignin } from "@react-native-google-signin/google-signin";

const DRIVE_APPDATA_SCOPE = "https://www.googleapis.com/auth/drive.appdata";

let configured = false;

function ensureConfigured() {
  if (configured) return;
  GoogleSignin.configure({ scopes: [DRIVE_APPDATA_SCOPE] });
  configured = true;
}

export interface GoogleAccount {
  email: string;
  name: string | null;
  photo: string | null;
}

function toAccount(user: {
  user: { email: string; name: string | null; photo: string | null };
}): GoogleAccount {
  return { email: user.user.email, name: user.user.name, photo: user.user.photo };
}

export async function signIn(): Promise<GoogleAccount> {
  ensureConfigured();
  await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  const result = await GoogleSignin.signIn();
  if (result.type !== "success") {
    throw new Error("Google sign-in was cancelled");
  }
  return toAccount(result.data);
}

export async function signInSilently(): Promise<GoogleAccount | null> {
  ensureConfigured();
  try {
    const result = await GoogleSignin.signInSilently();
    if (result.type !== "success") return null;
    return toAccount(result.data);
  } catch {
    return null;
  }
}

// `getCurrentUser`/`hasPreviousSignIn` read the native module's in-memory
// client, which on Android isn't initialized until `configure()` has run at
// least once this session — without this, calling either before ever
// visiting the sign-in screen returns null/false even though the user is
// really still signed in (same account the desktop app already synced).
export function getCurrentAccount(): GoogleAccount | null {
  ensureConfigured();
  const user = GoogleSignin.getCurrentUser();
  return user ? toAccount(user) : null;
}

export function isSignedIn(): boolean {
  ensureConfigured();
  return GoogleSignin.hasPreviousSignIn();
}

export async function getAccessToken(): Promise<string> {
  ensureConfigured();
  const tokens = await GoogleSignin.getTokens();
  return tokens.accessToken;
}

export async function signOut(): Promise<void> {
  await GoogleSignin.signOut();
}
