import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ObjectStorageError, type ObjectStorage, type PutOptions } from './object-storage';

export interface S3Settings {
  readonly endpoint: string;
  readonly region: string;
  readonly forcePathStyle: boolean;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Milliseconds a storage call may take; calls are made from workers, never inside a business transaction. */
  readonly timeoutMs: number;
}

/**
 * The one storage adapter (ADR-0032): the AWS SDK against any S3-compatible service. Development and CI run it
 * against Versity Gateway; production uses the provider chosen at provisioning (A-067).
 */
export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;

  constructor(settings: S3Settings) {
    this.client = new S3Client({
      endpoint: settings.endpoint,
      region: settings.region,
      forcePathStyle: settings.forcePathStyle,
      credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
      requestHandler: { requestTimeout: settings.timeoutMs, connectionTimeout: settings.timeoutMs },
      maxAttempts: 3,
    });
  }

  async put(bucket: string, key: string, body: Buffer, options: PutOptions): Promise<void> {
    const input: PutObjectCommandInput = { Bucket: bucket, Key: key, Body: body, ContentType: options.contentType };
    if (options.retainUntil !== undefined) {
      input.ObjectLockMode = 'COMPLIANCE';
      input.ObjectLockRetainUntilDate = options.retainUntil;
    }
    await this.call(`put ${bucket}`, () => this.client.send(new PutObjectCommand(input)));
  }

  async get(bucket: string, key: string): Promise<Buffer> {
    const output = await this.call(`get ${bucket}`, () => this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key })));
    if (output.Body === undefined) {
      throw new ObjectStorageError(`get ${bucket}: empty body`);
    }
    return Buffer.from(await output.Body.transformToByteArray());
  }

  signedGetUrl(bucket: string, key: string, ttlSeconds: number): Promise<string> {
    return this.call(`sign ${bucket}`, () => getSignedUrl(this.client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: ttlSeconds }));
  }

  async ensureBucket(bucket: string, options: { readonly objectLock: boolean }): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: bucket }));
      return;
    } catch {
      // Missing: create it below.
    }
    await this.call(`create ${bucket}`, () =>
      this.client.send(new CreateBucketCommand({ Bucket: bucket, ...(options.objectLock ? { ObjectLockEnabledForBucket: true } : {}) })),
    );
  }

  close(): void {
    this.client.destroy();
  }

  private async call<T>(what: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error';
      throw new ObjectStorageError(`object storage ${what} failed: ${name}`, { cause: error });
    }
  }
}
