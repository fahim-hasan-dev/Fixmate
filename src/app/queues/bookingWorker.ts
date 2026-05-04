import { Worker, Job } from 'bullmq';
import { redisConnection } from '../../helpers/redis';
import { QUEUE_NAMES } from './index';
import { Booking } from '../modules/booking/booking.model';
import { BOOKING_STATUS } from '../../enum/booking';
import { BookingStateMachine } from '../modules/booking/bookingStateMachine';
import { Payment } from '../modules/payment/payment.model';
import { logger } from '../../shared/logger';


export const bookingWorker = new Worker(
  QUEUE_NAMES.BOOKING,
  async (job: Job) => {

    if (job.name === 'settle-booking') {
      const { bookingId } = job.data;
      
      const booking = await Booking.findById(bookingId).populate('service').lean();
      if (!booking) {
        logger.warn(`Auto-Settle: Booking ${bookingId} no longer exists. Skipping.`);
        return;
      }

      // Final check: Only settle if it's still COMPLETED_BY_PROVIDER
      if (booking.bookingStatus !== BOOKING_STATUS.COMPLETED_BY_PROVIDER) {
        logger.info(`Auto-Settle: Booking ${bookingId} status is ${booking.bookingStatus}. Skipping auto-settle.`);
        return;
      }

      const payment = await Payment.findOne({ booking: bookingId }).lean();
      if (!payment) {
        logger.error(`Auto-Settle: Payment record not found for booking ${bookingId}`);
        return;
      }

      await BookingStateMachine.transitionState(
        bookingId,
        'system',
        BOOKING_STATUS.CONFIRMED_BY_CLIENT,
      );
      await BookingStateMachine.transitionState(
        bookingId,
        'system',
        BOOKING_STATUS.AUTO_SETTLED,
      );

      logger.info(`✅ Successfully auto-settled booking: ${bookingId}`);
    }
  },
  { connection: redisConnection }
);

bookingWorker.on('completed', (job) => {
  if (job.name === 'settle-booking') {
    logger.info(`Job ${job.id} completed successfully`);
  }
});

bookingWorker.on('failed', (job, err) => {
  logger.error(`❌ Job ${job?.id} failed: ${err.message}`);
});
