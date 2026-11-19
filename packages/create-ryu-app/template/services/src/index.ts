/**
 * Serves the app with Bun. `bun dev` runs this file and reloads on save; Bun
 * loads `.env` automatically.
 */

import { createApp } from "./app.ts";
import { readPort, readSettings } from "./settings.ts";

function log(line: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(line)}\n`);
}

const app = createApp({
	settings: readSettings(),
	onMailEvent: (event) => {
		log({ webhook: "mail", type: event.event_type, eventId: event.event_id });
	},
	onNotifyDelivery: (delivery) => {
		log({
			webhook: "notify",
			deliveryId: delivery.deliveryId,
			eventId: delivery.eventId,
		});
	},
});

export default {
	port: readPort(),
	fetch: app.fetch,
};
