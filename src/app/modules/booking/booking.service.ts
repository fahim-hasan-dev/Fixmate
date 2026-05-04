import { Types } from 'mongoose';
import { JwtPayload } from 'jsonwebtoken';
import exceljs from 'exceljs';
import { StatusCodes } from 'http-status-codes';
import ApiError from '../../../errors/ApiError';
import { IBooking } from './booking.interface';
import { Booking } from './booking.model';
import { BOOKING_STATUS } from '../../../enum/booking';
import { Service } from '../service/service.model';
import { User } from '../user/user.model';
import { SERVICE_DAY } from '../../../enum/service';
import { BookingStateMachine } from './bookingStateMachine';
import { createPaystackCheckout } from '../../../helpers/paystackHelper';
import { Request } from 'express';
import { Payment } from '../payment/payment.model';
import { createCancellationRefundRecord } from '../payment/payment.service';
import { applyClientCancellationPenalty, applyProviderCancellationPenalty } from '../penalty/penalty.utils';
import { refundPaystackTransaction } from '../../../helpers/paystackHelper';
import { PAYMENT_STATUS } from '../../../enum/payment';
import { USER_ROLES } from '../../../enum/user';

const STATUS_PERMISSIONS: Partial<Record<string, BOOKING_STATUS[]>> = {
  [USER_ROLES.PROVIDER]: [
    BOOKING_STATUS.ACCEPTED,
    BOOKING_STATUS.IN_PROGRESS,
    BOOKING_STATUS.COMPLETED_BY_PROVIDER,
    BOOKING_STATUS.CANCELLED,
    BOOKING_STATUS.DISPUTED,
  ],
  [USER_ROLES.CLIENT]: [
    BOOKING_STATUS.CONFIRMED_BY_CLIENT,
    BOOKING_STATUS.CANCELLED,
    BOOKING_STATUS.DISPUTED,
  ],
  [USER_ROLES.ADMIN]: Object.values(BOOKING_STATUS),
};

// Create a new booking and initialize Paystack checkout
const createBooking = async (user: JwtPayload, data: IBooking, req: Request) => {
  const service = await Service.findById(data.service).lean().exec();
  if (!service) throw new ApiError(StatusCodes.NOT_FOUND, 'We couldn\'t find the requested service. Please try selecting it again.');

  const provider = await User.findById(service.creator).lean().exec();
  if (!provider) throw new ApiError(StatusCodes.NOT_FOUND, 'We\'re having trouble locating the service provider. Please try again in a moment.');

  const bookingDate = new Date(data.date);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Validate if the selected date is in the past (ignoring time)
  if (bookingDate.setHours(0, 0, 0, 0) < today.getTime()) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Please select a future date for your booking.');
  }

  // Validate if the selected day is among provider's available days
  const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const bookingDay = days[bookingDate.getDay()] as SERVICE_DAY;
  const availableDays = provider.providerDetails?.availableDay || [];

  if (availableDays.length > 0 && !availableDays.includes(bookingDay)) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      `The provider is not available on ${bookingDate.toISOString().split('T')[0]}. Please choose a day that matches their schedule.`,
    );
  }

  const customer = await User.findById(user.authId)
    .lean()
    .exec();
  if (!customer) throw new ApiError(StatusCodes.NOT_FOUND, 'We couldn\'t find your account details. Please ensure you are logged in correctly.');

  const booking = await Booking.create({
    customer: customer._id,
    provider: provider._id,
    service: service._id,
    date: data.date,
    location: data.location,
    address: data.address,
    specialNote: data.specialNote,
    bookingStatus: BOOKING_STATUS.CREATED,
  });

  const url = await createPaystackCheckout(
    req,
    service.price,
    {
      bookingId: booking._id.toString(),
      providerId: provider._id.toString(),
      serviceId: service._id.toString(),
      customerId: customer._id.toString(),
    },
    customer.email || 'customer@example.com',
  );

  await Booking.findByIdAndUpdate(booking._id, { transactionId: url.id });

  return url;
};

