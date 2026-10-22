/** Run the trade tracker on its own (API + outcome polling), e.g. as a separate container. */
import 'dotenv/config';
import express from 'express';
import { startTracker } from './service.js';
import { createTrackerRouter } from './router.js';

const port = Number(process.env.TRACKER_PORT || 3101);
const host = process.env.HOST || '127.0.0.1';
const handle = await startTracker();
const app = express();
app.use(createTrackerRouter(handle.pool));
const server = app.listen(port, host, () => console.log(`[tracker] API on http://${host}:${port}`));
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    server.close();
    await handle.stop();
    process.exit(0);
  });
}
