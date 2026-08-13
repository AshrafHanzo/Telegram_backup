// Matches the OneDrive Android app's dark design language (the user's
// explicit visual reference for this app) rather than desktop's own Tailwind
// theme — pure black canvas, a brighter accent blue, and borderless list
// rows that rely on spacing instead of dividers.
export const colors = {
  canvas: "#000000",
  sidebar: "#000000",
  surface: "#0f0f0f",
  surfaceRaised: "#1a1a1a",
  surfaceSunken: "#000000",

  accent: "#4EA1F3",
  accentHover: "#6CB4FF",
  accentSoft: "rgba(78, 161, 243, 0.16)",
  accentContrast: "#07141b",

  text: "#FFFFFF",
  textSecondary: "#9A9A9E",
  textTertiary: "#6E6E73",

  borderSubtle: "rgba(255, 255, 255, 0.05)",
  border: "rgba(255, 255, 255, 0.09)",
  borderStrong: "rgba(255, 255, 255, 0.16)",

  hover: "rgba(255, 255, 255, 0.06)",
  selected: "rgba(78, 161, 243, 0.14)",
  overlay: "rgba(0, 0, 0, 0.7)",

  success: "#3DDC84",
  warning: "#F2B94C",
  danger: "#FF453A",
  info: "#63A9FF",
} as const;
