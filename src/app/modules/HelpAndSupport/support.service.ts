// HelpAndSupport Service
import { JwtPayload } from 'jsonwebtoken';
import { ISupport } from './support.interface';
import { Support } from './support.model';
import { User } from '../user/user.model';
import { USER_ROLES } from '../../../enum/user';
import { NotificationService } from '../notification/notification.service';
import { Types } from 'mongoose';
import { SupportStatus } from '../../../enum/support';
import ApiError from '../../../errors/ApiError';
import { StatusCodes } from 'http-status-codes';
import { emailTemplate } from '../../../shared/emailTemplate';
import QueryBuilder from '../../builder/QueryBuilder';
import { notificationQueue } from '../../queues';

// Create a new support ticket and notify all administrators
const createSupport = async (user: JwtPayload, data: Partial<ISupport>) => {
  const support = await Support.create({
    attachment: data.attachment,
    description: data.description,
    title: data.title,
    user: new Types.ObjectId(user.authId),
  });

  const [getAdmins, getUser] = await Promise.all([
    User.find({ role: USER_ROLES.ADMIN }),
    User.findById(user.authId)
      .select('name email')
      .lean(),
  ]);

  getAdmins.forEach(async element => {
    await NotificationService.insertNotification({
      for: element._id,
      message: `New Support Request from ${getUser?.name || getUser?.email} regarding: ${data.title}. Please review it at your earliest convenience.`,
    });
  });

  return support;
};

// Retrieve all support tickets with filtering by status and searching by user info
const getSupports = async (query: Record<string, unknown>) => {
  const { status, search, ...queryObj } = query;
  const queryFilter: any = {};

  if (status && String(status).trim() !== '') {
    queryFilter.status =
      String(status).toUpperCase() === 'PENDING' ? SupportStatus.PENDING : SupportStatus.COMPLETED;
  }

  if (search && String(search).trim() !== '') {
    const userFilter: any = {
      $or: [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ],
    };

    const matchedUsers = await User.find(userFilter).select('_id').lean();
    const userIds = matchedUsers.map(u => u._id);
    queryFilter.user = { $in: userIds };
  }

  const supportQuery = new QueryBuilder<ISupport>(
    Support.find(queryFilter)
      .populate('user', 'name email role category contact')
      .select('-updatedAt -__v') as any,
    queryObj as Record<string, unknown>,
  )
    .search(['title', 'description'])
    .filter()
    .sort()
    .paginate()
    .fields();

  const data = await supportQuery.modelQuery.lean().exec();
  const meta = await supportQuery.getPaginationInfo();

  return {
    meta,
    data,
  };
};

// Mark a support ticket as resolved and send a confirmation email to the user
const markAsResolve = async (_user: JwtPayload, supportId: string) => {
  const support = await Support.findById(new Types.ObjectId(supportId)).populate('user');
  if (!support) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'We couldn\'t find the support ticket you\'re looking for.');
  }

  if(support.status === SupportStatus.COMPLETED){
    throw new ApiError(StatusCodes.BAD_REQUEST, 'This support ticket has already been marked as resolved.');
  }


  const res = await Support.findOneAndUpdate(
    { _id: new Types.ObjectId(supportId) },
    { status: SupportStatus.COMPLETED },
    { new: true },
  )

  const user = support.user as any;
  if (user && user.email) {
    const emailData = emailTemplate.supportResolved({
      name: user.name,
      email: user.email,
    });

    await notificationQueue.add('send-email', emailData);
  }

  return res;
};

export const SupportServices = {
  createSupport,
  getSupports,
  markAsResolve,
};
