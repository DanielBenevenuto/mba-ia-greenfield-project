import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ACCESS_KEY_ID: 'storage-key',
  S3_SECRET_ACCESS_KEY: 'storage-secret',
  S3_BUCKET: 'streamtube',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage keys', () => {
  it.each(['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_BUCKET'])(
    'should reject a configuration missing %s',
    (key) => {
      const env = { ...requiredEnv } as Record<string, string>;
      delete env[key];
      const { error } = envValidationSchema.validate(env, {
        allowUnknown: true,
        abortEarly: false,
      });
      expect(error).toBeDefined();
      expect(error!.message).toContain(key);
    },
  );

  it('should default the storage endpoints to the Compose service name', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.S3_ENDPOINT).toBe('http://minio:9000');
    expect(value.S3_PUBLIC_ENDPOINT).toBe('http://minio:9000');
  });

  it('should reject an upload part size below the 5 MiB floor imposed by S3', () => {
    const { error } = validate({ UPLOAD_PART_SIZE_BYTES: '1024' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('UPLOAD_PART_SIZE_BYTES');
  });

  it('should reject an upload part size above the 5 GiB ceiling imposed by S3', () => {
    const { error } = validate({
      UPLOAD_PART_SIZE_BYTES: String(6 * 1024 * 1024 * 1024),
    });
    expect(error).toBeDefined();
    expect(error!.message).toContain('UPLOAD_PART_SIZE_BYTES');
  });
});

describe('envValidationSchema — queue keys', () => {
  it('should default the queue host to the Compose service name', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.REDIS_HOST).toBe('redis');
    expect(value.REDIS_PORT).toBe(6379);
  });

  it('should apply retry defaults when not configured', () => {
    const { value } = validate({});
    expect(value.VIDEO_PROCESSING_ATTEMPTS).toBe(3);
    expect(value.VIDEO_PROCESSING_BACKOFF_MS).toBe(5000);
  });

  it('should reject a non-numeric REDIS_PORT', () => {
    const { error } = validate({ REDIS_PORT: 'not-a-port' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('REDIS_PORT');
  });
});
