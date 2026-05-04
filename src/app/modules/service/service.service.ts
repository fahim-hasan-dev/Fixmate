import { Types } from 'mongoose';
import { JwtPayload } from 'jsonwebtoken';
import { StatusCodes } from 'http-status-codes';
import ApiError from '../../../errors/ApiError';
import { Service } from './service.model';
import { IService } from './service.interface';
import QueryBuilder from '../../builder/QueryBuilder';
import unlinkFile from '../../../shared/unlinkFile';
import { USER_ROLES, VERIFICATION_STATUS } from '../../../enum/user';
import { User } from '../user/user.model';
import { calculateDistance } from '../../../shared/calculateDistance';

// Add a new service offered by a provider
const addService = async (user: JwtPayload, payload: Partial<IService>) => {
  const userData = await User.findById(user.authId).lean();
  
  if(userData?.providerDetails?.verificationStatus !== VERIFICATION_STATUS.APPROVED){
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Your account is not verified, please verify your account to add service.');
  }
  const isSubscribed = userData?.providerDetails?.subscription?.isSubscribed && 
    (userData.providerDetails.subscription.expiryDate ? new Date(userData.providerDetails.subscription.expiryDate) > new Date() : false);

  const service = await Service.create({ 
    ...payload, 
    creator: user.authId,
    isCreatorSubscribed: isSubscribed
  });
  return service;
};

// Update an existing service's
const updateService = async (id: string, payload: Partial<IService>) => {
  const existingService = await Service.findById(id).lean().exec();
  if (!existingService) throw new ApiError(StatusCodes.NOT_FOUND, 'We couldn\'t find the service details you\'re looking for.');

  if (payload.image && existingService.image) {
    unlinkFile(existingService.image);
  }

  const service = await Service.findByIdAndUpdate(id, payload, { new: true }).lean().exec();
  
  // Clear service cache on update
  await invalidateServiceCache(id);

  return service;
};


// Retrieve all services created by a specific provider
const getHomeServices = async (user: JwtPayload, query: any) => {
  const { distance, minRating, maxRating, searchTerm, ...queryParams } = query;

  const client = await User.findById(user.authId).select('location').lean();
  if (!client || !client.location || !Array.isArray(client.location.coordinates) || client.location.coordinates.length < 2) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Please update your location with valid coordinates to see available services.');
  }

  const clientCoords = client.location.coordinates as [number, number];

  if (distance || minRating || maxRating) {
    const providerCriteria: any = { role: USER_ROLES.PROVIDER };

    if (minRating || maxRating) {
      providerCriteria['providerDetails.averageRating'] = {};
      if (minRating) providerCriteria['providerDetails.averageRating'].$gte = Number(minRating);
      if (maxRating) providerCriteria['providerDetails.averageRating'].$lte = Number(maxRating);
    }

    if (distance) {
      providerCriteria.location = {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: clientCoords,
          },
          $maxDistance: Number(distance) * 1000,
        },
      };
    }

    const providers = await User.find(providerCriteria).select('_id').lean();
    const providerIds = providers.map(p => p._id);
    queryParams.creator = { $in: providerIds };
  }

  const serviceQuery = new QueryBuilder(
    Service.find({ isDeleted: false, isSuspended: false }).populate(
      'creator',
      'name image address location providerDetails.averageRating',
    ),
    queryParams,
  )
    .filter();

  if (searchTerm) {
    const orConditions: any[] = [
      { category: { $regex: searchTerm, $options: 'i' } },
      { subCategory: { $regex: searchTerm, $options: 'i' } },
    ];

    const matchingProviders = await User.find({
      role: USER_ROLES.PROVIDER,
      name: { $regex: searchTerm, $options: 'i' },
    }).select('_id').lean();

    if (matchingProviders.length > 0) {
      orConditions.push({ creator: { $in: matchingProviders.map(p => p._id) } });
    }

    serviceQuery.modelQuery = serviceQuery.modelQuery.find({ $or: orConditions });
  }

  // Priority to subscribed providers
  serviceQuery.modelQuery = serviceQuery.modelQuery.sort('-isCreatorSubscribed');

  serviceQuery.sort().paginate().fields();

  const data = await serviceQuery.modelQuery.lean().exec();
  const meta = await serviceQuery.getPaginationInfo();

  const formattedData = data.map((service: any) => {
    let serviceDistance = null;
    const providerLocation = service.creator?.location?.coordinates;
    if (providerLocation && Array.isArray(providerLocation) && providerLocation.length >= 2) {
      serviceDistance = calculateDistance(clientCoords, providerLocation as [number, number]);
    }
    return {
      ...service,
      distance: serviceDistance,
    };
  });

  return { meta, data: formattedData };
};

