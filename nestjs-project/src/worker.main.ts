import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

/**
 * Entrypoint of the `video-worker` container. `createApplicationContext` boots
 * the DI container without an HTTP server — the process exists only to consume
 * the video-processing queue.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();

  const logger = new Logger('VideoWorker');
  logger.log('Video worker started; consuming the video-processing queue');

  const shutdown = async (signal: string): Promise<void> => {
    logger.log(`Received ${signal}, shutting down`);
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void bootstrap();
