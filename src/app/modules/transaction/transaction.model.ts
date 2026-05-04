import { Schema, model } from 'mongoose';
import { ITransaction } from './transaction.interface';
import { generateCustomId } from '../../../utils/idGenerator';

const transactionSchema = new Schema<ITransaction>(
  {
    type: {
      type: String,
      enum: ['PAYMENT', 'EARNINGS', 'REFUND', 'WITHDRAWAL', 'PENALTY'],
      required: true,
    },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    booking: { type: Schema.Types.ObjectId, ref: 'Booking', default: null },
    amount: { type: Number, required: true },
    fee: { type: Number, required: true },
    netAmount: { type: Number, required: true },
    status: {
      type: String,
      enum: ['PENDING', 'COMPLETED', 'FAILED'],
      required: true,
    },
    p2ptransactionId: { type: String, default: '' },
    customId: { type: String, unique: true, sparse: true },
  },
  { timestamps: true },
);

transactionSchema.pre('save', async function (next) {
  if (this.isNew && !this.customId) {
    this.customId = await generateCustomId('TRX');
  }
  next();
});
transactionSchema.index({ user: 1, type: 1, status: 1 });
transactionSchema.index({ createdAt: -1 });

export const Transaction = model<ITransaction>('Transaction', transactionSchema);
