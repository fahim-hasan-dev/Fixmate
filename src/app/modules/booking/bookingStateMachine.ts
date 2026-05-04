import mongoose, { Types } from 'mongoose';
import { Booking } from './booking.model';
import { BOOKING_STATUS } from '../../../enum/booking';
import ApiError from '../../../errors/ApiError';
import { StatusCodes } from 'http-status-codes';
import { User } from '../user/user.model';
import { handleBookingSettlement } from '../payment/payment.utils';
import { NotificationService } from '../notification/notification.service';
import { Service } from '../service/service.model';
import { cancelBookingCleanup, cancelScheduledSettlement, scheduleAutoSettlement } from '../../queues/queueUtils';

const VALID_TRANSITIONS: Record<string, BOOKING_STATUS[]> = {
  [BOOKING_STATUS.CREATED]: [BOOKING_STATUS.REQUESTED, BOOKING_STATUS.CANCELLED],
  [BOOKING_STATUS.REQUESTED]: [
    BOOKING_STATUS.ACCEPTED,
    BOOKING_STATUS.CANCELLED,
  ],
  [BOOKING_STATUS.ACCEPTED]: [BOOKING_STATUS.IN_PROGRESS, BOOKING_STATUS.CANCELLED],
  [BOOKING_STATUS.IN_PROGRESS]: [
    BOOKING_STATUS.COMPLETED_BY_PROVIDER,
    BOOKING_STATUS.DISPUTED,
    BOOKING_STATUS.CANCELLED,
  ],
  [BOOKING_STATUS.COMPLETED_BY_PROVIDER]: [
    BOOKING_STATUS.CONFIRMED_BY_CLIENT,
    BOOKING_STATUS.SETTLED,
    BOOKING_STATUS.DISPUTED,
    BOOKING_STATUS.AUTO_SETTLED,
  ],
  [BOOKING_STATUS.CONFIRMED_BY_CLIENT]: [BOOKING_STATUS.SETTLED],
  [BOOKING_STATUS.SETTLED]: [BOOKING_STATUS.DISPUTED],
  [BOOKING_STATUS.AUTO_SETTLED]: [BOOKING_STATUS.DISPUTED],

  [BOOKING_STATUS.CANCELLED]: [],
  [BOOKING_STATUS.DISPUTED]: [
    BOOKING_STATUS.SETTLED,
    BOOKING_STATUS.CANCELLED,
  ],

};

export class BookingStateMachine {
  static async transitionState(
    bookingId: string | Types.ObjectId,
    role: 'client' | 'provider' | 'admin' | 'system',
    targetState: BOOKING_STATUS,
    reason: string = '',
    session?: mongoose.ClientSession
  ) {
    return this.executeTransition(bookingId, role, targetState, reason, false, session);
  }

  static async adminForceState(
    bookingId: string | Types.ObjectId,
    targetState: BOOKING_STATUS,
    reason: string,
    session?: mongoose.ClientSession
  ) {
    if (!reason?.trim())
      throw new ApiError(StatusCodes.BAD_REQUEST, 'Please provide a reason why you are manually changing the booking status.');
    return this.executeTransition(bookingId, 'admin', targetState, `[ADMIN FORCE] ${reason}`, true, session);
  }

