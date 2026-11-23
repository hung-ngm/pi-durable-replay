const STORAGE_KEY = "control-token";

/**
 * The single-user control token (SPEC Q8). Prompted once, kept in session storage
 * only: it survives reloads of this tab, never local storage, never a cookie.
 */
export function controlToken(): string {
  const stored = window.sessionStorage.getItem(STORAGE_KEY);
  if (stored !== null && stored !== "") return stored;
  const entered = window.prompt("Control token") ?? "";
  if (entered !== "") window.sessionStorage.setItem(STORAGE_KEY, entered);
  return entered;
}
