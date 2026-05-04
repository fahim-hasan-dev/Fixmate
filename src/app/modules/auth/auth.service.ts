// Auth Service
import { StatusCodes } from 'http-status-codes';
import { IAuthResponse, IResetPassword } from './auth.interface';
import { User } from '../user/user.model';
import ApiError from '../../../errors/ApiError';
import { USER_ROLES, USER_STATUS } from '../../../enum/user';
import { AuthHelper } from './auth.helper';
import { AuthCommonServices, authResponse } from './common';
import { ILoginData } from '../../../interfaces/auth';
import { emailTemplate } from '../../../shared/emailTemplate';
import { notificationQueue } from '../../queues';
import { cancelUnverifiedCleanup, scheduleUnverifiedCleanup } from '../../queues/queueUtils';
import { JwtPayload } from 'jsonwebtoken';
import { jwtHelper } from '../../../helpers/jwtHelper';
import config from '../../../config';
import bcrypt from 'bcrypt';
import cryptoToken, { generateOtp } from '../../../utils/crypto';
import { Token } from '../token/token.model';
import { IUser } from '../user/user.interface';
import mongoose from 'mongoose';

// Create a new user account with OTP verification
export const createUser = async (payload: IUser) => {
  payload.email = payload.email?.toLowerCase().trim();
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    if (payload.role === USER_ROLES.ADMIN) {
      throw new ApiError(StatusCodes.BAD_REQUEST, `Admin accounts cannot be created this way. Please contact the administrator.`);
    }

    const isUserExist = await User.findOne({
      email: payload.email,
      status: { $nin: [USER_STATUS.DELETED] },
    }).session(session).lean();

    if (isUserExist) {
      throw new ApiError(StatusCodes.BAD_REQUEST, `An account is already registered with this email address. Try logging in instead.`);
    }

    const otp = generateOtp();
    const otpExpiresIn = new Date(Date.now() + 5 * 60 * 1000);

    const authentication = {
      oneTimeCode: otp,
      expiresAt: otpExpiresIn,
      latestRequestAt: new Date(),
      requestCount: 1,
      authType: 'createAccount' as const,
      restrictionLeftAt: null,
      resetPassword: false,
      wrongLoginAttempts: 0,
    };

    const userData: any = {
      ...payload,
      password: payload.password,
      authentication,
      role: payload.role || USER_ROLES.CLIENT,
    };

    if (userData.role !== USER_ROLES.PROVIDER) {
      delete userData.providerDetails;
    } else if (!userData.providerDetails) {
      userData.providerDetails = {};
    }

    const user = await User.create([userData], { session });

    if (!user[0]) throw new ApiError(StatusCodes.BAD_REQUEST, 'We were unable to create your account at this time. Please try again or contact support.');

    const createdUser = user[0];

    const createAccountEmail = emailTemplate.createAccount({
      name: payload.name,
      email: payload.email,
      otp,
    });
    
    await notificationQueue.add('send-email', createAccountEmail);
    await scheduleUnverifiedCleanup(createdUser._id.toString());

    await session.commitTransaction();
    return createdUser._id;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

// Authenticate a user and return tokens
const login = async (payload: ILoginData): Promise<IAuthResponse> => {
  const { email, phone } = payload;
  const query = email ? { email: email.toLowerCase().trim() } : { phone: phone };

  const isUserExist = await User.findOne({
    ...query,
    status: { $in: [USER_STATUS.ACTIVE] },
  })
    .select('+password +authentication')
    .lean();

  if (!isUserExist) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      `We couldn't find an account with that ${email ? 'email address' : 'phone number'}. Please check your entry or sign up for a new account.`,
    );
  }

  const result = await AuthCommonServices.handleLoginLogic(payload, isUserExist);
  return result;
};

