/**
 * Entry point of the local proxy backend.
 *
 * Start it with `npm start` (production build) or `npm run dev:server`
 * (development). The backend binds to loopback by default; set
 * KAGGLE_KIT_HOST to expose it on another interface.
 */

import { createApp } from './app';
import { loadServerConfig } from './config';

const config = loadServerConfig();
const app = createApp({ config });

app.server.listen(config.port, config.host, () => {
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  app.logger.info(`Kaggle-Kit proxy listening on http://${config.host}:${port}`);
  app.logger.info('Browser client: http://' + `${config.host}:${port}`);
  if (config.allowedHosts) {
    app.logger.info('Upstream host allow list: ' + config.allowedHosts.join(', '));
  } else {
    app.logger.warn(
      'No upstream host allow list is configured. Set KAGGLE_KIT_ALLOWED_HOSTS to restrict which hosts this proxy may reach.',
    );
  }
});

function shutdown(signal: string): void {
  app.logger.info(`Received ${signal}, shutting down.`);
  app.server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
