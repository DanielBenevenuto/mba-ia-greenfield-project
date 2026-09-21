import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  /** Endpoint used for server-to-server calls — the Compose service name. */
  endpoint: process.env.S3_ENDPOINT || 'http://minio:9000',
  /**
   * Endpoint used only to sign URLs handed to clients. SigV4 signs the Host
   * header, so a URL signed with the internal endpoint is only valid for a
   * request whose Host is the internal one — clients outside the Compose
   * network need URLs signed against this endpoint instead.
   */
  publicEndpoint:
    process.env.S3_PUBLIC_ENDPOINT ||
    process.env.S3_ENDPOINT ||
    'http://minio:9000',
  region: process.env.S3_REGION || 'us-east-1',
  accessKeyId: process.env.S3_ACCESS_KEY_ID || 'streamtube',
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || 'streamtube',
  bucket: process.env.S3_BUCKET || 'streamtube',
  /** MinIO serves path-style buckets; real S3 uses virtual-host style. */
  forcePathStyle: (process.env.S3_FORCE_PATH_STYLE || 'true') === 'true',
  /** Part size for multipart uploads. S3 requires 5 MiB <= part <= 5 GiB. */
  uploadPartSizeBytes: parseInt(
    process.env.UPLOAD_PART_SIZE_BYTES || '67108864',
    10,
  ),
  uploadUrlExpirationSeconds: parseInt(
    process.env.UPLOAD_URL_EXPIRATION_SECONDS || '3600',
    10,
  ),
  downloadUrlExpirationSeconds: parseInt(
    process.env.DOWNLOAD_URL_EXPIRATION_SECONDS || '300',
    10,
  ),
}));
