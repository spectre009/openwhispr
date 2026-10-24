/** How a saved key shows: its first three and last four characters at most. */
export function maskApiKey(key: string): string {
  if (key.length <= 8) return "••••••••";
  return key.slice(0, 3) + "..." + key.slice(-4);
}
