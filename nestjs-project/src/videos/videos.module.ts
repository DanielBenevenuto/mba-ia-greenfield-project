import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { ChannelsModule } from '../channels/channels.module';
import queueConfig from '../config/queue.config';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from './video.constants';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    // For OptionalJwtAuthGuard on the public playback routes.
    AuthModule,
    ChannelsModule,
    StorageModule,
    ConfigModule.forFeature(queueConfig),
    BullModule.forRootAsync({
      imports: [ConfigModule.forFeature(queueConfig)],
      inject: [queueConfig.KEY],
      useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
        connection: { host: cfg.host, port: cfg.port },
      }),
    }),
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
  ],
  controllers: [VideosController],
  providers: [VideosService],
  exports: [TypeOrmModule, VideosService, BullModule],
})
export class VideosModule {}
