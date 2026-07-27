// Identity constants. Every user-visible name the extension claims — provider
// id, config filename, log paths, env vars — derives from here so a rename is
// a one-line change and can never drift between modules.

export const PROVIDER_ID = "claude-subscription";

/** Marker written to the registered provider's `baseUrl`. Used to detect that the
 *  active model routes through this extension (circular-delegation guard, compact
 *  takeover) without string-matching the provider id at every call site. */
export const PROVIDER_BASE_URL = PROVIDER_ID;

/** Basename of the JSON config file, looked up in both the global pi agent dir
 *  and the project pi config dir. */
export const CONFIG_FILE_NAME = `${PROVIDER_ID}.json`;

export const DEBUG_ENV_VAR = "CLAUDE_SUBSCRIPTION_DEBUG";
export const DEBUG_PATH_ENV_VAR = "CLAUDE_SUBSCRIPTION_DEBUG_PATH";

export const DEBUG_LOG_BASENAME = `${PROVIDER_ID}.log`;
export const DIAG_LOG_BASENAME = `${PROVIDER_ID}-diag.log`;

/** Subdirectory (next to the debug log) holding one Claude Code CLI debug log per query. */
export const CLI_LOG_DIR_NAME = "cc-cli-logs";

export const ISSUES_URL = "https://github.com/zottiben/pi-claude-subscription/issues/new";

/** Log-line prefix and the name used in user-facing notifications. */
export const LOG_PREFIX = PROVIDER_ID;
