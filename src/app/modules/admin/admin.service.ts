import { USER_ROLES, USER_STATUS } from '../../../enum/user';
import { User } from '../user/user.model';
import { Booking } from '../booking/booking.model';
import { Payment } from '../payment/payment.model';
import QueryBuilder from '../../builder/QueryBuilder';
import { BOOKING_STATUS } from '../../../enum/booking';
import { PAYMENT_STATUS } from '../../../enum/payment';
import { Penalty } from '../penalty/penalty.model';

// Get platform overview statistics (users, providers, bookings, revenue)
export const overview = async (yearChart: string, startDate?: string, endDate?: string) => {
  const dateQuery: any = {};
  if (startDate || endDate) {
    dateQuery.createdAt = {};
    if (startDate) dateQuery.createdAt.$gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setUTCHours(23, 59, 59, 999);
      dateQuery.createdAt.$lte = end;
    }
  }

  const totalProviders = await User.countDocuments({ role: USER_ROLES.PROVIDER, ...dateQuery });
  const totalUsers = await User.countDocuments({ role: { $ne: USER_ROLES.ADMIN }, ...dateQuery });
  const upCommingOrders = await Booking.countDocuments({ bookingStatus: BOOKING_STATUS.ACCEPTED });

  const topProviders = await User.aggregate([
    {
      $match: {
        role: USER_ROLES.PROVIDER,
        status: USER_STATUS.ACTIVE,
        verified: true,
      },
    },
    {
      $sort: {
        'providerDetails.metrics.completedJobs': -1,
        'providerDetails.averageRating': -1,
      },
    },
    { $limit: 10 },
    {
      $project: {
        _id: 0,
        userId: '$_id',
        name: 1,
        image: 1,
        category: '$providerDetails.category',
        reviewCount: '$providerDetails.totalRating',
        avgRating: { $round: ['$providerDetails.averageRating', 2] },
        completedJobs: '$providerDetails.metrics.completedJobs',
      },
    },
  ]);

  const recentServices = await Booking.find({ bookingStatus: { $ne: BOOKING_STATUS.CREATED } })
    .select('provider bookingStatus customer date service customId paymentId createdAt')
    .populate('provider', 'name contact address providerDetails.category')
    .populate('customer', 'name')
    .populate('service', 'price')
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();

  const payments = await Payment.find({
    booking: { $in: recentServices.map((b) => b._id) },
  }).select('booking paymentStatus');

  const enhancedRecentServices = recentServices.map((service) => {
    const payment = payments.find((p) => p.booking && p.booking.toString() === service._id.toString());
    return {
      ...service,
      paymentStatus: payment ? payment.paymentStatus : null,
    };
  });

  const [{ totalClientPenalty = 0 } = {}] = await Penalty.aggregate([
    { $match: { type: 'CLIENT', ...dateQuery } },
    { $group: { _id: null, totalClientPenalty: { $sum: '$taken' } } },
  ]);

  const [{ totalProviderPenalty = 0 } = {}] = await Penalty.aggregate([
    { $match: { type: 'PROVIDER', amount: 30, ...dateQuery } },
    { $group: { _id: null, totalProviderPenalty: { $sum: '$taken' } } },
  ]);

  const [{ totalRevenueValue = 0 } = {}] = await Payment.aggregate([
    {
      $lookup: {
        from: 'bookings',
        localField: 'booking',
        foreignField: '_id',
        as: 'bookingDetails',
      },
    },
    { $unwind: '$bookingDetails' },
    {
      $match: {
        'bookingDetails.bookingStatus': { $in: [BOOKING_STATUS.SETTLED, BOOKING_STATUS.AUTO_SETTLED] },
        ...dateQuery
      }
    },
    { $group: { _id: null, totalRevenueValue: { $sum: '$servicePrice' } } },
  ]);

  const [{ totalPlatformFee = 0 } = {}] = await Payment.aggregate([
    {
      $lookup: {
        from: 'bookings',
        localField: 'booking',
        foreignField: '_id',
        as: 'bookingDetails',
      },
    },
    { $unwind: '$bookingDetails' },
    {
      $match: {
        $or: [
          { 'bookingDetails.bookingStatus': { $in: [BOOKING_STATUS.SETTLED, BOOKING_STATUS.AUTO_SETTLED] } },
          { paymentStatus: PAYMENT_STATUS.PARTIAL_REFUNDED }
        ],
        ...dateQuery
      }
    },
    { $group: { _id: null, totalPlatformFee: { $sum: '$platformFee' } } },
  ]);

  const totalRevenue = totalRevenueValue;
  const totalEarning = totalPlatformFee + totalClientPenalty + totalProviderPenalty;

  const year = Number(yearChart) || new Date().getFullYear();

  const monthlyPlatformFees = await Payment.aggregate([
    {
      $lookup: {
        from: 'bookings',
        localField: 'booking',
        foreignField: '_id',
        as: 'bookingDetails',
      },
    },
    { $unwind: '$bookingDetails' },
    {
      $match: {
        $or: [
          { 'bookingDetails.bookingStatus': { $in: [BOOKING_STATUS.SETTLED, BOOKING_STATUS.AUTO_SETTLED] } },
          { paymentStatus: PAYMENT_STATUS.PARTIAL_REFUNDED }
        ],
        createdAt: {
          $gte: new Date(`${year}-01-01`),
          $lte: new Date(`${year}-12-31`),
        },
      },
    },
    { $group: { _id: { $month: '$createdAt' }, totalProfit: { $sum: '$platformFee' } } },
  ]);

  const monthlyClientPenalties = await Penalty.aggregate([
    {
      $match: {
        type: 'CLIENT',
        taken: { $gt: 0 },
        createdAt: {
          $gte: new Date(`${year}-01-01`),
          $lte: new Date(`${year}-12-31`),
        },
      },
    },
    { $group: { _id: { $month: '$createdAt' }, totalProfit: { $sum: '$taken' } } },
  ]);

  const monthlyProviderPenalties = await Penalty.aggregate([
    {
      $match: {
        type: 'PROVIDER',
        amount: 30,
        taken: { $gt: 0 },
        createdAt: {
          $gte: new Date(`${year}-01-01`),
          $lte: new Date(`${year}-12-31`),
        },
      },
    },
    { $group: { _id: { $month: '$createdAt' }, totalProfit: { $sum: '$taken' } } },
  ]);

  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const monthlyEarning = monthNames.map((name, index) => {
    const monthIndex = index + 1;
    const pf = monthlyPlatformFees.find((m) => m._id === monthIndex)?.totalProfit || 0;
    const cp = monthlyClientPenalties.find((m) => m._id === monthIndex)?.totalProfit || 0;
    const pp = monthlyProviderPenalties.find((m) => m._id === monthIndex)?.totalProfit || 0;
    return {
      month: name,
      profit: pf + cp + pp,
    };
  });


  return {
    totalUsers,
    totalProviders,
    upCommingOrders,
    totalRevenue,
    totalEarning,
    recentServices: enhancedRecentServices,
    topProviders,
    monthlyEarning,
  };
};


