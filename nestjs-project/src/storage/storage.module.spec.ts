import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

describe('StorageModule', () => {
  it('should compile and expose a configured StorageService', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    const service = module.get(StorageService);

    expect(service).toBeInstanceOf(StorageService);
    expect(service.bucket).toBe(storageConfig().bucket);
    expect(service.partSizeBytes).toBe(storageConfig().uploadPartSizeBytes);

    await module.close();
  }, 30000);
});
