import queueConfig from './queue.config';

describe('queueConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should map every environment variable to the typed shape', () => {
    process.env.REDIS_HOST = 'redis';
    process.env.REDIS_PORT = '6380';
    process.env.VIDEO_PROCESSING_ATTEMPTS = '5';
    process.env.VIDEO_PROCESSING_BACKOFF_MS = '1000';

    expect(queueConfig()).toEqual({
      host: 'redis',
      port: 6380,
      videoProcessingAttempts: 5,
      videoProcessingBackoffMs: 1000,
    });
  });

  it('should default the host to the Compose service name', () => {
    delete process.env.REDIS_HOST;
    delete process.env.REDIS_PORT;

    const config = queueConfig();

    expect(config.host).toBe('redis');
    expect(config.port).toBe(6379);
  });

  it('should coerce numeric variables to numbers, not strings', () => {
    process.env.VIDEO_PROCESSING_ATTEMPTS = '3';

    const config = queueConfig();

    expect(typeof config.port).toBe('number');
    expect(typeof config.videoProcessingAttempts).toBe('number');
    expect(config.videoProcessingAttempts).toBe(3);
  });

  it('should apply the retry defaults when not configured', () => {
    delete process.env.VIDEO_PROCESSING_ATTEMPTS;
    delete process.env.VIDEO_PROCESSING_BACKOFF_MS;

    const config = queueConfig();

    expect(config.videoProcessingAttempts).toBe(3);
    expect(config.videoProcessingBackoffMs).toBe(5000);
  });
});
