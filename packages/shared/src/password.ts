/** Password strength estimate for the setup meter (0–4). The hard rule is length ≥ 12 (SPEC §8.1). */
export const MIN_ADMIN_PASSWORD = 12;

export function passwordStrength(pw: string): number {
  let classes = 0;
  if (/[a-z]/.test(pw)) classes++;
  if (/[A-Z]/.test(pw)) classes++;
  if (/\d/.test(pw)) classes++;
  if (/[^A-Za-z0-9]/.test(pw)) classes++;
  const unique = new Set(pw).size;
  let score = 0;
  if (pw.length >= MIN_ADMIN_PASSWORD) score++;
  if (pw.length >= 16) score++;
  if (classes >= 3) score++;
  if (unique >= 10 && pw.length >= 14) score++;
  return Math.min(4, score);
}
