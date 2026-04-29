/**
 * ThemeProvider — system / light / dark with manual override.
 *
 * The user's preference is stored in localStorage under "theme" with
 * one of "system" | "light" | "dark". When the value is "system",
 * the provider mirrors the OS-level `prefers-color-scheme` and
 * subscribes to changes so toggling the system theme propagates
 * without a reload.
 *
 * To avoid a flash of wrong theme on first paint, an inline script
 * (`themeBootScript`) runs *before* React hydrates and applies the
 * resolved class to <html>. This component then takes over.
 */
import * as React from "react";

export type Theme = "system" | "light" | "dark";

const STORAGE_KEY = "theme";

interface ThemeContextValue {
  theme: Theme;
  resolved: "light" | "dark";
  setTheme: (t: Theme) => void;
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "system";
  const v = window.localStorage.getItem(STORAGE_KEY);
  if (v === "light" || v === "dark" || v === "system") return v;
  return "system";
}

function resolveSystemTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyClass(resolved: "light" | "dark") {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (resolved === "dark") {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Initialize without touching `window` so SSR doesn't crash; the
  // useEffect below re-reads from localStorage + media query and
  // re-applies after hydration. The boot script handles the first
  // paint so this hydration mismatch is invisible.
  const [theme, setThemeState] = React.useState<Theme>("system");
  const [resolved, setResolved] = React.useState<"light" | "dark">("light");

  // On mount: read storage + system preference, sync state.
  React.useEffect(() => {
    const stored = readStoredTheme();
    const sys = resolveSystemTheme();
    const next = stored === "system" ? sys : stored;
    setThemeState(stored);
    setResolved(next);
    applyClass(next);
  }, []);

  // Subscribe to system theme changes — only matters when the user
  // selected "system". `change` fires on macOS auto / Windows theme
  // switch.
  React.useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const next = mq.matches ? "dark" : "light";
      setResolved(next);
      applyClass(next);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const setTheme = React.useCallback((t: Theme) => {
    setThemeState(t);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, t);
    }
    const next = t === "system" ? resolveSystemTheme() : t;
    setResolved(next);
    applyClass(next);
  }, []);

  const value = React.useMemo(() => ({ theme, resolved, setTheme }), [theme, resolved, setTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) {
    // Soft fallback — used during SSR / before provider mounts.
    return {
      theme: "system",
      resolved: "light",
      setTheme: () => {},
    };
  }
  return ctx;
}

/**
 * Inline script — runs synchronously in <head> before React hydrates
 * to prevent a flash of light theme when the stored preference is
 * dark. Self-contained and minimal; if anything throws we fall back
 * to "light" gracefully.
 */
export const themeBootScript = `
(function(){try{
  var s=localStorage.getItem('theme');
  var sys=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';
  var t=s==='light'||s==='dark'?s:sys;
  if(t==='dark'){document.documentElement.classList.add('dark');}
}catch(e){}})();
`;
