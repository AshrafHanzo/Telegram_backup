import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";

const API_ID_KEY = "td_api_id";
const API_HASH_KEY = "td_api_hash";

export interface TelegramCredentials {
  apiId: number;
  apiHash: string;
}

export async function saveCredentials(creds: TelegramCredentials): Promise<void> {
  await AsyncStorage.setItem(API_ID_KEY, String(creds.apiId));
  await SecureStore.setItemAsync(API_HASH_KEY, creds.apiHash);
}

export async function loadCredentials(): Promise<TelegramCredentials | null> {
  const [apiIdStr, apiHash] = await Promise.all([
    AsyncStorage.getItem(API_ID_KEY),
    SecureStore.getItemAsync(API_HASH_KEY),
  ]);
  if (!apiIdStr || !apiHash) return null;
  const apiId = Number(apiIdStr);
  if (!Number.isFinite(apiId)) return null;
  return { apiId, apiHash };
}

export async function clearCredentials(): Promise<void> {
  await AsyncStorage.removeItem(API_ID_KEY);
  await SecureStore.deleteItemAsync(API_HASH_KEY);
}
