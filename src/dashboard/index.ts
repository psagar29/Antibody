import {randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import type {Server, ServerResponse} from 'node:http';

import {
  DashboardRepository,
  RunFileNotFoundError,
  RunIntegrityError,
  RunNotFoundError,
} from './model.js';
import {renderDashboardPage} from './page.js';

export interface DashboardOptions {
  readonly runsDirectory: string;
  readonly host?: string;
  readonly port?: number;
}

export interface DashboardHandle {
  readonly url: string;
  close(): Promise<void>;
}

const MAX_URL_LENGTH = 4096;

export async function startDashboard(options: DashboardOptions): Promise<DashboardHandle> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  if (host.length === 0) throw new Error('host must not be empty');
  if (!isLoopbackHost(host)) {
    throw new Error('host must be a loopback address (127.0.0.1, ::1, or localhost)');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('port must be an integer from 0 through 65535');
  }
  const repository = await DashboardRepository.open(options.runsDirectory);
  const server = createServer((request, response) => {
    void handleRequest(repository, request.method ?? 'GET', request.url ?? '/', response);
  });
  await listen(server, host, port);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Dashboard did not bind a TCP address');
  }
  const displayHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  let closePromise: Promise<void> | undefined;
  return {
    url: `http://${displayHost}:${String(address.port)}`,
    close() {
      closePromise ??= closeServer(server);
      return closePromise;
    },
  };
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

async function handleRequest(
  repository: DashboardRepository,
  method: string,
  requestUrl: string,
  response: ServerResponse,
): Promise<void> {
  const headOnly = method === 'HEAD';
  try {
    if (method !== 'GET' && !headOnly) {
      response.setHeader('Allow', 'GET, HEAD');
      sendJson(response, 405, {error: {code: 'METHOD_NOT_ALLOWED', message: 'Use GET or HEAD'}}, false);
      return;
    }
    if (requestUrl.length > MAX_URL_LENGTH) {
      sendJson(response, 414, {error: {code: 'URI_TOO_LONG', message: 'Request URI is too long'}}, headOnly);
      return;
    }
    const url = new URL(requestUrl, 'http://dashboard.local');
    if (url.pathname === '/') {
      const nonce = randomBytes(18).toString('base64url');
      send(
        response,
        200,
        Buffer.from(renderDashboardPage(nonce), 'utf8'),
        'text/html; charset=utf-8',
        headOnly,
        dashboardCsp(nonce),
      );
      return;
    }
    const segments = decodePathSegments(url.pathname);
    if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'runs') {
      const index = await repository.list();
      sendJson(response, 200, index, headOnly);
      return;
    }
    if (segments.length === 3 && segments[0] === 'api' && segments[1] === 'runs') {
      const runId = segments[2];
      if (runId === undefined) throw new RunNotFoundError('Run not found');
      const run = await repository.detail(runId);
      sendJson(response, 200, {run}, headOnly);
      return;
    }
    if (
      segments.length === 5 &&
      segments[0] === 'api' &&
      segments[1] === 'runs' &&
      segments[3] === 'files'
    ) {
      const runId = segments[2];
      const key = segments[4];
      if (runId === undefined || key === undefined) throw new RunFileNotFoundError('File not found');
      const file = await repository.readFile(runId, key);
      response.setHeader('Content-Disposition', `inline; filename="${file.name}"`);
      send(response, 200, file.bytes, file.contentType, headOnly, artifactCsp());
      return;
    }
    sendNotFound(response, headOnly);
  } catch (error: unknown) {
    if (error instanceof URIError) {
      sendJson(response, 400, {error: {code: 'BAD_PATH', message: 'Malformed request path'}}, headOnly);
    } else if (error instanceof RunNotFoundError || error instanceof RunFileNotFoundError) {
      sendNotFound(response, headOnly);
    } else if (error instanceof RunIntegrityError) {
      sendJson(
        response,
        422,
        {error: {code: 'RUN_INTEGRITY_FAILED', message: 'Run failed integrity verification'}},
        headOnly,
      );
    } else {
      sendJson(
        response,
        500,
        {error: {code: 'INTERNAL_ERROR', message: 'Dashboard could not read local proof data'}},
        headOnly,
      );
    }
  }
}

function decodePathSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment));
}

function sendNotFound(response: ServerResponse, headOnly: boolean): void {
  sendJson(response, 404, {error: {code: 'NOT_FOUND', message: 'Route not found'}}, headOnly);
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  headOnly: boolean,
): void {
  send(
    response,
    status,
    Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'),
    'application/json; charset=utf-8',
    headOnly,
    apiCsp(),
  );
}

function send(
  response: ServerResponse,
  status: number,
  bytes: Buffer,
  contentType: string,
  headOnly: boolean,
  contentSecurityPolicy: string,
): void {
  setSecurityHeaders(response, contentSecurityPolicy);
  response.statusCode = status;
  response.setHeader('Content-Type', contentType);
  response.setHeader('Content-Length', String(bytes.byteLength));
  response.end(headOnly ? undefined : bytes);
}

function setSecurityHeaders(response: ServerResponse, contentSecurityPolicy: string): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', contentSecurityPolicy);
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(), payment=(), usb=()');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
}

function dashboardCsp(nonce: string): string {
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "img-src data:",
    "manifest-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "worker-src 'none'",
  ].join('; ');
}

function apiCsp(): string {
  return "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox";
}

function artifactCsp(): string {
  return "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox";
}

async function listen(server: Server, host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}
