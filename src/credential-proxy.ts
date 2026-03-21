/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

const CLAUDE_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
// Refresh when less than 2 hours remain
const REFRESH_THRESHOLD_MS = 2 * 60 * 60 * 1000;
// Check every hour
const REFRESH_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** Read full OAuth credentials from ~/.claude/.credentials.json. */
function readFullClaudeCredentials():
  | { accessToken: string; refreshToken?: string; expiresAt?: number }
  | undefined {
  try {
    const credPath = join(homedir(), '.claude', '.credentials.json');
    const creds = JSON.parse(readFileSync(credPath, 'utf-8'));
    return creds?.claudeAiOauth;
  } catch {
    return undefined;
  }
}

/** Read the current OAuth token from ~/.claude/.credentials.json if available. */
function readClaudeCredentials(): string | undefined {
  return readFullClaudeCredentials()?.accessToken;
}

/** Perform OAuth refresh token exchange and update ~/.claude/.credentials.json. */
async function refreshOAuthToken(): Promise<boolean> {
  const creds = readFullClaudeCredentials();
  if (!creds?.refreshToken) {
    logger.warn('OAuth refresh: no refresh token available');
    return false;
  }

  const now = Date.now();
  if (creds.expiresAt && creds.expiresAt - now > REFRESH_THRESHOLD_MS) {
    // Token still has plenty of time left
    return false;
  }

  const expiresInH = creds.expiresAt
    ? ((creds.expiresAt - now) / 3600000).toFixed(1)
    : 'unknown';
  logger.info({ expiresInH }, 'OAuth token expiring soon, refreshing');

  return new Promise((resolve) => {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLAUDE_OAUTH_CLIENT_ID,
      refresh_token: creds.refreshToken!,
    }).toString();

    const tokenUrl = new URL(CLAUDE_OAUTH_TOKEN_URL);
    const req = httpsRequest(
      {
        hostname: tokenUrl.hostname,
        port: 443,
        path: tokenUrl.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            if (!data.access_token) {
              logger.error({ data }, 'OAuth refresh: unexpected response');
              resolve(false);
              return;
            }
            // Update credentials file
            const credPath = join(homedir(), '.claude', '.credentials.json');
            const existing = JSON.parse(readFileSync(credPath, 'utf-8'));
            existing.claudeAiOauth = {
              ...existing.claudeAiOauth,
              accessToken: data.access_token,
              ...(data.refresh_token && { refreshToken: data.refresh_token }),
              ...(data.expires_in && {
                expiresAt: Date.now() + data.expires_in * 1000,
              }),
            };
            writeFileSync(credPath, JSON.stringify(existing, null, 2));
            logger.info('OAuth token refreshed successfully');
            resolve(true);
          } catch (err) {
            logger.error({ err }, 'OAuth refresh: failed to parse response');
            resolve(false);
          }
        });
      },
    );

    req.on('error', (err) => {
      logger.error({ err }, 'OAuth refresh: request failed');
      resolve(false);
    });

    req.write(body);
    req.end();
  });
}

/** Start periodic OAuth token refresh (no-op in API key mode). */
export function startOAuthRefresher(): void {
  if (detectAuthMode() !== 'oauth') return;

  // Attempt immediately, then on interval
  void refreshOAuthToken();
  setInterval(() => void refreshOAuthToken(), REFRESH_CHECK_INTERVAL_MS);
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one.
          // Read dynamically on each request so token refreshes are picked up
          // immediately without a service restart.
          if (headers['authorization']) {
            const oauthToken =
              readClaudeCredentials() ||
              secrets.CLAUDE_CODE_OAUTH_TOKEN ||
              secrets.ANTHROPIC_AUTH_TOKEN;
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
