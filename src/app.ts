import express, { NextFunction, Request, Response } from "express";
import { createDatabase, AppDatabase } from "./db/database";
import { createFormProcessingService, FormProcessingDependencies } from "./forms/form-service";
import { formStatuses, FormStatus } from "./forms/status";
import { lookupPostcode } from "./providers/idealpostcodes";
import { sendEmail } from "./providers/sendgrid";

type CreateAppOptions = Partial<Omit<FormProcessingDependencies, "db">> & {
	db?: AppDatabase;
};

export const createApp = (options: CreateAppOptions = {}) => {
	const app = express();
	const db = options.db ?? createDatabase();
	const forms = createFormProcessingService({
		db,
		lookupPostcode: options.lookupPostcode ?? lookupPostcode,
		sendEmail: options.sendEmail ?? sendEmail,
	});

	app.locals.db = db;
	app.use(express.json());

	app.post(
		"/ingest",
		asyncHandler(async (req: Request, res: Response) => {
			const result = await forms.ingest(req.body);
			const statusCode = result.duplicate ? 200 : result.form.status === "ready" ? 201 : 202;
			res.status(statusCode).json(result);
		}),
	);

	app.post(
		"/retry/:id",
		asyncHandler(async (req: Request, res: Response) => {
			const id = parsePositiveInteger(req.params.id);
			if (!id) {
				res.status(400).json({ error: "Form id must be a positive integer" });
				return;
			}

			const form = await forms.retry(id);
			if (!form) {
				res.status(404).json({ error: "Form was not found" });
				return;
			}

			res.status(form.status === "ready" ? 200 : 202).json({ form });
		}),
	);

	app.post(
		"/retry",
		asyncHandler(async (req: Request, res: Response) => {
			const status = parseStatusFilter(req.query.status);
			if (status === "invalid") {
				res.status(400).json({ error: "Status filter is invalid" });
				return;
			}

			const retriedForms = await forms.retryAll(status);
			res.json({ retried: retriedForms.length, forms: retriedForms });
		}),
	);

	app.get("/forms", (_req: Request, res: Response) => {
		const status = parseStatusFilter(_req.query.status);
		if (status === "invalid") {
			res.status(400).json({ error: "Status filter is invalid" });
			return;
		}

		res.json({ forms: forms.list(status) });
	});

	app.get("/forms/:id", (req: Request, res: Response) => {
		const id = parsePositiveInteger(req.params.id);
		if (!id) {
			res.status(400).json({ error: "Form id must be a positive integer" });
			return;
		}

		const form = forms.get(id);
		if (!form) {
			res.status(404).json({ error: "Form was not found" });
			return;
		}

		res.json({ form });
	});

	app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
		res.status(500).json({ error: error.message });
	});

	return app;
};

const asyncHandler =
	(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => {
		handler(req, res, next).catch(next);
	};

const parsePositiveInteger = (value: string | string[]) => {
	if (Array.isArray(value)) {
		return undefined;
	}

	const id = Number(value);
	return Number.isInteger(id) && id > 0 ? id : undefined;
};

const parseStatusFilter = (value: Request["query"][string]): FormStatus | "invalid" | undefined => {
	if (typeof value === "undefined") {
		return undefined;
	}

	if (Array.isArray(value) || typeof value !== "string") {
		return "invalid";
	}

	return formStatuses.includes(value as FormStatus) ? (value as FormStatus) : "invalid";
};

export default createApp;
