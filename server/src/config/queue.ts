import Bull from 'bull';

const queues: Map<string, Bull.Queue> = new Map();

export function getQueue(name: string): Bull.Queue {
  if (!queues.has(name)) {
    const queue = new Bull(name, process.env.REDIS_URL || 'redis://localhost:6379', {
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 500,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      },
    });
    queues.set(name, queue);
  }
  return queues.get(name)!;
}

// Queue names
export const QUEUE_NAMES = {
  EMAIL_PROCESSING: 'email-processing',
  DOCUMENT_ANALYSIS: 'document-analysis',
  NOTIFICATION: 'notification',
  DOCUMENT_COMPLETION: 'document-completion',
  CERTIFICATE_GENERATION: 'certificate-generation',
} as const;
