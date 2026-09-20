import { randomUUID } from 'node:crypto';
import storageConfig from '../../config/storage.config';
import { StorageService } from '../../storage/storage.service';
import { createVideoFixture } from '../../test/video-fixture';
import {
  VideoMetadataExtractor,
  VideoProcessingError,
} from './video-metadata.extractor';

/**
 * Real ffprobe/ffmpeg over a real presigned URL served by the Compose MinIO.
 * This is the closest thing to what the worker does in production; mocking the
 * toolchain here would hide exactly the failures this SI exists to prevent.
 */
describe('VideoMetadataExtractor (integration)', () => {
  let extractor: VideoMetadataExtractor;
  let storage: StorageService;
  let sourceUrl: string;
  let fixture: Awaited<ReturnType<typeof createVideoFixture>>;

  beforeAll(async () => {
    extractor = new VideoMetadataExtractor();
    storage = new StorageService(storageConfig());

    fixture = await createVideoFixture(3, 320, 240);

    const key = `videos/${randomUUID()}/source/fixture.mp4`;
    await storage.putObject(key, fixture.buffer, 'video/mp4');
    sourceUrl = await storage.presignReadUrl(key, 600);
  }, 120000);

  describe('probe', () => {
    it('should read the duration from a presigned URL without downloading the file', async () => {
      const result = await extractor.probe(sourceUrl);

      expect(result.durationSeconds).not.toBeNull();
      expect(result.durationSeconds!).toBeGreaterThan(2.9);
      expect(result.durationSeconds!).toBeLessThan(3.2);
    }, 60000);

    it('should read resolution and codec from the video stream', async () => {
      const result = await extractor.probe(sourceUrl);

      expect(result.metadata.width).toBe(fixture.width);
      expect(result.metadata.height).toBe(fixture.height);
      expect(result.metadata.video_codec).toBe('h264');
      expect(result.metadata.format_name).toContain('mp4');
      expect(result.metadata.bitrate).toBeGreaterThan(0);
    }, 60000);

    it('should report no audio codec for a video-only file', async () => {
      const result = await extractor.probe(sourceUrl);

      expect(result.metadata.audio_codec).toBeNull();
    }, 60000);

    it('should fail with the tool output when the input cannot be read', async () => {
      const missing = await storage.presignReadUrl(
        `videos/${randomUUID()}/source/does-not-exist.mp4`,
        600,
      );

      await expect(extractor.probe(missing)).rejects.toBeInstanceOf(
        VideoProcessingError,
      );
      await expect(extractor.probe(missing)).rejects.toThrow(/ffprobe failed/);
    }, 60000);

    it('should reject a file that carries no video stream', async () => {
      const key = `videos/${randomUUID()}/source/not-a-video.mp4`;
      await storage.putObject(
        key,
        Buffer.from('this is not a video'),
        'video/mp4',
      );
      const url = await storage.presignReadUrl(key, 600);

      await expect(extractor.probe(url)).rejects.toBeInstanceOf(
        VideoProcessingError,
      );
    }, 60000);
  });

  describe('extractThumbnail', () => {
    it('should return a JPEG buffer captured from the requested frame', async () => {
      const buffer = await extractor.extractThumbnail(sourceUrl, 1);

      expect(buffer.length).toBeGreaterThan(0);
      // JPEG SOI marker.
      expect(buffer[0]).toBe(0xff);
      expect(buffer[1]).toBe(0xd8);
      // JPEG EOI marker.
      expect(buffer[buffer.length - 2]).toBe(0xff);
      expect(buffer[buffer.length - 1]).toBe(0xd9);
    }, 60000);

    it('should fall back to the first frame when the offset is past the end', async () => {
      const buffer = await extractor.extractThumbnail(sourceUrl, 9999);

      expect(buffer.length).toBeGreaterThan(0);
      expect(buffer[0]).toBe(0xff);
      expect(buffer[1]).toBe(0xd8);
    }, 60000);

    it('should fail with the tool output when the input cannot be read', async () => {
      const missing = await storage.presignReadUrl(
        `videos/${randomUUID()}/source/nope.mp4`,
        600,
      );

      await expect(
        extractor.extractThumbnail(missing, 1),
      ).rejects.toBeInstanceOf(VideoProcessingError);
    }, 60000);
  });
});
