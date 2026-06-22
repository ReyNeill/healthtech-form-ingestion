import crypto from "crypto";

export const hashPayload = (payload: unknown) => {
	return crypto.createHash("sha256").update(stableStringify(payload)).digest("hex");
};

const stableStringify = (value: unknown): string => {
	if (typeof value === "undefined") {
		return "undefined";
	}

	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}

	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}

	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
		.join(",")}}`;
};
