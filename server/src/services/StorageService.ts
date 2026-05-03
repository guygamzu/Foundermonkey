import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  PutBucketCorsCommand,
  GetBucketCorsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { logger } from '../config/logger.js';

export class StorageService {
  private s3: S3Client;
  private bucket: string;

  constructor() {
    this.s3 = new S3Client({
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
    });
    this.bucket = process.env.S3_BUCKET || 'lapen-documents';
  }

  async ensureBucketCors(): Promise<void> {
    try {
      await this.s3.send(new GetBucketCorsCommand({ Bucket: this.bucket }));
      logger.info('S3 bucket CORS already configured');
    } catch {
      try {
        await this.s3.send(new PutBucketCorsCommand({
          Bucket: this.bucket,
          CORSConfiguration: {
            CORSRules: [{
              AllowedOrigins: ['*'],
              AllowedMethods: ['GET', 'HEAD'],
              AllowedHeaders: ['*'],
              MaxAgeSeconds: 3600,
            }],
          },
        }));
        logger.info('S3 bucket CORS configured successfully');
      } catch (err) {
        logger.warn({ err }, 'Could not set S3 bucket CORS — pre-signed URLs may fail in browser');
      }
    }
  }

  async uploadDocument(key: string, content: Buffer, contentType: string): Promise<string> {
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: content,
      ContentType: contentType,
      ServerSideEncryption: 'AES256',
    }));
    logger.info({ key }, 'Document uploaded to S3');
    return key;
  }

  async getDocument(key: string): Promise<Buffer> {
    let response;
    try {
      response = await this.s3.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }));
    } catch (err: any) {
      const code = err?.name || err?.Code;
      if (code === 'NoSuchKey' || code === 'NotFound' || err?.$metadata?.httpStatusCode === 404) {
        throw new Error('Document file not available');
      }
      throw err;
    }
    const stream = response.Body;
    if (!stream) throw new Error('Empty response from S3');

    const chunks: Uint8Array[] = [];
    for await (const chunk of stream as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async getSignedDownloadUrl(key: string, expiresIn = 3600): Promise<string> {
    const url = await getSignedUrl(this.s3, new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    }), { expiresIn });
    return url;
  }

  async deleteDocument(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    }));
    logger.info({ key }, 'Document deleted from S3');
  }

  generateKey(userId: string, documentId: string, filename: string): string {
    return `documents/${userId}/${documentId}/${filename}`;
  }

  generateSignedKey(documentId: string, filename: string): string {
    return `signed/${documentId}/${filename}`;
  }

  generateCertificateKey(documentId: string): string {
    return `certificates/${documentId}/certificate-of-completion.pdf`;
  }
}
