import { z } from "zod";

export const ingestedFormSchema = z
	.object({
		session_id: z.string().min(1),
		application_reference: z.string().min(1),
		name: z.string().min(1),
		email: z.string().email(),
		gender: z.enum(["male", "female", "other"]),
		date_of_birth: z.string().date(),
		phone_number: z.string().optional(),
		mobile_number: z.string().min(1),
		address: z
			.object({
				address_line_1: z.string().min(1),
				address_line_2: z.string().min(1),
				address_line_3: z.string().optional(),
				postcode: z.string().min(1),
				country: z.string().min(1),
			})
			.strict(),
	})
	// Strict parsing makes unannounced provider schema drift visible and retryable.
	.strict();

export type IngestedFormSchema = z.infer<typeof ingestedFormSchema>;
