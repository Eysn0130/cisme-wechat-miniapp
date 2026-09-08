export function formatCnyCents(value: unknown): string | null {
  const cents = Number(value);
  if (!Number.isSafeInteger(cents) || cents < 0) return null;
  if (cents % 100 === 0) return String(cents / 100);
  return (cents / 100).toFixed(2);
}
