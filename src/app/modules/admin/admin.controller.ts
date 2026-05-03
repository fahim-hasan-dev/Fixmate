// Admin Controller
import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import catchAsync from '../../../shared/catchAsync';
import sendResponse from '../../../shared/sendResponse';
import { AdminServices } from './admin.service';
import { CategoryController } from '../category/category.controller';
import { BookingController } from '../booking/booking.controller';
import { VerificationController } from '../verification/verification.controller';
import { TermsAndPolicyController } from '../terms&policy/terms&policy.controller';

// Controller for platform overview stats
const overview = catchAsync(async (req: Request, res: Response) => {
  const result = await AdminServices.overview(
    req.query.year as string,
    req.query.startDate as string,
    req.query.endDate as string
  );

  sendResponse(res, {
    success: true,
    statusCode: StatusCodes.OK,
    message: 'Admin overview retrieved successfully',
    data: result,
  });
});

const addNewCategory = CategoryController.addNewCategory;
const getCategories = CategoryController.getCategories;
const updateCategory = CategoryController.updateCategory;
const deleteCategory = CategoryController.deleteCategory;

const getPolicy = TermsAndPolicyController.getPolicy;
const upsertPolicy = TermsAndPolicyController.upsertPolicy;
const getTerms = TermsAndPolicyController.getTerms;
const upsertTerms = TermsAndPolicyController.upsertTerms;

const getRequests = VerificationController.getAllRequests;
const approveOrReject = VerificationController.updateStatus;

// Controller for generic find functionality
const find = catchAsync(async (req: Request, res: Response) => {
  const result = await AdminServices.find(req.query as any);

  sendResponse(res, {
    success: true,
    statusCode: StatusCodes.OK,
    message: 'Find successful',
    data: result,
  });
});

const getBookings = BookingController.getBookings;

// Controller to fetch exact profit breakdowns
const getRevenueTracking = catchAsync(async (_req: Request, res: Response) => {
  const result = await AdminServices.getRevenueTracking();
  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Revenue tracking statistics retrieved successfully',
    data: result,
  });
});

export const AdminController = {
  addNewCategory,
  getCategories,
  updateCategory,
  deleteCategory,
  getPolicy,
  upsertPolicy,
  getTerms,
  upsertTerms,
  getRequests,
  approveOrReject,
  overview,
  find,
  getBookings,
  getRevenueTracking,
};
