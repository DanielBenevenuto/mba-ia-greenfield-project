import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from './channels/entities/channel.entity';
import { User } from './users/entities/user.entity';
import databaseConfig from './config/database.config';
import queueConfig from './config/queue.config';
import storageConfig from './config/storage.config';
import { envValidationSchema } from './config/env.validation';
import { StorageModule } from './storage/storage.module';
import { Video } from './videos/entities/video.entity';
import { VideoMetadataExtractor } from './videos/processing/video-metadata.extractor';
import { VideoProcessor } from './videos/processing/video.processor';
import { VIDEO_PROCESSING_QUEUE } from './videos/video.constants';

/**
 * Root module of the `video-worker` process. Deliberately narrow: config,
 * database, storage and the processor — no controllers, no HTTP server, no
 * auth. It shares entities and services with the API instead of duplicating
 * them, which is the whole point of running a second process from the same
 * codebase rather than a separate project.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, queueConfig, storageConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres' as const,
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    // `autoLoadEntities` only picks up what `forFeature` registers, and TypeORM
    // needs metadata for the whole relation closure of Video:
    // Video -> Channel -> User (which points back at Channel). The auth token
    // entities are unreachable from that closure, so the worker does not load
    // them.
    TypeOrmModule.forFeature([Video, Channel, User]),
    StorageModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [queueConfig.KEY],
      useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
        connection: { host: cfg.host, port: cfg.port },
      }),
    }),
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
  ],
  providers: [VideoProcessor, VideoMetadataExtractor],
})
export class WorkerModule {}
