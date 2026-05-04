import { model, Schema } from 'mongoose';
import { IService } from './service.interface';
import { generateCustomId } from '../../../utils/idGenerator';

const serviceSchema = new Schema<IService>(
  {
    creator: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    image: {
      type: String,
      required: true,
    },
    category: {
      type: String,
      required: true,
    },
    subCategory: {
      type: String,
      required: true,
    },
    price: {
      type: Number,
      required: true,
    },
    expertise: {
      type: String,
      default: '',
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
    isSuspended: {
      type: Boolean,
      default: false,
    },
    customId: {
      type: String,
      unique: true,
      sparse: true,
    },
    isCreatorSubscribed: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

serviceSchema.index({ category: 1, subCategory: 1 });
serviceSchema.index({ creator: 1 });
serviceSchema.index({ price: 1 });
serviceSchema.index({ isDeleted: 1, isSuspended: 1 });
serviceSchema.index({ createdAt: -1 });

serviceSchema.pre('save', async function (next) {
  if (this.isNew && !this.customId) {
    this.customId = await generateCustomId('SVC');
  }
  next();
});

export const Service = model<IService>('Service', serviceSchema);
