import mongoose, { Types } from 'mongoose';
import { StatusCodes } from 'http-status-codes';
import ApiError from '../../../errors/ApiError';
import { Payment } from './payment.model';
import { User } from '../user/user.model';
import { settlePendingPenaltyDues } from '../penalty/penalty.utils';
import { TransactionService } from '../transaction/transaction.service';
import { NotificationService } from '../notification/notification.service';
import { invalidateProfileCache } from '../../utils/cacheUtils';

export const handleBookingSettlement = async (bookingId: string, session?: mongoose.ClientSession) => {
  try {
    const payment = await Payment.findOne({ booking: new Types.ObjectId(bookingId) }).session(session || null);
    if (!payment || !payment.provider) throw new ApiError(StatusCodes.NOT_FOUND, 'We couldn\'t find a payment record for this booking.');

    if (payment.isSettled) {
      return; // Already settled
    }

    const providerId = payment.provider.toString();
    const providerPay = payment.providerPay;

    // Settle pending penalty dues automatically from provider's earnings
    const creditAmount = await settlePendingPenaltyDues(providerId, providerPay);

    // Credit provider wallet
    await User.findByIdAndUpdate(providerId, {
      $inc: { 'providerDetails.wallet': creditAmount, 'providerDetails.metrics.totalReceivedJobs': 1 },
    }, { session });

    // Sync profile cache to reflect new wallet balance
    await invalidateProfileCache(providerId);

    // Update Payment record status
    payment.isSettled = true;
    await payment.save({ session });

    await TransactionService.recordTransaction({
      type: 'EARNINGS',
      user: providerId,
      booking: bookingId,
      amount: providerPay,
      status: 'COMPLETED',
    });

    await NotificationService.insertNotification({
      for: payment.provider as any,
      message: `Great news! The booking has been settled. $${creditAmount.toFixed(2)} has been added to your wallet after any necessary adjustments.`,
    });
  } catch (error) {
    console.error('Booking Settlement Error:', error);
    throw error;
  }
};
