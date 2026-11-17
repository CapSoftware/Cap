import { describe, expect, test } from "bun:test";
import { ProgressWebhookThrottle } from "../../loom-importer/job";

describe("ProgressWebhookThrottle", () => {
	test("sends the first update for a job", () => {
		const throttle = new ProgressWebhookThrottle(15_000);
		expect(throttle.shouldSend("job-1", "downloading", 0)).toBe(true);
	});

	test("holds same-phase updates inside the interval", () => {
		const throttle = new ProgressWebhookThrottle(15_000);
		throttle.shouldSend("job-1", "downloading", 0);
		expect(throttle.shouldSend("job-1", "downloading", 1_000)).toBe(false);
		expect(throttle.shouldSend("job-1", "downloading", 14_999)).toBe(false);
	});

	test("sends again once the interval passes", () => {
		const throttle = new ProgressWebhookThrottle(15_000);
		throttle.shouldSend("job-1", "downloading", 0);
		expect(throttle.shouldSend("job-1", "downloading", 15_000)).toBe(true);
		expect(throttle.shouldSend("job-1", "downloading", 20_000)).toBe(false);
		expect(throttle.shouldSend("job-1", "downloading", 30_000)).toBe(true);
	});

	test("sends a phase change straight away", () => {
		const throttle = new ProgressWebhookThrottle(15_000);
		throttle.shouldSend("job-1", "downloading", 0);
		expect(throttle.shouldSend("job-1", "uploading", 1)).toBe(true);
		expect(throttle.shouldSend("job-1", "uploading", 2)).toBe(false);
	});

	test("tracks jobs separately", () => {
		const throttle = new ProgressWebhookThrottle(15_000);
		throttle.shouldSend("job-1", "downloading", 0);
		expect(throttle.shouldSend("job-2", "downloading", 1)).toBe(true);
	});

	test("forgets finished jobs", () => {
		const throttle = new ProgressWebhookThrottle(15_000);
		throttle.shouldSend("job-1", "downloading", 0);
		throttle.forget("job-1");
		expect(throttle.shouldSend("job-1", "downloading", 1)).toBe(true);
	});
});
