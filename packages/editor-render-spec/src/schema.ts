import { z } from "zod";
import { ASPECT_RATIO_KEYS } from "./types";

export const AspectRatioKeySchema = z.enum(ASPECT_RATIO_KEYS);

export const RgbTupleSchema = z.tuple([z.number(), z.number(), z.number()]);

export const BackgroundSourceSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("wallpaper"),
		path: z.string().nullable(),
	}),
	z.object({
		type: z.literal("image"),
		path: z.string().nullable(),
	}),
	z.object({
		type: z.literal("color"),
		value: RgbTupleSchema,
		alpha: z.number().optional(),
	}),
	z.object({
		type: z.literal("gradient"),
		from: RgbTupleSchema,
		to: RgbTupleSchema,
		angle: z.number().optional(),
	}),
]);

export const AdvancedShadowSchema = z.object({
	size: z.number(),
	opacity: z.number(),
	blur: z.number(),
});

export const BackgroundConfigSchema = z.object({
	source: BackgroundSourceSchema,
	padding: z.number(),
	rounding: z.number(),
	roundingType: z.enum(["rounded", "squircle"]),
	crop: z
		.object({
			x: z.number(),
			y: z.number(),
			width: z.number(),
			height: z.number(),
		})
		.nullable(),
	shadow: z.number(),
	advancedShadow: AdvancedShadowSchema,
});

export const TimelineSegmentSchema = z.object({
	start: z.number(),
	end: z.number(),
	timescale: z.number(),
});

export const TimelineConfigSchema = z.object({
	segments: z.array(TimelineSegmentSchema),
});

export const NormalizedRenderConfigSchema = z.object({
	aspectRatio: AspectRatioKeySchema.nullable(),
	background: BackgroundConfigSchema,
	timeline: TimelineConfigSchema.nullable(),
});
