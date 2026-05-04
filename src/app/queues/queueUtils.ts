import { bookingQueue, cleanupQueue } from './index';
import { logger } from '../../shared/logger';
 
/**
 * Schedules an auto-settlement job for a booking to run after 48 hours.
 */
export const scheduleAutoSettlement = async (bookingId: string) => {
  const delay = 48 * 60 * 60 * 1000;
  const jobId = `settle-${bookingId}`;
  try {
    await bookingQueue.add('settle-booking', { bookingId }, { delay, jobId });
    logger.info(`📅 Scheduled auto-settlement for booking ${bookingId} in 48 hours.`);
  } catch (error) {
    logger.error(`Failed to schedule auto-settlement for ${bookingId}:`, error);
  }
};
 
export const cancelScheduledSettlement = async (bookingId: string) => {
  const jobId = `settle-${bookingId}`;
  try {
    const job = await bookingQueue.getJob(jobId);
    if (job) await job.remove();
  } catch (error) {
    logger.error(`Failed to cancel auto-settlement for ${bookingId}:`, error);
  }
};

/**
 * Schedules cleanup for an unverified user account after 5 minutes.
 */
export const scheduleUnverifiedCleanup = async (userId: string) => {
  const delay = 5 * 60 * 1000; // 5 minutes
  const jobId = `cleanup-user-${userId}`;
  try {
    await cleanupQueue.add('unverified-account-cleanup', { userId }, { delay, jobId });
    logger.info(`📅 Scheduled cleanup for unverified user ${userId} in 5 minutes.`);
  } catch (error) {
    logger.error(`Failed to schedule cleanup for user ${userId}:`, error);
  }
};

export const cancelUnverifiedCleanup = async (userId: string) => {
  const jobId = `cleanup-user-${userId}`;
  try {
    const job = await cleanupQueue.getJob(jobId);
    if (job) await job.remove();
  } catch (error) {
    logger.error(`Failed to cancel cleanup for user ${userId}:`, error);
  }
};

/**
 * Schedules cleanup for a stale 'CREATED' booking after 1 hour.
 */
export const scheduleBookingCleanup = async (bookingId: string) => {
  const delay = 60 * 60 * 1000; // 1 hour
  const jobId = `cleanup-booking-${bookingId}`;
  try {
    await cleanupQueue.add('booking-cleanup', { bookingId }, { delay, jobId });
    logger.info(`📅 Scheduled cleanup for stale booking ${bookingId} in 1 hour.`);
  } catch (error) {
    logger.error(`Failed to schedule cleanup for booking ${bookingId}:`, error);
  }
};

export const cancelBookingCleanup = async (bookingId: string) => {
  const jobId = `cleanup-booking-${bookingId}`;
  try {
    const job = await cleanupQueue.getJob(jobId);
    if (job) await job.remove();
  } catch (error) {
    logger.error(`Failed to cancel cleanup for booking ${bookingId}:`, error);
  }
};