// Authenticate an admin user and return tokens
const adminLogin = async (payload: ILoginData): Promise<IAuthResponse> => {
  const { email, phone } = payload;
  const query = email ? { email: email.trim().toLowerCase() } : { phone: phone };

  const isUserExist = await User.findOne({
    ...query,
  })
    .select('+password +authentication')
    .lean();

  if (!isUserExist) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      `We couldn't find an account with that ${email ? 'email address' : 'phone number'}. Please check your entry or sign up for a new account.`,
    );
  }

  if (isUserExist.role !== USER_ROLES.ADMIN) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'You do not have the necessary permissions to log in as an administrator.');
  }

  const isPasswordMatch = await AuthHelper.isPasswordMatched(
    payload.password,
    isUserExist.password as string,
  );

  if (!isPasswordMatch) {
    throw new ApiError(StatusCodes.UNAUTHORIZED, 'The password you entered is incorrect. Please try again.');
  }

  const tokens = AuthHelper.createToken(
    isUserExist._id,
    isUserExist.role,
    isUserExist.name,
    isUserExist.email,
  );

  return authResponse(
    StatusCodes.OK,
    `Welcome back ${isUserExist.name}`,
    isUserExist.role,
    tokens.accessToken,
    tokens.refreshToken,
  );
};

// Handle forgot password request and send OTP
const forgetPassword = async (email?: string, phone?: string) => {
  const query = email ? { email: email.toLocaleLowerCase().trim() } : { phone: phone };
  const isUserExist = await User.findOne({
    ...query,
    status: { $in: [USER_STATUS.ACTIVE] },
  }).lean();

  if (!isUserExist) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'We couldn\'t find an account matching that email or phone number.');
  }

  const otp = generateOtp();

  const authentication = {
    resetPassword: true,
    oneTimeCode: otp,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    latestRequestAt: new Date(),
    requestCount: 1,
    authType: 'resetPassword' as const,
    restrictionLeftAt: null,
    wrongLoginAttempts: 0,
  };

  await User.findByIdAndUpdate(
    isUserExist._id,
    {
      $set: { authentication: authentication },
    },
    { new: true },
  );

  if (email) {
    const forgetPasswordEmailTemplate = emailTemplate.resetPassword({
      name: isUserExist.name,
      email: isUserExist.email,
      otp,
    });

    await notificationQueue.add('send-email', forgetPasswordEmailTemplate);
  }

  return 'OTP sent successfully.';
};

// Reset user password using a verified token
const resetPassword = async (resetToken: string, payload: IResetPassword) => {
  const { newPassword, confirmPassword } = payload;
  if (newPassword !== confirmPassword) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'The passwords you entered don\'t match. Please make sure they are exactly the same.');
  }

  const isTokenExist = await Token.isExistToken(resetToken);

  if (!isTokenExist) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      "To reset your password, please verify your account first for your security.",
    );
  }

  const isUserExist = await User.findById(isTokenExist.user).select('+authentication').lean();
  console.log(isUserExist);

  if (!isUserExist) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      'We couldn\'t find your account. Please try again or reach out to our support team.',
    );
  }

  const { authentication } = isUserExist;
  if (!authentication?.resetPassword) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      'You\'ll need to request a new password reset to proceed. Please click on "Forgot Password" again.',
    );
  }

  const isTokenValid = await Token.isExpireToken(resetToken);
  if (!isTokenValid) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'This password reset link has expired. Please request a new one to continue.');
  }

  const hashPassword = await bcrypt.hash(newPassword, Number(config.bcrypt_salt_rounds));

  const updatedUserData = {
    password: hashPassword,
    authentication: {
      resetPassword: false,
      oneTimeCode: '',
      expiresAt: null,
      latestRequestAt: new Date(),
      requestCount: 0,
      restrictionLeftAt: null,
      wrongLoginAttempts: 0,
    },
  };

  await User.findByIdAndUpdate(isUserExist._id, { $set: updatedUserData }, { new: true });

  return { message: 'Password reset successfully' };
};

