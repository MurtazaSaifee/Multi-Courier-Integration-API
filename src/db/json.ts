export function toJsonb(value: unknown): unknown {
  if (value === undefined || value === null) {
    return null;
  }
  return JSON.stringify(value);
}
