/**
 * Home Assistant channel.
 *
 * Two-way integration:
 *   HA → Claw: HA automations POST JSON webhooks to /webhook on port 3002.
 *              Events are delivered as messages to registered HA groups.
 *   Claw → HA: sendMessage() creates a persistent notification in HA.
 *
 * Required env vars:
 *   HA_URL    - e.g. http://homeassistant.local:8123
 *   HA_TOKEN  - Long-Lived Access Token from HA profile
 *
 * Optional:
 *   HA_WEBHOOK_PORT   - port for inbound webhooks (default: 3002)
 *   HA_WEBHOOK_SECRET - shared secret for webhook auth (default: nanoclaw)
 */
import { createServer, Server, IncomingMessage, ServerResponse } from 'http';

import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
  NewMessage,
} from '../types.js';
import { registerChannel } from './registry.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';

const HA_JID_SUFFIX = '@ha';

interface HaEnv {
  HA_URL: string;
  HA_TOKEN: string;
  HA_WEBHOOK_PORT?: string;
  HA_WEBHOOK_SECRET?: string;
}

class HomeAssistantChannel implements Channel {
  name = 'homeassistant';
  private server: Server | null = null;
  private connected = false;
  private onMessage: OnInboundMessage;
  private registeredGroups: () => Record<string, RegisteredGroup>;
  private haUrl: string;
  private haToken: string;
  private webhookPort: number;
  private webhookSecret: string;

  constructor(opts: {
    onMessage: OnInboundMessage;
    onChatMetadata: OnChatMetadata;
    registeredGroups: () => Record<string, RegisteredGroup>;
  }) {
    this.onMessage = opts.onMessage;
    this.registeredGroups = opts.registeredGroups;
    const env = readEnvFile([
      'HA_URL',
      'HA_TOKEN',
      'HA_WEBHOOK_PORT',
      'HA_WEBHOOK_SECRET',
    ]) as unknown as HaEnv;
    this.haUrl = (env.HA_URL || '').replace(/\/$/, '');
    this.haToken = env.HA_TOKEN || '';
    this.webhookPort = parseInt(env.HA_WEBHOOK_PORT || '3002', 10);
    this.webhookSecret = env.HA_WEBHOOK_SECRET || 'nanoclaw';
  }

  async connect(): Promise<void> {
    this.server = createServer((req, res) => this.handleRequest(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.webhookPort, '0.0.0.0', () => {
        logger.info(
          { port: this.webhookPort },
          'HomeAssistant webhook server started',
        );
        resolve();
      });
      this.server!.on('error', reject);
    });
    this.connected = true;
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }

    // Optional secret check via X-HA-Secret header or ?secret= query param
    const url = new URL(req.url || '/', `http://localhost`);
    const secret =
      (req.headers['x-ha-secret'] as string) ||
      url.searchParams.get('secret') ||
      '';
    if (this.webhookSecret && secret !== this.webhookSecret) {
      res.writeHead(401);
      res.end('Unauthorized');
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<
          string,
          unknown
        >;
        res.writeHead(200);
        res.end('OK');
        this.processEvent(body);
      } catch {
        res.writeHead(400);
        res.end('Bad Request');
      }
    });
  }

  private processEvent(body: Record<string, unknown>): void {
    const groups = this.registeredGroups();
    const haGroup = Object.entries(groups).find(([jid]) =>
      jid.endsWith(HA_JID_SUFFIX),
    );
    if (!haGroup) {
      logger.warn(
        'HomeAssistant event received but no HA group registered — use setup/register to add one',
      );
      return;
    }

    const [jid] = haGroup;
    const eventType = (body.event_type as string) || 'event';

    // Use explicit message field if provided, otherwise format the payload
    let text: string;
    if (typeof body.message === 'string') {
      text = body.message;
    } else {
      const data = (body.data as Record<string, unknown>) || {};
      const parts = Object.entries(data)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      text = `[HA: ${eventType}]${parts ? ` ${parts}` : ''}`;
    }

    const msg: NewMessage = {
      id: `ha_${Date.now()}`,
      chat_jid: jid,
      sender: 'homeassistant',
      sender_name: 'Home Assistant',
      content: text,
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
    };

    logger.info({ jid, eventType, text }, 'HomeAssistant event received');
    this.onMessage(jid, msg);
  }

  async sendMessage(_jid: string, text: string): Promise<void> {
    if (!this.haUrl || !this.haToken) return;
    try {
      const res = await fetch(
        `${this.haUrl}/api/services/persistent_notification/create`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.haToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ message: text, title: 'Claw' }),
        },
      );
      if (!res.ok) {
        logger.warn(
          { status: res.status },
          'HA persistent_notification failed',
        );
      }
    } catch (err) {
      logger.error({ err }, 'Failed to send notification to HomeAssistant');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith(HA_JID_SUFFIX);
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.connected = false;
    }
  }
}

registerChannel('homeassistant', (opts) => {
  const env = readEnvFile(['HA_URL', 'HA_TOKEN']) as unknown as HaEnv;
  if (!env.HA_URL || !env.HA_TOKEN) return null;
  return new HomeAssistantChannel(opts);
});