// Verify user account or reset code using OTP
const verifyAccount = async (email: string, onetimeCode: string): Promise<IAuthResponse> => {
  if (!onetimeCode) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Please enter the verification code to continue.');
  }
  const isUserExist = await User.findOne({
    email: email.toLowerCase().trim(),
    status: { $nin: [USER_STATUS.DELETED] },
  })
    .select('+password +authentication')
    .lean();

  if (!isUserExist) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      `We couldn't find an account associated with ${email}. Please sign up for a new account to continue.`,
    );
  }

  const { authentication } = isUserExist;

  if (authentication?.oneTimeCode !== onetimeCode) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'The verification code you entered is incorrect. Please double-check it and try again.');
  }

  const currentDate = new Date();
  if (authentication?.expiresAt! < currentDate) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'This verification code has expired for your security. Please request a new code to continue.');
  }

  if (!isUserExist.verified) {
    await User.findByIdAndUpdate(isUserExist._id, { $set: { verified: true } }, { new: true });
    await cancelUnverifiedCleanup(isUserExist._id.toString());

    const tokens = AuthHelper.createToken(
      isUserExist._id,
      isUserExist.role,
      isUserExist.name,
      isUserExist.email,
    );
    const userInfo = {
      id: isUserExist._id,
      role: isUserExist.role,
      name: isUserExist.name,
      email: isUserExist.email!,
      image: isUserExist.image!,
    };

    return authResponse(
      StatusCodes.OK,
      `Welcome ${isUserExist.name} to our platform.`,
      undefined,
      tokens.accessToken,
      tokens.refreshToken,
      undefined,
      userInfo,
    );
  } else {
    await User.findByIdAndUpdate(
      isUserExist._id,
      {
        $set: {
          authentication: {
            oneTimeCode: '',
            expiresAt: null,
            latestRequestAt: null,
            requestCount: 0,
            authType: '',
            resetPassword: true,
          },
        },
      },
      { new: true },
    );

    const token = await Token.create({
      token: cryptoToken(),
      user: isUserExist._id,
      expireAt: new Date(Date.now() + 5 * 60 * 1000),
    });
    console.log(token.token);

    if (!token) {
      throw new ApiError(StatusCodes.BAD_REQUEST, 'We encountered a problem during verification. Please try again or reach out to support.');
    }

    return authResponse(
      StatusCodes.OK,
      'OTP verified successfully, please reset your password.',
      undefined,
      undefined,
      undefined,
      token.token,
    );
  }
};

// Generate a new access token using a refresh token
const getAccessToken = async (token: string) => {
  if (!token) {
    throw new ApiError(StatusCodes.UNAUTHORIZED, 'Your session has expired. Please log in again to continue safely.');
  }

  try {
    const decodedToken = jwtHelper.verifyToken(token, config.jwt.jwt_refresh_secret as string);

    const { userId, role } = decodedToken;

    const tokens = AuthHelper.createToken(userId, role, decodedToken.name, decodedToken.email);

    return {
      accessToken: tokens.accessToken,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'TokenExpiredError') {
      throw new ApiError(StatusCodes.UNAUTHORIZED, 'Your session has expired. Please log in again.');
    }
    throw new ApiError(StatusCodes.FORBIDDEN, 'Your session is no longer valid. Please log in again.');
  }
};

// Resend OTP to a user's phone or email
const resendOtpToPhoneOrEmail = async (
  authType: 'resetPassword' | 'createAccount',
  email?: string,
  phone?: string,
) => {
  const query = email ? { email: email } : { phone: phone };
  const isUserExist = await User.findOne({
    ...query,
    status: { $in: [USER_STATUS.ACTIVE] },
  }).select('+authentication');

  if (!isUserExist) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      `We couldn't find an account with that ${email ? 'email address' : 'phone number'}. Please check your entry or sign up for a new account.`,
    );
  }

  const { authentication } = isUserExist;
  if (authentication?.requestCount! >= 5) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      'You have exceeded the maximum number of requests for a code. Please wait a little while before trying again.',
    );
  }

  const otp = generateOtp();
  const updatedAuthentication = {
    ...authentication,
    oneTimeCode: otp,
    latestRequestAt: new Date(),
    requestCount: authentication?.requestCount! + 1,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    authType: authType,
  };

  if (email) {
    const forgetPasswordEmailTemplate = emailTemplate.resendOtp({
      email: isUserExist.email,
      name: isUserExist.name,
      otp,
      type: authType,
    });

    await User.findByIdAndUpdate(
      isUserExist._id,
      {
        $set: { authentication: updatedAuthentication },
      },
      { new: true },
    );

    await notificationQueue.add('send-email', forgetPasswordEmailTemplate);
  }

  if (phone) {
    await User.findByIdAndUpdate(
      isUserExist._id,
      {
        $set: { authentication: updatedAuthentication },
      },
      { new: true },
    );
  }
};

