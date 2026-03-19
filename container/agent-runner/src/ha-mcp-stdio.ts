/**
 * Home Assistant MCP Server (stdio)
 * Runs inside the container as a subprocess.
 * HA_URL and HA_TOKEN are passed as env vars from the host.
 *
 * Tools exposed to Claw:
 *   ha_get_state         - Get state of one entity
 *   ha_list_entities     - List entities by domain
 *   ha_call_service      - Call any HA service (turn_on, turn_off, set_temperature, etc.)
 *   ha_get_history       - Get state history for an entity
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const HA_URL = (process.env.HA_URL || '').replace(/\/$/, '');
const HA_TOKEN = process.env.HA_TOKEN || '';

if (!HA_URL || !HA_TOKEN) {
  process.stderr.write('HA_URL and HA_TOKEN must be set\n');
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${HA_TOKEN}`,
  'Content-Type': 'application/json',
};

async function haGet(path: string): Promise<unknown> {
  const res = await fetch(`${HA_URL}/api${path}`, { headers });
  if (!res.ok) throw new Error(`HA API error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function haPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${HA_URL}/api${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HA API error ${res.status}: ${await res.text()}`);
  return res.json();
}

const server = new McpServer({ name: 'homeassistant', version: '1.0.0' });

server.tool(
  'ha_get_state',
  'Get the current state and attributes of a Home Assistant entity (e.g. light.salon, sensor.temperature)',
  { entity_id: z.string().describe('Entity ID, e.g. light.salon or sensor.temperature_exterieure') },
  async ({ entity_id }) => {
    const state = await haGet(`/states/${entity_id}`) as Record<string, unknown>;
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(state, null, 2) }],
    };
  },
);

server.tool(
  'ha_list_entities',
  'List all Home Assistant entities, optionally filtered by domain (light, switch, sensor, climate, etc.)',
  {
    domain: z.string().optional().describe('Filter by domain: light, switch, sensor, climate, binary_sensor, scene, script, automation, etc.'),
    search: z.string().optional().describe('Filter by entity_id or friendly_name substring'),
  },
  async ({ domain, search }) => {
    const states = await haGet('/states') as Array<Record<string, unknown>>;
    let filtered = states;
    if (domain) filtered = filtered.filter(s => (s.entity_id as string).startsWith(`${domain}.`));
    if (search) filtered = filtered.filter(s =>
      (s.entity_id as string).includes(search) ||
      ((s.attributes as Record<string, unknown>)?.friendly_name as string || '').toLowerCase().includes(search.toLowerCase())
    );
    const summary = filtered.map(s => ({
      entity_id: s.entity_id,
      state: s.state,
      name: (s.attributes as Record<string, unknown>)?.friendly_name,
    }));
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }],
    };
  },
);

server.tool(
  'ha_call_service',
  'Call a Home Assistant service to control devices. Examples: turn on/off lights, set climate temperature, trigger automations/scripts, activate scenes.',
  {
    domain: z.string().describe('Service domain, e.g. light, switch, climate, scene, script, automation, media_player'),
    service: z.string().describe('Service name, e.g. turn_on, turn_off, toggle, set_temperature, activate, trigger'),
    entity_id: z.string().optional().describe('Target entity ID. Can be a single entity or comma-separated list.'),
    data: z.record(z.string(), z.unknown()).optional().describe('Additional service data, e.g. {"brightness": 200, "temperature": 21}'),
  },
  async ({ domain, service, entity_id, data }) => {
    const body: Record<string, unknown> = { ...data };
    if (entity_id) body.entity_id = entity_id;
    const result = await haPost(`/services/${domain}/${service}`, body);
    return {
      content: [{ type: 'text' as const, text: `Service called successfully.\n${JSON.stringify(result, null, 2)}` }],
    };
  },
);

server.tool(
  'ha_get_history',
  'Get state history for a Home Assistant entity over the last N hours',
  {
    entity_id: z.string().describe('Entity ID to get history for'),
    hours: z.number().optional().describe('Number of hours to look back (default: 24)'),
  },
  async ({ entity_id, hours = 24 }) => {
    const start = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const history = await haGet(
      `/history/period/${start}?filter_entity_id=${entity_id}&minimal_response=true`,
    );
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(history, null, 2) }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
