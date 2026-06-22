export const retryableStatuses = ["validation_failed", "geocoding_failed", "transform_failed", "email_failed"] as const;
export const formStatuses = ["received", "ready", ...retryableStatuses] as const;

export type FormStatus = (typeof formStatuses)[number];

export type EmailNotificationStatus = "pending" | "sent" | "failed";
