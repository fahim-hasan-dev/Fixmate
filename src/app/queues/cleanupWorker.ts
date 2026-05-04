import { Worker, Job } from 'bullmq';
import { redisConnection } from '../../helpers/redis';
import { QUEUE_NAMES } from './index';
import { Booking } from '../modules/booking/booking.model';
import { User } from '../modules/user/user.model';
import { BOOKING_STATUS } from '../../enum/booking';
import { logger } from '../../shared/logger';


export const cleanupWorker = new Worker(
  QUEUE_NAMES.CLEANUP,
  async (job: Job) => {
    if (job.name === 'booking-cleanup') {
      const { bookingId } = job.data;
      
      const result = await Booking.deleteOne({
        _id: bookingId,
        bookingStatus: BOOKING_STATUS.CREATED,
      });

      if (result.deletedCount > 0) {
        logger.info(`Cleanup Job: Deleted stale 'CREATED' booking: ${bookingId}`);
      }
      return { deletedCount: result.deletedCount };
    }

    if (job.name === 'unverified-account-cleanup') {
      const { userId } = job.data;

      const result = await User.deleteOne({
        _id: userId,
        verified: false,
      });

      if (result.deletedCount > 0) {
        logger.info(`Cleanup Job: Deleted unverified account: ${userId}`);
      }
      return { deletedCount: result.deletedCount };
    }
  },
  { connection: redisConnection }
);

cleanupWorker.on('failed', (job, err) => {
  logger.error(`❌ Cleanup Job ${job?.id} failed: ${err.message}`);
});
