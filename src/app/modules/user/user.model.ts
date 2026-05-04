import mongoose, { Schema, Types } from 'mongoose';
import bcrypt from 'bcrypt';
import { IUser, UserModel } from './user.interface';
import { GENDER, USER_ROLES, USER_STATUS, VERIFICATION_STATUS } from '../../../enum/user';
import { SERVICE_DAY } from '../../../enum/service';
import { StatusCodes } from 'http-status-codes';
import ApiError from '../../../errors/ApiError';
import config from '../../../config';
import { generateCustomId } from '../../../utils/idGenerator';

const UserSchema = new Schema<IUser, UserModel>(
  {
    name: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
    },
    password: {
      type: String,
      required: true,
      select: 0,
    },
    image: {
      type: String,
      default: '',
    },
    contact: {
      type: String,
      default: '',
    },
    whatsApp: {
      type: String,
      default: '',
    },
    dateOfBirth: {
      type: String,
      default: '',
    },
    gender: {
      type: String,
      enum: Object.values(GENDER),
      default: GENDER.MALE,
    },
    address: {
      type: String,
      default: '',
    },
    role: {
      type: String,
      enum: Object.values(USER_ROLES),
      required: true,
    },

    status: {
      type: String,
      enum: Object.values(USER_STATUS),
      default: USER_STATUS.ACTIVE,
    },
    location: {
      type: {
        type: String,
        default: 'Point',
      },
      coordinates: {
        type: [Number],
        default: [0, 0],
      },
    },
    verified: {
      type: Boolean,
      default: false,
    },
    fcmToken: {
      type: String,
      default: '',
    },
    authentication: {
      type: {
        restrictionLeftAt: {
          type: Date,
          default: null,
        },
        resetPassword: {
          type: Boolean,
          default: false,
        },
        wrongLoginAttempts: {
          type: Number,
          default: 0,
        },
        passwordChangedAt: {
          type: Date,
        },
        oneTimeCode: {
          type: String,
          default: '',
        },
        latestRequestAt: {
          type: Date,
          default: Date.now,
        },
        expiresAt: {
          type: Date,
        },
        requestCount: {
          type: Number,
          default: 0,
        },
        authType: {
          type: String,
          enum: ['createAccount', 'resetPassword'],
        },
      },
      select: 0,
    },
    customId: { type: String, unique: true, sparse: true },
    providerDetails: {
      type: {
        category: {
          type: String,
          default: '',
        },
        nationalId: {
          type: String,
          default: '',
        },
        nationality: {
          type: String,
          default: '',
        },
        experience: {
          type: String,
          default: '',
        },
        language: {
          type: String,
          default: '',
        },
        overView: {
          type: String,
          default: '',
        },
        wallet: {
          type: Number,
          default: 0,
        },
        availableDay: {
          type: [String],
          enum: Object.values(SERVICE_DAY),
          default: [],
        },
        startTime: {
          type: String,
          default: '',
        },
        endTime: {
          type: String,
          default: '',
        },
        isVatRegistered: {
          type: Boolean,
          default: false,
        },
        vatNumber: {
          type: String,
          required: false,
        },
        companyName: {
          type: String,
          default: '',
        },
        serviceDistance: {
          type: Number,
          default: 50,
        },
        companyRegistrationNumber: {
          type: String,
        },
        paystackRecipientCode: {
          type: String,
          default: '',
        },
        paystackAccountId: {
          type: String,
          default: '',
        },
        bankName: {
          type: String,
          default: '',
        },
        accountNumber: {
          type: String,
          default: '',
        },
        rankingScore: { type: Number, default: 0 },
        totalRating: { type: Number, default: 0 },
        averageRating: { type: Number, default: 0 },
        verificationStatus: {
          type: String,
          enum: Object.values(VERIFICATION_STATUS),
          default: VERIFICATION_STATUS.UNVERIFIED,
        },
        metrics: {
          acceptedJobs: { type: Number, default: 0 },
          declinedJobs: { type: Number, default: 0 },
          completedJobs: { type: Number, default: 0 },
          totalReceivedJobs: { type: Number, default: 0 },
          disputedJobs: { type: Number, default: 0 },
          totalResponseTime: { type: Number, default: 0 },
          totalResponseCount: { type: Number, default: 0 },
        },
        subscription: {
          isSubscribed: { type: Boolean, default: false },
          platform: { type: String, enum: ['none', 'apple', 'google'], default: 'none' },
          status: { type: String, enum: ['active', 'canceled', 'expired', 'past_due', 'none'], default: 'none' },
          expiryDate: { type: Date, default: null },
          originalTransactionId: { type: String, default: null },
          latestReceiptToken: { type: String, default: null },
        },
      },
      required: false,
      _id: false,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

UserSchema.index({ role: 1, status: 1 });
UserSchema.index({ verified: 1 });
UserSchema.index({ 'providerDetails.verificationStatus': 1 });
UserSchema.index({ 'providerDetails.rankingScore': -1 });

UserSchema.index({ location: '2dsphere' });

UserSchema.virtual('providerDetails.metrics.acceptance_rate').get(function (this: IUser) {
  const metrics = this.providerDetails?.metrics;
  if (!metrics) return 0;
  const totalReceivedJobs = metrics.totalReceivedJobs || 0;
  const acceptedJobs = metrics.acceptedJobs || 0;
  return totalReceivedJobs > 0 ? Math.round((acceptedJobs / totalReceivedJobs) * 100) : 0;
});

UserSchema.virtual('providerDetails.metrics.decline_rate').get(function (this: IUser) {
  const metrics = this.providerDetails?.metrics;
  if (!metrics) return 0;
  const totalReceivedJobs = metrics.totalReceivedJobs || 0;
  const declinedJobs = metrics.declinedJobs || 0;
  return totalReceivedJobs > 0 ? Math.round((declinedJobs / totalReceivedJobs) * 100) : 0;
});

UserSchema.virtual('providerDetails.metrics.averageResponseTime').get(function (this: IUser) {
  const metrics = this.providerDetails?.metrics;
  if (!metrics) return 'N/A';
  const totalResponseCount = metrics.totalResponseCount || 0;
  const totalResponseTime = metrics.totalResponseTime || 0;

  if (totalResponseCount === 0) return 'N/A';

  const avgMs = totalResponseTime / totalResponseCount;
  const totalMinutes = Math.round(avgMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) return `${hours} hr ${minutes} min`;
  return `${minutes} min`;
});

UserSchema.virtual('providerDetails.metrics.completion_rate').get(function (this: IUser) {
  const metrics = this.providerDetails?.metrics;
  if (!metrics) return 0;
  const acceptedJobs = metrics.acceptedJobs || 0;
  const completedJobs = metrics.completedJobs || 0;
  return acceptedJobs > 0 ? Math.round((completedJobs / acceptedJobs) * 100) : 0;
});

UserSchema.virtual('providerDetails.metrics.dispute_rate').get(function (this: IUser) {
  const metrics = this.providerDetails?.metrics;
  if (!metrics) return 0;
  const acceptedJobs = metrics.acceptedJobs || 0;
  const disputedJobs = metrics.disputedJobs || 0;
  return acceptedJobs > 0 ? Math.round((disputedJobs / acceptedJobs) * 100) : 0;
});

UserSchema.statics.isPasswordMatched = async function (
  givenPassword: string,
  savedPassword: string,
) {
  return bcrypt.compare(givenPassword, savedPassword);
};

UserSchema.statics.isExistUserById = async function (id: string) {
  return await this.findById(id).select('+password');
};

UserSchema.statics.isExistUserByEmail = async function (email: string) {
  return await this.findOne({ email }).select('+password');
};

UserSchema.statics.updateRankingScore = async function (
  providerId: string | Types.ObjectId,
  session?: mongoose.ClientSession,
) {
  const user = await this.findById(providerId).session(session || null).lean().exec();
  if (!user || user.role !== USER_ROLES.PROVIDER) return;

  const metrics = user.providerDetails?.metrics || {};
  const acceptedJobs = metrics.acceptedJobs || 0;
  const completedJobs = metrics.completedJobs || 0;
  const totalReceivedJobs = metrics.totalReceivedJobs || 0;
  const totalResponseCount = metrics.totalResponseCount || 0;
  const totalResponseTime = metrics.totalResponseTime || 0;

  const completionRate = acceptedJobs > 0 ? (completedJobs / acceptedJobs) * 100 : 0;
  const acceptanceRate = totalReceivedJobs > 0 ? (acceptedJobs / totalReceivedJobs) * 100 : 0;
  const avgResponseTime = totalResponseCount > 0 ? totalResponseTime / totalResponseCount : 0;

  const ratingResult = await mongoose
    .model('Review')
    .aggregate([
      { $match: { provider: new Types.ObjectId(providerId as string) } },
      { $group: { _id: null, avgRating: { $avg: '$rating' }, totalRating: { $sum: 1 } } },
    ])
    .session(session || null);

  const avgRating = ratingResult.length > 0 ? ratingResult[0].avgRating || 0 : 0;
  const totalRating = ratingResult.length > 0 ? ratingResult[0].totalRating || 0 : 0;

  const oneDayInMs = 24 * 60 * 60 * 1000;
  const oneHourInMs = 60 * 60 * 1000;
  const responseTimeFactor = Math.max(
    0,
    100 - (Math.max(0, avgResponseTime - oneHourInMs) / (oneDayInMs - oneHourInMs)) * 100,
  );

  const score =
    (completionRate || 0) * 0.4 +
    (acceptanceRate || 0) * 0.3 +
    ((avgRating || 0) / 5) * 100 * 0.2 +
    (responseTimeFactor || 0) * 0.1;

  const finalScore = isNaN(score) ? 0 : Math.round(score * 100) / 100;

  await this.findByIdAndUpdate(
    providerId,
    { 
      'providerDetails.rankingScore': finalScore,
      'providerDetails.totalRating': totalRating,
      'providerDetails.averageRating': Math.round((avgRating) * 10) / 10,
    },
    { session: session || null },
  );
};

UserSchema.pre('save', async function (this: IUser & mongoose.Document, next) {
  try {
    if (this.isNew && !this.customId) {
      const prefix = this.role === USER_ROLES.PROVIDER ? 'PRV' : 'USR';
      this.customId = await generateCustomId(prefix);
    }
    if (this.isModified('email')) {
      const isExist = await User.findOne({
        email: this.email,
        status: { $in: [USER_STATUS.ACTIVE, USER_STATUS.BLOCKED] },
        _id: { $ne: this._id },
      });

      if (isExist) {
        return next(
          new ApiError(StatusCodes.BAD_REQUEST, 'An account with this email address already exists. Please use a different email or log in to your account.'),
        );
      }
    }
    if (this.isModified('password')) {
      this.password = await bcrypt.hash(this.password, Number(config.bcrypt_salt_rounds));
    }
    next();
  } catch (error) {
    next(error as Error);
  }
});

export const User = mongoose.model<IUser, UserModel>('User', UserSchema);
