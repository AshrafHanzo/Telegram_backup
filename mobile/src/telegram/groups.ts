import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";

// Purely local organization metadata, same as desktop's `groups` /
// `folder_metadata.group_id` SQLite tables — there is no Telegram-side
// entity for a "group", so this has no corresponding TDLib call.

export interface FolderGroup {
  id: string;
  name: string;
  colorHex?: string;
  order: number;
}

const GROUPS_KEY = "folder_groups";
const ASSIGNMENTS_KEY = "folder_group_assignments";
const FOLDER_ORDER_KEY = "folder_order";

async function readJson<T>(key: string, fallback: T): Promise<T> {
  const raw = await AsyncStorage.getItem(key);
  return raw ? JSON.parse(raw) : fallback;
}

export async function listGroups(): Promise<FolderGroup[]> {
  const groups = await readJson<FolderGroup[]>(GROUPS_KEY, []);
  return groups.sort((a, b) => a.order - b.order);
}

export async function createGroup(name: string, colorHex?: string): Promise<FolderGroup> {
  const groups = await listGroups();
  const group: FolderGroup = {
    id: Array.from(Crypto.getRandomBytes(8))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(""),
    name,
    colorHex,
    order: groups.length,
  };
  await AsyncStorage.setItem(GROUPS_KEY, JSON.stringify([...groups, group]));
  return group;
}

export async function updateGroup(id: string, patch: Partial<Pick<FolderGroup, "name" | "colorHex">>): Promise<void> {
  const groups = await listGroups();
  const updated = groups.map((g) => (g.id === id ? { ...g, ...patch } : g));
  await AsyncStorage.setItem(GROUPS_KEY, JSON.stringify(updated));
}

export async function deleteGroup(id: string): Promise<void> {
  const groups = (await listGroups()).filter((g) => g.id !== id);
  await AsyncStorage.setItem(GROUPS_KEY, JSON.stringify(groups));

  const assignments = await readJson<Record<string, string>>(ASSIGNMENTS_KEY, {});
  for (const chatId of Object.keys(assignments)) {
    if (assignments[chatId] === id) delete assignments[chatId];
  }
  await AsyncStorage.setItem(ASSIGNMENTS_KEY, JSON.stringify(assignments));
}

export async function updateGroupOrder(orderedIds: string[]): Promise<void> {
  const groups = await listGroups();
  const byId = new Map(groups.map((g) => [g.id, g]));
  const reordered = orderedIds
    .map((id, index) => {
      const group = byId.get(id);
      return group ? { ...group, order: index } : null;
    })
    .filter((g): g is FolderGroup => g !== null);
  await AsyncStorage.setItem(GROUPS_KEY, JSON.stringify(reordered));
}

export async function getFolderGroupAssignments(): Promise<Record<string, string>> {
  return readJson<Record<string, string>>(ASSIGNMENTS_KEY, {});
}

export async function assignFolderToGroup(chatId: number, groupId: string | null): Promise<void> {
  const assignments = await getFolderGroupAssignments();
  if (groupId) {
    assignments[String(chatId)] = groupId;
  } else {
    delete assignments[String(chatId)];
  }
  await AsyncStorage.setItem(ASSIGNMENTS_KEY, JSON.stringify(assignments));
}

export async function getFolderOrder(): Promise<Record<string, number>> {
  return readJson<Record<string, number>>(FOLDER_ORDER_KEY, {});
}

export async function setFolderOrder(chatId: number, order: number): Promise<void> {
  const orders = await getFolderOrder();
  orders[String(chatId)] = order;
  await AsyncStorage.setItem(FOLDER_ORDER_KEY, JSON.stringify(orders));
}
