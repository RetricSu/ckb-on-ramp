import cors from 'cors';
import express from 'express';
import { config } from './config.js';
import apiRouter from './routes/api.js';

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: '16kb' }));
app.use('/api', apiRouter);
app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof SyntaxError && (error as { type?: unknown }).type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Request body must be valid JSON' });
    return;
  }
  console.error(error);
  res.status(502).json({ error: error instanceof Error ? error.message : 'Upstream request failed' });
});
const server = app.listen(config.port, () => console.log(`CKB On-ramp API listening on http://localhost:${config.port} (${config.mode})`));
const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
