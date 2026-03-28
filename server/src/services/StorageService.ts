import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
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
    const response = await this.s3.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    }));
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
