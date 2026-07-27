// TypeBox (JSON Schema) -> Zod conversion, used when exposing pi tools over MCP.
//
// Pi tools declare parameters as TypeBox objects, which are plain JSON Schema at
// runtime. The Agent SDK's createSdkMcpServer requires Zod: it detects Zod via the
// `~standard` marker or `_def`/`_zod` properties and *silently* downgrades anything
// unrecognised to `{type: "object", properties: {}}`, leaving the model with no
// parameter information at all. This module bridges the two so bridged pi tools keep
// their schemas. If tool arguments start coming through empty after an SDK bump, check
// whether that detection changed or whether raw JSON Schema is now accepted.

import { z } from "zod";

interface JsonSchemaNode {
	type?: unknown;
	enum?: unknown;
	items?: unknown;
	description?: unknown;
	properties?: unknown;
	required?: unknown;
}

export function jsonSchemaPropertyToZod(prop: JsonSchemaNode): z.ZodTypeAny {
	let base: z.ZodTypeAny;
	if (Array.isArray(prop.enum) && prop.enum.length > 0) {
		base = z.enum(prop.enum.map(String) as [string, ...string[]]);
	} else {
		switch (prop.type) {
			case "string": base = z.string(); break;
			case "number": case "integer": base = z.number(); break;
			case "boolean": base = z.boolean(); break;
			case "array":
				base = prop.items
					? z.array(jsonSchemaPropertyToZod(prop.items as JsonSchemaNode))
					: z.array(z.unknown());
				break;
			case "object": base = z.record(z.string(), z.unknown()); break;
			default: base = z.unknown();
		}
	}
	if (typeof prop.description === "string") base = base.describe(prop.description);
	return base;
}

export function jsonSchemaToZodShape(schema: unknown): Record<string, z.ZodTypeAny> {
	if (typeof schema !== "object" || schema === null) return {};
	const s = schema as JsonSchemaNode;
	if (s.type !== "object" || typeof s.properties !== "object" || s.properties === null) return {};
	const props = s.properties as Record<string, JsonSchemaNode>;
	const required = new Set(Array.isArray(s.required) ? s.required.map(String) : []);
	const shape: Record<string, z.ZodTypeAny> = {};
	for (const [key, prop] of Object.entries(props)) {
		const zodProp = jsonSchemaPropertyToZod(prop);
		shape[key] = required.has(key) ? zodProp : zodProp.optional();
	}
	return shape;
}
