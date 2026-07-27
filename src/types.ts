// Shared type aliases for the pi surface this extension talks to.

import type { Api, Model } from "@earendil-works/pi-ai";

/**
 * A model registered by this extension.
 *
 * The provider declares a custom `api` string ("claude-subscription") that isn't one of
 * pi-ai's KnownApi values. `Api` is an open union (`KnownApi | (string & {})`), so
 * `Model<Api>` accepts it while still type-checking every other field — which is why
 * this exists instead of `Model<any>`.
 */
export type BridgeModel = Model<Api>;
