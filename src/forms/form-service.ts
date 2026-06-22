import { AppDatabase } from "../db/database";
import { HttpResponse } from "../providers/httpresponse";
import { ingestedFormSchema } from "./schemas/ingested_schema";
import { TransformedFormSchema } from "./schemas/transformed_schema";
import { hashPayload } from "./canonical-json";
import { retryableStatuses, FormStatus, EmailNotificationStatus } from "./status";
import { transformForm } from "./transform";

type LookupPostcode = (postcode: string) => Promise<HttpResponse<{ longitude: number; latitude: number }>>;
type SendEmail = (args: { to: string; from: string; subject: string; body: string }) => Promise<HttpResponse<void>>;

export type FormProcessingDependencies = {
	db: AppDatabase;
	lookupPostcode: LookupPostcode;
	sendEmail: SendEmail;
};

type IngestedFormRow = {
	id: number;
	session_id: string | null;
	application_reference: string | null;
	payload_hash: string;
	raw_payload: string;
	status: FormStatus;
	error_code: string | null;
	error_message: string | null;
	error_details: string | null;
	created_at: string;
	updated_at: string;
};

type EmailNotificationRow = {
	status: EmailNotificationStatus;
	attempts: number;
	last_error: string | null;
};

export type FormRecord = {
	id: number;
	sessionId?: string;
	applicationReference?: string;
	status: FormStatus;
	error?: {
		code: string;
		message: string;
		issues?: ValidationIssue[];
	};
	transformedForm?: TransformedFormSchema;
	email?: EmailNotificationRow;
	createdAt: string;
	updatedAt: string;
};

export type IngestFormResult = {
	duplicate: boolean;
	form: FormRecord;
};

export type ValidationIssue = {
	path: string;
	message: string;
};

export const createFormProcessingService = ({ db, lookupPostcode, sendEmail }: FormProcessingDependencies) => {
	const createOrFindForm = db.transaction((rawPayload: unknown, payloadHash: string, sessionId: string | null, applicationReference: string | null) => {
		const existing = findExistingForm(db, payloadHash, sessionId, applicationReference);
		if (existing) {
			return { duplicate: true, row: existing };
		}

		const insert = db
			.prepare(
				`INSERT INTO ingested_forms (session_id, application_reference, payload_hash, raw_payload, status)
				 VALUES (@sessionId, @applicationReference, @payloadHash, @rawPayload, 'received')`,
			)
			.run({
				sessionId,
				applicationReference,
				payloadHash,
				rawPayload: JSON.stringify(rawPayload),
			});

		return {
			duplicate: false,
			row: getRequiredFormRow(db, Number(insert.lastInsertRowid)),
		};
	});

	const ingest = async (rawPayload: unknown): Promise<IngestFormResult> => {
		const payload = rawPayload === undefined ? null : rawPayload;
		const { sessionId, applicationReference } = extractDedupeKeys(payload);
		const payloadHash = hashPayload(payload);
		const { duplicate, row } = createOrFindForm(payload, payloadHash, sessionId, applicationReference);

		if (duplicate) {
			return { duplicate, form: toFormRecord(db, row) };
		}

		return {
			duplicate,
			form: await processForm(row.id),
		};
	};

	const retry = async (id: number): Promise<FormRecord | undefined> => {
		const row = getFormRow(db, id);
		if (!row) {
			return undefined;
		}

		if (!retryableStatuses.includes(row.status as (typeof retryableStatuses)[number])) {
			return toFormRecord(db, row);
		}

		return processForm(id);
	};

	const get = (id: number): FormRecord | undefined => {
		const row = getFormRow(db, id);
		return row ? toFormRecord(db, row) : undefined;
	};

	const list = (status?: FormStatus): FormRecord[] => {
		return getFormRows(db, status).map((row) => toFormRecord(db, row));
	};

	const retryAll = async (status?: FormStatus): Promise<FormRecord[]> => {
		const rows = getRetryableFormRows(db, status);
		const forms: FormRecord[] = [];

		for (const row of rows) {
			forms.push(await processForm(row.id));
		}

		return forms;
	};

	const processForm = async (id: number): Promise<FormRecord> => {
		const row = getRequiredFormRow(db, id);
		const rawPayload = JSON.parse(row.raw_payload) as unknown;
		const parsed = ingestedFormSchema.safeParse(rawPayload);

		if (!parsed.success) {
			const issues = parsed.error.issues.map((issue) => ({
				path: issue.path.join(".") || "root",
				message: issue.message,
			}));
			updateFailure(db, id, "validation_failed", "SCHEMA_VALIDATION_FAILED", "Payload does not match the agreed provider schema", issues);
			return toFormRecord(db, getRequiredFormRow(db, id));
		}

		updateDedupeKeys(db, id, parsed.data.session_id, parsed.data.application_reference);

		const coordinates = await lookupPostcode(parsed.data.address.postcode);
		if (coordinates.statusCode < 200 || coordinates.statusCode >= 300 || !coordinates.body) {
			updateFailure(db, id, "geocoding_failed", "GEOCODING_FAILED", `Postcode lookup failed with status ${coordinates.statusCode}`);
			return toFormRecord(db, getRequiredFormRow(db, id));
		}

		let transformedForm: TransformedFormSchema;
		try {
			transformedForm = transformForm(parsed.data, coordinates.body);
		} catch (error) {
			updateFailure(db, id, "transform_failed", "TRANSFORM_FAILED", error instanceof Error ? error.message : "Unknown transform error");
			return toFormRecord(db, getRequiredFormRow(db, id));
		}

		upsertTransformedForm(db, id, transformedForm);
		ensureEmailNotification(db, id);

		const notification = getEmailNotification(db, id);
		if (notification?.status === "sent") {
			updateStatus(db, id, "ready");
			return toFormRecord(db, getRequiredFormRow(db, id));
		}

		const emailResponse = await sendEmail({
			to: "happyforms@bots.com",
			from: "noreply@healthtech1.uk",
			subject: `Form ingested: ${transformedForm.applicationReference}`,
			body: `Form ${transformedForm.applicationReference} for ${transformedForm.firstName} ${transformedForm.lastName} was ingested.`,
		});

		if (emailResponse.statusCode < 200 || emailResponse.statusCode >= 300) {
			markEmailFailed(db, id, `Email provider failed with status ${emailResponse.statusCode}`);
			updateFailure(db, id, "email_failed", "EMAIL_FAILED", `Email provider failed with status ${emailResponse.statusCode}`);
			return toFormRecord(db, getRequiredFormRow(db, id));
		}

		markEmailSent(db, id);
		updateStatus(db, id, "ready");
		return toFormRecord(db, getRequiredFormRow(db, id));
	};

	return { ingest, retry, retryAll, get, list };
};

