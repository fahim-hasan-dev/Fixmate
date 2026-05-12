// Payment Service
import ApiError from '../../../errors/ApiError';
import config from '../../../config';
import { StatusCodes } from 'http-status-codes';
import { FilterQuery, Types } from 'mongoose';
import {
  createTransferRecipient,
  initiateTransfer,
  createPaystackCheckout
} from '../../../helpers/paystackHelper';
import crypto from 'crypto';
import { PAYMENT_STATUS } from '../../../enum/payment';
import { NotificationService } from '../notification/notification.service';
import { Request } from 'express';
import { Booking } from '../booking/booking.model';
import { Payment } from './payment.model';
import { Service } from '../service/service.model';
import { User } from '../user/user.model';
import { BookingStateMachine } from '../booking/bookingStateMachine';
import exceljs from 'exceljs';
import { BOOKING_STATUS } from '../../../enum/booking';
import { JwtPayload } from 'jsonwebtoken';
import QueryBuilder from '../../builder/QueryBuilder';
import { IUser } from '../user/user.interface';
import { Transaction } from '../transaction/transaction.model';
import { TransactionService } from '../transaction/transaction.service';

// Handle post-payment logic: update booking, create SERVICE_PAYMENT record, notify provider
const handlePaymentSuccessLogic = async (
  bookingID: string,
  transactionId: string,
  paystackPaymentId: string,
) => {
  try {
    const booking = await Booking.findById(bookingID);
    if (!booking) throw new ApiError(StatusCodes.BAD_REQUEST, 'We couldn\'t find the booking for this payment.');
    if (booking.isPaid) return;

    const updatedBooking = await Booking.findOneAndUpdate(
      { _id: bookingID, isPaid: false },
      { isPaid: true, transactionId: transactionId, paymentId: paystackPaymentId },
      { new: true },
    );

    if (!updatedBooking) return;

    const serviceData = await Service.findById(booking.service).lean();
    const providerData = await User.findById(booking.provider).lean();
    const customerData = await User.findById(booking.customer).lean();

    if (!serviceData || !providerData || !customerData) {
      throw new ApiError(StatusCodes.BAD_REQUEST, 'We couldn\'t find some of the information needed for this payment. Please refresh and try again.');
    }

    const servicePrice = serviceData.price;
    let vat = 0;
    if (providerData.providerDetails?.isVatRegistered) {
      vat = Number((servicePrice * 0.15).toFixed(2));
    }
    const isSubscribed =
      providerData.providerDetails?.subscription?.isSubscribed &&
      (providerData.providerDetails?.subscription?.expiryDate ? new Date(providerData.providerDetails.subscription.expiryDate) > new Date() : false);

    const platformFeeRatio = isSubscribed ? 0.15 : 0.18;
    const providerPayRatio = isSubscribed ? 0.85 : 0.82;

    const platformFee = Number((servicePrice * platformFeeRatio).toFixed(2));
    const providerPay = Number((servicePrice * providerPayRatio).toFixed(2));
    const paystackGatewayFee = Number((servicePrice * 0.03).toFixed(2));

    await Payment.create({
      paymentStatus: PAYMENT_STATUS.PAID,
      customer: booking.customer,
      provider: booking.provider,
      service: booking.service,
      booking: booking._id,
      paymentId: paystackPaymentId,
      servicePrice,
      vat,
      platformFee,
      paystackGatewayFee,
      providerPay,
    });

    await TransactionService.recordTransaction({
      type: 'PAYMENT',
      user: booking.customer,
      booking: booking._id,
      amount: servicePrice,
      status: 'COMPLETED',
      p2ptransactionId: transactionId,
    });

    await BookingStateMachine.transitionState(
      bookingID,
      'system',
      BOOKING_STATUS.REQUESTED,
      'Booking automatically requested to provider after successful payment',
    );
  } catch (error) {
    console.error('Payment Success Error:', error);
    throw error;
  }
};



export const createCancellationRefundRecord = async (
  bookingId: string,
  refundedAmount: number,
) => {
  const status = PAYMENT_STATUS.REFUNDED;

  return Payment.findOneAndUpdate(
    { booking: new Types.ObjectId(bookingId) },
    {
      paymentStatus: status,
      refundAmount: refundedAmount,
    },
    { new: true }
  ).then(async (res) => {
    if (res) {
      await TransactionService.recordTransaction({
        type: 'REFUND',
        user: (res as any).customer,
        booking: (res as any).booking,
        amount: refundedAmount,
        status: 'COMPLETED',
      });
    }
    return res;
  });
};

export const createSettlementRecord = async (bookingId: string) => {
  return Payment.findOneAndUpdate(
    { booking: new Types.ObjectId(bookingId) },
    { isSettled: true },
    { new: true }
  );
};

