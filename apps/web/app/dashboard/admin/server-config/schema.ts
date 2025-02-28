import { z } from "zod";

// Schema for server configuration form
export const serverConfigSchema = z.object({
  licenseKey: z.string().nullable(),
  signupsEnabled: z.boolean().default(false),
  emailSendFromName: z.string().nullable(),
  emailSendFromEmail: z.string().email().nullable(),
});

// Type for server configuration form
export type ServerConfigFormValues = z.infer<typeof serverConfigSchema>;

// Schema for super admin management
export const superAdminSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().email(),
  image: z.string().nullable(),
});

export type SuperAdminUser = z.infer<typeof superAdminSchema>;
