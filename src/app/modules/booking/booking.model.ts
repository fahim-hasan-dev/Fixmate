import { Document, model, Schema } from 'mongoose';
import { IBooking } from './booking.interface';
import { BOOKING_STATUS } from '../../../enum/booking';
import { generateCustomId } from '../../../utils/idGenerator';

const bookingSchema = new Schema<IBooking>(
  {
    customer: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    provider: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    service: {
      type: Schema.Types.ObjectId,
      ref: 'Service',
    },
    bookingStatus: {
      type: String,
      enum: Object.values(BOOKING_STATUS),
      default: BOOKING_STATUS.CREATED,
    },
    date: {
      type: Date,
      default: Date.now,
    },
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number],
        default: [0, 0],
      },
    },
    address: {
      type: String,
      default: '',
    },
    specialNote: {
      type: String,
      default: '',
    },
    paymentId: {
      type: String,
      default: '',
    },

    transactionId: {
      type: String,
    },
    customId: {
      type: String,
      unique: true,
      sparse: true,
    },
    cancelReason: {
      type: String,
      default: '',
    },
    cancelledBy: {
      type: String,
      enum: ['CLIENT', 'PROVIDER'],
    },
    isPaid: {
      type: Boolean,
      default: false,
    },
    respondedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

bookingSchema.index({ customer: 1, bookingStatus: 1 });
bookingSchema.index({ provider: 1, bookingStatus: 1 });
bookingSchema.index({ createdAt: -1 });

bookingSchema.index({ location: '2dsphere' });

bookingSchema.pre('save', async function (this: IBooking & Document, next) {
  if (this.isNew && !this.customId) {
    this.customId = await generateCustomId('BKG');
  }
  next();
});

export const Booking = model<IBooking>('Booking', bookingSchema);