// Retrieve a list of bookings based on user role and query filters
const getBookings = async (user: JwtPayload, query: any, role: 'client' | 'provider' | 'admin') => {
  const { searchTerm, ...rest } = query;
  const userId = user.authId;

  const matchStage: any = { isDeleted: { $ne: true }, bookingStatus: { $ne: BOOKING_STATUS.CREATED } };

  if (role === 'client') {
    matchStage.customer = new Types.ObjectId(userId);
  } else if (role === 'provider') {
    matchStage.provider = new Types.ObjectId(userId);
    matchStage.isPaid = true;
  }

  if (rest.status) {
    const statusArray = (rest.status as string).split(',').map(s => s.trim());
    matchStage.bookingStatus = { $in: statusArray };
  }

  const pipeline: any[] = [{ $match: matchStage }];

  pipeline.push(
    {
      $lookup: {
        from: 'users',
        localField: 'customer',
        foreignField: '_id',
        pipeline: [{ $project: { name: 1, image: 1, address: 1, contact: 1, whatsApp: 1, customId: 1, email: 1 } }],
        as: 'customer',
      },
    },
    { $unwind: { path: '$customer', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'users',
        localField: 'provider',
        foreignField: '_id',
        pipeline: [{ $project: { name: 1, image: 1, contact: 1, whatsApp: 1, customId: 1, email: 1, 'providerDetails.category': 1 } }],
        as: 'provider',
      },
    },
    { $unwind: { path: '$provider', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'services',
        localField: 'service',
        foreignField: '_id',
        pipeline: [{ $project: { name: 1, image: 1, price: 1, category: 1, subCategory: 1, customId: 1 } }],
        as: 'service',
      },
    },
    { $unwind: { path: '$service', preserveNullAndEmptyArrays: true } },
  );

  if (searchTerm) {
    pipeline.push({
      $match: {
        $or: [
          { customId: { $regex: searchTerm, $options: 'i' } },
          { 'customer.customId': { $regex: searchTerm, $options: 'i' } },
          { 'customer.email': { $regex: searchTerm, $options: 'i' } },
          { 'provider.customId': { $regex: searchTerm, $options: 'i' } },
          { 'provider.email': { $regex: searchTerm, $options: 'i' } },
          { 'service.customId': { $regex: searchTerm, $options: 'i' } },
          { 'service.category': { $regex: searchTerm, $options: 'i' } },
        ],
      },
    });
  }

  const sortStr = (rest.sort as string) || '-createdAt';
  const sortDir = sortStr.startsWith('-') ? -1 : 1;
  const sortField = sortStr.replace('-', '');
  pipeline.push({ $sort: { [sortField]: sortDir } });

  const page = Number(rest.page) || 1;
  const limit = Number(rest.limit) || 10;
  const skip = (page - 1) * limit;

  pipeline.push({
    $facet: {
      metadata: [{ $count: 'total' }],
      data: [{ $skip: skip }, { $limit: limit }],
    },
  });

  const result = await Booking.aggregate(pipeline);

  const total = result[0]?.metadata[0]?.total || 0;
  const data = result[0]?.data || [];
  const totalPage = Math.ceil(total / limit);

  return { meta: { total, limit, page, totalPage }, data };
};

// Get a single booking's details by its ID
const getBookingById = async (id: string) => {
  const booking = await Booking.findById(id)
    .populate([
      { path: 'service', select: 'image price category subCategory customId' },
      { path: 'provider', select: 'name image address customId providerDetails.category contact whatsApp' },
      { path: 'customer', select: 'name image address customId contact whatsApp' },
    ])
    .lean()
    .exec();

  if (!booking) throw new ApiError(StatusCodes.NOT_FOUND, 'We couldn\'t find the details for this booking.');
  return booking;
};

// Update booking information using its ID
const updateBooking = async (id: string, data: Partial<IBooking>) => {
  const booking = await Booking.findByIdAndUpdate(id, data, { new: true }).lean().exec();
  if (!booking) throw new ApiError(StatusCodes.NOT_FOUND, 'We couldn\'t find the details for this booking.');
  return booking;
};

