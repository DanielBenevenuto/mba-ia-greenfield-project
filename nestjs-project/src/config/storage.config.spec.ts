import storageConfig from './storage.config';

describe('storageConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should map every environment variable to the typed shape', () => {
    process.env.S3_ENDPOINT = 'http://minio:9000';
    process.env.S3_PUBLIC_ENDPOINT = 'https://cdn.streamtube.test';
    process.env.S3_REGION = 'sa-east-1';
    process.env.S3_ACCESS_KEY_ID = 'key';
    process.env.S3_SECRET_ACCESS_KEY = 'secret';
    process.env.S3_BUCKET = 'bucket';
    process.env.S3_FORCE_PATH_STYLE = 'false';
    process.env.UPLOAD_PART_SIZE_BYTES = '10485760';
    process.env.UPLOAD_URL_EXPIRATION_SECONDS = '900';
    process.env.DOWNLOAD_URL_EXPIRATION_SECONDS = '120';

    const config = storageConfig();

    expect(config).toEqual({
      endpoint: 'http://minio:9000',
      publicEndpoint: 'https://cdn.streamtube.test',
      region: 'sa-east-1',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      bucket: 'bucket',
      forcePathStyle: false,
      uploadPartSizeBytes: 10485760,
      uploadUrlExpirationSeconds: 900,
      downloadUrlExpirationSeconds: 120,
    });
  });

  it('should keep the internal and public endpoints distinct when they differ', () => {
    process.env.S3_ENDPOINT = 'http://minio:9000';
    process.env.S3_PUBLIC_ENDPOINT = 'http://localhost:9000';

    const config = storageConfig();

    expect(config.endpoint).toBe('http://minio:9000');
    expect(config.publicEndpoint).toBe('http://localhost:9000');
  });

  it('should fall back to the internal endpoint when no public endpoint is set', () => {
    process.env.S3_ENDPOINT = 'http://minio:9000';
    delete process.env.S3_PUBLIC_ENDPOINT;

    expect(storageConfig().publicEndpoint).toBe('http://minio:9000');
  });

  it('should coerce numeric variables to numbers, not strings', () => {
    process.env.UPLOAD_PART_SIZE_BYTES = '67108864';

    const config = storageConfig();

    expect(typeof config.uploadPartSizeBytes).toBe('number');
    expect(config.uploadPartSizeBytes).toBe(67108864);
  });

  it('should treat any S3_FORCE_PATH_STYLE value other than "true" as false', () => {
    process.env.S3_FORCE_PATH_STYLE = 'no';
    expect(storageConfig().forcePathStyle).toBe(false);

    process.env.S3_FORCE_PATH_STYLE = 'true';
    expect(storageConfig().forcePathStyle).toBe(true);
  });

  it('should default the endpoints to the Compose service name', () => {
    delete process.env.S3_ENDPOINT;
    delete process.env.S3_PUBLIC_ENDPOINT;

    const config = storageConfig();

    expect(config.endpoint).toBe('http://minio:9000');
    expect(config.publicEndpoint).toBe('http://minio:9000');
  });
});