// Retrieve all available services
const getServices = async (user: JwtPayload, query: any) => {
  const { searchTerm, ...rest } = query;

  const matchStage: any = { isDeleted: false };
  
  const isSuspended = rest.isSuspended;
  if (isSuspended !== undefined) {
    matchStage.isSuspended = isSuspended === 'true';
  }

  if (user.role === USER_ROLES.PROVIDER) {
    matchStage.creator = new Types.ObjectId(user.authId || user.id);
  }

  const pipeline: any[] = [{ $match: matchStage }];

  pipeline.push(
    {
      $lookup: {
        from: 'users',
        localField: 'creator',
        foreignField: '_id',
        pipeline: [{ $project: { name: 1, image: 1, customId: 1 } }],
        as: 'creator',
      },
    },
    { $unwind: { path: '$creator', preserveNullAndEmptyArrays: true } },
  );

  if (searchTerm) {
    pipeline.push({
      $match: {
        $or: [
          { category: { $regex: searchTerm, $options: 'i' } },
          { subCategory: { $regex: searchTerm, $options: 'i' } },
          { customId: { $regex: searchTerm, $options: 'i' } },
          { 'creator.customId': { $regex: searchTerm, $options: 'i' } },
          { 'creator.name': { $regex: searchTerm, $options: 'i' } },
        ],
      },
    });
  }

  const sortStr = (rest.sort as string) || '-createdAt';
  const sortDir = sortStr.startsWith('-') ? -1 : 1;
  const sortField = sortStr.replace('-', '');
  pipeline.push({ $sort: { [sortField]: sortDir } });

  const page = Number(rest.page) || 1;
  const limit = Number(rest.limit) || 10;
  const skip = (page - 1) * limit;

  pipeline.push({
    $facet: {
      metadata: [{ $count: 'total' }],
      data: [{ $skip: skip }, { $limit: limit }],
    },
  });

  const result = await Service.aggregate(pipeline);

  const total = result[0]?.metadata[0]?.total || 0;
  const data = result[0]?.data || [];
  const totalPage = Math.ceil(total / limit);

  return { meta: { total, limit, page, totalPage }, data };
};

import { redisConnection } from '../../../helpers/redis';
import { CACHE_KEYS, invalidateServiceCache } from '../../utils/cacheUtils';

// Get detailed information about a specific service by its ID with caching
const getServiceById = async (id: string, user?: JwtPayload) => {
  const cacheKey = CACHE_KEYS.SERVICE_DETAILS(id);

  // Check cache for existing service data
  const cachedService = await redisConnection.get(cacheKey);
  let service: any;

  if (cachedService) {
    service = JSON.parse(cachedService);
  } else {
    service = await Service.findById(id)
      .populate('creator', 'name image email contact location customId address providerDetails.averageRating providerDetails.totalRating providerDetails.availableDay providerDetails.startTime providerDetails.endTime providerDetails.language providerDetails.overView providerDetails.category providerDetails.isVatRegistered')
      .lean()
      .exec();

    if (!service) throw new ApiError(StatusCodes.NOT_FOUND, 'We couldn\'t find the service details in our system.');

    // Cache service details for 24 hours
    await redisConnection.set(cacheKey, JSON.stringify(service), 'EX', 24 * 60 * 60);
  }

  if (user && user.role === USER_ROLES.CLIENT) {
    const client = await User.findById(user.authId).select('location').lean();
    const clientCoords = client?.location?.coordinates as [number, number];
    const providerCoords = (service.creator as any)?.location?.coordinates as [number, number];

    if (clientCoords && providerCoords && Array.isArray(clientCoords) && Array.isArray(providerCoords)) {
      (service as any).distance = calculateDistance(clientCoords, providerCoords);
    } else {
      (service as any).distance = null;
    }
  }

  return service;
};

// Soft-delete a service by setting isDeleted to true
const deleteService = async (id: string) => {
  const service = await Service.findByIdAndUpdate(id, { isDeleted: true }, { new: true })
    .lean()
    .exec();
  if (!service) throw new ApiError(StatusCodes.NOT_FOUND, 'We couldn\'t find the service you want to delete.');

  // Clear service cache on deletion
  await invalidateServiceCache(id);
  return service;
};

const toggleServiceSuspension = async (id: string, isSuspended: boolean) => {
  const service = await Service.findByIdAndUpdate(id, { isSuspended }, { new: true }).lean().exec();
  if (!service) throw new ApiError(StatusCodes.NOT_FOUND, 'We couldn\'t find the service you want to update.');

  // Clear service cache on suspension toggle
  await invalidateServiceCache(id);

  return service;
};

export const ServiceService = {
  addService,
  updateService,
  deleteService,
  getHomeServices,
  getServices,
  getServiceById,
  toggleServiceSuspension,
};
