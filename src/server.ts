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
  const server = createServer(async (req, res) => {
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
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    server.close(() => { closeNativeBackend().finally(() => process.exit(0)); });
  });
});
