// Unit tests for the TypeBox (JSON Schema) -> Zod conversion.
//
// This exists because createSdkMcpServer silently downgrades a schema it doesn't
// recognise as Zod to an empty object, leaving the model with no parameter information.
// A silent failure like that needs explicit coverage.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { jsonSchemaPropertyToZod, jsonSchemaToZodShape } from "../../src/typebox-to-zod.js";

describe("jsonSchemaPropertyToZod", () => {
	it("maps the primitive types", () => {
		assert.equal(jsonSchemaPropertyToZod({ type: "string" }).safeParse("x").success, true);
		assert.equal(jsonSchemaPropertyToZod({ type: "number" }).safeParse(1).success, true);
		assert.equal(jsonSchemaPropertyToZod({ type: "integer" }).safeParse(1).success, true);
		assert.equal(jsonSchemaPropertyToZod({ type: "boolean" }).safeParse(true).success, true);
	});

	it("rejects values of the wrong type", () => {
		assert.equal(jsonSchemaPropertyToZod({ type: "string" }).safeParse(1).success, false);
		assert.equal(jsonSchemaPropertyToZod({ type: "number" }).safeParse("x").success, false);
	});

	it("maps enums", () => {
		const schema = jsonSchemaPropertyToZod({ enum: ["read", "full"] });
		assert.equal(schema.safeParse("read").success, true);
		assert.equal(schema.safeParse("nope").success, false);
	});

	it("maps typed arrays", () => {
		const schema = jsonSchemaPropertyToZod({ type: "array", items: { type: "string" } });
		assert.equal(schema.safeParse(["a", "b"]).success, true);
		assert.equal(schema.safeParse([1]).success, false);
	});

	it("maps untyped arrays permissively", () => {
		assert.equal(jsonSchemaPropertyToZod({ type: "array" }).safeParse([1, "a"]).success, true);
	});

	it("falls back to unknown for unrecognised types", () => {
		assert.equal(jsonSchemaPropertyToZod({ type: "wat" }).safeParse({ any: "thing" }).success, true);
	});
});

describe("jsonSchemaToZodShape", () => {
	it("converts a real TypeBox tool schema, marking optionals", () => {
		const parameters = Type.Object({
			prompt: Type.String({ description: "The prompt" }),
			mode: Type.Optional(Type.String()),
		});
		const shape = jsonSchemaToZodShape(parameters);

		assert.deepEqual(Object.keys(shape).sort(), ["mode", "prompt"]);
		assert.equal(shape.prompt?.safeParse(undefined).success, false, "required fields must reject undefined");
		assert.equal(shape.mode?.safeParse(undefined).success, true, "optional fields must accept undefined");
	});

	it("preserves descriptions, which are what the model reads", () => {
		const shape = jsonSchemaToZodShape(Type.Object({ prompt: Type.String({ description: "The prompt" }) }));
		assert.equal(shape.prompt?.description, "The prompt");
	});

	it("returns empty for schemas that aren't objects", () => {
		assert.deepEqual(jsonSchemaToZodShape(undefined), {});
		assert.deepEqual(jsonSchemaToZodShape(null), {});
		assert.deepEqual(jsonSchemaToZodShape({ type: "string" }), {});
		assert.deepEqual(jsonSchemaToZodShape({ type: "object" }), {}, "an object with no properties");
	});

	it("handles a parameterless tool", () => {
		assert.deepEqual(jsonSchemaToZodShape(Type.Object({})), {});
	});
});
