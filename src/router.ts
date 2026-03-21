import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}">${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

/**
 * Detects the API provider from an authentication error message.
 * Returns the provider name (e.g. 'Claude/Anthropic') or null if not an auth error.
 */
export function detectApiProvider(text: string): string | null {
  if (
    !text.includes('authentication_error') &&
    !text.includes('Failed to authenticate')
  ) {
    return null;
  }
  // Anthropic/Claude: identified by Anthropic JSON error envelope + request_id format
  if (
    text.includes('"type":"error"') &&
    (text.includes('"request_id"') || text.includes('req_'))
  ) {
    return 'Claude/Anthropic';
  }
  // Google/Gmail: OAuth errors from Google APIs
  if (
    text.includes('google') ||
    text.includes('gmail') ||
    text.includes('accounts.google.com')
  ) {
    return 'Google/Gmail';
  }
  // GitHub
  if (text.includes('github') || text.includes('github.com')) {
    return 'GitHub';
  }
  // WhatsApp / Baileys
  if (text.includes('whatsapp') || text.includes('baileys')) {
    return 'WhatsApp';
  }
  return null;
}

/**
 * Patterns indicating a "nothing found" result from a scheduled task.
 * Messages matching these patterns are suppressed (return '' from formatOutbound).
 */
const TASK_SILENCE_PATTERNS = [
  // French
  'aucun email non lu',
  'aucun email trouvé',
  'aucune notification de livraison',
  'aucun virement',
  'aucune livraison',
  'aucune mise à jour de livraison',
  'aucun nouveau message',
  'rien à signaler',
  'rien de nouveau',
  'tâche terminée silencieusement',
  'pas de message envoyé',
  'arrêt silencieux',
  // English
  'no emails found',
  'no unread emails',
  'no notifications found',
  'no delivery notification',
  'nothing found',
  'nothing to report',
  'completed silently',
  'task completed silently',
  'no new messages',
];

export function isSilentResult(text: string): boolean {
  const lower = text.toLowerCase();
  return TASK_SILENCE_PATTERNS.some((p) => lower.includes(p));
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';

  // Suppress "nothing found" task results — no message sent to user
  if (isSilentResult(text)) return '';

  // Enrich authentication error messages with the API provider name
  const provider = detectApiProvider(text);
  if (provider) {
    return text.replace(
      'Failed to authenticate.',
      `[${provider}] Failed to authenticate.`,
    );
  }

  return text;
}


export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
