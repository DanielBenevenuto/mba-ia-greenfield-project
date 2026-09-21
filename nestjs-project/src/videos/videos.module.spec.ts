import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import appConfig from '../config/app.config';
import authConfig from '../config/auth.config';
import mailConfig from '../config/mail.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { createTestDataSource } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosModule', () => {
  it('should compile with its queue, storage, channels and auth wiring', async () => {
    const module = await Test.createTestingModule({
      imports: [
        // Global by necessity: VideosModule's import graph reaches AuthModule
        // (OptionalJwtAuthGuard) and therefore MailModule, and every one of
        // those uses `forRootAsync` + `ConfigType`, whose factory context does
        // not inherit non-global providers.
        ConfigModule.forRoot({
          isGlobal: true,
          load: [appConfig, authConfig, mailConfig, queueConfig, storageConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();

    expect(module.get(VideosService)).toBeInstanceOf(VideosService);

    await module.close();
  }, 30000);
});
