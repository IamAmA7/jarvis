/** Short, sortable-ish ids for chunks + sessions. */
export function makeId(prefix = ''): string {
  const rand =
    (globalThis.crypto as { randomUUID?: () => string }).randomUUID?.().replace(/-/g, '').slice(0, 8) ??
    Math.random().toString(36).slice(2, 10);
  return `${prefix}${Date.now().toString(36)}${rand}`;
}
