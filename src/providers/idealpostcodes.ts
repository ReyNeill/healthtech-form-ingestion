import { HttpResponse } from "./httpresponse";

export const lookupPostcode = async (_postcode: string): Promise<HttpResponse<{ longitude: number; latitude: number }>> => {
	const forcedStatusCode = parseForcedStatusCode(process.env.MOCK_IDEALPOSTCODES_STATUS);
	// Generate a random number between 0 and 1
	const randomNumber = Math.random();

	// Simulating an asynchronous operation, e.g., looking up a postcode
	await new Promise((resolve) => setTimeout(resolve, 1000));

	const success = forcedStatusCode ? forcedStatusCode >= 200 && forcedStatusCode < 300 : randomNumber < 0.95;
	return {
		statusCode: forcedStatusCode ?? (success ? 200 : 500),
		body: success ? { longitude: 50.05, latitude: -5.05 } : undefined,
	};
};

const parseForcedStatusCode = (value: string | undefined) => {
	if (!value) {
		return undefined;
	}

	const statusCode = Number(value);
	return Number.isInteger(statusCode) ? statusCode : undefined;
};
