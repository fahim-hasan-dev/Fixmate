import { FilterQuery, Query, PopulateOptions } from 'mongoose';

class QueryBuilder<T> {
  public modelQuery: Query<T[], T>;
  public query: Record<string, unknown>;

  constructor(modelQuery: Query<T[], T>, query: Record<string, unknown>) {
    this.modelQuery = modelQuery;
    this.query = query;
  }

  search(searchableFields: string[]) {
    if (this?.query?.searchTerm) {
      this.modelQuery = this.modelQuery.find({
        $or: searchableFields.map(
          field =>
            ({
              [field]: {
                $regex: this.query.searchTerm,
                $options: 'i',
              },
            }) as FilterQuery<T>,
        ),
      });
    }
    return this;
  }

  filter() {
    const queryObj = { ...this.query };
    const excludeFields = [
      'searchTerm',
      'sort',
      'page',
      'limit',
      'fields',
      'withLocked',
      'showHidden',
      'download',
      'startDate',
      'endDate',
    ];
    excludeFields.forEach(el => delete queryObj[el]);

    const filters: Record<string, any> = cleanObject(queryObj);

    // Automatically map comma-separated values and arrays to MongoDB $in operator
    Object.keys(filters).forEach(key => {
      const value = filters[key];
      if (typeof value === 'string' && value.includes(',')) {
        filters[key] = { $in: value.split(',').map(item => item.trim()) };
      } else if (Array.isArray(value)) {
        filters[key] = { $in: value };
      }
    });

    if (this.query.startDate || this.query.endDate) {
      filters.createdAt = {};
      if (this.query.startDate) {
        filters.createdAt.$gte = new Date(this.query.startDate as string);
      }
      if (this.query.endDate) {
        const end = new Date(this.query.endDate as string);
        end.setUTCHours(23, 59, 59, 999);
        filters.createdAt.$lte = end;
      }
    }

    if (queryObj.minPrice || queryObj.maxPrice) {
      filters.price = {};
      if (queryObj.minPrice) {
        filters.price.$gte = Number(queryObj.minPrice);
        delete filters.minPrice;
      }
      if (queryObj.maxPrice) {
        filters.price.$lte = Number(queryObj.maxPrice);
        delete filters.maxPrice;
      }
    }

    this.modelQuery = this.modelQuery.find(filters as FilterQuery<T>);
    return this;
  }

  sort() {
    let sort = (this?.query?.sort as string) || '-createdAt';
    this.modelQuery = this.modelQuery.sort(sort);
    return this;
  }

  paginate() {
    let limit = Number(this?.query?.limit) || 10;
    let page = Number(this?.query?.page) || 1;
    let skip = (page - 1) * limit;

    this.modelQuery = this.modelQuery.skip(skip).limit(limit);
    return this;
  }

  fields() {
    let fields = (this?.query?.fields as string)?.split(',').join(' ') || '-__v';
    this.modelQuery = this.modelQuery.select(fields);
    return this;
  }

  populate(
    populateFields: (string | PopulateOptions)[],
    selectFields: Record<string, unknown> = {},
  ) {
    this.modelQuery = this.modelQuery.populate(
      populateFields.map(field =>
        typeof field === 'string' ? { path: field, select: selectFields[field] } : field,
      ),
    );
    return this;
  }

  async getPaginationInfo() {
    const total = await this.modelQuery.model.countDocuments(this.modelQuery.getFilter());
    const limit = Number(this?.query?.limit) || 10;
    const page = Number(this?.query?.page) || 1;
    const totalPage = Math.ceil(total / limit);

    return {
      total,
      limit,
      page,
      totalPage,
    };
  }
}

function cleanObject(obj: Record<string, any>) {
  const cleaned: Record<string, any> = {};
  for (const key in obj) {
    const value = obj[key];
    if (
      value !== null &&
      value !== undefined &&
      value !== '' &&
      value !== 'undefined' &&
      !(Array.isArray(value) && value.length === 0) &&
      !(typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)
    ) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

export default QueryBuilder;
