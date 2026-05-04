import { TermsModel } from './terms&policy.model';
import { redisConnection } from '../../../helpers/redis';
import { CACHE_KEYS, invalidateTermsAndPolicyCache } from '../../utils/cacheUtils';

// Retrieve the current terms and conditions content 
const getTerms = async () => {
  const cached = await redisConnection.get(CACHE_KEYS.TERMS);
  if (cached) return JSON.parse(cached);

  const result = await TermsModel.findOne({ type: 'terms' }).select('content -_id').lean().exec();
  if (result) {
    await redisConnection.set(CACHE_KEYS.TERMS, JSON.stringify(result), 'EX', 7 * 24 * 60 * 60);
  }
  return result;
};

// Retrieve the current privacy policy 
const getPolicy = async () => {
  const cached = await redisConnection.get(CACHE_KEYS.POLICY);
  if (cached) return JSON.parse(cached);

  const result = await TermsModel.findOne({ type: 'policy' }).select('content -_id').lean().exec();
  if (result) {
    await redisConnection.set(CACHE_KEYS.POLICY, JSON.stringify(result), 'EX', 7 * 24 * 60 * 60);
  }
  return result;
};

// Create or update the terms and conditions content
const upsertTerms = async (content: string) => {
  const result = await TermsModel.findOneAndUpdate(
    { type: 'terms' },
    { content, type: 'terms' },
    { upsert: true, new: true },
  )
    .lean()
    .exec();
  await invalidateTermsAndPolicyCache('terms');
  return result;
};

// Create or update the privacy policy content
const upsertPolicy = async (content: string) => {
  const result = await TermsModel.findOneAndUpdate(
    { type: 'policy' },
    { content, type: 'policy' },
    { upsert: true, new: true },
  )
    .lean()
    .exec();
  await invalidateTermsAndPolicyCache('policy');
  return result;
};

export const TermsAndPolicyService = {
  getTerms,
  getPolicy,
  upsertTerms,
  upsertPolicy,
};
