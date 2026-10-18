import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { nativeHttpRequest, closeNativeBackend } from './lib/native-backend.server';

const dev = process.env.COZE_PROJECT_ENV !== 'PROD';
const hostname = process.env.HOSTNAME || 'localhost';
const port = parseInt(process.env.PORT || '5000', 10);

// Create Next.js app
const app = next({ dev, hostname, port, webpack: true });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  let stopping = false;
  const server = createServer(async (req, res) => {
    if (stopping) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
      res.end('Service is stopping');
      return;
    }
    try {
      const pathname = new URL(req.url || '/', 'http://localhost').pathname;
      if (pathname === '/health' || pathname === '/v1' || pathname.startsWith('/v1/')) {
        await nativeHttpRequest(req, res);
        return;
      }
      const parsedUrl = parse(req.url!, true);
      await handle(req, res, parsedUrl);
    } catch {
      // URLs, bodies and upstream error objects can contain account data.
      console.error('Request handling failed');
      res.statusCode = 500;
      res.end('Internal server error');
    }
  });
  server.once('error', err => {
    console.error('HTTP server failed', 'code' in err && typeof err.code === 'string' ? err.code : 'UNKNOWN');
    process.exit(1);
  });
  server.listen(port, () => {
    console.log(
      `> Server listening at http://${hostname}:${port} as ${
        dev ? 'development' : process.env.COZE_PROJECT_ENV
      }`,
    );
  });
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    // Stop accepting requests, allow bounded time for real work to finish, then
    // close the backend/database. A lingering connection cannot block exit forever.
    const drainDeadline = setTimeout(() => server.closeAllConnections(), 30_000);
    drainDeadline.unref();
    const exitDeadline = setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 45_000);
    exitDeadline.unref();
    const finish = (code: number) => {
      clearTimeout(drainDeadline); clearTimeout(exitDeadline); process.exit(code);
    };
    server.close(error => {
      clearTimeout(drainDeadline);
      void closeNativeBackend().then(() => finish(error ? 1 : 0), () => finish(1));
    });
    server.closeIdleConnections();
  };
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, shutdown);
});
