import { Test } from '@nestjs/testing';
import { VideoMetadataExtractor } from './videos/processing/video-metadata.extractor';
import { VideoProcessor } from './videos/processing/video.processor';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('should compile and expose the video processor', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(module.get(VideoProcessor)).toBeInstanceOf(VideoProcessor);
    expect(module.get(VideoMetadataExtractor)).toBeInstanceOf(
      VideoMetadataExtractor,
    );

    await module.close();
  }, 60000);
});
