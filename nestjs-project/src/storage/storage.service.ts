import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';

export interface UploadPartUrl {
  part_number: number;
  url: string;
}

export interface CompletedPart {
  part_number: number;
  etag: string;
}

export interface ObjectRangeResult {
  body: Readable;
  contentLength: number;
  contentType: string;
  /** Only present when the request carried a Range header. */
  contentRange?: string;
}

export interface ObjectHead {
  contentLength: number;
  contentType: string;
}

/** Keeps the object key printable and free of path traversal. */
export function sanitizeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? 'video';
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return cleaned.slice(0, 200) || 'video';
}

export function buildSourceKey(videoId: string, filename: string): string {
  return `videos/${videoId}/source/${sanitizeFilename(filename)}`;
}

export function buildThumbnailKey(videoId: string): string {
  return `thumbnails/${videoId}/poster.jpg`;
}

@Injectable()
export class StorageService {
  /** Used for every server-to-server call (Compose-internal hostname). */
  private readonly client: S3Client;
  /**
   * Used only to sign URLs handed to callers outside the Compose network.
   * SigV4 signs the Host header, so a URL signed by `client` would be rejected
   * when the caller resolves a different host.
   */
  private readonly publicClient: S3Client;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.client = this.createClient(config.endpoint);
    this.publicClient =
      config.publicEndpoint === config.endpoint
        ? this.client
        : this.createClient(config.publicEndpoint);
  }

  private createClient(endpoint: string): S3Client {
    return new S3Client({
      endpoint,
      region: this.config.region,
      forcePathStyle: this.config.forcePathStyle,
      credentials: {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
      },
    });
  }

  get bucket(): string {
    return this.config.bucket;
  }

  get partSizeBytes(): number {
    return this.config.uploadPartSizeBytes;
  }

  get uploadUrlExpirationSeconds(): number {
    return this.config.uploadUrlExpirationSeconds;
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const result = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );

    if (!result.UploadId) {
      throw new Error(`Storage did not return an UploadId for key ${key}`);
    }
    return result.UploadId;
  }

  /** One presigned PUT per part — the client uploads them directly. */
  async presignUploadPartUrls(
    key: string,
    uploadId: string,
    totalParts: number,
  ): Promise<UploadPartUrl[]> {
    const urls = await Promise.all(
      Array.from({ length: totalParts }, (_, index) => index + 1).map(
        async (partNumber) => ({
          part_number: partNumber,
          url: await getSignedUrl(
            this.publicClient,
            new UploadPartCommand({
              Bucket: this.bucket,
              Key: key,
              UploadId: uploadId,
              PartNumber: partNumber,
            }),
            { expiresIn: this.config.uploadUrlExpirationSeconds },
          ),
        }),
      ),
    );

    return urls;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [...parts]
            .sort((a, b) => a.part_number - b.part_number)
            .map((part) => ({
              PartNumber: part.part_number,
              ETag: part.etag,
            })),
        },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  async headObject(key: string): Promise<ObjectHead> {
    const result = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
    );

    return {
      contentLength: result.ContentLength ?? 0,
      contentType: result.ContentType ?? 'application/octet-stream',
    };
  }

  /**
   * Streams an object, optionally restricted to a byte range. The body is piped
   * straight to the HTTP response — nothing is buffered, so memory stays flat
   * regardless of the object size.
   */
  async getObjectRange(
    key: string,
    range?: string,
  ): Promise<ObjectRangeResult> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: range }),
    );

    return {
      body: result.Body as Readable,
      contentLength: result.ContentLength ?? 0,
      contentType: result.ContentType ?? 'application/octet-stream',
      contentRange: result.ContentRange,
    };
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  /**
   * Read URL for consumers **inside** the Compose network — notably ffprobe /
   * ffmpeg in the worker, which resolve the internal hostname.
   */
  async presignReadUrl(
    key: string,
    expiresInSeconds?: number,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      {
        expiresIn: expiresInSeconds ?? this.config.downloadUrlExpirationSeconds,
      },
    );
  }

  /** Download URL for external callers, forcing a save-as with the original name. */
  async presignDownloadUrl(
    key: string,
    filename: string,
    contentType: string,
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${sanitizeFilename(filename)}"`,
        ResponseContentType: contentType,
      }),
      { expiresIn: this.config.downloadUrlExpirationSeconds },
    );
  }

  /** Thumbnail URL for external callers (browser <img>). */
  async presignPublicReadUrl(key: string): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: this.config.downloadUrlExpirationSeconds },
    );
  }
}
