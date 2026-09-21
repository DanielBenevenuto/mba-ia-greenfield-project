import storageConfig from '../config/storage.config';

/**
 * Presigned URLs handed to clients are signed against `S3_PUBLIC_ENDPOINT`,
 * which in a real deployment is a hostname reachable from outside the Compose
 * network (e.g. `localhost:9000`). Tests run *inside* the `nestjs-api`
 * container, where that hostname does not resolve, so they rewrite the origin
 * back to the internal endpoint before issuing the request.
 *
 * SigV4 signs the Host header, so this rewrite only works when the two
 * endpoints share a host — which is the default in this project's `.env`
 * (both point at `http://minio:9000`). When they genuinely differ, the
 * presigned URL cannot be exercised from inside the container and the test
 * asserts the URL's shape instead of dereferencing it.
 */
export function isPublicEndpointReachableFromTests(): boolean {
  const config = storageConfig();
  return config.publicEndpoint === config.endpoint;
}

export function toInternalUrl(url: string): string {
  const config = storageConfig();
  if (config.publicEndpoint === config.endpoint) return url;
  return url.replace(config.publicEndpoint, config.endpoint);
}

/** Uploads one multipart part and returns its ETag. */
export async function putPart(url: string, body: Buffer): Promise<string> {
  const response = await fetch(toInternalUrl(url), {
    method: 'PUT',
    body: new Uint8Array(body),
  });

  if (!response.ok) {
    throw new Error(
      `Part upload failed: ${response.status} ${await response.text()}`,
    );
  }

  const etag = response.headers.get('etag');
  if (!etag) throw new Error('Part upload returned no ETag');
  return etag;
}
