import { HttpResponse } from "./httpresponse";

export const sendEmail = async ({
	to: _to,
	from: _from,
	subject: _subject,
	body: _body,
}: {
	to: string;
	from: string;
	subject: string;
	body: string;
}): Promise<HttpResponse<void>> => {
	const forcedStatusCode = parseForcedStatusCode(process.env.MOCK_SENDGRID_STATUS);
	// Generate a random number between 0 and 1
	const randomNumber = Math.random();

	// Simulating an asynchronous operation, e.g., sending an email
	await new Promise((resolve) => setTimeout(resolve, 1000));
	return {
		statusCode: forcedStatusCode ?? (randomNumber < 0.95 ? 200 : 500),
		body: undefined,
	};
};

const parseForcedStatusCode = (value: string | undefined) => {
	if (!value) {
		return undefined;
	}

	const statusCode = Number(value);
	return Number.isInteger(statusCode) ? statusCode : undefined;
};
