import { PrismaClient } from '@prisma/client';
import { loadConfig } from './config';
import { createLogger } from './logger';
import { startMonitorWorker } from './queue/monitor-worker';

const log = createLogger('worker');
const config = loadConfig();
const prisma = new PrismaClient();
const worker = startMonitorWorker(prisma, config, log);
log.info({ concurrency: config.worker.concurrency, tickMs: config.worker.schedulerTickMs }, 'worker started');

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'shutting down, waiting for running checks');
  await worker.close();
  await prisma.$disconnect();
  log.info('worker stopped cleanly');
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
