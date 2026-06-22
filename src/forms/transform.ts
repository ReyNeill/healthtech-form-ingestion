import { IngestedFormSchema } from "./schemas/ingested_schema";
import { TransformedFormSchema } from "./schemas/transformed_schema";

export const transformForm = (
	form: IngestedFormSchema,
	coordinates: { longitude: number; latitude: number },
): TransformedFormSchema => {
	// The provider sends one name field, so split deterministically instead of guessing name semantics.
	const [firstName, ...lastNameParts] = form.name.trim().split(/\s+/);
	const lastName = lastNameParts.join(" ");

	if (!firstName || !lastName) {
		throw new Error("Name must include at least a first and last name");
	}

	const dateOfBirth = new Date(`${form.date_of_birth}T00:00:00.000Z`);
	if (Number.isNaN(dateOfBirth.getTime())) {
		throw new Error("Date of birth is invalid");
	}

	return {
		sessionId: form.session_id,
		applicationReference: form.application_reference,
		firstName,
		lastName,
		email: form.email,
		gender: form.gender === "other" ? "prefer-not-to-say" : form.gender,
		dateOfBirth,
		phoneNumber: form.phone_number,
		mobileNumber: form.mobile_number,
		addressLine1: form.address.address_line_1,
		addressLine2: form.address.address_line_2,
		addressLine3: form.address.address_line_3,
		postcode: form.address.postcode,
		country: form.address.country,
		longitude: coordinates.longitude,
		latitude: coordinates.latitude,
	};
};
