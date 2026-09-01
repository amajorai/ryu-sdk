import { type ApiTarget, request } from "./client.ts";

export interface CatalogItem {
	category: string;
	deprecated: boolean;
	description: string;
	display_name: string;
	install_state: string;
	installed_version: string | null;
	latest_version: string | null;
	name: string;
	recommended: boolean;
}

export interface SidecarStatus {
	name: string;
	running: boolean;
}

export interface ServiceEntry extends CatalogItem {
	running: boolean;
}

export async function fetchSidecarStatus(
	target: ApiTarget
): Promise<SidecarStatus[]> {
	const json = await request<{ sidecars?: SidecarStatus[] }>(
		target,
		"/api/sidecar/status"
	);
	return json.sidecars ?? [];
}

export async function fetchCatalog(target: ApiTarget): Promise<CatalogItem[]> {
	const json = await request<{ sidecars?: CatalogItem[] }>(
		target,
		"/api/catalog"
	);
	return json.sidecars ?? [];
}

export async function fetchServices(
	target: ApiTarget
): Promise<ServiceEntry[]> {
	const [statuses, catalog] = await Promise.all([
		fetchSidecarStatus(target),
		fetchCatalog(target),
	]);
	const statusByName = new Map(
		statuses.map((status) => [status.name, status.running])
	);
	return catalog.map((item) => ({
		...item,
		running: statusByName.get(item.name) ?? false,
	}));
}
