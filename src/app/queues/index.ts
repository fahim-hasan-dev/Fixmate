import { Queue } from 'bullmq';
import { redisConnection } from '../../helpers/redis';
import { logger } from '../../shared/logger';

// Default queue options
export const defaultQueueOptions = {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: true,
    removeOnFail: false,
  },
};

// Define Queue Names
export const QUEUE_NAMES = {
  BOOKING: 'booking-queue',
  NOTIFICATION: 'notification-queue',
  CLEANUP: 'cleanup-queue',
};

// Initialize Queues
export const bookingQueue = new Queue(QUEUE_NAMES.BOOKING, defaultQueueOptions);
export const notificationQueue = new Queue(QUEUE_NAMES.NOTIFICATION, defaultQueueOptions);
export const cleanupQueue = new Queue(QUEUE_NAMES.CLEANUP, defaultQueueOptions);

logger.info('🛠️  BullMQ Queues initialized');
