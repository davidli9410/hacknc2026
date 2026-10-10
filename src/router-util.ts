// Handle normalization: E.164 for phones, lowercase for emails, prefixed ids for terminal/sim.

export function normalizeHandle(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^(term|sim):/.test(s)) return s;
  if (s.includes("@")) return s.toLowerCase().replace(/^mailto:/, "");
  const digits = s.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return /^\+\d{7,15}$/.test(digits) ? digits : null;
  const d = digits.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  if (d.length >= 7 && d.length <= 15) return `+${d}`;
  return null;
}