  private static async executeTransition(
    bookingId: string | Types.ObjectId,
    _role: string,
    targetState: BOOKING_STATUS,
    _reason: string,
    isForce: boolean,
    session?: mongoose.ClientSession
  ) {
    const query = Booking.findById(bookingId);
    if (session) query.session(session);
    const booking = await query;
    if (!booking) throw new ApiError(StatusCodes.NOT_FOUND, 'We couldn\'t find the booking record in our system.');

    const currentState = booking.bookingStatus as BOOKING_STATUS;
    const allowedTransitions = VALID_TRANSITIONS[currentState] || [];

    // Validation
    if (!isForce && !allowedTransitions.includes(targetState)) {
      throw new ApiError(
        StatusCodes.BAD_REQUEST,
        `This booking cannot be moved from its current status (${currentState}) to the requested status (${targetState}). Please refresh and try again.`
      );
    }

    // Update Status
    booking.bookingStatus = targetState;

    const now = new Date();
    const responseTime = now.getTime() - booking.createdAt.getTime();

    const metricsUpdate: any = { $inc: {}, $set: {} };

    if (targetState === BOOKING_STATUS.ACCEPTED) {
      metricsUpdate.$inc['providerDetails.metrics.acceptedJobs'] = 1;
      metricsUpdate.$inc['providerDetails.metrics.totalResponseTime'] = responseTime;
      metricsUpdate.$inc['providerDetails.metrics.totalResponseCount'] = 1;
      booking.respondedAt = now;
    } else if (targetState === BOOKING_STATUS.COMPLETED_BY_PROVIDER) {
      metricsUpdate.$inc['providerDetails.metrics.completedJobs'] = 1;
    } else if (targetState === BOOKING_STATUS.DISPUTED) {
      metricsUpdate.$inc['providerDetails.metrics.disputedJobs'] = 1;
    } else if (targetState === BOOKING_STATUS.CANCELLED && currentState === BOOKING_STATUS.REQUESTED && _role === 'provider') {
      // If provider cancels at the requested stage, it counts as a decline
      metricsUpdate.$inc['providerDetails.metrics.declinedJobs'] = 1;
      metricsUpdate.$inc['providerDetails.metrics.totalResponseTime'] = responseTime;
      metricsUpdate.$inc['providerDetails.metrics.totalResponseCount'] = 1;
      booking.respondedAt = now;
    }

    if (Object.keys(metricsUpdate.$inc).length > 0 || Object.keys(metricsUpdate.$set).length > 0) {
      await User.findByIdAndUpdate(booking.provider, metricsUpdate, session ? { session } : undefined);
      await (User as any).updateRankingScore(booking.provider, session);
    }

    await booking.save(session ? { session } : undefined);

    if (currentState === BOOKING_STATUS.CREATED) {
      await cancelBookingCleanup(bookingId.toString());
    }

    // BullMQ - Handle exact-time auto-settlement scheduling
    if (targetState === BOOKING_STATUS.COMPLETED_BY_PROVIDER) {
      await scheduleAutoSettlement(bookingId.toString());
    } else if (
      targetState === BOOKING_STATUS.SETTLED ||
      targetState === BOOKING_STATUS.CONFIRMED_BY_CLIENT ||
      targetState === BOOKING_STATUS.DISPUTED ||
      targetState === BOOKING_STATUS.CANCELLED
    ) {
      await cancelScheduledSettlement(bookingId.toString());
    }

    if (targetState === BOOKING_STATUS.SETTLED || targetState === BOOKING_STATUS.AUTO_SETTLED) {
      await handleBookingSettlement(bookingId.toString(), session);
    }

    // Send notifications for status transitions
    await this.sendStateNotification(booking, targetState, _role, _reason);

    // Emit real-time socket event for both customer and provider
    if (global.io) {
      const eventData = {
        bookingId: booking._id,
        status: targetState,
        customer: booking.customer,
        provider: booking.provider,
        updatedAt: new Date()
      };
      
      global.io.emit(`booking_status_updated::${booking.customer.toString()}`, eventData);
      global.io.emit(`booking_status_updated::${booking.provider.toString()}`, eventData);
    }

    return booking;
  }

  private static async sendStateNotification(booking: any, status: BOOKING_STATUS, role: string, reason: string) {
    try {
      const service = await Service.findById(booking.service).select('category subCategory').lean();
      const serviceName = service?.subCategory || service?.category || 'Service';

      let notificationTarget: any = null;
      let message = '';

      switch (status) {
        case BOOKING_STATUS.REQUESTED:
          notificationTarget = booking.provider;
          message = `Great news! You have a new booking request for ${serviceName}. Please check the details and respond soon.`;
          break;
        case BOOKING_STATUS.ACCEPTED:
          notificationTarget = booking.customer;
          message = `Your booking for ${serviceName} has been accepted! The provider will be with you shortly.`;
          break;
        case BOOKING_STATUS.IN_PROGRESS:
          notificationTarget = booking.customer;
          message = `Work has started on your ${serviceName} booking. You can track the progress through the app.`;
          break;
        case BOOKING_STATUS.COMPLETED_BY_PROVIDER:
          notificationTarget = booking.customer;
          message = `Your ${serviceName} job is finished! The provider has marked it as complete. Please take a moment to review and confirm.`;
          break;
        case BOOKING_STATUS.CONFIRMED_BY_CLIENT:
          notificationTarget = booking.provider;
          message = `The client has confirmed that the ${serviceName} job is complete. Thank you for your service!`;
          break;
        case BOOKING_STATUS.CANCELLED:
          notificationTarget = role === 'client' ? booking.provider : booking.customer;
          message = `We're sorry to inform you that your booking for ${serviceName} was cancelled by the ${role}. ${reason ? `Reason: ${reason}` : ''}`;
          break;
        case BOOKING_STATUS.DISPUTED:
          // Notify the other party when one raises a dispute
          notificationTarget = role === 'client' ? booking.provider : booking.customer;
          message = `A dispute has been raised for the booking ${serviceName}.`;
          break;

        case BOOKING_STATUS.SETTLED:
        case BOOKING_STATUS.AUTO_SETTLED:
          notificationTarget = booking.provider;
          message = `Your earnings for the ${serviceName} job have been added to your wallet. Well done!`;
          break;
      }

      if (notificationTarget && message) {
        await NotificationService.insertNotification({
          for: notificationTarget,
          message,
        });
      }
    } catch (error) {
      console.error('Notification Error in State Machine:', error);
    }
  }
}
