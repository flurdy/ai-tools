import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { encodeRow as specimen } from "../pi/experiments/goal-baseline/fixture/csv.mjs";

const cases = JSON.parse(readFileSync(new URL("../pi/experiments/goal-baseline/oracle/cases.json", import.meta.url), "utf8"));

// This harness executes trusted, committed functions only, never a trial candidate.
function failures(encodeRow) {
	return cases.flatMap(({ id, fields, expected }) => {
		const input = [...fields];
		try {
			const output = encodeRow(input);
			assert.equal(typeof output, "string");
			assert.equal(output, expected);
			assert.deepEqual(input, fields);
			return [];
		} catch {
			return [id];
		}
	});
}

function reference(fields) {
	return fields.map((field) => {
		const escaped = field.replaceAll('"', '""');
		return /[,"\r\n]/.test(field) || (fields.length === 1 && field === "") ? `"${escaped}"` : field;
	}).join(",") + "\r\n";
}

const defectCases = ["quote", "repeated-quotes", "quote-with-comma-and-newline"];

test("oracle cases have unique IDs, string fields and exact CRLF-terminated expected bytes", () => {
	assert.equal(cases.length, 13);
	assert.equal(new Set(cases.map(({ id }) => id)).size, cases.length);
	for (const { id, fields, expected } of cases) {
		assert.equal(typeof id, "string");
		assert.ok(id.length > 0);
		assert.ok(Array.isArray(fields));
		assert.ok(fields.every((field) => typeof field === "string"));
		assert.equal(typeof expected, "string");
		assert.ok(expected.endsWith("\r\n"));
	}
});

test("specimen fails only the intended quote-doubling cases", () => {
	assert.deepEqual(failures(specimen), defectCases);
});

test("trusted reference passes every frozen case", () => {
	assert.deepEqual(failures(reference), []);
});

test("the oracle is independent of repeated local evaluations", () => {
	const before = structuredClone(cases);
	assert.deepEqual(failures(reference), []);
	assert.deepEqual(failures(specimen), defectCases);
	assert.deepEqual(cases, before);
});

test("mutating inputs fails even when the returned CSV is correct", () => {
	assert.equal(failures((fields) => {
		const output = reference(fields);
		fields.push("unexpected");
		return output;
	}).length, cases.length);
});

test("exceptions and non-string outputs cannot pass", () => {
	assert.equal(failures(() => { throw new Error("fixture failure"); }).length, cases.length);
	assert.equal(failures((fields) => new String(reference(fields))).length, cases.length);
});

test("missing CRLF and unnecessary quoting cannot pass", () => {
	assert.equal(failures((fields) => reference(fields).slice(0, -2)).length, cases.length);
	const alwaysQuoted = (fields) => fields.map((field) => `"${field.replaceAll('"', '""')}"`).join(",") + "\r\n";
	assert.ok(failures(alwaysQuoted).includes("plain"));
	assert.ok(failures(alwaysQuoted).includes("spaces"));
});
