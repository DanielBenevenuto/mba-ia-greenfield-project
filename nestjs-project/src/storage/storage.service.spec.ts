import {
  buildSourceKey,
  buildThumbnailKey,
  sanitizeFilename,
} from './storage.service';

describe('storage key helpers', () => {
  describe('buildSourceKey', () => {
    it('should place the source under videos/{videoId}/source/', () => {
      expect(buildSourceKey('abc-123', 'holiday.mp4')).toBe(
        'videos/abc-123/source/holiday.mp4',
      );
    });

    it('should keep every asset of one video under the same prefix', () => {
      const videoId = 'abc-123';

      expect(
        buildSourceKey(videoId, 'a.mp4').startsWith(`videos/${videoId}/`),
      ).toBe(true);
      expect(buildThumbnailKey(videoId)).toBe(
        `thumbnails/${videoId}/poster.jpg`,
      );
    });
  });

  describe('sanitizeFilename', () => {
    it('should strip directory components to prevent path traversal', () => {
      expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
      expect(sanitizeFilename('C:\\videos\\clip.mp4')).toBe('clip.mp4');
    });

    it('should replace characters outside the safe set', () => {
      expect(sanitizeFilename('my video (final).mp4')).toBe(
        'my_video__final_.mp4',
      );
    });

    it('should preserve dots, dashes and underscores', () => {
      expect(sanitizeFilename('my-video_v2.final.mp4')).toBe(
        'my-video_v2.final.mp4',
      );
    });

    it('should fall back to a default name when nothing survives', () => {
      expect(sanitizeFilename('...')).toBe('video');
      expect(sanitizeFilename('')).toBe('video');
    });

    it('should cap the length so the key stays within the column limit', () => {
      expect(sanitizeFilename(`${'a'.repeat(400)}.mp4`)).toHaveLength(200);
    });
  });
});
