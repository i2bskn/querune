const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;

// The trimmed name, or null if invalid: 1 to maxLength characters (code points) without control characters.
export function normalizeDisplayName(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  const length = [...name].length;
  if (length < 1 || length > maxLength || CONTROL.test(name)) return null;
  return name;
}

// The first key of the body that is not allowed, or null.
export function unknownField(body: Record<string, unknown>, allowed: string[]): string | null {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) return key;
  return null;
}
