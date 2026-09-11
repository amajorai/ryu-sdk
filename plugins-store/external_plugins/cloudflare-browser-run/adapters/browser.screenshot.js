// Capability adapter for `browser.control / browser.screenshot` backed by Cloudflare Browser Run.
// Injected globals: `input`, `defaults`, `callTool`, and `callNamed`.
// This flat fragment runs inside Core's generated async adapter IIFE.

const url = typeof input.tab_id === "string" ? input.tab_id.trim() : "";
if (!url) {
	return { error: "tab_id is required; Cloudflare Browser Run uses the URL as the tab id" };
}

const raw = await callTool({ url });
if (!raw || raw.isError || raw.error || raw.available === false) {
	return { raw };
}
const image = raw?.content?.find((item) => item?.type === "image");
if (!image) {
	return { raw };
}
return {
	tab_id: url,
	url,
	image: image
		? { data: image.data, mimeType: image.mimeType }
		: undefined,
	raw,
};
