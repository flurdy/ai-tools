import assert from "node:assert/strict";
import test from "node:test";
import {
	createOpenRouterCreditsCache,
	fetchOpenRouterCredits,
	isOpenRouterCreditsStale,
	openRouterCreditsApiKey,
} from "./openrouter-credits.ts";

const jsonResponse = (body: unknown, status = 200) =>
	Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

test("loads the management key for the configured project", () => {
	const calls: string[][] = [];
	const lookup = (service: string, project: string) => {
		calls.push([service, project]);
		return "  secret  ";
	};

	assert.equal(openRouterCreditsApiKey({ SECRET_API_KEY_PROJECT: "flurdy" }, lookup), "secret");
	assert.deepEqual(calls, [["openrouter_management", "flurdy"]]);
});

test("retains an explicit management key without invoking the helper", () => {
	let lookups = 0;
	assert.equal(
		openRouterCreditsApiKey({ PI_STATUSLINE_OPENROUTER_MANAGEMENT_KEY: "  secret  " }, () => {
			lookups++;
			return undefined;
		}),
		"secret",
	);
	assert.equal(lookups, 0);
});

test("does not load a management key when disabled or unconfigured", () => {
	let lookups = 0;
	const lookup = () => {
		lookups++;
		return "secret";
	};

	assert.equal(openRouterCreditsApiKey({}, lookup), undefined);
	assert.equal(openRouterCreditsApiKey({ PI_STATUSLINE_OPENROUTER_CREDITS: "0", SECRET_API_KEY_PROJECT: "flurdy" }, lookup), undefined);
	assert.equal(lookups, 0);
});

test("does not create a lookup when disabled or unconfigured", () => {
	let requests = 0;
	for (const env of [{}, { PI_STATUSLINE_OPENROUTER_CREDITS: "0", SECRET_API_KEY_PROJECT: "flurdy" }]) {
		const cache = createOpenRouterCreditsCache({
			apiKey: openRouterCreditsApiKey(env, () => "secret"),
			fetchImpl: () => {
				requests++;
				return jsonResponse({ data: { total_credits: 10, total_usage: 2 } });
			},
		});
		assert.equal(cache, undefined);
	}
	assert.equal(requests, 0);
});

test("fetches account credits and calculates the remaining balance", async () => {
	let requestUrl = "";
	let authorization = "";
	const credits = await fetchOpenRouterCredits({
		apiKey: "management-secret",
		fetchedAtMs: 123,
		fetchImpl: (input, init) => {
			requestUrl = String(input);
			authorization = new Headers(init?.headers).get("authorization") ?? "";
			return jsonResponse({ data: { total_credits: 100.5, total_usage: 25.75 } });
		},
	});

	assert.equal(requestUrl, "https://openrouter.ai/api/v1/credits");
	assert.equal(authorization, "Bearer management-secret");
	assert.deepEqual(credits, {
		totalCredits: 100.5,
		totalUsage: 25.75,
		remainingCredits: 74.75,
		fetchedAtMs: 123,
	});
});

test("rejects malformed credit responses", async () => {
	for (const body of [null, {}, { data: {} }, { data: { total_credits: "10", total_usage: 2 } }, { data: { total_credits: -1, total_usage: 2 } }]) {
		await assert.rejects(
			fetchOpenRouterCredits({ apiKey: "secret", fetchImpl: () => jsonResponse(body) }),
			/did not include valid totals/,
		);
	}
	await assert.rejects(
		fetchOpenRouterCredits({ apiKey: "secret", fetchImpl: () => Promise.resolve(new Response("not json")) }),
		/not valid JSON/,
	);
});

test("reports authorization failures without exposing the management key or response body", async () => {
	for (const status of [401, 403]) {
		const error = await assert.rejects(
			fetchOpenRouterCredits({
				apiKey: "management-secret",
				fetchImpl: () => jsonResponse({ error: { message: "management-secret rejected" } }, status),
			}),
			new RegExp(`HTTP ${status}`),
		);
		assert.doesNotMatch(String(error), /management-secret/);
	}
});

test("times out a hanging request", async () => {
	let aborted = false;
	const fetchImpl: typeof fetch = (_input, init) =>
		new Promise((_resolve, reject) => {
			init?.signal?.addEventListener(
				"abort",
				() => {
					aborted = true;
					reject(new Error("aborted"));
				},
				{ once: true },
			);
		});

	await assert.rejects(fetchOpenRouterCredits({ apiKey: "secret", timeoutMs: 10, fetchImpl }), /timed out after 10ms/);
	assert.equal(aborted, true);
});

test("supports aborting before and during a request", async () => {
	const before = new AbortController();
	before.abort();
	let called = false;
	await assert.rejects(
		fetchOpenRouterCredits({
			apiKey: "secret",
			signal: before.signal,
			fetchImpl: () => {
				called = true;
				return jsonResponse({});
			},
		}),
		/aborted/,
	);
	assert.equal(called, false);

	const during = new AbortController();
	const query = fetchOpenRouterCredits({
		apiKey: "secret",
		signal: during.signal,
		fetchImpl: (_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			}),
	});
	during.abort();
	await assert.rejects(query, /aborted/);
});

test("retains and immediately marks the last balance stale after a transient refresh failure", async () => {
	let request = 0;
	const cache = createOpenRouterCreditsCache({
		apiKey: "secret",
		staleAfterMs: 60_000,
		fetchImpl: () => {
			request++;
			return request === 1
				? jsonResponse({ data: { total_credits: 10, total_usage: 2 } })
				: Promise.reject(new Error("network unavailable"));
		},
	});
	assert.ok(cache);
	await cache.refresh();
	assert.equal(cache.credits?.remainingCredits, 8);
	assert.equal(cache.isStale(), false);
	await cache.refresh();
	assert.equal(cache.credits?.remainingCredits, 8);
	assert.equal(cache.isStale(), true);
});

test("hides a previous balance after authorization or malformed-response failures", async () => {
	for (const failedResponse of [
		() => jsonResponse({ error: { message: "forbidden" } }, 403),
		() => jsonResponse({ data: { total_credits: "invalid", total_usage: 2 } }),
	]) {
		let request = 0;
		const cache = createOpenRouterCreditsCache({
			apiKey: "secret",
			fetchImpl: () => {
				request++;
				return request === 1 ? jsonResponse({ data: { total_credits: 10, total_usage: 2 } }) : failedResponse();
			},
		});
		assert.ok(cache);
		await cache.refresh();
		assert.equal(cache.credits?.remainingCredits, 8);
		await cache.refresh();
		assert.equal(cache.credits, undefined);
	}
});

test("marks old credit snapshots stale", () => {
	const credits = { totalCredits: 10, totalUsage: 2, remainingCredits: 8, fetchedAtMs: 1000 };
	assert.equal(isOpenRouterCreditsStale(credits, 2000, 5000), false);
	assert.equal(isOpenRouterCreditsStale(credits, 6001, 5000), true);
});