// Soft-delete a user account after password verification
const deleteAccount = async (user: JwtPayload, password: string) => {
  const { authId } = user;
  const isUserExist = await User.findById(authId).select('+password');

  if (!isUserExist) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'We were unable to delete your account. Please check your account details and try again.');
  }

  if (isUserExist.status === USER_STATUS.DELETED) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'This account has already been deleted.');
  }

  const isPasswordMatched = await bcrypt.compare(password, isUserExist.password);

  if (!isPasswordMatched) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      'To verify and delete your account, please enter your correct password.',
    );
  }

  const deletedData = await User.findByIdAndUpdate(authId, {
    $set: { status: USER_STATUS.DELETED },
  });

  return {
    status: StatusCodes.OK,
    message: 'Account deleted successfully.',
    deletedData,
  };
};

// Resend OTP for either account creation or password reset
const resendOtp = async (email: string, authType: 'createAccount' | 'resetPassword') => {
  const isUserExist = await User.findOne({
    email: email.toLowerCase().trim(),
    status: { $in: [USER_STATUS.ACTIVE] },
  }).select('+authentication').lean();

  if (!isUserExist) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      `We couldn't find an account registered with ${email}. Please check the email and try again.`,
    );
  }

  const { authentication } = isUserExist;

  const otp = generateOtp();
  const authenticationPayload = {
    ...authentication,
    oneTimeCode: otp,
    latestRequestAt: new Date(),
    requestCount: authentication?.requestCount! + 1,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
  };

  if (authenticationPayload.requestCount! >= 5) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      'You have reached the limit for code requests. Please wait and try again in a few minutes for your security.',
    );
  }

  await User.findByIdAndUpdate(
    isUserExist._id,
    {
      $set: { authentication: authenticationPayload },
    },
    { new: true },
  );

  if (email) {
    const forgetPasswordEmailTemplate = emailTemplate.resendOtp({
      email: email,
      name: isUserExist.name,
      otp,
      type: authType,
    });

    await notificationQueue.add('send-email', forgetPasswordEmailTemplate);
  }

  return 'OTP sent successfully.';
};

// Change user password for an authenticated user
const changePassword = async (user: JwtPayload, currentPassword: string, newPassword: string) => {
  const isUserExist = await User.findById(user.authId).select('+password').lean();

  if (!isUserExist) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'We were unable to locate your account details.');
  }

  const isPasswordMatch = await AuthHelper.isPasswordMatched(
    currentPassword,
    isUserExist.password as string,
  );

  if (!isPasswordMatch) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'The current password you entered is incorrect. Please check and try again.');
  }

  const hashedPassword = await bcrypt.hash(newPassword, Number(config.bcrypt_salt_rounds));

  await User.findByIdAndUpdate(user.authId, { password: hashedPassword }, { new: true });

  return { message: 'Password changed successfully' };
};

// Update the FCM token for push notifications
const refreshFcmToken = async (user: JwtPayload, token: string) => {
  const result = await User.findByIdAndUpdate(
    user.authId,
    { fcmToken: token },
    { new: true },
  );
  if (!result) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'We couldn\'t find your account to update your notifications.');
  }
};

export const AuthServices = {
  forgetPassword,
  resetPassword,
  verifyAccount,
  login,
  getAccessToken,
  resendOtpToPhoneOrEmail,
  deleteAccount,
  resendOtp,
  changePassword,
  createUser,
  adminLogin,
  refreshFcmToken,
};