// Generic find function for users or verification requests
export const find = async (query: any) => {
  const { compo, ...rest } = query;
  let model: any = User;
  if (compo === 'verification') {
  }
  const qb = new QueryBuilder(model.find(), rest)
    .search(['name', 'email'])
    .filter()
    .sort()
    .paginate()
    .fields();
  const data = await qb.modelQuery.lean().exec();
  const meta = await qb.getPaginationInfo();
  return { meta, data };
};



// Advanced Endpoint for direct mathematical breakdown mapping platform profit logic
export const getRevenueTracking = async () => {
  const [{ totalPlatformFee = 0 } = {}] = await Payment.aggregate([
    {
      $lookup: {
        from: 'bookings',
        localField: 'booking',
        foreignField: '_id',
        as: 'bookingDetails',
      },
    },
    { $unwind: '$bookingDetails' },
    {
      $match: {
        $or: [
          { 'bookingDetails.bookingStatus': { $in: [BOOKING_STATUS.SETTLED, BOOKING_STATUS.AUTO_SETTLED] } },
          { paymentStatus: PAYMENT_STATUS.PARTIAL_REFUNDED }
        ]
      }
    },
    { $group: { _id: null, totalPlatformFee: { $sum: '$platformFee' } } },
  ]);

  const [{ totalClientPenalty = 0 } = {}] = await Penalty.aggregate([
    { $match: { type: 'CLIENT' } },
    { $group: { _id: null, totalClientPenalty: { $sum: '$taken' } } },
  ]);

  const [{ totalProviderPenalty = 0 } = {}] = await Penalty.aggregate([
    { $match: { type: 'PROVIDER', amount: 30 } },
    { $group: { _id: null, totalProviderPenalty: { $sum: '$taken' } } },
  ]);

  const totalRevenue = totalPlatformFee + totalClientPenalty + totalProviderPenalty;

  return {
    breakdown: {
      platformFees: totalPlatformFee,
      clientPenalties: totalClientPenalty,
      providerPenaltiesCollected: totalProviderPenalty
    },
    netPlatformRevenue: totalRevenue
  };
};

export const AdminServices = {
  overview,
  find,
  getRevenueTracking,
};
