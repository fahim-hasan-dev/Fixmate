import { redisConnection } from '../../helpers/redis';
import { logger } from '../../shared/logger';

export const CACHE_KEYS = {
  PROFILE: (userId: string) => `profile:${userId}`,
  CATEGORIES: 'categories:all',
  TERMS: 'terms:content',
  POLICY: 'policy:content',
  SERVICE_DETAILS: (serviceId: string) => `service:${serviceId}`,
};

/**
 * Deletes the cached profile of a user.
 * Call this whenever user data (name, wallet, rating, etc.) is updated.
 */
export const invalidateProfileCache = async (userId: string) => {
  try {
    await redisConnection.del(CACHE_KEYS.PROFILE(userId));
  } catch (error) {
    logger.error(`Redis Cache Invalidation Error (User: ${userId}):`, error);
  }
};

/**
 * Deletes the cached category list.
 * Call this whenever a category is added, updated, or deleted.
 */
export const invalidateCategoryCache = async () => {
  try {
    await redisConnection.del(CACHE_KEYS.CATEGORIES);
  } catch (error) {
    logger.error('Redis Cache Invalidation Error (Categories):', error);
  }
};

/**
 * Deletes cached Terms and Policy content.
 */
export const invalidateTermsAndPolicyCache = async (type: 'terms' | 'policy') => {
  try {
    const key = type === 'terms' ? CACHE_KEYS.TERMS : CACHE_KEYS.POLICY;
    await redisConnection.del(key);
  } catch (error) {
    logger.error(`Redis Cache Invalidation Error (${type}):`, error);
  }
};

/**
 * Deletes a cached service detail record.
 */
export const invalidateServiceCache = async (serviceId: string) => {
  try {
    await redisConnection.del(CACHE_KEYS.SERVICE_DETAILS(serviceId));
  } catch (error) {
    logger.error(`Redis Cache Invalidation Error (Service: ${serviceId}):`, error);
  }
};
