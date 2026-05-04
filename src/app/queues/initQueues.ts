import { bookingWorker } from './bookingWorker';
import { cleanupWorker } from './cleanupWorker';
import { notificationWorker } from './notificationWorker';
import { logger } from '../../shared/logger';

export const initQueues = async () => {
  try {
    // Initialize Workers (they start automatically on instantiation)
    const workers = [bookingWorker, cleanupWorker, notificationWorker];
    logger.info(`🚀 Registered ${workers.length} BullMQ Workers`);
  } catch (error) {
    logger.error('Error initializing BullMQ:', error);
  }
};