const extractDedupeKeys = (rawPayload: unknown) => {
	if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
		return { sessionId: null, applicationReference: null };
	}

	const record = rawPayload as Record<string, unknown>;
	return {
		sessionId: typeof record.session_id === "string" ? record.session_id : null,
		applicationReference: typeof record.application_reference === "string" ? record.application_reference : null,
	};
};

const findExistingForm = (db: AppDatabase, payloadHash: string, sessionId: string | null, applicationReference: string | null) => {
	return db
		.prepare(
			`SELECT * FROM ingested_forms
			 WHERE payload_hash = @payloadHash
				OR (@sessionId IS NOT NULL AND session_id = @sessionId)
				OR (@applicationReference IS NOT NULL AND application_reference = @applicationReference)`,
		)
		.get({ payloadHash, sessionId, applicationReference }) as IngestedFormRow | undefined;
};

const getFormRow = (db: AppDatabase, id: number) => {
	return db.prepare("SELECT * FROM ingested_forms WHERE id = ?").get(id) as IngestedFormRow | undefined;
};

const getFormRows = (db: AppDatabase, status?: FormStatus) => {
	if (status) {
		return db.prepare("SELECT * FROM ingested_forms WHERE status = ? ORDER BY id DESC").all(status) as IngestedFormRow[];
	}

	return db.prepare("SELECT * FROM ingested_forms ORDER BY id DESC").all() as IngestedFormRow[];
};

const getRetryableFormRows = (db: AppDatabase, status?: FormStatus) => {
	if (status && !retryableStatuses.includes(status as (typeof retryableStatuses)[number])) {
		return [];
	}

	if (status) {
		return db.prepare("SELECT * FROM ingested_forms WHERE status = ? ORDER BY id ASC").all(status) as IngestedFormRow[];
	}

	return db
		.prepare(
			`SELECT * FROM ingested_forms
			 WHERE status IN (${retryableStatuses.map(() => "?").join(", ")})
			 ORDER BY id ASC`,
		)
		.all(...retryableStatuses) as IngestedFormRow[];
};