export const createDisputeRefundRecord = async (
  bookingId: string,
  refundedAmount: number,
) => {
  return Payment.findOneAndUpdate(
    { booking: new Types.ObjectId(bookingId) },
    {
      paymentStatus: PAYMENT_STATUS.REFUNDED,
      refundAmount: refundedAmount,
      platformFee: 0,
      providerPay: 0,
      vat: 0,
    },
    { new: true }
  ).then(async (res) => {
    if (res) {
      await TransactionService.recordTransaction({
        type: 'REFUND',
        user: (res as any).customer,
        booking: (res as any).booking,
        amount: refundedAmount,
        status: 'COMPLETED',
      });
    }
    return res;
  });
};

// Create a Paystack transfer recipient for a provider
const generateRecipient = async (req: Request) => {
  const user = req.user;
  const {  accountNumber, bankCode } = req.body;

  if ( !accountNumber || !bankCode) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Please provide your account number, and bank code to continue.');
  }

  const userOnDB = await User.findById(user.authId || user.id);
  if (!userOnDB) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'We couldn\'t find your account details. Please try logging in again.');
  }

  const recipient = await createTransferRecipient(userOnDB.name, accountNumber, bankCode);

  await User.findByIdAndUpdate(userOnDB._id, {
    'providerDetails.paystackRecipientCode': recipient.recipient_code,
    'providerDetails.bankName': bankCode,
    'providerDetails.accountNumber': accountNumber,
    "providerDetails.paystackAccountId": recipient.account_id,
  });

  return {
    recipientCode: recipient.recipient_code,
    bankName: bankCode,
    accountNumber: accountNumber
  };
};

// Handle Paystack webhooks
const webhook = async (req: Request) => {
  console.log("hit webhook")
  const payload = req.body;
  const hash = crypto.createHmac('sha512', config.paystack.secretKey || 'sk_test_placeholder').update(payload).digest('hex');
  if (hash !== req.headers['x-paystack-signature']) {
    throw new ApiError(StatusCodes.UNAUTHORIZED, 'We couldn\'t verify the security signature for this request.');
  }

  const event = JSON.parse(req.body.toString());

  if (event.event === 'charge.success') {
    const data = event.data;
    const reference = data.reference;

    const customFields = data.metadata?.custom_fields || [];
    const getMetaField = (key: string) =>
      customFields.find((f: any) => f.variable_name === key)?.value;

    const bookingID = getMetaField('bookingId');
    if (bookingID) {
      await handlePaymentSuccessLogic(bookingID, reference, data.id.toString());
    }
  } else if (event.event === 'transfer.success') {
    const data = event.data;
    const tx: any = await Transaction.findOneAndUpdate({ p2ptransactionId: data.reference }, { status: 'COMPLETED' });
    if (tx) {
      await NotificationService.insertNotification({
        for: tx.user,
        message: `Your withdrawal of $${tx.amount.toFixed(2)} has been successfully processed. The funds should appear in your bank account shortly.`,
      });
    }
  } else if (event.event === 'transfer.failed' || event.event === 'transfer.reversed') {
    const data = event.data;
    const tx: any = await Transaction.findOneAndUpdate({ p2ptransactionId: data.reference }, { status: 'FAILED' });
    if (tx) {
      // Refund user's wallet
      await User.findByIdAndUpdate(tx.user, { $inc: { 'providerDetails.wallet': tx.amount } });
      await NotificationService.insertNotification({
        for: tx.user,
        message: `Unfortunately, your withdrawal of $${tx.amount.toFixed(2)} could not be completed and the amount has been safely returned to your wallet.`,
      });
    }
  }

  return { success: true };
};

// Retrieve wallet balance and transaction history for a provider
const getWallet = async (user: JwtPayload, query: any) => {
  const userId = user.authId;
  const provider = (await User.findById(userId).lean().exec()) as IUser;
  if (!provider) throw new ApiError(StatusCodes.NOT_FOUND, 'We couldn\'t find your service provider profile.');

  const walletQuery = new QueryBuilder(
    Transaction.find({ user: new Types.ObjectId(userId) })
      .populate({
        path: 'booking',
        select: 'customId service',
        populate: {
          path: 'service',
          select: 'name category image',
        },
      })
      .sort('-createdAt'),
    query,
  )
    .filter()
    .paginate()
    .fields();

  const data = await walletQuery.modelQuery.lean().exec();
  const meta = await walletQuery.getPaginationInfo();

  return { meta, balance: provider.providerDetails?.wallet || 0, data };
};

