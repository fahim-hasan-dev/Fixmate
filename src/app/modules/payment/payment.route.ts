import { Router } from 'express';
import { PaymentControllers } from './payment.controller';
import { USER_ROLES } from '../../../enum/user';
import auth from '../../middleware/auth';
import { generateInvoiceAPI } from '../../../helpers/pdfMaker';

const router = Router();

router.post(
  '/generate-recipient',
  auth(USER_ROLES.PROVIDER),
  PaymentControllers.generateRecipient,
);

router.get('/wallet', auth(USER_ROLES.PROVIDER), PaymentControllers.getWallet);

router.get(
  '/history',
  auth(USER_ROLES.PROVIDER, USER_ROLES.CLIENT, USER_ROLES.ADMIN),
  PaymentControllers.getPaymentHistory,
);

router.get(
  '/history/:id',
  auth(USER_ROLES.PROVIDER, USER_ROLES.CLIENT, USER_ROLES.ADMIN),
  PaymentControllers.getPaymentDetails,
);

router.post('/withdraw', auth(USER_ROLES.PROVIDER), PaymentControllers.withdraw);

router.get(
  '/download',
  auth(USER_ROLES.ADMIN),
  PaymentControllers.downloadPayments
);

router.post(
  '/checkout/:bookingId',
  auth(USER_ROLES.CLIENT),
  PaymentControllers.checkoutBooking
);

router.get(
  '/download-invoice/:id',
  auth(USER_ROLES.PROVIDER, USER_ROLES.CLIENT, USER_ROLES.ADMIN),
  generateInvoiceAPI
);

export const PaymentRoutes = router;
