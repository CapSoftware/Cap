import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";

const LicenseType = Schema.Literal("yearly", "lifetime");

export class HttpContract extends HttpApi.make("cap-license-api").add(
	HttpApiGroup.make("license")
		.add(
			HttpApiEndpoint.post("activateCommercialLicense", "/commercial/activate")
				.setHeaders(
					Schema.Struct({
						licensekey: Schema.String,
						instanceid: Schema.String,
					}),
				)
				.setPayload(
					Schema.Struct({
						reset: Schema.optional(Schema.Boolean),
					}),
				)
				.addSuccess(
					Schema.Struct({
						message: Schema.String,
						expiryDate: Schema.optional(Schema.Number),
						refresh: Schema.Number,
					}),
				)
				.addError(
					Schema.Struct({
						message: Schema.String,
					}),
					{ status: 403 },
				),
		)
		.add(
			HttpApiEndpoint.post(
				"createCommercialCheckoutUrl",
				"/commercial/checkout",
			)
				.setPayload(
					Schema.Struct({
						type: LicenseType,
						quantity: Schema.optional(
							Schema.Number.pipe(
								Schema.int(),
								Schema.greaterThanOrEqualTo(1),
								Schema.lessThanOrEqualTo(100),
							),
						),
					}),
				)
				.addSuccess(Schema.Struct({ url: Schema.String }))
				.addError(
					Schema.Struct({
						message: Schema.String,
					}),
					{ status: 500 },
				),
		),
) {}
