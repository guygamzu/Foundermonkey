import { Request, Response, NextFunction } from 'express';
import { logger } from '../config/logger.js';

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  logger.error({ err, path: req.path, method: req.method }, 'Unhandled error');

  if (err.message === 'Insufficient credits') {
    res.status(402).json({ error: 'Insufficient credits', message: err.message });
    return;
  }

  if (err.message.includes('not found') || err.message.includes('Not found')) {
    res.status(404).json({ error: 'Not found', message: err.message });
    return;
  }

  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'production' ? 'Something went wrong' : err.message,
  });
}
