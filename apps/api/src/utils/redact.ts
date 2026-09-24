export function redactSecret(message: string, secret?: string, replacement = '[REDACTED_KEY]'): string {
  if (!secret) return message;
  const trimmed = secret.trim();
  if (!trimmed) return message;
  const noPrefix = trimmed.replace(/^0x/, '');
  const withPrefix = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  return message.replaceAll(withPrefix, replacement).replaceAll(noPrefix, replacement);
}
