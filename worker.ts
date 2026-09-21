import handler from 'vinext/server/fetch-handler';
import { cleanupVerificationFiles } from './lib/verification-retention';
import type { PrivateEnvironment } from './lib/private-verification';

const worker = {
  fetch: handler.fetch,
  async scheduled(_event: ScheduledController, env: PrivateEnvironment, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      // Bounded batches. Any backlog remains durable for the next daily run.
      for (let i = 0; i < 20; i++) {
        const result = await cleanupVerificationFiles(env);
        if (result.scanned < 100) break;
      }
    })());
  },
};
export default worker;
