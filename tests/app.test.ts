import request from "supertest";
import { createApp } from "../src/app";
import { createDatabase, AppDatabase } from "../src/db/database";

const validForm = () => ({
	session_id: "c8267b77-d796-451e-9948-e82f56412b56",
	application_reference: "GRU-123089-2026",
	name: "John Doe",
	email: "john.doe@example.com",
	gender: "male",
	date_of_birth: "1990-01-01",
	phone_number: "07123456789",
	mobile_number: "07123456789",
	address: {
		address_line_1: "Stratford Village Surgery",
		address_line_2: "50C Romford Road",
		address_line_3: "London",
		postcode: "E15 4BZ",
		country: "United Kingdom",
	},
});

const validFormWith = (overrides: Partial<ReturnType<typeof validForm>>) => ({
	...validForm(),
	...overrides,
});

describe("form ingestion", () => {
	let db: AppDatabase;
	let lookupPostcode: jest.Mock;
	let sendEmail: jest.Mock;
	let app: ReturnType<typeof createApp>;

	beforeEach(() => {
		db = createDatabase(":memory:");
		lookupPostcode = jest.fn().mockResolvedValue({ statusCode: 200, body: { longitude: 50.05, latitude: -5.05 } });
		sendEmail = jest.fn().mockResolvedValue({ statusCode: 200 });
		app = createApp({ db, lookupPostcode, sendEmail });
	});

	afterEach(() => {
		db.close();
	});

	it("ingests, transforms, geocodes, and sends a notification", async () => {
		const response = await request(app).post("/ingest").send(validForm());

		expect(response.status).toBe(201);
		expect(response.body.form.status).toBe("ready");
		expect(response.body.form.transformedForm).toEqual(
			expect.objectContaining({
				sessionId: "c8267b77-d796-451e-9948-e82f56412b56",
				applicationReference: "GRU-123089-2026",
				firstName: "John",
				lastName: "Doe",
				longitude: 50.05,
				latitude: -5.05,
			}),
		);
		expect(lookupPostcode).toHaveBeenCalledWith("E15 4BZ");
		expect(sendEmail).toHaveBeenCalledTimes(1);
	});

	it("does not process the same form twice", async () => {
		await request(app).post("/ingest").send(validForm());
		const duplicate = await request(app).post("/ingest").send(validForm());

		expect(duplicate.status).toBe(200);
		expect(duplicate.body.duplicate).toBe(true);
		expect(sendEmail).toHaveBeenCalledTimes(1);
		expect(countRows(db, "ingested_forms")).toBe(1);
		expect(countRows(db, "transformed_forms")).toBe(1);
		expect(countRows(db, "email_notifications")).toBe(1);
	});

	it("persists schema drift as a retryable validation failure", async () => {
		const payload = {
			...validForm(),
			unexpected_provider_field: true,
		};

		const response = await request(app).post("/ingest").send(payload);

		expect(response.status).toBe(202);
		expect(response.body.form.status).toBe("validation_failed");
		expect(response.body.form.error.code).toBe("SCHEMA_VALIDATION_FAILED");
		expect(response.body.form.error.message).toBe("Payload does not match the agreed provider schema");
		expect(response.body.form.error.issues).toContainEqual({
			path: "root",
			message: 'Unrecognized key: "unexpected_provider_field"',
		});
		expect(lookupPostcode).not.toHaveBeenCalled();
		expect(sendEmail).not.toHaveBeenCalled();
		expect(countRows(db, "ingested_forms")).toBe(1);
	});

	it("persists an empty request body as a validation failure", async () => {
		const response = await request(app).post("/ingest");

		expect(response.status).toBe(202);
		expect(response.body.form.status).toBe("validation_failed");
		expect(lookupPostcode).not.toHaveBeenCalled();
		expect(sendEmail).not.toHaveBeenCalled();
		expect(countRows(db, "ingested_forms")).toBe(1);
	});

	it("retries a geocoding failure without losing the raw form", async () => {
		lookupPostcode.mockResolvedValueOnce({ statusCode: 500 });
		const failed = await request(app).post("/ingest").send(validForm());

		expect(failed.status).toBe(202);
		expect(failed.body.form.status).toBe("geocoding_failed");
		expect(sendEmail).not.toHaveBeenCalled();

		const retried = await request(app).post(`/retry/${failed.body.form.id}`);

		expect(retried.status).toBe(200);
		expect(retried.body.form.status).toBe("ready");
		expect(lookupPostcode).toHaveBeenCalledTimes(2);
		expect(sendEmail).toHaveBeenCalledTimes(1);
	});

	it("retries email delivery without duplicating the transformed form", async () => {
		sendEmail.mockResolvedValueOnce({ statusCode: 500 }).mockResolvedValueOnce({ statusCode: 200 });
		const failed = await request(app).post("/ingest").send(validForm());

		expect(failed.status).toBe(202);
		expect(failed.body.form.status).toBe("email_failed");
		expect(countRows(db, "transformed_forms")).toBe(1);

		const retried = await request(app).post(`/retry/${failed.body.form.id}`);

		expect(retried.status).toBe(200);
		expect(retried.body.form.status).toBe("ready");
		expect(sendEmail).toHaveBeenCalledTimes(2);
		expect(countRows(db, "transformed_forms")).toBe(1);
		expect(getNotificationAttempts(db)).toBe(2);
	});

	it("returns a stored form by id", async () => {
		const ingested = await request(app).post("/ingest").send(validForm());

		const response = await request(app).get(`/forms/${ingested.body.form.id}`);

		expect(response.status).toBe(200);
		expect(response.body.form).toEqual(ingested.body.form);
	});

	it("lists stored forms for manual inspection", async () => {
		await request(app).post("/ingest").send(validForm());
		await request(app)
			.post("/ingest")
			.send(
				validFormWith({
			session_id: "881fa3b2-84cd-4517-b909-84a073ca0110",
			application_reference: "GRU-123092-2026",
			email: "jane.doe@example.com",
				}),
			);

		const response = await request(app).get("/forms");

		expect(response.status).toBe(200);
		expect(response.body.forms).toHaveLength(2);
		expect(response.body.forms.map((form: { id: number }) => form.id)).toEqual([2, 1]);
	});

	it("filters listed forms by status", async () => {
		await request(app).post("/ingest").send(validForm());
		await request(app).post("/ingest").send({ unexpected: true });

		const response = await request(app).get("/forms?status=validation_failed");

		expect(response.status).toBe(200);
		expect(response.body.forms).toHaveLength(1);
		expect(response.body.forms[0].status).toBe("validation_failed");
	});

	it("rejects invalid status filters", async () => {
		const response = await request(app).get("/forms?status=not_real");

		expect(response.status).toBe(400);
		expect(response.body.error).toBe("Status filter is invalid");
	});

	it("retries all retryable forms", async () => {
		lookupPostcode.mockResolvedValueOnce({ statusCode: 500 });
		await request(app).post("/ingest").send(validForm());

		sendEmail.mockResolvedValueOnce({ statusCode: 500 });
		await request(app)
			.post("/ingest")
			.send(
				validFormWith({
					session_id: "881fa3b2-84cd-4517-b909-84a073ca0110",
					application_reference: "GRU-123092-2026",
					email: "jane.doe@example.com",
				}),
			);

		const response = await request(app).post("/retry");

		expect(response.status).toBe(200);
		expect(response.body.retried).toBe(2);
		expect(response.body.forms.map((form: { status: string }) => form.status)).toEqual(["ready", "ready"]);
		expect(countRows(db, "transformed_forms")).toBe(2);
	});

	it("retries retryable forms by status", async () => {
		lookupPostcode.mockResolvedValueOnce({ statusCode: 500 });
		await request(app).post("/ingest").send(validForm());

		sendEmail.mockResolvedValueOnce({ statusCode: 500 });
		await request(app)
			.post("/ingest")
			.send(
				validFormWith({
					session_id: "881fa3b2-84cd-4517-b909-84a073ca0110",
					application_reference: "GRU-123092-2026",
					email: "jane.doe@example.com",
				}),
			);

		const response = await request(app).post("/retry?status=geocoding_failed");

		expect(response.status).toBe(200);
		expect(response.body.retried).toBe(1);
		expect(response.body.forms[0].status).toBe("ready");
		expect((await request(app).get("/forms?status=email_failed")).body.forms).toHaveLength(1);
	});

	it("returns 404 for a missing form", async () => {
		const response = await request(app).get("/forms/999");

		expect(response.status).toBe(404);
		expect(response.body.error).toBe("Form was not found");
	});
});

const countRows = (db: AppDatabase, tableName: "ingested_forms" | "transformed_forms" | "email_notifications") => {
	return (db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number }).count;
};

const getNotificationAttempts = (db: AppDatabase) => {
	return (db.prepare("SELECT attempts FROM email_notifications").get() as { attempts: number }).attempts;
};
