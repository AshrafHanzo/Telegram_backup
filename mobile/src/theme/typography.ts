// Mirrors app/src/App.css's --text-* scale (converted rem -> px at a 16px base).
export const typography = {
  appTitle: { fontSize: 22, fontWeight: "700" as const },
  title: { fontSize: 20, fontWeight: "600" as const },
  sectionTitle: { fontSize: 13, fontWeight: "600" as const, letterSpacing: 0.4 },
  ui: { fontSize: 15, fontWeight: "400" as const },
  uiEmphasis: { fontSize: 15, fontWeight: "600" as const },
  metadata: { fontSize: 12, fontWeight: "400" as const },
  badge: { fontSize: 11, fontWeight: "600" as const },
} as const;
