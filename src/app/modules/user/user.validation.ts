import { z } from 'zod';

const updateUserProfileZodSchema = z.object({
  body: z
    .object({
      name: z.string().optional(),
      gender: z.string().optional(),
      address: z.string().optional(),
      dateOfBirth: z.string().optional(),
      whatsApp: z.string().optional(),
      contact: z.string().optional(),
      location: z.object({
        coordinates: z.array(z.number()),
      }).optional(),
      image: z.string().optional(),
    }).strict(),
});

const updateProviderProfileZodSchema = z.object({
  body: z
    .object({
      name: z.string().optional(),
      gender: z.string().optional(),
      address: z.string().optional(),
      dateOfBirth: z.string().optional(),
      whatsApp: z.string().optional(),
      contact: z.string().optional(),
      location: z.object({
        coordinates: z.array(z.number()),
      }).optional(),
      image: z.string().optional(),
      providerDetails: z
        .object({
          category: z.string().optional(),
          nationalId: z.string().optional(),
          nationality: z.string().optional(),
          experience: z.string().optional(),
          language: z.array(z.string()).optional(),
          overView: z.string().optional(),
          availableDay: z.array(z.string()).optional(),
          startTime: z.string().optional(),
          endTime: z.string().optional(),
          isVatRegistered: z.boolean().optional(),
          vatNumber: z.string().optional(),
          companyName: z.string().optional(),
          companyRegistrationNumber: z.string().optional(),
          serviceDistance: z.number().optional(),
        }).optional(),
    }).strict(),
});

const idParamsSchema = z.object({
  params: z
    .object({
      id: z.string({ invalid_type_error: 'User id is required' }),
    })
    .strict(),
});

const blockAndUnblockUserSchema = z.object({
  params: z
    .object({
      id: z.string({ invalid_type_error: 'User id is required' }),
      status: z.enum(['BLOCKED', 'ACTIVE', 'DELETED'], { required_error: 'Status is required' }),
    })
    .strict(),
});

export const UserValidation = {
  updateUserProfileZodSchema,
  updateProviderProfileZodSchema,
  idParamsSchema,
  blockAndUnblockUserSchema,
};
