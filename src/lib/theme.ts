import { useEffect, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_KEY = "theme";
/** The order the title-bar button cycles through. */
export const THEME_ORDER: ThemePreference[] = ["system", "light", "dark"];

const query = () => window.matchMedia("(prefers-color-scheme: dark)");

export function storedTheme(): ThemePreference {
  const stored = localStorage.getItem(THEME_KEY);
  return THEME_ORDER.includes(stored as ThemePreference) ? (stored as ThemePreference) : "system";
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? (query().matches ? "dark" : "light") : preference;
}

/** Puts the resolved theme on <html>, which is what every token in index.css keys off. */
function applyTheme(resolved: ResolvedTheme) {
  document.documentElement.classList.toggle("dark", resolved === "dark");
}

export function nextTheme(current: ThemePreference): ThemePreference {
  return THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length];
}

/**
 * The saved preference and what it currently resolves to. "System" follows Windows' app theme live,
 * so flipping it in Settings changes the app without a restart.
 */
export function useTheme() {
  const [preference, setPreferenceState] = useState<ThemePreference>(storedTheme);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(preference));

  useEffect(() => {
    const update = () => {
      const next = resolveTheme(preference);
      setResolved(next);
      applyTheme(next);
    };
    update();
    if (preference !== "system") return;
    const media = query();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [preference]);

  function setPreference(next: ThemePreference) {
    localStorage.setItem(THEME_KEY, next);
    setPreferenceState(next);
  }

  return { preference, resolved, setPreference, cycle: () => setPreference(nextTheme(preference)) };
}
