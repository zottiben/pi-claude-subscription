// Process-wide runtime state: resolved config and the pi UI handle.
//
// These are set once when the extension activates and read from every layer below, so
// they live here rather than being threaded through every call. Access goes through
// functions, not exported `let`s, so a stale binding can't be captured at import time.

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { ProviderConfig } from "./config.js";
import type { LongContextSettings } from "./models.js";

let providerSettings: ProviderConfig = {};
let longContextSettings: LongContextSettings = { plan: "pro", longContextExtraUsage: false };
let ui: ExtensionUIContext | null = null;

export function setProviderSettings(settings: ProviderConfig): void {
	providerSettings = settings;
	longContextSettings = {
		plan: settings.plan ?? "pro",
		longContextExtraUsage: settings.longContextExtraUsage ?? false,
	};
}

export function getProviderSettings(): ProviderConfig {
	return providerSettings;
}

/** Plan/entitlement inputs that decide which models get a 1M context window. */
export function getLongContextSettings(): LongContextSettings {
	return longContextSettings;
}

export function setUI(next: ExtensionUIContext | null): void {
	ui = next;
}

/** Notify the user through pi's TUI. No-op before the first session_start, or in modes without a UI. */
export function notify(message: string, level: "info" | "warning" | "error"): void {
	ui?.notify(message, level);
}
