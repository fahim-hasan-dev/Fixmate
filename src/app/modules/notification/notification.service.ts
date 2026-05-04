// Notification Service
import { JwtPayload } from 'jsonwebtoken';
import { INotification } from './notification.interface';
import { Notification } from './notification.model';
import { FilterQuery } from 'mongoose';
import QueryBuilder from '../../builder/QueryBuilder';
import { User } from '../user/user.model';
import { notificationQueue } from '../../queues';

// Save a new notification and trigger push/socket updates
const insertNotification = async (payload: Partial<INotification>): Promise<INotification> => {
  const result = await Notification.create(payload);

  if (result.message) {
    const receiverId = result.for.toString();
    const receiverUser = await User.findById(receiverId).select('fcmToken fullName');

    if (receiverUser && receiverUser.fcmToken) {
      await notificationQueue.add('send-push-notification', {
        fcmToken: receiverUser.fcmToken,
        title: 'New Notification',
        message: result.message,
      });
    }
  }

  const io = global.io;
  if (io && result.for) {
    io.emit(`notification::${result.for.toString()}`, result);
  }

  return result;
};

// Retrieve notifications for a user and mark them as read
const getNotificationFromDB = async (
  user: JwtPayload,
  query: FilterQuery<any>,
): Promise<Object> => {
  const result = new QueryBuilder(Notification.find({ for: user.authId }), query)
  .sort()
  .paginate();
  const notifications = await result.modelQuery;
  const pagination = await result.getPaginationInfo();


  await Notification.updateMany(
    { for: user.authId, isRead: false },
    {
      $set: {
        isRead: true,
        readAt: new Date(),
      },
    },
  );

  const resultData: Record<string, any> = {
    meta: pagination,
    data: notifications
  }

    const io = global.io;
  if (io && user.authId) {
    io.emit(`notification::${user.authId.toString()}`, {message:"refatch notication count"});
  }

  return resultData;
};

// Get the total count of unread notifications for a user
const getUnreadCountFromDB = async (user: JwtPayload) => {
  const count = await Notification.countDocuments({
    for: user.authId,
    isRead: false,
  });

  return {unreadCount: count};
};

export const NotificationService = {
  insertNotification,
  getNotificationFromDB,
  getUnreadCountFromDB,
};