const getRequiredFormRow = (db: AppDatabase, id: number) => {
	const row = getFormRow(db, id);
	if (!row) {
		throw new Error(`Form ${id} was not found`);
	}
	return row;
};

const updateDedupeKeys = (db: AppDatabase, id: number, sessionId: string, applicationReference: string) => {
	db.prepare(
		`UPDATE ingested_forms
		 SET session_id = @sessionId,
			 application_reference = @applicationReference,
			 updated_at = CURRENT_TIMESTAMP
		 WHERE id = @id`,
	).run({ id, sessionId, applicationReference });
};

const updateFailure = (db: AppDatabase, id: number, status: FormStatus, errorCode: string, errorMessage: string, issues?: ValidationIssue[]) => {
	db.prepare(
		`UPDATE ingested_forms
		 SET status = @status,
			 error_code = @errorCode,
			 error_message = @errorMessage,
			 error_details = @errorDetails,
			 updated_at = CURRENT_TIMESTAMP
		 WHERE id = @id`,
	).run({ id, status, errorCode, errorMessage, errorDetails: issues ? JSON.stringify({ issues }) : null });
};

const updateStatus = (db: AppDatabase, id: number, status: FormStatus) => {
	db.prepare(
		`UPDATE ingested_forms
		 SET status = @status,
			 error_code = NULL,
			 error_message = NULL,
			 error_details = NULL,
			 updated_at = CURRENT_TIMESTAMP
		 WHERE id = @id`,
	).run({ id, status });
};

const upsertTransformedForm = (db: AppDatabase, ingestedFormId: number, form: TransformedFormSchema) => {
	db.prepare(
		`INSERT INTO transformed_forms (ingested_form_id, session_id, application_reference, payload)
		 VALUES (@ingestedFormId, @sessionId, @applicationReference, @payload)
		 ON CONFLICT(ingested_form_id) DO UPDATE SET payload = excluded.payload`,
	).run({
		ingestedFormId,
		sessionId: form.sessionId,
		applicationReference: form.applicationReference,
		payload: JSON.stringify(form),
	});
};

const ensureEmailNotification = (db: AppDatabase, ingestedFormId: number) => {
	db.prepare(
		`INSERT OR IGNORE INTO email_notifications (ingested_form_id, to_address, status)
		 VALUES (@ingestedFormId, 'happyforms@bots.com', 'pending')`,
	).run({ ingestedFormId });
};

const getEmailNotification = (db: AppDatabase, ingestedFormId: number) => {
	return db
		.prepare("SELECT status, attempts, last_error FROM email_notifications WHERE ingested_form_id = ?")
		.get(ingestedFormId) as EmailNotificationRow | undefined;
};

const markEmailFailed = (db: AppDatabase, ingestedFormId: number, errorMessage: string) => {
	db.prepare(
		`UPDATE email_notifications
		 SET status = 'failed',
			 attempts = attempts + 1,
			 last_error = @errorMessage,
			 updated_at = CURRENT_TIMESTAMP
		 WHERE ingested_form_id = @ingestedFormId`,
	).run({ ingestedFormId, errorMessage });
};

const markEmailSent = (db: AppDatabase, ingestedFormId: number) => {
	db.prepare(
		`UPDATE email_notifications
		 SET status = 'sent',
			 attempts = attempts + 1,
			 last_error = NULL,
			 updated_at = CURRENT_TIMESTAMP
		 WHERE ingested_form_id = @ingestedFormId`,
	).run({ ingestedFormId });
};

const toFormRecord = (db: AppDatabase, row: IngestedFormRow): FormRecord => {
	const transformed = db.prepare("SELECT payload FROM transformed_forms WHERE ingested_form_id = ?").get(row.id) as { payload: string } | undefined;

	return {
		id: row.id,
		sessionId: row.session_id ?? undefined,
		applicationReference: row.application_reference ?? undefined,
		status: row.status,
		error:
			row.error_code && row.error_message
				? {
						code: row.error_code,
						message: row.error_message,
						issues: parseErrorIssues(row.error_details),
					}
				: undefined,
		transformedForm: transformed ? (JSON.parse(transformed.payload) as TransformedFormSchema) : undefined,
		email: getEmailNotification(db, row.id),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
};

const parseErrorIssues = (errorDetails: string | null) => {
	if (!errorDetails) {
		return undefined;
	}

	const parsed = JSON.parse(errorDetails) as { issues?: ValidationIssue[] };
	return parsed.issues;
};
