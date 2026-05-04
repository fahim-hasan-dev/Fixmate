// Category Service
import { StatusCodes } from 'http-status-codes';
import { Types } from 'mongoose';
import ApiError from '../../../errors/ApiError';
import QueryBuilder from '../../builder/QueryBuilder';
import { ICategory } from './category.interface';
import { Category } from './category.model';
import { invalidateCategoryCache, CACHE_KEYS } from '../../utils/cacheUtils';
import { redisConnection } from '../../../helpers/redis';

// Create a new service category
const addNewCategory = async (category: ICategory) => {
  if (!category.image) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Please upload an image for the category.');
  }
  console.log({ category })
  const result = await Category.create(category);
  
  // Clear category cache to reflect the new addition
  await invalidateCategoryCache();
  
  return result;
};

// Retrieve all active categories with Redis caching for simple requests
const getCategories = async (query: Record<string, unknown>) => {
  const isSimpleQuery = !query.searchTerm && !query.page && !query.limit;

  if (isSimpleQuery) {
    const cachedCategories = await redisConnection.get(CACHE_KEYS.CATEGORIES);
    if (cachedCategories) {
      return JSON.parse(cachedCategories);
    }
  }

  const categoryQuery = Category.find({ isDeleted: false }).select('name image subCategory');

  const categoryQueryBuilder = new QueryBuilder(categoryQuery, query)
    .search(['name'])
    .filter()
    .sort()
    .paginate()
    .fields();

  const data = await categoryQueryBuilder.modelQuery.lean().exec();
  const meta = await categoryQueryBuilder.getPaginationInfo();
  const result = { data, meta };

  if (isSimpleQuery) {
    // Cache the full category list for 24 hours
    await redisConnection.set(CACHE_KEYS.CATEGORIES, JSON.stringify(result), 'EX', 24 * 60 * 60);
  }

  return result;
};

// Update an existing category's information
const updateCategory = async (id: string, category: ICategory) => {
  const result = await Category.findByIdAndUpdate(new Types.ObjectId(id), category, {
    new: true,
  })
    .lean()
    .exec();
  if (!result) throw new ApiError(StatusCodes.BAD_REQUEST, 'We couldn\'t find the category you\'re looking for.');

  // Clear category cache to reflect updates
  await invalidateCategoryCache();

  return result;
};

// Soft-delete a category by setting isDeleted to true
const deleteCategory = async (id: string) => {
  const result = await Category.findByIdAndUpdate(
    new Types.ObjectId(id),
    { isDeleted: true },
    { new: true },
  )
    .lean()
    .exec();
  if (!result) throw new ApiError(StatusCodes.BAD_REQUEST, 'Category not found');

  // Clear category cache after deletion
  await invalidateCategoryCache();

  return result;
};

export const CategoryService = {
  addNewCategory,
  getCategories,
  updateCategory,
  deleteCategory,
};
