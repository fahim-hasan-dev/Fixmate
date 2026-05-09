import { Model, Types } from 'mongoose';
import { GENDER, USER_ROLES, USER_STATUS, VERIFICATION_STATUS } from '../../../enum/user';
import { SERVICE_DAY } from '../../../enum/service';
export { USER_ROLES, USER_STATUS };

type IAuthentication = {
  restrictionLeftAt: Date | null;
  resetPassword: boolean;
  wrongLoginAttempts: number;
  passwordChangedAt?: Date;
  oneTimeCode: string;
  latestRequestAt: Date;
  expiresAt?: Date;
  requestCount?: number;
  authType?: 'createAccount' | 'resetPassword';
};

export type IUser = {
  _id: Types.ObjectId;
  customId?: string;
  name: string;
  email: string;
  password: string;
  image?: string;
  contact: string;
  whatsApp: string;
  dateOfBirth: string;
  gender: GENDER;
  address: string;
  location: {
    type: 'Point';
    coordinates: number[];
  };
  role: USER_ROLES;
  fcmToken: string;
  authentication: IAuthentication;
  status: USER_STATUS;
  verified: boolean;
  // provider specific fields
  providerDetails?: {
    category?: string;
    nationalId?: string;
    nationality?: string;
    experience?: string;
    language?: string[];
    overView?: string;
    wallet?: number;
    availableDay?: SERVICE_DAY[];
    startTime?: string;
    endTime?: string;
    isVatRegistered?: boolean;
    vatNumber?: string;
    companyName?: string;
    companyRegistrationNumber?: string;
    paystackRecipientCode?: string;
    paystackAccountId?: string;
    bankName?: string;
    accountNumber?: string;
    rankingScore?: number;
    totalRating?: number;
    averageRating?: number;
    verificationStatus?: VERIFICATION_STATUS;
    serviceDistance?: number;
    metrics?: {
      acceptedJobs?: number;
      declinedJobs?: number;
      completedJobs?: number;
      totalReceivedJobs?: number;
      disputedJobs?: number;
      totalResponseTime?: number;
      totalResponseCount?: number;
      averageResponseTime?: string;
    };
    subscription?: {
      isSubscribed: boolean;
      platform: 'none' | 'apple' | 'google';
      status: 'active' | 'canceled' | 'expired' | 'past_due' | 'none';
      expiryDate: Date | null;
      originalTransactionId: string | null;
      latestReceiptToken: string | null;
    };
  }
};

export type UserModel = {
  isPasswordMatched: (givenPassword: string, savedPassword: string) => Promise<boolean>;
  isExistUserByEmail(email: string): Promise<IUser | null>;
  updateRankingScore(providerId: string | Types.ObjectId): Promise<void>;
  isExistUserById(id: string): Promise<IUser | null>;
} & Model<IUser>;
