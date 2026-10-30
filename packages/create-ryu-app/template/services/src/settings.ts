/**
 * This server's own settings. The Ryu SDK reads its keys (RYU_API_KEY,
 * RYU_ORGANIZATION_ID, RYU_NOTIFY_API_KEY) itself; these are the values only
 * this app needs.
 */

/** Settings read from the environment; each is optional so the server starts without it. */
export interface AppSettings {
	/** The inbox ID Mail sends from. A key with only `mail:send` must pass an ID, not an address. */
	mailFrom?: string;
	/** The `whsec_…` signing secret of your Mail webhook. */
	mailWebhookSecret?: string;
	/** The secret of your Notify webhook destination. */
	notifyWebhookSecret?: string;
}

type EnvSource = Record<string, string | undefined>;

function present(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

/** The port the server listens on when `PORT` is unset, empty or invalid. */
export const DEFAULT_PORT = 3000;
const MAX_PORT = 65_535;
const DIGITS = /^\d+$/;

/**
 * Reads `PORT` from `env` (default `process.env`). An empty value (as left by
 * `cp .env.example .env`), a non-number or an out-of-range port falls back to
 * {@link DEFAULT_PORT}.
 */
export function readPort(env: EnvSource = process.env): number {
	const raw = present(env.PORT);
	if (!(raw && DIGITS.test(raw))) {
		return DEFAULT_PORT;
	}
	const port = Number(raw);
	return port >= 1 && port <= MAX_PORT ? port : DEFAULT_PORT;
}

/** Reads {@link AppSettings} from `env` (default `process.env`). */
export function readSettings(env: EnvSource = process.env): AppSettings {
	return {
		mailFrom: present(env.MAIL_FROM),
		mailWebhookSecret: present(env.MAIL_WEBHOOK_SECRET),
		notifyWebhookSecret: present(env.NOTIFY_WEBHOOK_SECRET),
	};
}