// Retrieve filtered payment history for a user
const getPaymentHistory = async (user: JwtPayload, query: any) => {
  const { startTime, endTime, paymentStatus, searchTerm, ...rest } = query;
  const userId = user.authId;
  const userData = (await User.findById(userId).lean().exec()) as IUser;
  if (!userData) throw new ApiError(StatusCodes.NOT_FOUND, 'We couldn\'t find your account details.');

  const isProvider = userData.role === 'PROVIDER';
  const isAdmin = userData.role === 'ADMIN';

  const matchStage: FilterQuery<any> = {};

  if (!isAdmin) {
    matchStage[isProvider ? 'provider' : 'customer'] = new Types.ObjectId(userId);
  }

  if (startTime && endTime) {
    matchStage.createdAt = { $gte: new Date(startTime), $lte: new Date(endTime) };
  }

  if (paymentStatus) {
    const statusArray = (paymentStatus as string).split(',').map((s) => s.trim());
    matchStage.paymentStatus = statusArray.length > 1 ? { $in: statusArray } : statusArray[0];
  }

  const pipeline: any[] = [{ $match: matchStage }];

  pipeline.push(
    {
      $lookup: {
        from: 'users',
        localField: 'customer',
        foreignField: '_id',
        pipeline: [{ $project: { name: 1, image: 1, customId: 1 } }],
        as: 'customer',
      },
    },
    { $unwind: { path: '$customer', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'users',
        localField: 'provider',
        foreignField: '_id',
        pipeline: [{ $project: { name: 1, image: 1, customId: 1 } }],
        as: 'provider',
      },
    },
    { $unwind: { path: '$provider', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'services',
        localField: 'service',
        foreignField: '_id',
        pipeline: [{ $project: { name: 1, category: 1, customId: 1 } }],
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
          { 'provider.customId': { $regex: searchTerm, $options: 'i' } },
        ],
      },
    });
  }

  // Sorting
  const sortStr = (rest.sort as string) || '-createdAt';
  const sortDir = sortStr.startsWith('-') ? -1 : 1;
  const sortField = sortStr.replace('-', '');
  pipeline.push({ $sort: { [sortField]: sortDir } });

  // Pagination
  const page = Number(rest.page) || 1;
  const limit = Number(rest.limit) || 10;
  const skip = (page - 1) * limit;

  pipeline.push({
    $facet: {
      metadata: [{ $count: 'total' }],
      data: [{ $skip: skip }, { $limit: limit }],
    },
  });

  const result = await Payment.aggregate(pipeline);

  const total = result[0]?.metadata[0]?.total || 0;
  const data = result[0]?.data || [];
  const totalPage = Math.ceil(total / limit);

  return {
    meta: { total, limit, page, totalPage },
    ...(isProvider && { balance: userData.providerDetails?.wallet || 0 }),
    data
  };
};

// Get detailed information for a specific payment record
const getPaymentDetails = async (id: string) => {
  const info: any = await Payment.findById(id).populate('customer service provider').lean().exec();

  if (!info) throw new ApiError(StatusCodes.NOT_FOUND, 'We couldn\'t find the requested payment details.');

  const base = {
    customId: info.customId,
    paymentStatus: info.paymentStatus,
    dateAndTime: info.createdAt,
    customer: info.customer
      ? { name: info.customer.name, email: info.customer.email, address: info.customer.address, customId: info.customer.customId }
      : null,
    provider: info.provider
      ? { name: info.provider.name, email: info.provider.email, address: info.provider.address, customId: info.provider.customId }
      : null,
    service: info.service
      ? {
        category: info.service.category,
        subCategory: info.service.subCategory,
        price: info.service.price,
        customId: info.service.customId,
      }
      : null,
  };

  return {
    ...base,
    servicePrice: info.servicePrice,
    vat: info.vat,
    platformFee: info.platformFee,
    paystackGatewayFee: info.paystackGatewayFee,
    providerPay: info.providerPay,
    refundAmount: info.refundAmount,
  };
};

