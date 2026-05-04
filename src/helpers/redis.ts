import Redis from 'ioredis';
import config from '../config';
import { logger } from '../shared/logger';

const redisConfig = {
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  maxRetriesPerRequest: null,
};

export const redisConnection = new Redis(redisConfig);

redisConnection.on('connect', () => {
  logger.info('🚀 Redis connected successfully');
});

redisConnection.on('error', (error) => {
  logger.error('❌ Redis connection error:', error);
});
