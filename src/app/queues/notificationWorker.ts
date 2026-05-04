import { Worker, Job } from 'bullmq';
import { redisConnection } from '../../helpers/redis';
import { QUEUE_NAMES } from './index';
import { PushNotificationService } from '../modules/notification/pushNotification.service';
import { emailHelper } from '../../helpers/emailHelper';
import { logger } from '../../shared/logger';

export const notificationWorker = new Worker(
  QUEUE_NAMES.NOTIFICATION,
  async (job: Job) => {
    if (job.name === 'send-push-notification') {
      const { fcmToken, title, message } = job.data;
      await PushNotificationService.sendPushNotification(fcmToken, title, message);
      return { success: true };
    }

    if (job.name === 'send-email') {
      const { to, subject, html } = job.data;
      await emailHelper.sendEmail({ to, subject, html });
      return { success: true };
    }
  },
  { connection: redisConnection }
);

notificationWorker.on('failed', (job, err) => {
  logger.error(`❌ Notification Job ${job?.id} failed: ${err.message}`);
});