// Initiate a fund withdrawal to a bank account
const withdraw = async (
  user: JwtPayload,
  data: { amount: number },
) => {
  const provider = (await User.findById(user.authId)
    .lean()
    .exec()) as IUser;
  if (!provider) throw new ApiError(StatusCodes.NOT_FOUND, 'We couldn\'t find your service provider profile to process the withdrawal.');

  const walletBalance = provider.providerDetails?.wallet || 0;
  const maxWithdrawable = walletBalance * 0.9;

  if (data.amount <= 0) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'The withdrawal amount must be greater than zero.');
  }

  if (data.amount > maxWithdrawable) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      `You don't have enough balance. You can withdraw up to 90% of your wallet, which is ${maxWithdrawable.toFixed(2)} at this time.`,
    );
  }

  const recipientCode = provider.providerDetails?.paystackRecipientCode;

  // Check if a transfer recipient exists in the profile
  if (!recipientCode) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      'We couldn\'t find a verified withdrawal account in your profile. Please set up your bank details first to continue.',
    );
  }

  const withdrawalFee = 0; // Configured to 0 withdrawal fee as requested
  const netPayout = data.amount;

  const transferRes = await initiateTransfer(netPayout, recipientCode, `Withdrawal for ${provider.name}`);

  if (!transferRes || !transferRes.reference) {
    throw new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, 'Transfer failed. Please try again.');
  }

  // Deduct the requested amount from the wallet using $inc for safety
  await User.findByIdAndUpdate(provider._id, {
    $inc: { 'providerDetails.wallet': -data.amount }
  }).lean().exec();

  await TransactionService.recordTransaction({
    type: 'WITHDRAWAL',
    user: provider._id,
    amount: data.amount,
    fee: withdrawalFee,
    status: 'PENDING',
    p2ptransactionId: transferRes.reference,
  });
};

const downloadPayments = async (query: Record<string, unknown>) => {
  const { startDate, endDate, format } = query;

  if (!format || !['csv', 'excel'].includes((format as string).toLowerCase())) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "Please specify a valid file format (CSV or Excel) for your download.");
  }

  const mongoQuery: any = {};

  if (startDate || endDate) {
    mongoQuery.createdAt = {};
    if (startDate) mongoQuery.createdAt.$gte = new Date(startDate as string);
    if (endDate) {
      const end = new Date(endDate as string);
      end.setUTCHours(23, 59, 59, 999);
      mongoQuery.createdAt.$lte = end;
    }
  }

  if (query.paymentStatus) {
    const statusArray = (query.paymentStatus as string).split(',').map(s => s.trim());
    mongoQuery.paymentStatus = { $in: statusArray };
  }

  const payments = await Payment.find(mongoQuery)
    .populate('customer', 'name email contact')
    .populate('provider', 'name email contact')
    .populate('service', 'category subCategory price')
    .sort('-createdAt')
    .lean();

  const workbook = new exceljs.Workbook();
  const worksheet = workbook.addWorksheet('Payments');

  worksheet.columns = [
    { header: 'Payment ID', key: 'id', width: 25 },
    { header: 'Date', key: 'date', width: 20 },
    { header: 'Customer', key: 'customer', width: 20 },
    { header: 'Provider', key: 'provider', width: 20 },
    { header: 'Service Category', key: 'service', width: 20 },
    { header: 'Service Price', key: 'price', width: 15 },
    { header: 'VAT', key: 'vat', width: 10 },
    { header: 'Platform Fee', key: 'platformFee', width: 15 },
    { header: 'Gateway Fee', key: 'gatewayFee', width: 15 },
    { header: 'Provider Pay', key: 'providerPay', width: 15 },
    { header: 'Refund Amount', key: 'refundAmount', width: 15 },
    { header: 'Status', key: 'status', width: 15 },
  ];

  payments.forEach((p: any) => {
    worksheet.addRow({
      id: p.customId || p._id.toString(),
      date: p.createdAt ? new Date(p.createdAt).toLocaleString() : 'N/A',
      customer: p.customer?.name || 'N/A',
      provider: p.provider?.name || 'N/A',
      service: p.service?.category || 'N/A',
      price: p.servicePrice,
      vat: p.vat,
      platformFee: p.platformFee,
      gatewayFee: p.paystackGatewayFee,
      providerPay: p.providerPay,
      refundAmount: p.refundAmount,
      status: p.paymentStatus,
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

// Dedicated API to create Paystack Checkout for a specific booking
const checkoutBooking = async (req: Request, bookingId: string) => {
  const booking = await Booking.findById(bookingId).lean().exec();
  if (!booking) throw new ApiError(StatusCodes.NOT_FOUND, 'We couldn\'t find the booking session.');

  if (booking.isPaid) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'This booking has already been paid for.');
  }

  const service = await Service.findById(booking.service).lean().exec();
  if (!service) throw new ApiError(StatusCodes.NOT_FOUND, 'We couldn\'t find the service details for this booking.');

  const provider = await User.findById(booking.provider).lean().exec();
  if (!provider) throw new ApiError(StatusCodes.NOT_FOUND, 'We couldn\'t find the service provider for this booking.');

  const customer = await User.findById(booking.customer).lean().exec();
  if (!customer) throw new ApiError(StatusCodes.NOT_FOUND, 'We couldn\'t find your account details. Please try logging in again.');

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

export const PaymentServices = {
  generateRecipient,
  webhook,
  getWallet,
  getPaymentHistory,
  getPaymentDetails,
  withdraw,
  downloadPayments,
  checkoutBooking,
};
