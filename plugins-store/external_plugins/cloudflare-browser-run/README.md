# Cloudflare Browser Run

Cloudflare Browser Run is an external provider for Ryu's swappable `browser.control`
layer. It connects to Cloudflare's hosted Browser Run MCP server with Core-managed
OAuth and exposes URL-scoped `browser.navigate`, `browser.snapshot`, and
`browser.screenshot` verbs.

The complete Cloudflare MCP tool set remains available under the `cloudflare.*`
namespace, including HTML, Markdown, PDF, JSON, links, crawl, and browser-session
tools. The canonical browser facade intentionally exposes only the operations whose
quick-action contract has a stable URL input; click, type, scroll, and tab-list
operations stay native until a session-backed adapter can preserve their semantics.

Install from Marketplace, complete the Cloudflare OAuth connection, then select
**Cloudflare Browser Run** in the Browser provider picker. The provider is marked
external because its browser runs on Cloudflare's edge rather than on the local
machine.

References:

- [Cloudflare Browser Run](https://developers.cloudflare.com/browser-run/)
- [Cloudflare Browser Rendering MCP server](https://github.com/cloudflare/mcp-server-cloudflare/tree/main/apps/browser-rendering)
