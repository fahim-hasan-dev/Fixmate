import { redisConnection } from '../../helpers/redis';
import { logger } from '../../shared/logger';

export const CACHE_KEYS = {
  PROFILE: (userId: string) => `profile:${userId}`,
  CATEGORIES: 'categories:all',
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