// Transition booking status to CANCELLED and handle fees if applicable
const cancelBooking = async (user: JwtPayload, id: string, reason?: string) => {
  const role = user.role.toLowerCase() as 'client' | 'provider';
  const booking = await Booking.findById(id).populate('service').exec();
  if (!booking) throw new ApiError(StatusCodes.NOT_FOUND, 'We couldn\'t find the booking record in our system.');

  const originalPayment: any = await Payment.findOne({
    booking: booking._id,
    paymentStatus: PAYMENT_STATUS.PAID,
  }).lean();

  const originalAmount = originalPayment ? originalPayment.servicePrice || 0 : 0;
  let penaltyFee = 0;

  const currentStatus = booking.bookingStatus as BOOKING_STATUS;

  // Set cancellation details
  booking.cancelReason = reason || '';
  booking.cancelledBy = user.role.toUpperCase() as 'CLIENT' | 'PROVIDER';
  await booking.save();

  // No penalty if cancelled at the REQUESTED stage
  if (currentStatus === BOOKING_STATUS.REQUESTED) {
    if (originalAmount > 0) {
      await createCancellationRefundRecord(id, originalAmount);
      await refundPaystackTransaction(booking.transactionId, originalAmount);
    }
    await BookingStateMachine.transitionState(id, role, BOOKING_STATUS.CANCELLED, reason);
    return { message: 'Booking request cancelled successfully' };
  }

  if (role === 'client') {
    if (originalAmount > 0) {
      if (currentStatus === BOOKING_STATUS.ACCEPTED) {
        penaltyFee = originalAmount * 0.05;
      } else if (currentStatus === BOOKING_STATUS.IN_PROGRESS) {
        penaltyFee = originalAmount * 0.1;
      }

      await applyClientCancellationPenalty(
        booking._id.toString(),
        booking.transactionId,
        booking.customer.toString(),
        originalAmount,
        penaltyFee,
      );
    }

    await BookingStateMachine.transitionState(id, 'client', BOOKING_STATUS.CANCELLED, reason);
  } else {
    if (originalAmount > 0) {
      if (currentStatus === BOOKING_STATUS.ACCEPTED || currentStatus === BOOKING_STATUS.IN_PROGRESS) {
        penaltyFee = 30;
      }

      await applyProviderCancellationPenalty(
        booking._id.toString(),
        booking.transactionId,
        booking.provider.toString(),
        originalAmount,
        penaltyFee,
      );
    }

    await BookingStateMachine.transitionState(id, 'provider', BOOKING_STATUS.CANCELLED, reason);
  }

  return { message: 'Booking cancelled successfully' };
};

// Centralized status update logic with role-based validation
const updateBookingStatus = async (
  user: JwtPayload,
  id: string,
  status: BOOKING_STATUS,
  reason?: string,
) => {
  const role = user.role as string;
  const allowedStatuses = STATUS_PERMISSIONS[role] || [];

  let finalStatus = status;

  // If client confirms completion, move directly to SETTLED to trigger payout
  if (finalStatus === BOOKING_STATUS.CONFIRMED_BY_CLIENT) {
    finalStatus = BOOKING_STATUS.SETTLED;
  }

  if (!allowedStatuses.includes(status)) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      `You don't have permission to update this booking status to "${status}".`,
    );
  }

  // Handle Cancellation specially due to penalty logic
  if (finalStatus === BOOKING_STATUS.CANCELLED) {
    return await cancelBooking(user, id, reason);
  }

  // General transition for other statuses (ACCEPTED, IN_PROGRESS, COMPLETED, CONFIRMED, etc.)
  await BookingStateMachine.transitionState(id, role.toLowerCase() as any, finalStatus, reason);

  return { message: `Booking status updated to ${finalStatus} successfully` };
};

const downloadBookings = async (query: Record<string, unknown>) => {
  const { startDate, endDate, format } = query;

  if (!format || !['csv', 'excel'].includes((format as string).toLowerCase())) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "Please specify a valid file format (CSV or Excel) for your download.");
  }

  const mongoQuery: any = { isDeleted: { $ne: true } };

  if (startDate || endDate) {
    mongoQuery.createdAt = {};
    if (startDate) mongoQuery.createdAt.$gte = new Date(startDate as string);
    if (endDate) {
      const end = new Date(endDate as string);
      end.setUTCHours(23, 59, 59, 999);
      mongoQuery.createdAt.$lte = end;
    }
  }

  if (query.bookingStatus) {
    const statusArray = (query.bookingStatus as string).split(',').map(s => s.trim());
    mongoQuery.bookingStatus = { $in: statusArray };
  }

  const bookings = await Booking.find(mongoQuery)
    .populate('customer', 'name email contact address')
    .populate('provider', 'name email contact address')
    .populate('service', 'category subCategory price')
    .sort('-createdAt')
    .lean();

  const workbook = new exceljs.Workbook();
  const worksheet = workbook.addWorksheet('Bookings');

  worksheet.columns = [
    { header: 'Booking ID', key: 'customId', width: 20 },
    { header: 'Created At', key: 'createdAt', width: 22 },
    { header: 'Service Date', key: 'date', width: 22 },
    { header: 'Customer Name', key: 'customerName', width: 20 },
    { header: 'Customer Email', key: 'customerEmail', width: 25 },
    { header: 'Customer Contact', key: 'customerContact', width: 15 },
    { header: 'Provider Name', key: 'providerName', width: 20 },
    { header: 'Provider Email', key: 'providerEmail', width: 25 },
    { header: 'Provider Contact', key: 'providerContact', width: 15 },
    { header: 'Service Category', key: 'serviceCategory', width: 25 },
    { header: 'Service Price', key: 'servicePrice', width: 15 },
    { header: 'Address', key: 'address', width: 30 },
    { header: 'Special Note', key: 'specialNote', width: 30 },
    { header: 'Booking Status', key: 'bookingStatus', width: 20 },
    { header: 'Payment Status', key: 'isPaid', width: 15 },
    { header: 'Payment Gateway ID', key: 'paymentId', width: 25 },
    { header: 'Transaction ID', key: 'transactionId', width: 25 },
    { header: 'Responded At', key: 'respondedAt', width: 22 },
    { header: 'Cancel Reason', key: 'cancelReason', width: 25 },
    { header: 'Cancelled By', key: 'cancelledBy', width: 15 },
  ];

  bookings.forEach((b: any) => {
    worksheet.addRow({
      customId: b.customId || 'N/A',
      createdAt: b.createdAt ? new Date(b.createdAt).toLocaleString() : 'N/A',
      date: b.date ? new Date(b.date).toLocaleString() : 'N/A',
      customerName: b.customer?.name || 'N/A',
      customerEmail: b.customer?.email || 'N/A',
      customerContact: b.customer?.contact || 'N/A',
      providerName: b.provider?.name || 'N/A',
      providerEmail: b.provider?.email || 'N/A',
      providerContact: b.provider?.contact || 'N/A',
      serviceCategory: b.service?.category ? `${b.service.category} ${b.service.subCategory ? '- ' + b.service.subCategory : ''}` : 'N/A',
      servicePrice: b.service?.price || '0',
      address: b.address || 'N/A',
      specialNote: b.specialNote || 'N/A',
      bookingStatus: b.bookingStatus || 'N/A',
      isPaid: b.isPaid ? 'Paid' : 'Unpaid',
      paymentId: b.paymentId || 'N/A',
      transactionId: b.transactionId || 'N/A',
      respondedAt: b.respondedAt ? new Date(b.respondedAt).toLocaleString() : 'N/A',
      cancelReason: b.cancelReason || 'N/A',
      cancelledBy: b.cancelledBy || 'N/A',
    });
  });

  worksheet.getRow(1).font = { bold: true };

  let buffer: Buffer;
  let contentType: string;
  let fileExtension: string;

  if (format === 'excel') {
    buffer = (await workbook.xlsx.writeBuffer()) as any as Buffer;
    contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    fileExtension = 'xlsx';
  } else {
    buffer = (await workbook.csv.writeBuffer()) as any as Buffer;
    contentType = 'text/csv';
    fileExtension = 'csv';
  }

  return { buffer, contentType, fileExtension };
};

export const BookingService = {
  createBooking,
  getBookings,
  getBookingById,
  updateBooking,
  cancelBooking,
  updateBookingStatus,
  downloadBookings,
};
