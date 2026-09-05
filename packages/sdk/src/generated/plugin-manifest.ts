/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source of truth: crates/ryu-kernel-contracts (Rust) via the checked-in
 * schemas/plugin-manifest.schema.json. Regenerate with:
 *
 *   bun run generate:contracts
 *
 * (after re-blessing the schema with
 *  `RYU_REGEN_SCHEMAS=1 cargo test -p ryu-kernel-contracts` when the Rust
 *  manifest types change).
 */

/**
 * One selectable option for a [`SettingsFieldType::Select`] field.
 *
 * Accepts both spellings the desktop's `parseOptions` accepts: a bare string
 * (value and label are the same) or an object with an explicit `label`. Keeping
 * both is not indulgence — the bare-string form is what every hand-written
 * manifest reaches for, and rejecting it would push authors into boilerplate for
 * the common case.
 */
export type SettingsFieldOption =
	| string
	| {
			/**
			 * Display label. Absent = show the raw `value`.
			 */
			label?: string | null;
			/**
			 * The value persisted to the preference key.
			 */
			value: string;
	  };
/**
 * Authentication Ryu performs on behalf of the user for a remote MCP server.
 *
 * `deny_unknown_fields` is a security boundary: a publisher cannot smuggle a
 * client secret, token endpoint, redirect URI, token or scope list into a signed
 * manifest and have an older Core silently ignore it.
 */
export type McpServerAuthDecl = {
	client_id?: string | null;
	type: "oauth";
};
/**
 * What a capability provider acts on — see [`ProvidesEntry::target`].
 *
 * Deliberately two coarse values rather than a taxonomy. The only question a user
 * needs answered before swapping is "will this act on the machine in front of me,
 * or somewhere else?", and a finer vocabulary (container / VM / cloud / another
 * host) would be guesswork the manifests cannot honestly support.
 */
export type ProviderTarget = "local-machine" | "remote-desktop";
/**
 * A host surface a plugin can declare support for via `targets`.
 *
 * `core` is the headless node (a Core running with no UI at all).
 *
 * An **empty/absent** `targets` list means the plugin runs on *every* surface —
 * that is the backward-compatible default and MUST NOT be read as "hidden".
 */
export type Surface = "gateway" | "core" | "desktop" | "island" | "mobile" | "extension" | "web" | "cli" | "unknown";

/**
 * An installable Ryu App manifest (`manifest.json`).
 *
 * Modelled on Codex's `manifest.json` pattern: a thin descriptor that bundles one or
 * more [`RunnableEntry`] items (agents, workflows, tools, skills, companions,
 * channels, engines, policies), lists the permission grants the app requires, and
 * optionally declares a Companion surface (an in-desktop overlay or sidebar panel).
 *
 * # Per-kind config
 *
 * Each Runnable entry carries an optional `config` blob whose schema is
 * determined by its `kind`. See [`crate::schema`] for the per-kind structs and the
 * [`crate::schema::validate_runnable`] function.
 */
export interface PluginManifest {
	/**
	 * Primary brand accent color, hex (Ryu extension: `accentColor`).
	 */
	accentColor?: string | null;
	/**
	 * Activation events that lazily wake the plugin — VS-Code `activationEvents`.
	 * Recognised tokens: `"*"` (always active / eager), `"onStartup"`, `"onChat"`,
	 * `"onCommand:<id>"`, `"onRoute"` (fired the first time a lazy sidecar is woken
	 * by an inbound proxy hit), and `"onCapabilityCall"` (the broker analogue —
	 * fired when a lazy provider sidecar is woken by a capability-broker hit). An
	 * **empty** list means *eager* activation (back-compat: every existing manifest
	 * keeps activating on enable). The activation runtime firing these events lives
	 * in Core's `RunnableRegistry::register_active` + `fire_activation_event`;
	 * `onStartup`/`onChat`/`onRoute`/`onCapabilityCall` fire from Core, while
	 * `onCommand:<id>` fires from the desktop command palette.
	 */
	activation_events?: string[];
	/**
	 * Publisher/author. Claude `author` — a bare string or an object with a
	 * `name` field; the detail builder extracts the display string into
	 * `developer`. Kept as a raw value so both shapes round-trip.
	 */
	author?: {
		[k: string]: unknown;
	};
	/**
	 * The plugin's **backend bundle** — the JavaScript source of the extension-host
	 * entry module a [`crate::schema::SidecarProcess::Node`] sidecar runs (RFC Option
	 * B). This is the backend analogue of `ui_code`: a payload blob that Core writes
	 * to the plugin dir at the node sidecar's declared `entry` path at spawn, then
	 * loads via the embedded host bootstrap. Unlike `ui_code` (which the install path
	 * splits into a DB column so the on-disk manifest stays small), the backend blob
	 * rides **inline** in the manifest so the spawn path is self-contained (it reads
	 * the reconstituted manifest, no separate carriage channel) AND, for a
	 * marketplace plugin, the code is INSIDE the Gateway-signed surface — the whole
	 * backend is signed, not merely hash-bound. Absent for a plugin with no node
	 * backend. Written by `ryu pack`/`ryu publish`.
	 */
	backend_code?: string | null;
	/**
	 * Lower-case hex `sha256(utf8_bytes(backend_code))` — the integrity gate for the
	 * node backend, mirroring [`ui_code_sha256`]. When present, Core recomputes the
	 * hash over the on-disk entry file at spawn and **refuses to start** the node
	 * sidecar on mismatch (fail-closed), so an entry file swapped on disk between
	 * install and spawn can never run. Absent = trust the bundle as written (the same
	 * posture `ui_code_sha256` uses when omitted).
	 *
	 * [`ui_code_sha256`]: PluginManifest::ui_code_sha256
	 */
	backend_sha256?: string | null;
	/**
	 * Detail-page hero banner spec; opaque passthrough (Ryu ext).
	 *
	 * The banner is the listing's OWN background, not its icon enlarged. Declared
	 * or not, the hero always paints something: with no `banner` the detail page
	 * derives its wash from `icon_dither`, so an app that never thinks about this
	 * key still opens on its own colour rather than a grey slab. Declaring one is
	 * how an author says "my hero is not just my icon, bigger".
	 *
	 * Accepted keys, all optional — the render layer picks the first that paints
	 * and falls back down the list, so an unknown or malformed value degrades to
	 * the derived wash rather than failing:
	 *
	 * - `background` — a flat CSS background (a colour, a `linear-gradient(…)`).
	 * - `imageUrl` — a raster banner, painted `object-cover`. http(s) only.
	 * - `colors: [String]` — two or more stops, ramped 135°.
	 * - `style: "gradient" | "dither" | "flat" | "image"` — how to treat the
	 *   above; `dither` adds the noise overlay, `flat`/`image` select `background`
	 *   / `imageUrl` explicitly.
	 * - `seed: Number` — the dither noise seed, so two apps sharing a palette do
	 *   not share a texture.
	 *
	 * Kept as raw JSON like `icon_dither`, for the same reason: this is
	 * PUBLISHER-supplied and reaches a CSS background, so it must never fail the
	 * manifest parse, and the client validates before painting (`safeHttpUrl` for
	 * `imageUrl`; the flat string is trusted exactly as far as `icon_background`
	 * already is). Core does not read any of these keys — it copies the whole
	 * value onto the catalog entry — so a new one needs no Core release.
	 */
	banner?: {
		[k: string]: unknown;
	};
	/**
	 * Human-readable capability strings (Ryu extension). When absent the detail
	 * builder DERIVES these from `permission_grants` via
	 * [`crate::schema::capabilities_from_grants`]; declared values are used verbatim.
	 */
	capabilities?: string[];
	/**
	 * Free-text category (Claude `category`). The Store groups its Apps and
	 * Plugins tabs by this string, so two listings that mean the same shelf must
	 * spell it the same way — see the canonical set in `docs/`-adjacent
	 * `STORE_CATEGORY_ORDER` (`packages/marketplace/src/catalog/categories.ts`),
	 * which also decides shelf ORDER. An unrecognised value still renders; it just
	 * sorts after the known shelves, so a new category needs no client release.
	 */
	category?: string | null;
	/**
	 * Optional Companion surface descriptor: an in-desktop overlay or sidebar panel
	 * the app may register. Absent when the app has no Companion surface.
	 */
	companion?: CompanionSurface | null;
	/**
	 * VS-Code-style **contribution points**: a declare-by-id block naming which
	 * of the manifest's `runnables` the plugin contributes to each extensible
	 * surface. Every id referenced here MUST exist in `runnables` (the loader
	 * cross-validates). Absent when the plugin contributes nothing extra
	 * (the common case — a plugin's `runnables` are already its contributions).
	 */
	contributes?: Contributes | null;
	/**
	 * Long plaintext/markdown description. Empty when absent (the built-in card
	 * historically emitted `""` for this; preserved).
	 */
	description?: string | null;
	/**
	 * Required Ryu engine version (VS-Code `engines.vscode` analogue). When
	 * present, `engines.ryu` is a semver **requirement** (e.g. `">=0.3.0"`) and
	 * the loader rejects the manifest if the running Core version does not
	 * satisfy it. Absent = compatible with any Core version.
	 */
	engines?: EnginesReq | null;
	/**
	 * Prompt-chip examples (contract key `examplePrompts`; Ryu extension).
	 */
	examplePrompts?: string[];
	/**
	 * Whether the provider operates outside the local Ryu runtime, for example a
	 * hosted browser or remote MCP service. This is a presentation/provenance
	 * flag, not a permission grant; the actual remote endpoint remains declared
	 * under `mcp_servers` and is governed by the Gateway.
	 */
	external?: boolean;
	/**
	 * Hide this listing from the Store without uninstalling or disabling it.
	 *
	 * The listing keeps working for anyone who already has it — this is a
	 * *catalog* control, not a lifecycle one. It exists so an app that is built
	 * but not ready to be discovered can ship dark: the manifest stays compiled
	 * in, the routes stay registered, and the card simply is not offered.
	 *
	 * Absent ⇒ visible, matching the identically-named field the published
	 * `marketplace.json` already carries for third-party indexes
	 * (`catalog_source::sources`), so both tiers spell "don't list this" the same
	 * way and a client that predates the field just shows everything.
	 */
	hidden?: boolean;
	/**
	 * Homepage/website URL (Claude `homepage`; emitted as `website`).
	 */
	homepage?: string | null;
	/**
	 * Icon-primitive id for the listing card (Ryu extension: `icon`). An
	 * Iconify/icons0 `prefix:name`, a bare Hugeicons name, or a URL — resolved by
	 * the shared `Icon` primitive. Distinct from `icon_url`: this is a GLYPH id the
	 * card masks with `currentColor`, `icon_url` is a raster logo. When absent the
	 * card falls back to `icon_url`, then a default glyph.
	 *
	 * One id shape is NOT a glyph: `svgl:<slug>` (or `svgl:<light>|<dark>`) names a
	 * brand mark on svgl.app, which the card renders as a full-colour image instead
	 * — masking a brand's logo to `currentColor` would flatten it to a silhouette.
	 * Prefer it over `icon_url` for a listing that fronts a known product (Brave,
	 * Firecrawl, Notion, …): it is a stable, versionless id rather than a URL that
	 * can rot, and svgl's own API supplies the dark-theme variant when one exists.
	 */
	icon?: string | null;
	/**
	 * CSS background for the icon square (Ryu extension: `iconBackground`).
	 */
	iconBackground?: string | null;
	/**
	 * Dithered-gradient background for the card's icon square (Ryu extension:
	 * `iconDither`). Opaque passthrough `{ from, to?, direction? }` mirroring
	 * dither-kit's `DitherGradient` props (`from`/`to` are a palette-colour name or
	 * a hue number, `direction` is up|down|left|right). Kept as raw JSON like
	 * `banner` so an untrusted/typo'd value never fails the manifest parse — the
	 * render layer validates and falls back before painting.
	 */
	iconDither?: {
		[k: string]: unknown;
	};
	/**
	 * Inset for the card's icon square (Ryu extension: `iconPadding`).
	 *
	 * A product LOGO that is edge-to-edge in its own art has no breathing room
	 * inside the square and reads as a sticker rather than an icon. One of
	 * `none` | `sm` | `md` | `lg`.
	 *
	 * Any value other than `none` ALSO letterboxes the art (`object-contain`)
	 * instead of cropping it. That coupling is load-bearing, not a convenience:
	 * a listing declaring a bare `iconUrl` (no `icon`) is not in the brand lane,
	 * so it is painted `object-cover` — inset alone would be silently inert for
	 * exactly the raw-logo case this field exists for.
	 *
	 * `Option<String>` rather than a Rust enum, for the same forward-compat
	 * reason `icon_dither` is raw JSON: an unknown value must never fail the
	 * manifest parse. The render layer validates and falls back.
	 */
	iconPadding?: string | null;
	/**
	 * Logo URL (contract key `iconUrl`; Ryu extension).
	 */
	iconUrl?: string | null;
	/**
	 * Reverse-domain unique identifier for the app (e.g. `"com.example.my-app"`).
	 */
	id: string;
	/**
	 * Search keywords / tags (Claude `keywords`).
	 */
	keywords?: string[];
	/**
	 * SPDX license identifier (Claude `license`).
	 */
	license?: string | null;
	/**
	 * This plugin is REQUIRED FOR CORE: the UI must never offer to disable or
	 * uninstall it, and the lifecycle refuses both — with no `force` escape, which
	 * is what separates it from the softer
	 * [`crate::manifest`]-external load-bearing guard.
	 *
	 * **Declaring this does not grant it.** A manifest is untrusted input, and an
	 * undisableable plugin is exactly what a hostile one would ask to be, so the
	 * enforcement set is a Core-owned constant (`plugins::builtins::
	 * MANDATORY_PLUGINS`) and this field is only the manifest-side declaration of
	 * it. A bijection test keeps the two in lockstep, and a third-party manifest
	 * that sets it is ignored by the lifecycle — it only ever affects how the
	 * listing renders. Same posture as `CORE_PLUGINS`: privilege is never
	 * self-asserted.
	 */
	mandatory?: boolean;
	/**
	 * Declarative **stdio MCP servers** this plugin registers into Core's MCP
	 * registry on enable and deregisters on disable/uninstall. Each entry is a
	 * [`McpServerDecl`] keyed by the server name the registry uses (the same key a
	 * user's `mcp.json` would use). This is the manifest-owned successor to Core's
	 * hardcoded built-in MCP servers: a plugin declares its server here instead of
	 * Core baking a `com.ryu.<app>` server into `builtin_servers()`. Empty for the
	 * common case (a plugin that ships no MCP server). A user `mcp.json` entry with
	 * the same name still wins (user-overrides-builtin precedence is preserved by
	 * the registry).
	 */
	mcp_servers?: {
		[k: string]: McpServerDecl;
	};
	/**
	 * Human-readable display name shown in the app store / launcher.
	 */
	name: string;
	/**
	 * Permission grants this app declares it needs (e.g. `"mcp:web_search"`).
	 * These are *declarations only* at this layer — no enforcement happens here;
	 * the Gateway owns grant enforcement.
	 *
	 * This is the **app→host** lane and has nothing to do with
	 * [`permission_levels`], the **app→human** lane. See that field's doc comment
	 * for the three-way table; conflating the two is the likeliest future bug here.
	 *
	 * [`permission_levels`]: PluginManifest::permission_levels
	 */
	permission_grants?: string[];
	/**
	 * **The user-facing permission vocabulary this app declares** — the set of
	 * levels ("read", "edit", …) an administrator can later grant to a person or a
	 * team *inside* this app. Absent/empty = the app declares no vocabulary, which
	 * is every manifest predating this field.
	 *
	 * Spaces declaring `read` and `edit` is what makes "team X may edit in Spaces"
	 * expressible at all: a grant has to name a level, and a UI has to render a
	 * list of them. Without a declaration there is nothing to bind to.
	 *
	 * # Three lanes, one prefix — do not conflate them
	 *
	 * | field | direction | who decides | what it means |
	 * |---|---|---|---|
	 * | [`permission_grants`] | app → host | the **Gateway**, at install/enable | which host capabilities the app may *ask* for |
	 * | [`permissions`] ([`PermissionSet`]) | app → sandbox | **Core**, at spawn/exec | what the app's code may *touch* (FS paths, hosts, subprocess) |
	 * | `permission_levels` | app → human | an **admin**, per person/team | what a *person* may do inside the app |
	 *
	 * Only the first two are enforced today. This field is **declaration only**:
	 * nothing consumes it yet, so declaring `edit` gates nothing by itself. It is
	 * the vocabulary the ACL layer will bind grants against.
	 *
	 * # Ordering and implication
	 *
	 * Declaration order is display order — render the list as written. Strength is
	 * expressed with [`PermissionLevel::implies`] rather than a separate rank, so
	 * there is exactly one ordering and it cannot contradict itself: `edit` implying
	 * `read` means granting `edit` already conveys `read`, and no admin has to grant
	 * the same person both.
	 *
	 * [`permission_grants`]: PluginManifest::permission_grants
	 * [`permissions`]: PluginManifest::permissions
	 */
	permission_levels?: PermissionLevel[];
	/**
	 * **Unified, deny-by-default runtime permission set** — the single typed
	 * grammar (`{fs, child_process, run, network, tool}`) Core lowers to every sandbox
	 * backend (wasmtime WASI preopens, Docker `--mount`/`--network` flags, Deno
	 * `--allow-*` flags). Absent = **deny-all** (the default for every manifest
	 * predating this field), so an app that declares nothing keeps today's exact
	 * zero-permission sandbox posture.
	 *
	 * # Relationship to [`permission_grants`] and [`permission_levels`]
	 *
	 * These are **three distinct lanes** that must not be conflated:
	 * - [`permission_grants`] are opaque strings the **Gateway** approves at
	 *   install/enable time — the *approval* lane (who is allowed to ask).
	 * - `permissions` is the typed set **Core** lowers into the actual sandbox at
	 *   spawn/exec time — the *runtime-enforcement* lane (what the code can touch).
	 * - [`permission_levels`] is the app's *user-facing* vocabulary an admin grants
	 *   to a person or team — it never reaches the sandbox at all.
	 *
	 * A grant says "this app may use the filesystem capability"; `permissions.fs`
	 * says "…and here are the exact read/write paths the sandbox is opened with."
	 *
	 * [`permission_levels`]: PluginManifest::permission_levels
	 *
	 * # Altitude (manifest-level, per-runnable override is a followup)
	 *
	 * Declared at the manifest root because **both** current enforcement sites
	 * resolve their config from the owning manifest, not from a sub-entry: an
	 * `inline_deno` tool's backend is resolved from the manifest by
	 * `McpRegistry::resolve_app_tool_backend`, and a managed sidecar is spawned
	 * from the manifest by `ManifestSidecar`. A per-[`crate::schema::ToolConfig`] /
	 * per-[`crate::schema::SidecarSpec`] override is a clean future extension (the
	 * resolver would fall back to this manifest-level set) but is intentionally not
	 * in v1.
	 */
	permissions?: PermissionSet | null;
	/**
	 * Privacy policy URL (contract key `privacyPolicyUrl`; Ryu extension).
	 */
	privacyPolicyUrl?: string | null;
	/**
	 * **Capabilities this plugin provides** — the inverse of
	 * [`Requires::capabilities`]. Each entry names a capability the plugin's
	 * sidecar can serve for other plugins through the capability broker, binding
	 * the capability to one of this manifest's declared `sidecars` + a proxied
	 * route. Absent/empty for the common case (a plugin that consumes but does not
	 * provide capabilities). The loader cross-validates that every referenced
	 * `sidecar`/`route` exists (like `contributes`).
	 */
	provides?: ProvidesEntry[];
	/**
	 * Public source repository URL (Claude/Codex `repository`). This is listing
	 * metadata only; install and signature resolution still use the catalog's
	 * authoritative source fields.
	 */
	repository?: string | null;
	/**
	 * **Plugin-to-plugin dependencies** — the other plugins this one needs (the
	 * npm-shaped edge that lets the app decompose into a kernel + features).
	 * Resolved into a topological enable order by Core's `plugins::graph`.
	 *
	 * Absent = **no dependencies** (every manifest predating this field).
	 */
	requires?: Requires | null;
	/**
	 * The Runnables this app bundles. Each entry uses [`RunnableEntry`] from the
	 * [`crate::schema`] module so heterogeneous Runnables (agents, workflows,
	 * tools, skills, companions, channels, engines, policies) can be listed
	 * together with their per-kind config.
	 */
	runnables: RunnableEntry[];
	/**
	 * Optional declarative **external runtime** the plugin needs (e.g. a Python
	 * venv + pip deps + assets, like the TTS sidecar). The provisioner lives in
	 * Core (`crate::sidecar::external_runtime`); this is the declaration (#449).
	 * Absent for the common case (no external interpreter needed).
	 */
	runtime?: ExternalRuntimeConfig | null;
	/**
	 * App-Store gallery screenshot URLs (Ryu extension).
	 */
	screenshots?: string[];
	/**
	 * Optional companion/config setup card, or an array of such steps (Ryu
	 * extension). Opaque to Core — passed through to the detail payload verbatim.
	 */
	setup?: {
		[k: string]: unknown;
	};
	/**
	 * Declarative **managed sidecars** the plugin ships (the app ⇄ sidecar
	 * bridge): each is a long-running child process Core downloads/provisions,
	 * spawns, and health-monitors via the Core `SidecarManager` on enable,
	 * exactly like a built-in sidecar. Gated at enable by the `sidecar:process`
	 * grant (Core-tier auto; Community needs the approved grant). Empty for the
	 * common case (no bundled process).
	 */
	sidecars?: SidecarSpec[];
	/**
	 * Provenance hint for the marketplace index: `"builtin"`, an `owner/repo`
	 * slug, or a git/raw URL an external plugin ships from. Absent ⇒ `"builtin"`.
	 * This is an index HINT only — Core derives the real trust tier from
	 * `plugins::builtins` membership at runtime, NOT from this field. Consumed by
	 * the marketplace generator (`tools/mirror-plugins.sh`) to populate each
	 * entry's `source`/`builtin` pair.
	 */
	source?: string | null;
	/**
	 * How finished this listing is: `alpha`, `beta`, `rc`, … Absent or `stable`
	 * means finished and renders no badge.
	 *
	 * Free-form, NOT an enum, for the same reason the marketplace-index copy of
	 * this field is: an unrecognised tier renders verbatim rather than being
	 * dropped, so publishing a `canary` needs no client release.
	 */
	stability?: string | null;
	/**
	 * Per-surface support + UI declaration — the richer successor to [`targets`].
	 *
	 * When **present**, this map is authoritative and [`targets`] is ignored: a
	 * surface is supported iff it has an entry whose [`SurfaceSupport`] is not
	 * [`SurfaceSupport::None`], and an **absent key means the surface is not
	 * supported** (see [`PluginManifest::supports_surface`]). When **absent**, the
	 * predicate falls back to the legacy [`targets`] semantics (empty/absent =
	 * every surface) — so every manifest that predates this field keeps its exact
	 * behaviour. Never make an absent `surfaces` mean "no surfaces".
	 *
	 * [`targets`]: PluginManifest::targets
	 */
	surfaces?: {
		[k: string]: SurfaceEntry;
	} | null;
	/**
	 * Short one-line tagline shown under the name (Ryu extension).
	 */
	tagline?: string | null;
	/**
	 * Curated store-filter tags (Ryu extension). Unlike `keywords`, which is
	 * publisher search vocabulary, these stable labels are the values the
	 * Marketplace filter exposes. Keeping both fields lets Claude/Codex
	 * manifests round-trip their native `keywords` while Ryu authors opt into
	 * a deliberately bounded taxonomy.
	 */
	tags?: string[];
	/**
	 * Host surfaces this plugin runs on (desktop / island / mobile / …).
	 *
	 * **Empty or absent = runs on EVERY surface.** This is the backward-compatible
	 * default and must never be read as "runs nowhere" — every manifest that
	 * predates this field declares no targets and must keep surfacing everywhere.
	 * Filtering happens ONLY when this list is explicitly non-empty, and only at
	 * the read/surface boundary (see [`PluginManifest::supports_surface`]) — never
	 * in the storage layer, so an unsupported-target plugin stays installable and
	 * inspectable.
	 */
	targets?: Surface[];
	/**
	 * Terms-of-service URL (contract key `termsOfServiceUrl`; Ryu extension).
	 */
	termsOfServiceUrl?: string | null;
	/**
	 * Lower-case hex `sha256(utf8_bytes(ui_code))` binding the plugin's bundled
	 * sandboxed-UI code to this manifest. Because the Gateway signs the manifest
	 * verbatim (canonical key-sorted encoding), this hash is INSIDE the signed
	 * surface while the `ui_code` blob itself rides OUTSIDE it as payload; the
	 * install path recomputes the hash over the fetched code and rejects a
	 * mismatch fail-closed. Absent for a manifest-only plugin (no bundled UI) and
	 * for unsigned seed items. Written by `ryu pack`/`ryu publish`.
	 */
	ui_code_sha256?: string | null;
	/**
	 * Semver version string (e.g. `"1.0.0"`).
	 */
	version: string;
}
/**
 * Companion surface descriptor — an optional in-desktop overlay or sidebar panel
 * an App may register. Fields mirror the UX primitives a Companion widget needs;
 * all are optional except `label`.
 */
export interface CompanionSurface {
	/**
	 * Icon identifier (resolved by the desktop shell).
	 */
	icon?: string | null;
	/**
	 * Display label for the companion panel tab or tooltip.
	 */
	label: string;
	/**
	 * Keyboard shortcut string (e.g. `"ctrl+shift+r"`).
	 */
	shortcut?: string | null;
}
/**
 * VS-Code-style **contribution points** (`contributes` in `package.json`).
 *
 * The original five surfaces (`commands`/`tools`/`agents`/`workflows`/`policies`)
 * are lists of [`ContributionId`] references into the manifest's `runnables`: the
 * plugin *declares* that runnable `X` contributes to that surface. This is
 * declare-by-id, not a second copy of the runnable — the loader cross-validates
 * that every referenced id exists in `runnables`, so a typo is caught at load.
 *
 * Most surfaces added since are **self-contained**: they carry their own payload
 * and reference no runnable at all (`widgets`, `views`, `dock_panels`,
 * `sidebar_sections`, `sidebar_buttons`, `settings_tabs`, `composer_controls`,
 * `chat_features`, `slash_commands`, `turn_hooks`, `tool_filters`, `lsp_servers`,
 * `message_actions`, `selection_actions`, `context_menu_items`,
 * `agent_edit_panels`).
 *
 * # Extending
 *
 * Adding a surface is two decisions, and getting either wrong is silent:
 *
 * 1. **Id-reference or self-contained?** An id-reference surface is a
 *    `Vec<ContributionId>` and MUST be chained into [`Contributes::referenced_ids`]
 *    so the loader can catch a typo. A self-contained surface must be left OUT of
 *    it — every id in it names something other than a runnable (a PATH binary, a
 *    route, a tool namespace), so including it would reject every valid manifest.
 *    `referenced_ids` therefore covers exactly the five original surfaces and
 *    nothing else; that omission is deliberate, not an oversight to be tidied up.
 * 2. **Core-interpreted or client-rendered?** If Core acts on the payload
 *    (`tool_filters`, `turn_hooks`, `widgets`, `lsp_servers`) it gets a fully typed
 *    struct, because a key Core does not know is by construction a key Core cannot
 *    act on. If a client shell renders it (`views`, `dock_panels`,
 *    `sidebar_sections`, `settings_tabs`, `composer_controls`,
 *    `agent_edit_panels`) it stays opaque
 *    JSON, because deserializing into a struct here would DROP any key this Core
 *    build does not know about and a newer desktop would lose exactly the fields it
 *    was shipped to render.
 *
 * Client-rendered surfaces are then served, tagged with the owning plugin id, from
 * `GET /api/plugins/contributions`. Core-interpreted ones deliberately are not —
 * they are gathered at their own consumption site instead.
 */
export interface Contributes {
	/**
	 * Client-rendered panels for the agent edit page. Entries are deliberately
	 * opaque and self-contained: the desktop owns the panel vocabulary, while
	 * Core only stores, tags, and forwards the declaration through the plugin
	 * contributions endpoint. This lets a newer desktop add an agent-edit
	 * panel type without requiring every Core node to learn that type first.
	 * These entries name no runnable ids and therefore are intentionally absent
	 * from [`Contributes::referenced_ids`].
	 */
	agent_edit_panels?: unknown[];
	/**
	 * Agents the plugin contributes (referenced by runnable id).
	 */
	agents?: ContributionId[];
	/**
	 * Declarative chat feature descriptors. These are opaque, client-rendered
	 * declarations used to feature-detect chat behaviors whose implementation
	 * remains in the host (for example side chats or temporary chats). The
	 * owning plugin id is stamped by Core when the contribution endpoint serves
	 * them, so a disabled plugin removes both the descriptor and its UI affordance.
	 */
	chat_features?: unknown[];
	/**
	 * Metadata-only chat widget templates. Unlike [`Contributes::widgets`], this
	 * catalog is safe to show before a turn runs: it names a host-owned prompt
	 * affordance and a tool/view binding, never HTML, React, or capabilities.
	 */
	chat_widget_templates?: ChatWidgetTemplateContribution[] | null;
	/**
	 * Command-palette commands the plugin contributes (referenced by runnable id).
	 */
	commands?: ContributionId[];
	/**
	 * Declarative **native** UI widgets the plugin contributes to the desktop
	 * composer. Core stores these verbatim and serves them via
	 * `GET /api/plugins/contributions` (tagged with the owning `plugin` id); the
	 * desktop renders the known control types. Opaque to Core (the renderer owns
	 * interpretation) so a new control type needs no Core change — an entry Core has
	 * never heard of is forwarded byte-for-byte, so a desktop newer than the node it
	 * talks to still gets everything it was shipped to render.
	 *
	 * # The control vocabulary
	 *
	 * Every entry is an object carrying `id`, a `type` discriminant, a `label` and a
	 * `flag`; the remaining keys belong to that type. `flag` is universal because the
	 * per-request `plugin_flags` map is the composer's ONLY channel to the turn — a
	 * control the turn hook cannot observe would do nothing. `type` is deliberately NOT
	 * an enum (same reasoning as [`ViewContribution::view`]): an unknown member must
	 * reach a newer shell intact rather than being rejected at load by an older Core.
	 * The vocabulary the desktop composer understands today:
	 *
	 * - `"toggle"` — a switch row in the composer "+" menu, with an optional
	 *   `description`. Flipping it puts `flag: true` into `plugin_flags`. This is the
	 *   original — and until now the ONLY — rendered type.
	 * - `"select"` — a menu/segmented picker. Carries an `options` array of
	 *   `{ value, label, description?, icon? }` plus an optional `default`. The chosen
	 *   `value` (a string, not a bool) lands in `plugin_flags[flag]`, so a plugin can
	 *   offer modes ("fast" / "thorough") instead of on/off.
	 * - `"chip"` — an inline pill in the composer bar showing a LIVE value rather than
	 *   a menu row. Carries an optional `icon` and a `source` (the same
	 *   `@ryu/app-host/views` `ViewSource` a declarative view uses) the shell polls for
	 *   the displayed text, and exposes/clears its value through `flag`. This is what a
	 *   rich bespoke control (a recording indicator, a selected-clip pill) needs in
	 *   order to stop being hand-written host code.
	 * - `"action"` — a button that DISPATCHES rather than holding state. Carries an
	 *   optional `icon` and a `capability` (+ optional `args`) the shell invokes
	 *   through the plugin's granted capability seam — never inline code, and never a
	 *   capability the owning plugin was not granted — then marks `flag` so the turn
	 *   hook sees that it fired.
	 *
	 * A control may also carry `placement` (`"menu"`, the default, or `"bar"`) and
	 * `order`; the renderer, not Core, decides what to do with an unknown key.
	 *
	 * Renderers MUST ignore an entry whose `type` they do not know (the desktop
	 * filters by `type`), so shipping a new control type degrades to "not shown on
	 * older shells" instead of breaking the composer.
	 */
	composer_controls?: unknown[];
	/**
	 * Context-menu rows the plugin contributes to a shell entity menu (the
	 * conversation-row dropdown, a message right-click, a space row). Lets an app
	 * own a menu row instead of the shell hardcoding it (e.g. "Make a skill from
	 * this chat" is a Learning contribution, not an `AppSidebar` if). See
	 * [`ContextMenuContribution`]; served + tagged with the owning `plugin` id at
	 * `GET /api/plugins/contributions`.
	 *
	 * **Stored raw, validated at the chokepoint** — same rule as
	 * [`Contributes::message_actions`].
	 */
	context_menu_items?: ContextMenuContribution[];
	/**
	 * "New X" rows the app contributes to the shell's create menu (the sidebar
	 * footer "+"). See [`CreateActionContribution`].
	 *
	 * This exists because the create menu's only app seam used to be
	 * `sidebar_sections[].spec.create` — section-scoped, so an app that
	 * contributes no sidebar section could not put a row there at all. The shell
	 * therefore hardcoded rows for apps it happened to know about, and those rows
	 * stayed in the menu when the app was not installed, leading straight to an
	 * error page. A create action is its own contribution precisely so the row
	 * appears and disappears with the app.
	 *
	 * **Stored raw, validated at the chokepoint** — same rule as
	 * [`Contributes::context_menu_items`].
	 */
	create_actions?: CreateActionContribution[];
	/**
	 * **Deletable data categories** the app owns — one "Delete all X" row in
	 * Settings → Danger Zone (see [`DataCategoryContribution`]).
	 *
	 * The danger zone used to be two hardcoded lists that had to be edited
	 * together: a `DataCategory` enum in Core and a `CATEGORIES` array carrying the
	 * user-facing copy in the closed desktop source. Monitors and Meetings are
	 * app-owned data, so both lists named apps — which meant a node where Monitors
	 * was never enabled still offered to delete monitors, and the count was always
	 * 0. Declaring the category here makes the owning app the single source of both
	 * its existence and its wording, and makes the row appear and disappear with
	 * the app instead of with a client-side feature-detect.
	 *
	 * # Core-interpreted, so a typed struct — and NOT on the contributions endpoint
	 *
	 * Core has to resolve the id to something that can actually count and delete
	 * the rows, so per this type's own doc comment this gets a typed struct rather
	 * than opaque JSON, and it is gathered at its consumption site
	 * (`GET /api/data/counts`, which serves each category's descriptor next to its
	 * live count) rather than at `GET /api/plugins/contributions` — the same
	 * disposition as [`Contributes::tool_filters`] and [`Contributes::lsp_servers`].
	 *
	 * # Declaration, not implementation
	 *
	 * A declared category is served only when Core knows how to clear it; an id
	 * Core does not implement is skipped with a warn rather than being offered as a
	 * button that 400s. That split is deliberate and not a stepping stone to a
	 * generic HTTP truncate: clearing monitors has to tear down each monitor's
	 * backing scheduler job, and clearing meetings has to broadcast on the meetings
	 * SSE stream, so a blind `DELETE /monitors` would leave jobs ticking forever.
	 * The manifest owns *whether the row exists and what it says*; Core owns *what
	 * deleting actually entails*.
	 */
	data_categories?: DataCategoryContribution[];
	/**
	 * App-registered **workspace dock panels** — a tab in the desktop's bottom or
	 * right dock (Terminal / Code Review / Browser / Simulator live there today).
	 * This is the seam that lets an app OWN its dock tab instead of the shell
	 * welding the app into a closed `TabKind` union: `@ryu/browser` and
	 * `@ryu/simulator` are apps, and their tabs are contributions, not enum
	 * variants. Self-contained + opaque `spec` (see [`DockPanelContribution`]), so a
	 * new panel capability needs no Core change; served + tagged with the owning
	 * `plugin` id at `GET /api/plugins/contributions`.
	 */
	dock_panels?: DockPanelContribution[];
	/**
	 * **App events this plugin emits** — the *provider* half of the hook system,
	 * and the mirror image of [`Contributes::turn_hooks`] (the *consumer* half).
	 *
	 * Core's own hook phases (`post_assistant_turn`, `pre_tool_use`, `context`, …)
	 * are a closed set built into `plugin_host`, so before this surface existed a
	 * plugin could only react to things happening *in a chat turn*. An app that
	 * owns a real-world lifecycle — a meeting ending, a workflow run failing, an
	 * alert firing — had no way to let anything else react to it. That forced the
	 * classic anti-pattern: every consumer polls the producer's HTTP routes, and
	 * every new integration is bespoke wiring between two apps that must both be
	 * changed.
	 *
	 * Declaring an event here makes it a first-class hook phase. Any other plugin
	 * consumes it by naming it in a `turn_hooks[].on`, and any workflow consumes it
	 * with an `event` trigger — neither the producer nor Core learns anything about
	 * the consumer. Apps therefore both **provide** and **consume** over one
	 * mechanism.
	 *
	 * # Ids are namespaced, and that is what makes collisions impossible
	 *
	 * Every id MUST be `<owning plugin id>#<event name>` — the owning half is
	 * checked against the manifest's own `id` at load, and the name half is
	 * `[a-z0-9][a-z0-9._-]*`. Because a Core phase name never contains `/`, an app
	 * literally cannot declare an event that shadows one, no reserved-word list
	 * required. It is also why the emit path can authorize purely from the
	 * manifest: the caller's authenticated plugin id must be the id in the event
	 * name, so an app can only ever emit its **own** events.
	 *
	 * # Core-interpreted, so a typed struct
	 *
	 * Core reads this table to authorize emits and to serve the event catalog, so
	 * per this type's own doc comment it gets a typed struct rather than opaque
	 * JSON. It names event strings rather than runnable ids, so it is
	 * **self-contained** and stays out of [`Contributes::referenced_ids`].
	 */
	hook_events?: HookEventContribution[];
	/**
	 * **Live activities** the plugin contributes — small, always-live status cards
	 * the desktop shell's "Dynamic Island" dock (empty-shell launchpad + sidebar)
	 * renders for something in progress: an agent run, a download, a pending
	 * approval, a recording. The desktop half of the same status vocabulary the
	 * mobile `AgentActivity` uses, so one mental model spans devices.
	 *
	 * Each entry is a [`LiveActivityContribution`]: a typed envelope (`id`/`title`/
	 * `icon`/`accent`/`order`) around an **opaque** `spec` payload the desktop
	 * renderer interprets. Like a [`Contributes::sidebar_sections`] entry it carries
	 * a `ViewSource` (a Core `/api/` path the shell polls) and a field-map; unlike a
	 * section it maps response ROWS to live-activity cards (status/progress/target)
	 * instead of nav rows. The app returns DATA — never code — so a live activity
	 * cannot be made ugly and needs zero sidecar code.
	 *
	 * Self-contained (it names no runnable), so it stays out of
	 * [`Contributes::referenced_ids`]; the `spec` stays opaque to Core so a new
	 * activity capability is a renderer change, not a Core change. Served + tagged
	 * with the owning `plugin` id at `GET /api/plugins/contributions`.
	 */
	live_activities?: LiveActivityContribution[];
	/**
	 * **Language servers** the plugin declares, keyed by server name — the
	 * agent-neutral mirror of Claude Code's `.lsp.json` / `lspServers`, so a config
	 * written for either host loads in the other:
	 *
	 * ```json
	 * "lsp_servers": {
	 *   "go": { "command": "gopls", "args": ["serve"], "extensionToLanguage": { ".go": "go" } }
	 * }
	 * ```
	 *
	 * Only the container key is Ryu's (`lsp_servers`, snake_case like every sibling
	 * here); every key INSIDE a server entry is Claude's own camelCase spelling
	 * verbatim, because that body is what actually travels between the two hosts.
	 * No `lspServers` alias is accepted on purpose. `lsp_servers` — this exact
	 * spelling — is registered in the SDK's zod mirror (`ContributesSchema` in
	 * `packages/sdk/src/manifest.ts`), and that mirror STRIPS every key it does not
	 * list. An alias would therefore parse here and be silently deleted at
	 * `ryu pack` time, before the manifest is signed, which is a worse failure than
	 * a key that never parsed at all. One spelling, registered in both places.
	 *
	 * The plugin ships CONFIG ONLY, never the server binary — `command` is resolved
	 * from `PATH` at spawn time and a missing binary is a visible skip, not a load
	 * error. Core spawns and supervises these processes itself, so unlike the
	 * client-rendered surfaces above this one is fully typed
	 * ([`LspServerContribution`]) and is NOT served from
	 * `GET /api/plugins/contributions`; it is gathered at the spawn site, the same
	 * disposition as [`Contributes::tool_filters`].
	 *
	 * # Ordering is part of the contract
	 *
	 * Registration is **first-registration-wins per file extension**: if two enabled
	 * servers both claim `.go`, the first one registered owns it, the others never
	 * start for that extension, and the spawn site warns naming the owner. That rule
	 * is only reproducible if iteration order is, so this is a [`BTreeMap`] — it
	 * iterates lexicographically by server key, never in hash order and never in
	 * JSON authoring order. The full resolved invariant across a node is
	 * **(plugin enable order, then server key ascending)**.
	 *
	 * Note this makes the tie-break deterministic, not byte-identical to Claude
	 * Code's, which falls out of JS object insertion order. Two servers fighting
	 * over one extension is a misconfiguration in either host; what matters is that
	 * the same node always resolves it the same way and says who won.
	 */
	lsp_servers?: {
		[k: string]: LspServerContribution;
	};
	/**
	 * Per-message actions the plugin contributes to the desktop message toolbar
	 * (thumbs, rate, transform, …). Lets an app own a control in the per-message
	 * toolbar instead of the shell welding the action into the closed set of
	 * built-in toolbar buttons. Self-contained + opaque `spec` (see
	 * [`MessageActionContribution`]), so a new action kind needs no Core change;
	 * served + tagged with the owning `plugin` id at
	 * `GET /api/plugins/contributions`. A renderer that does not know a `kind`
	 * ignores it, so an older shell degrades to "not shown" rather than breaking.
	 *
	 * **Stored raw, validated at the chokepoint** — same rule as
	 * [`Contributes::settings_tabs`]: the desktop forwards the original bytes, so
	 * a shell newer than this Core build still gets every field it was shipped to
	 * render.
	 */
	message_actions?: MessageActionContribution[];
	/**
	 * **Output styles** the plugin ships — Markdown files that change *how* an agent
	 * answers (role, tone, default response shape) by editing the system prompt for
	 * the turn. See `docs/output-styles.md`.
	 *
	 * A style is NOT its own catalog kind, for exactly the argument
	 * [`Contributes::themes`] makes one field up: as a contribution it inherits
	 * install/uninstall/enable, versioning, signing, the Store detail page, reviews
	 * and the trust scorecard for free, and a plugin that ships a style ALONGSIDE
	 * other contributions (an app with a matching voice) stays expressible. A
	 * `CatalogKind::OutputStyle` would have been a second, weaker copy of all of
	 * that — and `CatalogKind::ALL` is a closed five-member enum that must stay
	 * that way, because every surface that switches on it exhaustively is a place a
	 * sixth member would have to be threaded by hand.
	 *
	 * # Safe with zero grants, unlike the other file-bearing family here
	 *
	 * The body is prose: nothing in the pipeline evaluates it, it only ever lands in
	 * a system prompt as text. So a style sits with themes on the safe side of the
	 * line — the worst a hostile one can do is make the agent tiresome — and
	 * pointedly NOT with [`Contributes::pi_extensions`], which is unsandboxed code
	 * and therefore tier-gated at the materializer.
	 *
	 * # Served on the contributions endpoint
	 *
	 * Unlike [`Contributes::pi_extensions`] and [`Contributes::lsp_servers`], which
	 * Core consumes at their own sites, this one IS served from
	 * `GET /api/plugins/contributions` — the desktop composer's style picker is a
	 * client-rendered surface and needs the declaration, not just its effect.
	 *
	 * Self-contained (it names no runnable), so it stays out of
	 * [`Contributes::referenced_ids`].
	 *
	 * ```json
	 * "output_styles": [
	 *   { "id": "eli5", "file": "output-styles/eli5.md" }
	 * ]
	 * ```
	 */
	output_styles?: OutputStyleContribution[];
	/**
	 * **Pi extensions** the plugin ships — TypeScript files the managed `ryu` (Pi)
	 * agent loads at process start:
	 *
	 * ```json
	 * "pi_extensions": [
	 *   { "id": "shell", "file": "pi-extensions/ryu-shell.ts",
	 *     "description": "background bash for the managed Pi agent" }
	 * ]
	 * ```
	 *
	 * Pi ships none of plan mode, sub-agents, permission prompts or background bash
	 * and says so deliberately in its own docs — "you can build or install those
	 * workflows as extensions or packages". This surface is that seam: the
	 * capabilities Core used to hardcode into the spawn path become plugins the user
	 * can enable and disable, and a third party can ship one at all.
	 *
	 * # This is UNSANDBOXED code, and the tier gate is not optional
	 *
	 * A [`Contributes::turn_hooks`] body runs in the deny-by-default Deno sandbox
	 * behind capability-gated `host.*` calls. A file named here runs **inside the Pi
	 * process** with full host privilege: the first-party ones spawn children and
	 * POST to Core. That is the same arbitrary-code-execution class as
	 * [`PluginManifest::mcp_servers`], so Core gates it identically — Core tier is
	 * auto-allowed, Community tier needs an operator-allowlisted grant, and the gate
	 * sits at the materializer, because writing the file is what makes it run.
	 *
	 * # Core-interpreted, so a typed struct — and NOT on the contributions endpoint
	 *
	 * Core resolves each `file` and projects it into the managed Pi's config dir, so
	 * per this type's own doc comment it gets a typed struct and is gathered at its
	 * consumption site (`pi_config::app_extensions`) rather than served from
	 * `GET /api/plugins/contributions` — the same disposition as
	 * [`Contributes::lsp_servers`].
	 *
	 * The `file` is deliberately NOT hydrated into an inline string the way a
	 * `code_file` is; see [`PluginManifest::pi_extension_refs`] for why.
	 */
	pi_extensions?: PiExtensionContribution[];
	/**
	 * Gateway policies the plugin contributes (referenced by runnable id).
	 */
	policies?: ContributionId[];
	/**
	 * Buttons the plugin contributes to the floating text-selection toolbar.
	 * This is the bridge between enabled apps/plugins and shared chat blocks:
	 * Core validates and tags the declaration, while the desktop owns the
	 * rendered toolbar and dispatches the selected text. A selection action may
	 * either name a granted `capability` or provide a host-owned `args.dispatch`
	 * (for example, a first-party shell action such as Side Chat). Self-contained
	 * + opaque for the same forward-compatibility reason as `message_actions`.
	 */
	selection_actions?: SelectionActionContribution[];
	/**
	 * Declarative settings tabs the plugin contributes (model pickers, text
	 * fields bound to preference keys). Served + rendered the same way.
	 *
	 * The **contract** for each entry is [`SettingsTabContribution`] — that is what
	 * the published JSON Schema advertises (`schemars(with = …)`) and what the
	 * loader holds every manifest to at import (see `validate_settings_tab`), so a
	 * malformed tab is rejected with a diagnostic instead of reaching the desktop
	 * and being silently dropped by the renderer's defensive parser.
	 *
	 * The *stored* type stays `serde_json::Value` on purpose. `GET
	 * /api/plugins/contributions` tags each entry in place with its owning `plugin`
	 * id and forwards it verbatim; deserializing into the struct here would silently
	 * DROP any key this Core build does not know about, so a desktop newer than the
	 * node it talks to would lose exactly the fields it was shipped to render. Parse
	 * once at the validation chokepoint, forward the original bytes.
	 */
	settings_tabs?: SettingsTabContribution[];
	/**
	 * App-registered sidebar **buttons** — a single nav row (e.g. Memory →
	 * `/library/memory`). The button-shaped sibling of [`Contributes::sidebar_sections`]
	 * (no live list, just a label/icon + a client route). See [`SidebarButtonContribution`].
	 */
	sidebar_buttons?: SidebarButtonContribution[];
	/**
	 * App-registered sidebar **modes** — a named preset of the whole left sidebar:
	 * which sections it offers as tabs, and which one it opens on.
	 *
	 * The third axis of the sidebar contract, after "what sections exist"
	 * ([`Contributes::sidebar_sections`]) and "what nav rows exist"
	 * ([`Contributes::sidebar_buttons`]): **how the sidebar as a whole is
	 * arranged**. The shell ships three modes of its own (every section stacked;
	 * every section as a tab; Bot mode, which is the pair Sessions ⇄ Agents), and
	 * before this member an app could add a section to that list but could not
	 * propose an arrangement — so a plugin wanting the Grok/Hermes bot-mode posture
	 * had to ask for a shell change. See [`SidebarModeContribution`].
	 *
	 * Self-contained (it names sections, not runnables), so it stays out of
	 * [`Contributes::referenced_ids`]; served + tagged with the owning `plugin` id
	 * at `GET /api/plugins/contributions`.
	 */
	sidebar_modes?: SidebarModeContribution[];
	/**
	 * App-registered sidebar **sections** — a header plus a live list of rows the
	 * shell fetches from a declared Core `/api/` path. Lets an app own its sidebar
	 * section (Canvas/Whiteboard/Meetings recent-doc lists) instead of the shell
	 * hardcoding it. Self-contained + opaque `spec` (see [`SidebarSectionContribution`]),
	 * so a new section capability needs no Core change; served + tagged with the
	 * owning `plugin` id at `GET /api/plugins/contributions`.
	 */
	sidebar_sections?: SidebarSectionContribution[];
	/**
	 * Slash commands the plugin contributes (e.g. `/goal`). The desktop maps the
	 * command to a `plugin_flags`/message action; the plugin's turn hook reads
	 * the resulting message. Served + rendered the same way.
	 */
	slash_commands?: unknown[];
	/**
	 * App-registered **marketplace tabs** — one section in the Store's nav bar,
	 * carrying the app's own installable catalog (workflow templates, meeting-notes
	 * templates, monitor presets, …). The Store-shaped sibling of
	 * [`Contributes::dock_panels`]: it lets an app own its browse-and-install
	 * surface instead of the shell welding the section into a closed `StoreSection`
	 * union. Self-contained + opaque `spec` (see [`StoreTabContribution`]).
	 *
	 * **Served OUTSIDE the enabled filter**, unlike every sibling family here: each
	 * entry is tagged with `plugin` plus `app_installed` / `app_enabled` and the
	 * renderer decides. Serving the declaration unconditionally keeps the door open
	 * for a surface that wants the tab as an acquisition funnel; the DATA behind it
	 * stays gated by the app's own route gate either way.
	 *
	 * The desktop Store deliberately renders only the tabs whose app is installed
	 * AND enabled. A pill present whether or not you own the app reads exactly like
	 * a section the shell hardcoded, and clicking it produced a "Turn on X" prompt
	 * where a catalog belongs. Apps are acquired from the Apps tab; the app's own
	 * sections appear with it.
	 */
	store_tabs?: StoreTabContribution[];
	/**
	 * **Colour themes** the plugin ships — the seam that makes a theme an ordinary
	 * marketplace item instead of a hardcoded entry in the shell's preset table.
	 *
	 * This is deliberately the VS Code / Zed shape: a theme is not its own catalog
	 * kind, it is a plugin that contributes one. That choice is load-bearing rather
	 * than cosmetic — it means a theme inherits install/uninstall/enable, versioning,
	 * signing, the Store detail page, reviews and the trust scorecard for free, and
	 * it means a plugin that ships a theme ALONGSIDE other contributions (an app with
	 * a matching skin) is expressible. A new `CatalogKind::Theme` would have bought a
	 * second, weaker copy of all of that.
	 *
	 * Each entry is a [`ThemeContribution`]: pure design tokens, no code. Themes are
	 * therefore the one contribution family that is safe with **zero** grants — the
	 * worst a hostile theme can do is look bad, because the shell only ever reads
	 * `tokens` into CSS custom properties and never evaluates them.
	 *
	 * Self-contained (it names no runnable), so it stays out of
	 * [`Contributes::referenced_ids`]. Typed rather than opaque JSON because Core
	 * does interpret it: the mode/token split is what lets a client ask for "the dark
	 * themes" without parsing every payload.
	 */
	themes?: ThemeContribution[];
	/**
	 * Tools this plugin wants **hidden** from the model's offered tool list —
	 * the declarative half of a tool firewall (see [`ToolFilterContribution`]).
	 *
	 * Purely declarative here: this contract defines and validates the shape, and
	 * the filter is applied where tools are offered to the model. Like
	 * [`Contributes::turn_hooks`] this is self-contained (the ids name tools from
	 * *other* plugins/servers by design — hiding your own tool is just not
	 * declaring it), so it is NOT cross-validated against `runnables`.
	 */
	tool_filters?: ToolFilterContribution[];
	/**
	 * Callable tools the plugin contributes (referenced by runnable id).
	 */
	tools?: ContributionId[];
	/**
	 * Hooks the plugin contributes — server-side logic that runs at a hook
	 * boundary and returns a directive. These are **self-contained** (they carry
	 * their own inline `code`), so they are NOT cross-validated against
	 * `runnables` like the id-reference surfaces above; the Core `plugin_host`
	 * runtime executes them in the sandbox.
	 *
	 * The field name is historical. It originally held only *chat* turn
	 * boundaries (`post_assistant_turn`, `pre_user_turn`); a hook's `on` is now
	 * any hook phase, including an **app event** another plugin declared in its
	 * [`Contributes::hook_events`] (`@example/meetings#meeting.ended`). It is
	 * deliberately NOT renamed: `turn_hooks` is load-bearing in every packaged
	 * manifest, the published JSON Schema, the SDK's TS mirror and the loader's
	 * invariant tests, and the rename would buy nothing but churn.
	 */
	turn_hooks?: TurnHookContribution[];
	/**
	 * **Declarative views** the plugin contributes (the Raycast tier). Each entry
	 * is a [`ViewContribution`]: a typed envelope (`id`/`view`) around an **opaque**
	 * `spec` payload the host renderer interprets. The app returns DATA
	 * (`items`/`columns`/`actions`/`fields`) — never code — and the shell renders it
	 * with the host's own `@ryu/ui` components (desktop) or the compact command-bar
	 * idiom (island), so one spec renders natively on every surface and cannot be
	 * made ugly. Like [`composer_controls`]/[`settings_tabs`] this is **self-contained**
	 * (not cross-validated against `runnables`), and the `view` discriminant + `spec`
	 * stay opaque to Core so a new view kind needs no Core change — the renderer owns
	 * the vocabulary (`list-detail`, `data-table`, `form`, `action-panel`,
	 * `filter-bar`, `empty-state`, `stat-card-row`).
	 *
	 * [`composer_controls`]: Contributes::composer_controls
	 * [`settings_tabs`]: Contributes::settings_tabs
	 */
	views?: ViewContribution[];
	/**
	 * App widgets the plugin contributes (Ryu Apps). Each binds a tool id to a
	 * `ui://widget/<slug>.html` template the tool renders inline in chat. The
	 * field is shape-identical to the SDK `manifest.ts` `WidgetContribution`.
	 */
	widgets?: WidgetContribution[];
	/**
	 * Workflows the plugin contributes (referenced by runnable id).
	 */
	workflows?: ContributionId[];
}
/**
 * A single contribution: a reference (by `id`) to a runnable declared in the
 * manifest's `runnables` list, optionally with a human-facing title (e.g. the
 * label a command shows in the palette).
 */
export interface ContributionId {
	/**
	 * The runnable id this contribution points at. Must exist in `runnables`.
	 */
	id: string;
	/**
	 * Optional display title (e.g. the palette label for a command).
	 */
	title?: string | null;
}
/**
 * A metadata-only entry the host may offer as a compact chat affordance.
 *
 * `backing` selects exactly one existing tool or view by id. The host owns the
 * eventual rendering and action dispatch; `safe_action_ids` are identifiers only
 * and are never executable payloads.
 */
export interface ChatWidgetTemplateContribution {
	/**
	 * `available`, `coming-soon`, or `unavailable`; unknown values are forwarded
	 * for forward compatibility and are not offered by older shells.
	 */
	availability?: string;
	backing: ChatWidgetTemplateBacking;
	description?: string | null;
	/**
	 * Open vocabulary so newer shells can add display modes without breaking
	 * older Core nodes; the desktop simply ignores modes it does not know.
	 */
	display_mode: string;
	examples?: string[];
	id: string;
	safe_action_ids?: string[];
	title: string;
	triggers?: string[];
}
export interface ChatWidgetTemplateBacking {
	tool_id?: string | null;
	view_id?: string | null;
}
/**
 * One context-menu row a plugin contributes (see
 * [`Contributes::context_menu_items`]).
 */
export interface ContextMenuContribution {
	/**
	 * WHICH menu. Closed-ish enum by convention, open by encoding (same call as
	 * [`DockPanelPlacement`]): `"conversation"` | `"message"` | `"space"` |
	 * `"agent"` | `"project"` | `"workflow"` | `"skill"` | `"channel"`. The shell
	 * owns the anchor set; an app cannot conjure a new menu, but an unknown value
	 * must not fail the load.
	 *
	 * An anchor names an ENTITY, not a place, so one declaration reaches every
	 * surface that shows it. The desktop renders these in the sidebar row's menu
	 * AND — for whatever entity a tab is showing — in that tab's right-click menu,
	 * on both the horizontal strip and the vertical tab list. `"channel"` is in the
	 * list because a channel is one of those tab-visible entities; it is not a
	 * desktop-only extension.
	 */
	anchor: string;
	args?: unknown;
	/**
	 * The granted capability the shell invokes when the row is clicked, plus
	 * static `args`. Never inline code, never a capability the owning plugin was
	 * not granted.
	 */
	capability: string;
	/**
	 * Optional feedback text for the shell's toast: `{ loading, success, error }`.
	 * Lets the app own its copy without owning the toast component.
	 */
	feedback?: {
		[k: string]: unknown;
	};
	/**
	 * Optional glyph id resolved by the shell's Icon primitive.
	 */
	icon?: string | null;
	/**
	 * Stable id for this row within the plugin.
	 */
	id: string;
	/**
	 * Row label.
	 */
	label: string;
	/**
	 * Sort position among contributed rows (ascending).
	 */
	order?: number | null;
}
/**
 * One "New X" row a plugin contributes to the shell's create menu (see
 * [`Contributes::create_actions`]).
 */
export interface CreateActionContribution {
	args?: unknown;
	/**
	 * Granted capability to invoke instead of navigating, plus static `args` —
	 * for a create that is an action rather than a destination. Dispatched
	 * through the same host seam as a context-menu row.
	 */
	capability?: string | null;
	/**
	 * Optional glyph id resolved by the shell's Icon primitive. The desktop's
	 * create menu draws no icons today (its rows are label-only by design), so
	 * this is read and ignored there — it exists for shells that do.
	 */
	icon?: string | null;
	/**
	 * Stable id for this row within the plugin.
	 */
	id: string;
	/**
	 * Row label, written as the user reads it — "New workflow", not "Workflow".
	 */
	label: string;
	/**
	 * Sort position among contributed rows (ascending).
	 */
	order?: number | null;
	/**
	 * In-app route the shell opens, e.g. `/workflows/new`. Must be a path, not a
	 * URL: this is a navigation inside the shell, and accepting a scheme here
	 * would turn a create row into an arbitrary-link affordance.
	 */
	target?: string | null;
	/**
	 * Title for the tab `target` opens. Falls back to `label`.
	 */
	title?: string | null;
}
/**
 * One **deletable data category** an app owns (see [`Contributes::data_categories`]).
 *
 * Everything the Danger Zone needs to draw and arm one destructive row, so the copy
 * lives with the app whose data it describes rather than in the desktop's source.
 */
export interface DataCategoryContribution {
	/**
	 * The word the user must type to arm the delete. Absent = the [`noun`], which is
	 * the right default often enough that requiring it would just be ceremony.
	 * Matched case-insensitively by the client.
	 *
	 * [`noun`]: DataCategoryContribution::noun
	 */
	confirm_word?: string | null;
	/**
	 * Exactly what disappears, shown in the confirm dialog. Required, and required
	 * to be specific: this is the last thing the user reads before an irreversible
	 * delete, and "this cannot be undone" tells them nothing they did not know.
	 */
	detail: string;
	/**
	 * Stable id — this is the `category` a `POST /api/data/clear` names, so it is
	 * the app's half of the delete contract and renaming it breaks the button.
	 */
	id: string;
	/**
	 * Plural noun for the live count line ("42 monitors" / "No monitors") and the
	 * "N deleted" toast. Lower-case: it is used mid-sentence.
	 */
	noun: string;
	/**
	 * The destructive button label and confirm-dialog title ("Delete all monitors").
	 */
	title: string;
}
/**
 * One app-registered **workspace dock panel** — a tab in the desktop's bottom or
 * right dock (see [`Contributes::dock_panels`]).
 *
 * The dock sibling of [`ViewContribution`] / [`SidebarSectionContribution`]: a typed
 * envelope (`id` / `title` / `icon` / `placement`) around an OPAQUE description of
 * what the tab renders. Core stores it verbatim, tags it with the owning `plugin` id
 * at `GET /api/plugins/contributions`, and never interprets `panel` or `spec` — so a
 * new panel capability is a renderer change, never a Core change.
 *
 * # The `panel` vocabulary
 *
 * `panel` is the render-mode discriminant the desktop's dock renderer switches on.
 * It is a plain `String` (not an enum) for the same reason [`ViewContribution::view`]
 * is: an unknown member must reach a newer shell intact rather than being rejected at
 * load by an older Core. The vocabulary the desktop understands today:
 *
 * - `"companion"` — mount the app's sandboxed companion surface in the dock. The
 *   `spec` names it: `{ "companion": "<runnable id>" }`. This is the third-party
 *   path: an app ships one companion UI and can surface it in the dock, the sidebar,
 *   or a full tab without any host code.
 * - `"view"` — render one of the plugin's own [`Contributes::views`] entries inside
 *   the dock chrome: `{ "view": "<view id>" }`. Data-only, drawn with the host's own
 *   `@ryu/ui` components, so a dock panel gets the Raycast tier for free.
 * - `"native"` — the shell's OWN component, registered under `<plugin>/<id>`. This is
 *   the migration seam for first-party apps whose panel is hand-written React driving
 *   their sidecar through the ext-proxy (`@ryu/browser`, `@ryu/simulator`): the
 *   *component* stays in the shell, but its existence, label, icon and placement stop
 *   being a hardcoded `TabKind` variant and become the app's own declaration, so
 *   disabling the app removes the tab. An unknown `<plugin>/<id>` simply renders
 *   nothing — a native panel is never a code channel.
 *
 * The full `spec` shape is owned by the shared TS vocabulary (`@ryu/app-host/views`
 * `DockPanelSpec`), NOT by this contract.
 */
export interface DockPanelContribution {
	/**
	 * Optional glyph id resolved by the shell's Icon primitive (Iconify/Hugeicons).
	 */
	icon?: string | null;
	/**
	 * Stable id for this panel within the plugin (the dock's tab key, namespaced by
	 * the shell as `plugin:<pluginId>:<id>` so two apps can reuse an id).
	 */
	id: string;
	/**
	 * Optional ordering hint within the dock's tab-type menu (lower = earlier).
	 */
	order?: number | null;
	/**
	 * The render-mode discriminant (`"companion"`, `"view"`, `"native"`, …). Opaque
	 * to Core; an unknown member is passed through so a newer shell can render it.
	 */
	panel: string;
	/**
	 * Which dock the panel opens in. Defaults to [`DockPanelPlacement::Bottom`], the
	 * drawer a terminal-shaped panel belongs in — and falls back to it for an
	 * unrecognised dock too, rather than failing the whole manifest
	 * (see [`deserialize_dock_panel_placement`]).
	 */
	placement?: "bottom" | "right" | "both";
	/**
	 * The payload for the render mode (`{ "companion": … }` / `{ "view": … }` / any
	 * future panel capability). Opaque to Core — the desktop dock renderer interprets
	 * it per `panel`. Absent = the mode needs no payload (the `"native"` case).
	 */
	spec?: {
		[k: string]: unknown;
	};
	/**
	 * Tab label shown on the dock tab strip and in the "new tab" menu.
	 */
	title: string;
}
/**
 * One **app event** a plugin declares it emits (a [`Contributes::hook_events`]
 * row). This is a *declaration*, not code: the event is raised at runtime by the
 * plugin's own sidecar calling the `events.emit` kernel capability, and Core
 * checks the emit against this table.
 *
 * The payload the emitter sends is delivered to every consumer as `ctx.event`, so
 * [`Self::payload_example`] is the contract a consumer author reads. Keep it
 * honest — it is the only description of the payload anyone gets.
 */
export interface HookEventContribution {
	/**
	 * What the event means and, critically, *when* it fires — including whether it
	 * can fire more than once for the same subject.
	 */
	description?: string | null;
	/**
	 * The fully-qualified event id: `<owning plugin id>#<event name>`, e.g.
	 * `@example/meetings#meeting.ended`. Validated at load against the owning
	 * manifest's `id`; see [`Contributes::hook_events`] for why the namespace is
	 * mandatory rather than conventional.
	 *
	 * Name the event after **what happened**, in the past tense, never after who
	 * should react to it: a consumer that renames the producer's event to suit
	 * itself is exactly the coupling this surface removes. The house patterns are
	 * `x.started` / `x.ended` / `x.failed` for a lifecycle, `x.ready` for a
	 * produced artifact, and `x.created` / `x.updated` / `x.deleted` for state.
	 */
	id: string;
	/**
	 * An example of the payload delivered as `ctx.event`. Documentation, not a
	 * schema: Core forwards whatever the emitter sends verbatim and validates
	 * nothing beyond the size cap, so this exists for the human writing a consumer.
	 */
	payload_example?: {
		[k: string]: unknown;
	};
	/**
	 * Human-readable title for the event picker (workflow trigger UI, docs).
	 */
	title: string;
}
/**
 * One app-registered **live activity** — a small, always-live status card the
 * desktop's "Dynamic Island" dock (empty-shell launchpad + sidebar) renders for
 * something in progress: an agent run, a download, a pending approval, a
 * recording. The desktop half of the status vocabulary the mobile `AgentActivity`
 * uses (`running` / `waiting` / `review` / `done` / `error`), so one mental model
 * spans devices.
 *
 * A typed envelope around an opaque `spec` (the `LiveActivitySpec` in
 * `@ryu/app-host/live-activity`: a `ViewSource` for the live rows, a field-map
 * from rows to card fields, and a `target` route template). Core stores it
 * verbatim and tags it with the owning `plugin` id; the `spec` stays opaque so a
 * new activity capability is a renderer change, not a Core change.
 */
export interface LiveActivityContribution {
	/**
	 * Optional accent colour hint (any CSS color) tinting the card.
	 */
	accent?: string | null;
	/**
	 * Optional glyph id resolved by the shell's Icon primitive (Iconify/Hugeicons).
	 */
	icon?: string | null;
	/**
	 * Stable id for this activity within the plugin (namespaced into the shell's
	 * dock identity as `plugin:<pluginId>:<id>:<rowId>`).
	 */
	id: string;
	/**
	 * Optional placement hint among the dock's activities (lower = first).
	 */
	order?: number | null;
	/**
	 * The opaque activity spec (source/map/target). Interpreted by the desktop
	 * renderer, never by Core. Absent = a header-only activity (renders nothing).
	 */
	spec?: {
		[k: string]: unknown;
	};
	/**
	 * Human-facing title shown on the dock card (falls back to the row title).
	 */
	title: string;
}
/**
 * One **language server** a plugin declares (see [`Contributes::lsp_servers`]).
 *
 * Field-for-field Claude Code's language-server config, camelCase on the wire, so
 * the same JSON body loads in either host. Required by Claude's spec: `command`
 * and `extensionToLanguage`. Everything else is optional and defaulted here to
 * Claude's documented default.
 *
 * # Why `command` and `extensionToLanguage` are `#[serde(default)]` anyway
 *
 * They are required by the SPEC, not by serde, and that is deliberate. Claude Code
 * **skips** a server whose config is invalid and starts the rest; making either
 * field a non-defaulted serde field would instead turn a missing one into a parse
 * error on the entire [`PluginManifest`], costing the plugin every runnable,
 * sidecar and tool it ships over one broken language-server entry. Defaulting them
 * is what makes the per-server skip reachable at all: the manifest parses, and
 * [`LspServerContribution::validate`] reports the reason at the spawn site.
 *
 * Unknown keys are dropped rather than rejected (no `deny_unknown_fields`
 * anywhere in this file), so a field from a newer Claude release costs a plugin
 * nothing.
 */
export interface LspServerContribution {
	/**
	 * Arguments passed to [`command`](LspServerContribution::command)
	 * (e.g. `["serve"]` for `gopls`).
	 */
	args?: string[];
	/**
	 * The server executable, resolved from `PATH` at spawn time (`gopls`,
	 * `rust-analyzer`, `typescript-language-server`, …).
	 *
	 * The plugin ships the CONFIG, never the binary. A `command` that is not on
	 * `PATH` is a graceful skip with a visible reason — the user is told which
	 * server did not start and why, and the rest of the node is unaffected.
	 * Defaulted to `""` so a missing one is a skipped server, not a dead manifest
	 * (see the type doc).
	 */
	command?: string;
	/**
	 * Push this server's diagnostics into the model's context after edits. Defaults
	 * to **true** (Claude Code parity); same `default` caveat as
	 * [`restart_on_crash`](LspServerContribution::restart_on_crash).
	 */
	diagnostics?: boolean;
	/**
	 * Extra environment variables for the server process, merged over the inherited
	 * environment.
	 */
	env?: {
		[k: string]: string;
	};
	/**
	 * File extension → LSP language id (`{ ".go": "go" }`) — the map that decides
	 * which files this server handles, and the thing two servers can collide on.
	 *
	 * Claude Code authors keys with a leading dot and in lowercase; a hand-written
	 * manifest will not always. Compare through
	 * [`normalize_lsp_extension_key`] (or read
	 * [`normalized_extensions`](LspServerContribution::normalized_extensions))
	 * rather than indexing this map directly, so `go`, `.go` and `.GO` all resolve
	 * to the same entry. Empty ⇒ the server claims nothing and is skipped.
	 */
	extensionToLanguage?: {
		[k: string]: string;
	};
	/**
	 * Sent verbatim as `initializationOptions` in the LSP `initialize` request.
	 * Opaque JSON on purpose: the shape is the individual language server's, and
	 * Ryu is a courier for it, not an interpreter. Absent = send none.
	 */
	initializationOptions?: {
		[k: string]: unknown;
	};
	/**
	 * Cap on automatic restarts before the server is left down. Absent = the spawn
	 * site's own default; meaningless when
	 * [`restart_on_crash`](LspServerContribution::restart_on_crash) is false.
	 */
	maxRestarts?: number | null;
	/**
	 * Restart the server when it exits unexpectedly. Defaults to **true** (Claude
	 * Code parity).
	 *
	 * Note this needs an explicit default fn: a bare `#[serde(default)]` on a
	 * `bool` yields `false` and would silently invert the documented behaviour.
	 * Like [`McpServerDecl::enabled`] it carries no `skip_serializing_if`, so the
	 * value always ships and a reader never has to know the default.
	 */
	restartOnCrash?: boolean;
	/**
	 * Sent verbatim as the payload of `workspace/didChangeConfiguration` once the
	 * server is initialized. Opaque for the same reason as
	 * [`initialization_options`](LspServerContribution::initialization_options).
	 * Absent = send nothing.
	 */
	settings?: {
		[k: string]: unknown;
	};
	/**
	 * Milliseconds to wait for a clean `shutdown`/`exit` before killing the
	 * process. Absent = the spawn site's own default.
	 *
	 * That default is the one place this type knowingly parts company with Claude
	 * Code, whose reference says an unset `shutdownTimeout` means **no timeout
	 * applies** — it waits on a wedged server indefinitely. Ryu's spawn sites
	 * impose a finite one (5s in `assets/pi-extensions/ryu-lsp.ts`, documented at
	 * the constant), because Pi is spawned per session and an unbounded wait would
	 * hold every teardown open behind one unresponsive server. An explicitly
	 * declared value is honoured verbatim, so a config written for either host
	 * still behaves identically; only the *unset* case differs.
	 */
	shutdownTimeout?: number | null;
	/**
	 * Milliseconds to wait for `initialize` to come back before giving up on the
	 * server. Absent = the spawn site's own default.
	 */
	startupTimeout?: number | null;
	/**
	 * How the host talks to the server: `"stdio"` (the default, and the only
	 * transport Core implements today) or `"socket"`.
	 *
	 * A plain `String` and not an enum, matching this file's other discriminants
	 * ([`ViewContribution::view`], [`DockPanelContribution::panel`]). The reason is
	 * sharper here than for those: [`DockPanelPlacement`] can afford to coerce an
	 * unrecognised value to its default because a panel opening in the wrong dock is
	 * cosmetic, whereas coercing an unrecognised transport to `stdio` would spawn a
	 * process and then speak a protocol it does not understand. The verbatim string
	 * survives instead, and the spawn site refuses what it cannot drive — see
	 * [`LspTransport`] and [`LspServerContribution::transport_kind`].
	 */
	transport?: string;
	/**
	 * Root directory the server is rooted at. Absent (the common case) = the
	 * session's workspace root, which is why this is an `Option` rather than a
	 * defaulted `String`: "unset, inherit the workspace" and "explicitly rooted
	 * somewhere" are different instructions.
	 */
	workspaceFolder?: string | null;
}
/**
 * One per-message toolbar action a plugin contributes (see
 * [`Contributes::message_actions`]).
 *
 * The `kind` discriminant is deliberately NOT an enum (same reasoning as
 * [`ViewContribution::view`]): a member an older shell has never heard of must
 * reach a newer shell intact rather than being rejected at load. Renderers ignore
 * a `kind` they do not know, so a new kind degrades to "not shown" instead of
 * breaking the message toolbar.
 */
export interface MessageActionContribution {
	args?: unknown;
	/**
	 * The granted capability the shell invokes when the action fires, plus static
	 * `args`. Never inline code, never a capability the owning plugin was not
	 * granted — identical to the `action` composer control's dispatch rule.
	 */
	capability: string;
	/**
	 * Optional glyph id resolved by the shell's Icon primitive (Iconify/Hugeicons).
	 */
	icon?: string | null;
	/**
	 * Stable id for this action within the plugin (the shell's element key and
	 * dispatch tag, namespaced as `plugin:<pluginId>:<id>`).
	 */
	id: string;
	/**
	 * Render mode: `"button"` (fire-and-forget) | `"toggle-group"` (mutually
	 * exclusive states, what thumbs is) | `"menu"`. Open string.
	 */
	kind: string;
	/**
	 * Accessible label (tooltip / aria-label) for the action button.
	 */
	label: string;
	/**
	 * Sort position among contributed actions (ascending).
	 */
	order?: number | null;
	/**
	 * Optional `ViewSource` the shell polls to hydrate current state (what lights
	 * the thumb on reload). Same `/api/`-path guard as views.
	 */
	state_source?: {
		[k: string]: unknown;
	};
	/**
	 * For `kind: "toggle-group"`: the states, each `{ value, label, icon?,
	 * active_icon? }`. Opaque to Core; the renderer owns the shape.
	 */
	states?: {
		[k: string]: unknown;
	};
	/**
	 * Which messages the action attaches to: `"assistant"` | `"user"` | `"any"`.
	 * Open string — an unknown role is ignored, not rejected.
	 */
	target: string;
}
/**
 * One **output style** a plugin ships (a [`Contributes::output_styles`] row).
 *
 * Carries the style's *body* in one of two forms and NOTHING else — no `name`, no
 * `description`, no `keep-coding-instructions`. Every one of those lives in the
 * file's own YAML frontmatter, which [`PluginManifest::hydrate_output_style_files`]
 * explains: mirroring them up here would create a second place a style's metadata
 * can be stated, and therefore a place it can disagree with itself.
 */
export interface OutputStyleContribution {
	/**
	 * SOURCE form: path to the Markdown file, relative to the plugin root — exactly
	 * `output-styles/<name>.md`. See [`validate_output_style_path`].
	 *
	 * Exactly one of `file` / `source` is set. Authors write `file`;
	 * [`PluginManifest::hydrate_output_style_files`] turns it into `source` at parse
	 * time and clears this, so a hydrated manifest is byte-indistinguishable from
	 * one that was authored inline.
	 */
	file?: string | null;
	/**
	 * Stable id for this style within the plugin (`[a-z0-9][a-z0-9._-]*`).
	 *
	 * Validated with the same alphabet as a [`PiExtensionContribution::id`], and for
	 * a related reason: the registry merges plugin, user, project and managed styles
	 * into one id-keyed table where later entries win, and the persisted per-turn /
	 * per-conversation / node-default selection is this id. A free-form id would
	 * make a selection unresolvable the moment it contained something a settings key
	 * or a URL path could not carry.
	 */
	id: string;
	/**
	 * WIRE form: the file's contents **verbatim, frontmatter included**.
	 *
	 * Deliberately the whole file rather than a pre-split body, so that a style
	 * contributed by a plugin and a style sitting in a user's `output-styles/`
	 * directory are the same bytes and go through the same single parser. See
	 * [`PluginManifest::hydrate_output_style_files`].
	 */
	source?: string | null;
}
/**
 * One **Pi extension** a plugin ships (a [`Contributes::pi_extensions`] row).
 *
 * Carries a path, never a body: unlike [`TurnHookContribution`] there is no inline
 * `code` twin, because nothing downstream reads the source as a string.
 */
export interface PiExtensionContribution {
	/**
	 * Optional human-facing one-liner (what the extension adds to the agent).
	 */
	description?: string | null;
	/**
	 * Path to the TypeScript source, relative to the plugin root — exactly
	 * `pi-extensions/<name>.ts`. See [`validate_pi_extension_path`].
	 */
	file: string;
	/**
	 * Stable id for this extension within the plugin (`[a-z0-9][a-z0-9._-]*`).
	 *
	 * Part of the materialized file name, so it is what makes one plugin's
	 * extensions distinguishable from another's on disk — and why it is validated
	 * with the same alphabet as an event name rather than left free-form.
	 */
	id: string;
}
/**
 * One button a plugin contributes to the floating text-selection toolbar (see
 * [`Contributes::selection_actions`]).
 *
 * `capability` is optional because a host-owned renderer can use an opaque
 * `args.dispatch` bridge instead. The desktop never executes manifest code: it
 * only renders this label and forwards the selected text to the owning host
 * handler.
 */
export interface SelectionActionContribution {
	/**
	 * Static renderer/dispatch arguments. The selected text is supplied by the
	 * host at click time and is never serialized into the manifest.
	 */
	args?: {
		[k: string]: unknown;
	};
	/**
	 * Optional granted capability for a plugin-owned dispatch.
	 */
	capability?: string | null;
	/**
	 * Optional glyph id resolved by the shell's icon primitive.
	 */
	icon?: string | null;
	/**
	 * Stable id for this action within the plugin.
	 */
	id: string;
	/**
	 * Render mode. The current desktop renders `"button"`; this remains open
	 * so newer shells can add a mode without making older cores reject it.
	 */
	kind: string;
	/**
	 * Accessible label shown in the selection toolbar.
	 */
	label: string;
	/**
	 * Sort position among contributed selection actions (ascending).
	 */
	order?: number | null;
}
/**
 * One **settings tab** a plugin contributes (see [`Contributes::settings_tabs`]).
 *
 * A tab is EITHER declarative (`fields`, rendered by the shared plugin-settings
 * renderer against Core's preference store) OR a named `view` the shell resolves to
 * a bespoke component — for an app whose settings genuinely cannot be expressed as
 * a list of fields. A tab with neither renders as an empty section, which the
 * desktop's defensive parser drops on the floor; the loader rejects it instead so
 * the author gets told.
 */
export interface SettingsTabContribution {
	/**
	 * The declarative fields this tab renders. Empty is only legal alongside a
	 * `view`.
	 */
	fields?: SettingsFieldContribution[];
	/**
	 * Stable id for this tab within the plugin — the settings nav routes to it and
	 * the renderer keys by it. Required: the desktop's fallback (`<plugin>.settings`)
	 * collides the moment a plugin declares a second tab.
	 */
	id: string;
	/**
	 * Which settings dialog this tab lands in. Absent/unrecognised = `node`.
	 */
	scope?: "node" | "user";
	/**
	 * Header label for the section. Absent = `"Settings"`, matching the renderer.
	 */
	title?: string;
	/**
	 * A rich settings view this app ships instead of declarative `fields`. Opaque
	 * here — the settings renderer owns the vocabulary and resolves the name to a
	 * component (first-party) or a sandboxed UI (third-party).
	 */
	view?: string | null;
}
/**
 * One configurable field inside a [`SettingsTabContribution`], bound to exactly
 * one preference key.
 *
 * `pref_key` is both the storage binding (`GET/PUT /api/preferences/:key`) **and**
 * the field's identity — the renderer keys its React elements by it — so two
 * fields sharing one `pref_key` inside a tab is a bug, not a shorthand, and the
 * loader rejects it.
 *
 * The `default`/`required`/`min`/`max`/`min_length`/`max_length` block is
 * validation metadata: declaring it is how a plugin gets its settings checked at
 * *import* instead of discovering at runtime that a user typed `"maybe"` into what
 * the hook reads as a number. It is cross-checked against `type` at load, because
 * validation metadata that is silently ignored (a `min` on a toggle) is worse than
 * none — it reads as a guarantee that was never enforced.
 */
export interface SettingsFieldContribution {
	/**
	 * Default value, in the field's own JSON type (bool for a toggle, number for
	 * a number, string elsewhere) — NOT the stringified form preferences are
	 * stored in, so a manifest stays readable and the type is checkable.
	 */
	default?: {
		[k: string]: unknown;
	};
	/**
	 * Helper caption shown under the field.
	 */
	description?: string | null;
	/**
	 * Display label. Absent = the renderer shows the `pref_key`.
	 */
	label?: string | null;
	/**
	 * Inclusive upper bound for a [`SettingsFieldType::Number`].
	 */
	max?: number | null;
	/**
	 * Maximum length for a text/textarea value.
	 */
	max_length?: number | null;
	/**
	 * Inclusive lower bound for a [`SettingsFieldType::Number`].
	 */
	min?: number | null;
	/**
	 * Minimum length for a text/textarea value.
	 */
	min_length?: number | null;
	/**
	 * Choices for a [`SettingsFieldType::Select`]; required for that type and
	 * inert for every other one.
	 */
	options?: SettingsFieldOption[];
	/**
	 * Placeholder for text / model-picker inputs.
	 */
	placeholder?: string | null;
	/**
	 * The preference key this field reads/writes. Required, non-empty, and
	 * restricted to a path-safe alphabet (it becomes a URL path segment).
	 */
	pref_key: string;
	/**
	 * Whether the user must supply a value (advisory: enforced by the renderer,
	 * declared here so the contract is one place).
	 */
	required?: boolean;
	/**
	 * Granularity for a [`SettingsFieldType::Number`] — the increment its stepper
	 * moves by, and the grid a typed value must land on.
	 *
	 * Distinct from [`Self::min`]/[`Self::max`], which bound the range: a value can
	 * sit inside the range and still be meaningless at this field's resolution
	 * (`0.5` where the setting counts whole pages). The renderer enforces it, so a
	 * field that declares it rejects an off-grid value rather than persisting one
	 * the plugin cannot use.
	 */
	step?: number | null;
	/**
	 * The control to render. Absent or unrecognised = a plain text input.
	 */
	type?: "text" | "textarea" | "number" | "toggle" | "select" | "model_picker" | "agent_picker" | "secret";
}
/**
 * One app-registered **sidebar button** — a single nav row (the button-shaped
 * sibling of [`SidebarSectionContribution`]). No live list: just a label/icon and a
 * client route the shell opens with `openTab`. Migrates hardcoded header-chrome
 * buttons (e.g. Memory) to the owning app.
 */
export interface SidebarButtonContribution {
	/**
	 * Optional mount context passed to the owning Companion when the button opens it.
	 * The host applies this only to the button's own app surface.
	 */
	context?: {
		[k: string]: unknown;
	} | null;
	/**
	 * Optional glyph id resolved by the shell's Icon primitive.
	 */
	icon?: string | null;
	/**
	 * Stable id for this button within the plugin.
	 */
	id: string;
	/**
	 * Optional placement hint among the sidebar buttons.
	 */
	order?: number | null;
	/**
	 * The client route this button opens (e.g. `"/library/memory"`).
	 */
	target: string;
	/**
	 * Button label.
	 */
	title: string;
}
/**
 * One app-registered **sidebar mode** — a named arrangement of the whole left
 * sidebar: the sections it offers as tabs, and the one it opens on.
 *
 * The shape is deliberately thin, and every field it does NOT have is the point:
 *
 * - **No renderer, no code.** A mode names existing sections. It cannot draw a row,
 *   which is why it needs no grants and cannot be a carriage channel — the worst a
 *   hostile mode can do is offer a tab list the user does not want, one menu row
 *   away from being switched off.
 * - **No row style.** How a section's rows draw belongs to that SECTION
 *   (`SidebarSectionSpec.rowStyle` in `@ryu/app-host/views`), because it is a
 *   property of the feed, not of an arrangement: a roster of named bots wants
 *   avatars whether or not the user is in a mode that features it. Putting it here
 *   would also mean a mode reaching across into another contribution's rendering,
 *   which is the coupling this member exists to avoid.
 * - **No `hidden` list.** A mode is a positive statement about what to show. The
 *   sections it does not name are simply not tabs in it.
 *
 * Section ids are the shell's own keys (`agents`, `chats`, `spaces`, …) or another
 * contributed section's namespaced key (`plugin:<pluginId>:<sectionId>`). A named
 * section that does not resolve is dropped rather than failing the mode — an app
 * may legitimately name a section from a sibling app the user has not installed,
 * and losing one tab is a better answer than losing the mode.
 */
export interface SidebarModeContribution {
	/**
	 * Which of `sections` the mode opens on. Absent (or naming a section not in
	 * `sections`) = the first one. This is the field that makes a mode an opinion
	 * rather than a filter: the shell's own Bot mode lists Sessions first but
	 * opens on Agents, because the roster is what the mode is for.
	 */
	default_section?: string | null;
	/**
	 * One-line description shown under the title where the mode is offered.
	 */
	description?: string | null;
	/**
	 * Optional glyph id resolved by the shell's Icon primitive (Iconify/Hugeicons).
	 */
	icon?: string | null;
	/**
	 * Stable id for this mode within the plugin (namespaced by the shell into the
	 * stored mode key as `plugin:<pluginId>:<id>`, so two apps can both ship a
	 * `bots` mode).
	 */
	id: string;
	/**
	 * Optional ordering hint among the modes on offer (lower = earlier).
	 */
	order?: number | null;
	/**
	 * The sections this mode offers as tabs, in display order. Empty = the mode is
	 * inert and the shell ignores it; a mode with one entry is a legitimate
	 * single-surface arrangement, not an error.
	 */
	sections?: string[];
	/**
	 * Label shown in the sidebar's mode menu and the Appearance tab.
	 */
	title: string;
}
/**
 * One app-registered **sidebar section** — a header plus a live list of rows the
 * desktop's compact sidebar renderer draws (the app-owned replacement for the
 * hardcoded Canvas/Whiteboard/Meetings sections). A typed envelope around an opaque
 * `spec` (the `SidebarSectionSpec` in `@ryu/app-host/views`: a `ViewSource` for the
 * rows, an `itemTarget` route template for `openTab`, optional `itemActions` and a
 * `create` action). Core stores it verbatim and tags it with the owning `plugin` id;
 * the `spec` stays opaque so a new section capability is a renderer change, not a
 * Core change.
 */
export interface SidebarSectionContribution {
	/**
	 * Optional glyph id resolved by the shell's Icon primitive (Iconify/Hugeicons).
	 */
	icon?: string | null;
	/**
	 * Stable id for this section within the plugin (namespaced into the shell's
	 * section key as `plugin:<pluginId>:<id>`).
	 */
	id: string;
	/**
	 * Optional placement hint among the sidebar sections (lower = higher up).
	 */
	order?: number | null;
	/**
	 * The opaque section spec (source/itemTarget/itemActions/create). Interpreted by
	 * the desktop renderer, never by Core. Absent = a header with no rows.
	 */
	spec?: {
		[k: string]: unknown;
	};
	/**
	 * Header label shown in the sidebar and the Customize dialog.
	 */
	title: string;
}
/**
 * One app-registered **marketplace tab** — a section in the Store's nav bar whose
 * content is the app's own installable catalog. A typed envelope around an opaque
 * `spec` (the `StoreTabSpec` in `@ryu/app-host/views`: a `ViewSource` for the rows,
 * a `groupBy`/`groups` split into card sections, an `install` action, and per-item
 * actions). Core stores it verbatim and tags it with the owning `plugin` id; the
 * `spec` stays opaque so a new catalog capability is a renderer change, not a Core
 * change.
 *
 * **There is no first-party escape hatch.** This contribution used to carry a
 * `view` naming a hand-written renderer the shell kept in a plugin-id allowlist,
 * for the one tab whose detail pane the vocabulary could not express (the
 * workflow-template graph). That made the flagship example of "an app can own a
 * Store section" the single section no other app could reproduce. The graph is a
 * declarative primitive now (`spec.detail.graph`), the field is gone, and every
 * contributed tab — first-party or not — renders from the same spec.
 */
export interface StoreTabContribution {
	/**
	 * Which nav cluster the pill joins — the shell draws a divider wherever the
	 * group changes. Built-in groups: `discover`, `catalog`, `community`, `manage`,
	 * `account`. An unknown value gets its own cluster rather than being dropped.
	 */
	group?: string | null;
	/**
	 * Optional glyph id resolved by the shell's Icon primitive (Iconify/Hugeicons).
	 */
	icon?: string | null;
	/**
	 * Stable id for this tab within the plugin. The shell namespaces it into the
	 * section key as `plugin:<pluginId>:<id>` so two apps can both ship a
	 * `templates` tab.
	 */
	id: string;
	/**
	 * Placement hint within the group (lower = further left).
	 */
	order?: number | null;
	/**
	 * The opaque tab spec (source/map/groups/search/install/itemActions). Interpreted
	 * by the desktop renderer, never by Core. Absent alongside an absent `view` = an
	 * empty tab.
	 */
	spec?: {
		[k: string]: unknown;
	};
	/**
	 * One-line description shown under the title in the section header.
	 */
	subtitle?: string | null;
	/**
	 * Nav-pill label.
	 */
	title: string;
}
/**
 * One colour theme a plugin contributes (`contributes.themes`).
 *
 * Shape-identical to the shell's own `ThemeVariant` (`@ryu/ui/theme/presets`), so a
 * theme installed from the marketplace and a theme that ships in the binary are the
 * same object by the time the picker renders them — there is no second rendering
 * path to keep in sync, and a plugin can never express a theme the built-ins could
 * not.
 *
 * # Why `tokens` is an untyped map
 *
 * The keys are CSS custom properties (`--background`, `--sidebar-ring`, …). Typing
 * them as a fixed struct would mean every new token added to the design system
 * silently DROPS out of third-party themes until Core is rebuilt and redeployed —
 * exactly the drift `settings_tabs` documents for its own `serde_json::Value`. The
 * values are never evaluated, only assigned to CSS variables, so an unknown key is
 * inert rather than dangerous.
 */
export interface ThemeContribution {
	/**
	 * Stable id used as the persisted preset selection. Namespace it with the
	 * plugin id (e.g. `"@acme/themes:midnight"`) so two plugins cannot collide, and
	 * so a selection survives the theme being renamed.
	 */
	id: string;
	/**
	 * Human name shown in the theme picker.
	 */
	label: string;
	/**
	 * Which mode slot this theme fills: `"light"` or `"dark"`. A plugin shipping a
	 * pair contributes two entries, mirroring how the shell keeps an independent
	 * preset per mode rather than one theme with two halves.
	 */
	mode: string;
	preview: ThemePreview;
	/**
	 * CSS custom property name → value (e.g. `"--background"` → `"oklch(1 0 0)"`).
	 */
	tokens: {
		[k: string]: string;
	};
}
/**
 * The four swatch colours the picker paints before the theme is applied.
 */
export interface ThemePreview {
	bg: string;
	primary: string;
	surface: string;
	text: string;
}
/**
 * One **tool filter**: a fully-qualified tool id a plugin wants withheld from the
 * model's offered tool list.
 *
 * Tools are namespaced `<server>.<tool>` (e.g. `browser.navigate`), so `tool`
 * must carry the namespace — a bare `navigate` would be ambiguous across servers
 * and is rejected at load. A **trailing** `*` is a prefix wildcard, which is how a
 * plugin withholds a whole server (`shadow.*`); it is the only wildcard position
 * allowed, because an interior or leading `*` invites a pattern that silently
 * matches far more than the author pictured.
 *
 * This type is declaration + validation only. The filter is **applied** where the
 * tool list is assembled for the model (the MCP offer site in
 * `apps/core/src/sidecar/mcp`), which calls [`ToolFilterContribution::matches`] so
 * the wildcard rule has exactly one implementation. Hiding a tool from the model
 * is not a security boundary — it does not revoke the capability, it only stops the
 * tool being advertised; enforcement stays with permissions and grants.
 */
export interface ToolFilterContribution {
	/**
	 * Why the plugin hides it — surfaced in the plugin's listing so a user can see
	 * what a plugin is removing from the model's view before installing it.
	 */
	reason?: string | null;
	/**
	 * Fully-qualified tool id (`<server>.<tool>`), optionally ending in `*` to
	 * hide every tool whose id starts with the preceding prefix.
	 */
	tool: string;
}
/**
 * A server-side chat turn hook contributed by a plugin. The `code` is a JS body
 * run in the plugin sandbox with `ctx` (the turn context) and `host` (the
 * capability bridge: `host.sideModel`, `host.storage`, `host.log`) in scope; it
 * returns a directive (`{kind:"none"}` | `{kind:"note",text}` |
 * `{kind:"continue",text}`). See Core's `plugin_host`.
 *
 * The body is authored as a **file** ([`code_file`]) and hydrated into [`code`]
 * at parse time — see [`PluginManifest::hydrate_code_files`] for why the two
 * fields are a source-form/wire-form pair rather than alternatives.
 *
 * [`code`]: Self::code
 * [`code_file`]: Self::code_file
 */
export interface TurnHookContribution {
	/**
	 * The JS hook body executed in the sandbox (returns a directive).
	 *
	 * Empty in a **source** manifest that declares [`Self::code_file`] instead;
	 * [`PluginManifest::hydrate_code_files`] fills it in before any consumer sees
	 * the manifest, and [`PluginManifest::validate`] refuses a manifest where it
	 * is still empty. Every read site therefore keeps reading exactly this field.
	 */
	code?: string;
	/**
	 * Path to the file holding the hook body, relative to the plugin root
	 * (`hooks/<name>.js`) — the authoring form. Mutually exclusive with
	 * [`Self::code`]; see [`PluginManifest::hydrate_code_files`].
	 */
	code_file?: string | null;
	/**
	 * Stable id for this hook (for logging/audit), unique within the plugin.
	 */
	id: string;
	/**
	 * Optional cheap pre-gate. When present, Core's `plugin_host` evaluates it
	 * in Rust **before** spawning the sandbox, so an idle hook (e.g. double-check
	 * with its toggle off, or goal with no active condition) costs a flag/prefix
	 * check or one KV read instead of a Deno process. This is what makes it safe
	 * to ship these hooks **enabled by default** on every surface. Absent (or all
	 * fields empty) → the hook always runs, preserving prior behaviour.
	 */
	match?: HookMatch | null;
	/**
	 * The turn boundary this hook fires on. Today only `"post_assistant_turn"`.
	 */
	on: string;
	/**
	 * Higher-priority hooks run first within a phase. Ties are resolved by
	 * plugin id and hook id, which makes first-writer-wins directives stable.
	 */
	priority?: number;
}
/**
 * A declarative pre-gate for a [`TurnHookContribution`]. The conditions are
 * OR-ed: the hook runs if **any** present condition matches. An empty match
 * (every field default) means "always run". Kept intentionally small — richer
 * matching belongs inside the hook JS, this only exists to skip the sandbox
 * spawn on turns where the hook provably cannot act.
 */
export interface HookMatch {
	/**
	 * Run if the last user message (trimmed) starts with any of these prefixes,
	 * e.g. `["/goal"]`. This is how a slash-command hook wakes up.
	 */
	commands?: string[];
	/**
	 * Run only if the request set this composer flag true (`ctx.flags[flag]`),
	 * e.g. `"io.ryu.double-check"`.
	 */
	flag?: string | null;
	/**
	 * Run if the plugin has stored state for this conversation (its default KV
	 * namespace has a value keyed by `conversation_id`), e.g. an active goal.
	 */
	stateful?: boolean;
	/**
	 * Run if the tool being called (`ctx.tool_name`) matches any of these
	 * patterns — for `pre_tool_use` / `post_tool_use` hooks. A pattern is a tool
	 * id with optional leading/trailing `*` wildcards (`"*"` = every tool,
	 * `"bash*"` = ids starting with `bash`). This keeps a tool-firewall hook from
	 * spawning the sandbox on every unrelated tool call.
	 */
	tools?: string[];
}
/**
 * One **declarative view** contribution (the Raycast tier — see [`Contributes::views`]).
 *
 * A typed envelope around an opaque `spec`: Core stores it verbatim, tags it with
 * the owning `plugin` id at `GET /api/plugins/contributions`, and forwards it to the
 * surface shell, which maps `view` + `spec` to native components. The `spec` shape is
 * owned by the shared TS vocabulary (`@ryu/app-host/views`), NOT by this contract, so
 * adding a view kind is a renderer change, never a Core change.
 */
export interface ViewContribution {
	/**
	 * Stable id for this view within the plugin (route/anchor key, unique per plugin).
	 */
	id: string;
	/**
	 * The DATA payload for the view (items/columns/actions/fields/…). Opaque to Core
	 * — the shared renderer interprets it per the `view` kind. Absent = an empty view.
	 */
	spec?: {
		[k: string]: unknown;
	};
	/**
	 * Optional human-facing title (tab label / palette entry). Absent = the shell
	 * derives one from the view kind or the plugin name.
	 */
	title?: string | null;
	/**
	 * The vocabulary member this view renders as — the discriminant the per-surface
	 * renderer switches on (`"list-detail"`, `"data-table"`, `"form"`,
	 * `"action-panel"`, `"filter-bar"`, `"empty-state"`, `"stat-card-row"`). Opaque
	 * to Core; an unknown kind is passed through so a newer shell can render it.
	 */
	view: string;
}
/**
 * One app-widget contribution (Ryu Apps). Binds the tool that renders the widget
 * to its HTML template. `ui_entry` is the source entry the SDK `ryu pack` builds
 * into the self-contained HTML for third-party apps; built-in apps serve HTML
 * from the in-process provider and leave it unset.
 */
export interface WidgetContribution {
	/**
	 * Default display mode (`inline` | `fullscreen` | `pip`).
	 */
	default_display_mode?: string;
	/**
	 * Widget MIME dialect (default `text/html+skybridge`).
	 */
	mime?: string;
	/**
	 * The fully-qualified tool id whose result renders this widget.
	 */
	tool_id: string;
	/**
	 * Source entry (e.g. `src/apps/checklist/index.tsx`) for `ryu pack`.
	 */
	ui_entry?: string | null;
	/**
	 * `ui://widget/<slug>.html` — the widget resource uri.
	 */
	uri: string;
}
/**
 * `engines` block — the **host** version floors, mirroring VS-Code's
 * `engines.vscode`. Every value is a semver **requirement** string.
 *
 * `ryu` is the Core floor and is the only required key (every manifest written
 * before per-surface floors existed carries just that one). The rest are optional
 * per-[`Surface`] floors: a plugin that needs a Gateway API added in 0.1.5 and a
 * desktop panel API added in 0.2.0 says so, instead of over-declaring one Core
 * floor and hoping the release train kept them in step.
 *
 * ## Why this is a flat struct and not a `BTreeMap<Surface, String>`
 *
 * The [`PluginManifest::surfaces`] map would be the obvious home, but it is
 * **absent from the SDK's zod mirror** (`packages/sdk/src/manifest.ts`), and zod
 * strips unlisted keys — so a floor declared there would be silently dropped from
 * every bundle `ryu pack` produces. `engines` is the block that already means
 * "host floor", it is what a manifest author reaches for, and mirroring it costs
 * one schema addition rather than a nested map.
 *
 * ## Unknown ≠ unsatisfied
 *
 * Core observes its own version and (via `/health`) the Gateway's. It does NOT
 * know the desktop, island, mobile, extension or web version — those are separate
 * installs that never report in. A floor against a surface whose version is
 * unknown is therefore **advisory, never blocking**: see
 * `HostVersions::evaluate`. Blocking on unknown would delist every plugin from
 * every surface Core cannot see, which is most of them.
 */
export interface EnginesReq {
	/**
	 * Floor for the **terminal** (`cli`) surface — the TUI that dispatches
	 * `ryu <app> <cmd>`.
	 */
	cli?: string | null;
	/**
	 * Floor for the **desktop** app (Tauri shell).
	 */
	desktop?: string | null;
	/**
	 * Floor for the **browser extension** surface.
	 */
	extension?: string | null;
	/**
	 * Floor for the **Gateway**. The one non-Core surface Core can actually
	 * observe (it spawns the Gateway and reads `version` from its `/health`), so a
	 * floor here is genuinely enforceable rather than advisory.
	 */
	gateway?: string | null;
	/**
	 * Floor for the **island** (the always-on overlay surface).
	 */
	island?: string | null;
	/**
	 * Floor for the **mobile** app. The one surface with a genuinely independent
	 * release train (App Store / Play review lag), so it is the floor most likely
	 * to be unsatisfied in practice.
	 */
	mobile?: string | null;
	/**
	 * Semver requirement the running **Core** version must satisfy (e.g.
	 * `">=0.3.0"`, `"^1.2"`). Parsed as a [`semver::VersionReq`]; an unparseable
	 * value causes the loader to reject the manifest, and an unsatisfied one moves
	 * it to the incompatible lane (shown in the marketplace, refused at install).
	 *
	 * Named `ryu` rather than `core` for backwards compatibility: every manifest
	 * in the wild spells it this way. [`EnginesReq::floor_for`] maps
	 * [`Surface::Core`] onto it.
	 */
	ryu: string;
	/**
	 * Floor for the **web** surface.
	 */
	web?: string | null;
}
/**
 * One declarative **MCP server** a plugin registers (see
 * [`PluginManifest::mcp_servers`]) — either a stdio command to spawn or a remote
 * HTTP endpoint to call.
 *
 * This is the manifest-side, dependency-free mirror of Core's runtime
 * `McpServerConfig`: pure data (schemars/serde only) so it can live in
 * kernel-contracts, with Core lowering it into its registry type on enable. A
 * stdio server is spawned per request as `command args…`; `command_env` lets
 * the manifest name an env var Core resolves to an absolute binary path
 * (e.g. `RYU_GHOST_BIN`) so a downloaded `~/.ryu/bin` binary can override the
 * bare `command`. An HTTP server names a [`url`](McpServerDecl::url) instead and
 * spawns nothing at all.
 *
 * The field names mirror the `mcp.json` dialect users already paste from Cursor
 * and Claude Desktop (`type` / `url` / `headers`) precisely so a manifest and a
 * hand-written config entry are the same shape. Static API-key auth may live in
 * [`headers`](McpServerDecl::headers). User-delegated OAuth is declared through
 * [`auth`](McpServerDecl::auth), and Core owns the resulting token lifecycle.
 */
export interface McpServerDecl {
	/**
	 * Arguments passed to the command.
	 */
	args?: string[];
	/**
	 * Core-owned OAuth for this remote MCP server. The manifest may name only an
	 * optional public client id; discovery, PKCE, tokens and redirect URIs are
	 * intentionally outside the publisher-controlled manifest.
	 */
	auth?: McpServerAuthDecl | null;
	/**
	 * Executable to spawn (e.g. `npx`, an absolute path, or a `~/.ryu/bin` name).
	 * Absent for a remote (`url`) server.
	 */
	command?: string | null;
	/**
	 * Optional env var whose value, when set, OVERRIDES [`command`] with an
	 * absolute binary path. Lets a plugin ship a bare `command` that Core repoints
	 * at a profile-specific downloaded binary. Absent ⇒ use `command` verbatim.
	 *
	 * [`command`]: McpServerDecl::command
	 */
	command_env?: string | null;
	/**
	 * Optional human description for the MCP listing endpoint.
	 */
	description?: string | null;
	/**
	 * When false, the server is registered but skipped by list/call. Defaults to
	 * true so a bare `{ command }` entry just works.
	 */
	enabled?: boolean;
	/**
	 * Extra environment variables for the server process.
	 */
	env?: {
		[k: string]: string;
	};
	/**
	 * Request headers sent with every call to a remote server (auth lives here).
	 */
	headers?: {
		[k: string]: string;
	};
	/**
	 * Transport: `stdio`, `http`, `streamable-http`, or `sse`. Absent ⇒ inferred
	 * from whichever of `command`/`url` is present. `http` and `streamable-http`
	 * select Streamable HTTP; `sse` selects the legacy HTTP+SSE transport.
	 */
	type?: string | null;
	/**
	 * Endpoint URL for a remote (HTTP) server. Absent for a stdio server.
	 */
	url?: string | null;
}
/**
 * One entry in an app's **user-facing permission vocabulary** — a level an admin
 * can grant to a person or a team inside that app (see
 * [`PluginManifest::permission_levels`], which also explains why this is a
 * different axis from `permission_grants` and `permissions`).
 *
 * Deliberately self-describing: an admin UI renders the grant picker from `label`
 * + `description` alone, so a level whose meaning lives only in the app's own docs
 * cannot exist.
 */
export interface PermissionLevel {
	/**
	 * One sentence telling an admin what granting this level actually allows.
	 * Required for the same reason as [`label`]: the admin deciding is usually
	 * not the person who wrote the app.
	 *
	 * [`label`]: PermissionLevel::label
	 */
	description: string;
	/**
	 * Stable machine id (e.g. `"read"`). Lower-case ASCII alphanumerics plus
	 * `-`, `_` and `.`, at most [`MAX_PLUGIN_ID_LEN`] bytes, and unique within the
	 * manifest.
	 *
	 * The alphabet is narrower than a plugin id's on purpose: these ids end up in
	 * API paths and in persisted grant strings, so `Read` and `read` must not be
	 * two levels that look identical to a human granting them.
	 */
	id: string;
	/**
	 * Ids of other levels in **this same manifest** that this level subsumes.
	 *
	 * This is the whole ordering mechanism — there is no separate rank, so the
	 * order can never contradict itself. `edit` implying `read` means a person
	 * granted `edit` already holds `read`; granting both is redundant, never
	 * required. Resolved transitively by
	 * [`resolve_implied_permission_levels`].
	 */
	implies?: string[];
	/**
	 * Short human label for the grant picker (e.g. `"Can edit"`). Required —
	 * an unlabelled level is unrenderable.
	 */
	label: string;
}
/**
 * The single, typed, **deny-by-default** permission set a plugin manifest
 * declares, lowered by Core to every sandbox backend.
 *
 * This is the one grammar that replaces three historically-disjoint ones:
 * the wasmtime/Docker [`crate`]-external `SandboxCapabilities` (typed but
 * unreachable from a manifest), the Deno PTC's hardcoded zero-allow-flag spawn,
 * and the opaque grant strings. A manifest declares ONE `permissions` block and
 * Core lowers it to WASI preopens, Docker mount/network flags, or Deno
 * `--allow-*` flags as appropriate.
 *
 * **Every field defaults to empty/false — the zero value is deny-all.** A missing
 * `permissions` block (or an explicit `{}`) is byte-for-byte the same posture as
 * today's zero-permission sandbox, which is what preserves the existing live
 * deny-all tests.
 */
export interface PermissionSet {
	/**
	 * Whether the sandboxed code may spawn child processes. `false` (default) =
	 * no subprocess execution. Lowers to Deno's `--allow-run`; the wasmtime/Docker
	 * lowering has no subprocess channel to open, so this is a no-op there (a WASI
	 * module cannot fork, and the Docker exec is a single fixed argv).
	 */
	child_process?: boolean;
	fs?: FsPermissions;
	/**
	 * Outbound network permission. `false`/absent (default) = no network; `true` =
	 * all hosts; a list of `host[:port]` entries = only those hosts (the shape
	 * Deno's `--allow-net` supports). See [`NetworkPermission`].
	 */
	network?: boolean | string[];
	/**
	 * Executable names sandboxed code may spawn when [`Self::child_process`] is
	 * true. Core lowers this to Deno's scoped `--allow-run=<name,...>` list in
	 * addition to declared capability shims. Empty grants no arbitrary binary.
	 */
	run?: string[];
	/**
	 * **Declaration-only** in v1: the registry tool ids this plugin's sandboxed
	 * code may call through the stdio `tools.*` bridge. Tools are brokered over
	 * stdout/stdin by Core (never an OS capability), so this does NOT lower to any
	 * `--allow-*` flag; it records intent and is a clean future extension for the
	 * `SandboxToolInvoker` allowlist. Empty (default) records no extra tool intent.
	 */
	tool?: string[];
}
/**
 * Filesystem read/write path allowlists. Empty = no FS access.
 */
export interface FsPermissions {
	/**
	 * Absolute paths the sandbox may **read**. Empty = no read access.
	 */
	read?: string[];
	/**
	 * Absolute paths the sandbox may **write**. Empty = no write access.
	 */
	write?: string[];
}
/**
 * One **provided capability** entry (in [`PluginManifest::provides`]).
 *
 * Binds an abstract capability name to a concrete serving surface on THIS
 * manifest: the local `sidecar` name whose declared HTTP `route` implements the
 * capability, plus the `grant` a consumer must hold to invoke it. The broker
 * routes a consumer's `/api/host/capability/<cap>` call to this sidecar's route
 * using the *provider's* minted token — the consumer never sees it.
 */
export interface ProvidesEntry {
	/**
	 * The capability name this plugin serves (e.g. `"rag"`). Consumers match on
	 * this against their [`Requires::capabilities`].
	 */
	capability: string;
	/**
	 * Preferred pick among the providers of a [`Self::selectable`] capability when
	 * the user has set no override. At most one provider per capability may declare
	 * it. Meaningless (and ignored) on a non-selectable capability.
	 */
	default?: boolean;
	/**
	 * The grant a consumer must hold (Gateway-approved) to invoke this capability
	 * via the broker. Absent = no extra grant beyond declaring the edge.
	 */
	grant?: string | null;
	/**
	 * The proxied sub-path (on the named sidecar's [`crate::schema::HttpProxySpec`])
	 * the broker forwards capability calls to (e.g. `"/rag/query"`). The loader
	 * cross-validates that the named sidecar declares a matching route.
	 */
	route?: string | null;
	/**
	 * Opt in to the **selectable** flavour: many providers of this capability may
	 * be enabled at once and the user *picks* one, exactly like a local engine.
	 *
	 * A non-selectable capability (the original, strict flavour used by `rag` /
	 * `engines`) treats a second enabled provider as an explicit
	 * `BindingError::Ambiguous` refusal. A selectable one resolves deterministically
	 * instead: user override > sole provider > the provider declaring
	 * [`Self::default_provider`] > lexicographically-lowest provider id. The pick is
	 * a pure function of the candidate set, so the disable-safety reconstruction
	 * argument in Core's binding registry is unchanged.
	 *
	 * Selectability is a property of the *capability*, so every provider of a given
	 * capability must agree on the flag; the loader rejects a mixed declaration.
	 */
	selectable?: boolean;
	/**
	 * The local `name` of one of this manifest's declared `sidecars` that serves
	 * the capability. The loader cross-validates it exists. Absent = an in-process
	 * capability with no dedicated sidecar (the broker declines to proxy it).
	 */
	sidecar?: string | null;
	/**
	 * WHAT this provider acts on, when the capability controls a machine or an
	 * environment rather than answering a query.
	 *
	 * Exists because "swap the provider" quietly means two different things.
	 * Swapping `web.search` from exa to tavily changes who answers; the question is
	 * the same. Swapping `computer.control` from ghost to bytebot changes **which
	 * computer gets typed on** — ghost drives the machine Ryu runs on, bytebot
	 * drives the desktop `bytebotd` runs on (a containerized Linux desktop in the
	 * shipped product). A picker that renders those two swaps identically is
	 * telling the user something false, and until this field existed the
	 * distinction lived only in a prose `description` that nothing structured
	 * could read.
	 *
	 * Absent = not applicable or unspecified. That is the honest default for the
	 * capabilities where locality is meaningless (`web.search`, `memory`, `rag`),
	 * and it is deliberately NOT [`ProviderTarget::LocalMachine`]: defaulting to
	 * "this machine" would silently mislabel every future hosted provider that
	 * forgets to declare it.
	 */
	target?: ProviderTarget | null;
	/**
	 * The human name of the **capability** (not of this provider): `"Search"` for
	 * `web.search`, `"Document Parsing"` for `document.parse`. What a layer picker
	 * puts above the provider list.
	 *
	 * Declared here, on the provider, because the capability itself is not a
	 * manifest — it exists only as the string its providers agree on — and there is
	 * nowhere else to hang the name. So every provider of a capability should carry
	 * the same `title`, and the layer keeps its name when the default provider is
	 * uninstalled.
	 *
	 * Deliberately NOT unanimity-checked the way [`Self::selectable`] is: forcing
	 * six independent `web.search` manifests to spell one cosmetic string
	 * byte-identically or fail to load trades a real capability for a label. Core
	 * picks one with the same ladder the binder uses (declared default, else
	 * lowest plugin id) and disagreement costs at most a differently-worded header.
	 *
	 * Absent = the client falls back to its own naming (a built-in table, else the
	 * capability's last dotted segment). No server-side humaniser derives it from
	 * the id — that route reads `news.crud` as "News Crud".
	 */
	title?: string | null;
	/**
	 * Capability **verb → this provider's tool** bindings, the seam that keeps the
	 * model-visible tool surface stable across a swap.
	 *
	 * The key is a canonical verb from the host's capability verb table (e.g.
	 * `"web.search"`); the value names the provider's own registered tool plus the
	 * argument/response mapping into the canonical shape. A provider that omits a
	 * verb simply does not serve it — the facade reports the verb unavailable
	 * rather than guessing.
	 */
	tools?: {
		[k: string]: CapabilityToolBinding;
	};
	/**
	 * The capability's own semver version (independent of the plugin version), so
	 * a consumer's [`CapabilityReq::min_version`] floor can be checked against the
	 * capability contract rather than the app release.
	 */
	version: string;
}
/**
 * How one capability **verb** maps onto a concrete provider tool.
 *
 * The facade tool (`web.search`, `browser.navigate`, …) is registered by the host
 * from its canonical verb table; at call time it resolves the capability's bound
 * provider, reads this binding, renames the arguments, re-enters tool dispatch on
 * [`Self::tool`], and maps the response back. Swapping the provider therefore
 * changes neither the tool id nor its schema.
 */
export interface CapabilityToolBinding {
	/**
	 * Optional provider-shipped ADAPTER: JavaScript that maps this verb onto the
	 * provider's tool when the shapes are too far apart for the declarative fields
	 * above to bridge.
	 *
	 * The declarative path ([`Self::args`] … [`Self::response`]) stays the default
	 * and covers the ~80% of providers that are a rename plus a field map: no code
	 * review, no sandbox, no supply-chain surface, and a third party ships one file.
	 * But some provider shapes no amount of JSON can express — an async job API that
	 * must be polled (`POST /crawl` → job id → `GET /crawl/{id}`), a token vocabulary
	 * that needs per-provider normalization, a body that must read a `pref:` value.
	 * Growing the grammar one vendor quirk at a time pushed provider-specific logic
	 * into shared kernel code; an adapter puts it back in the provider's own manifest.
	 *
	 * Present = the adapter REPLACES the declarative mapping for this verb: it
	 * receives the canonical arguments and returns the canonical result, and
	 * [`Self::args`] / [`Self::arg_template`] / [`Self::arg_clamp`] / [`Self::response`]
	 * are not applied (the adapter is doing that job). [`Self::tool`] still names the
	 * target and is still the ONLY tool the adapter can reach.
	 */
	adapter?: CapabilityAdapter | null;
	/**
	 * Per-argument numeric limits this provider can actually honour, keyed by the
	 * **canonical** argument name (before any rename).
	 *
	 * Exists because canonical schemas describe what agents may ask for, while
	 * providers differ in what they accept: `web.search.limit` allows up to 100,
	 * but Brave's `count` maxes at 20. Without this, selecting Brave turns a
	 * perfectly valid `limit: 50` into an upstream 4xx — the swap stops being
	 * transparent, which is the entire point of the facade. Clamping is the right
	 * resolution rather than erroring: the caller asked for "up to N", and fewer
	 * results is a normal outcome, whereas a failed search is not.
	 */
	arg_clamp?: {
		[k: string]: ArgBounds;
	};
	/**
	 * Constant arguments merged into every call (provider-specific knobs the
	 * canonical schema does not expose, e.g. `{"search_depth": "advanced"}`).
	 */
	arg_defaults?: {
		[k: string]: unknown;
	};
	/**
	 * A request-body TEMPLATE this provider needs, with `{canonical_arg}`
	 * placeholders substituted from the call.
	 *
	 * `args` renames flat keys and `[]` wraps a scalar in an array; neither can build
	 * a NESTED shape. Real APIs need them: Mem0's write endpoint takes
	 * `messages: [{role, content}]`, so without a template the whole write half of
	 * that provider is unbindable — which is precisely the gap that made Ryu's
	 * memory bridges inert while Hermes, which writes per-provider adapter CODE, had
	 * none. This closes it declaratively instead of admitting code per provider.
	 *
	 * A string that is EXACTLY `"{arg}"` is replaced by that argument's value with
	 * its JSON type preserved (`5` stays a number); a string merely CONTAINING
	 * `{arg}` interpolates as text. An argument consumed by the template is not also
	 * passed through, so it cannot appear twice under two names.
	 */
	arg_template?: {
		[k: string]: unknown;
	};
	/**
	 * Canonical argument name → this provider's argument name. A canonical argument
	 * with no entry is passed through under its own name; map it to the empty string
	 * to drop it (the provider cannot express it).
	 */
	args?: {
		[k: string]: string;
	};
	/**
	 * Optional response normalization into the canonical result shape. Absent = the
	 * provider's output is returned verbatim under `{ provider, raw }`.
	 */
	response?: CapabilityResponseMap | null;
	/**
	 * The provider's own fully-qualified tool id (e.g. `"exa.search"`,
	 * `"app.firecrawl_scrape"`) that implements this verb.
	 */
	tool: string;
}
/**
 * Provider-shipped JavaScript that maps one capability verb onto one provider tool.
 *
 * Runs in the SAME Deno sandbox as an `inline_deno` plugin tool, under the same
 * [`crate`-level] grant model: the providing plugin must hold `tool:execute`, so
 * shipping code is a visible, approvable act rather than a silent one.
 *
 * The program is handed:
 * - `input` — the canonical verb arguments, after layer defaults are applied.
 * - `defaults` — the provider's resolved `arg_defaults`, including any `pref:`
 *   tokens already looked up. This is what lets an adapter read per-install
 *   configuration a template could not (`arg_template` expands from the CALLER's
 *   arguments, so it can never see a resolved preference).
 * - `callTool(args)` — invokes the provider's own [`CapabilityToolBinding::tool`]
 *   and resolves to its raw response. It takes NO tool id: the target is fixed by
 *   the manifest, so sandboxed code cannot redirect the call at another tool. An
 *   adapter therefore grants no authority the declarative path did not already
 *   grant — it is strictly the same single re-entry, expressed as code.
 *
 * It returns the canonical result shape, which the facade passes through unchanged.
 *
 * **Bounded by the sandbox wall-clock.** A run gets `DEFAULT_DEADLINE_SECS` of
 * active compute, and time spent awaiting a tool call counts against it. An
 * adapter that polls an async job must therefore treat "still running" as a normal
 * outcome to report, not something to wait out.
 */
export interface CapabilityAdapter {
	/**
	 * The adapter body. Evaluated as the tail of a sandbox program that has already
	 * bound `input`, `defaults`, `callTool` and `callNamed`; it `return`s the
	 * canonical result.
	 *
	 * Empty in a **source** manifest that declares [`Self::code_file`] instead;
	 * [`PluginManifest::hydrate_code_files`] fills it in at parse time and
	 * [`PluginManifest::validate`] refuses a manifest where it is still empty.
	 */
	code?: string;
	/**
	 * Path to the file holding the adapter body, relative to the plugin root
	 * (`adapters/<verb>.js`) — the authoring form. Mutually exclusive with
	 * [`Self::code`]; see [`PluginManifest::hydrate_code_files`].
	 */
	code_file?: string | null;
	/**
	 * ADDITIONAL provider tool ids this adapter may call, beyond
	 * [`CapabilityToolBinding::tool`], reachable from the body as
	 * `callNamed(id, args)`.
	 *
	 * Exists because a whole class of real APIs is two calls, not one: an async job
	 * API starts work at one endpoint and reads the result from another
	 * (`POST /crawl` → job id → `GET /crawl/{id}`). A single-tool adapter cannot
	 * express that, so those providers would stay unbindable — the gap that
	 * excluded every async API from every layer.
	 *
	 * This is an ALLOWLIST fixed by the manifest and checked host-side: a name not
	 * listed here (and not [`CapabilityToolBinding::tool`]) is refused. Sandboxed
	 * code chooses only *among* tools the provider declared, never a tool of its
	 * own — which is what keeps the id-taking form from becoming an escalation seam.
	 */
	tools?: string[];
}
/**
 * Inclusive numeric bounds a provider can honour for one canonical argument.
 * Integers, not floats. Every clampable canonical argument is a COUNT — result
 * limits, crawl depth, page caps — so `i64` is the honest type, and it keeps the
 * whole manifest tree `Eq` (a float would force `PartialEq`-only all the way up
 * through `ProvidesEntry` and `PluginManifest`) while avoiding float comparison.
 */
export interface ArgBounds {
	/**
	 * Largest value the provider accepts. Absent = no upper bound.
	 */
	max?: number | null;
	/**
	 * Smallest value the provider accepts. Absent = no lower bound.
	 */
	min?: number | null;
}
/**
 * Normalizes one provider's response into the capability's canonical shape.
 *
 * Deliberately a flat rename table rather than a general transform language: the
 * canonical shapes are small and list-of-records shaped, and a manifest that can
 * run arbitrary extraction logic is a much larger trust surface.
 */
export interface CapabilityResponseMap {
	/**
	 * Canonical per-item field name → the provider's field name (dotted paths
	 * allowed). Fields with no entry are dropped from the canonical item but remain
	 * available under the item's `raw` key.
	 */
	fields?: {
		[k: string]: string;
	};
	/**
	 * Dotted path to the provider's result array within its response (e.g.
	 * `"results"`, `"data.items"`). Absent = the response itself is the array, or —
	 * when it is not an array — a single record.
	 */
	results?: string | null;
}
/**
 * `requires` block — the plugin's **plugin-to-plugin** dependencies.
 *
 * This is the npm-shaped edge that lets the app decompose into a minimal kernel
 * plus features: a plugin declares the other plugins it needs, and the lifecycle
 * (Core's `plugins::graph`) resolves them into a topological enable order.
 *
 * Distinct from [`EnginesReq`], which constrains plugin→**Core** (the engine
 * version). `requires` constrains plugin→**plugin**.
 *
 * Absent (the default, and the case for every manifest that predates this field)
 * means *no dependencies* — the plugin enables standalone exactly as before.
 */
export interface Requires {
	/**
	 * Other plugins that must be installed (and are auto-enabled, in dependency
	 * order) before this one can enable.
	 */
	apps?: AppDependency[];
	/**
	 * **Capabilities** this plugin requires — the layered, provider-agnostic edge
	 * (`requires: [rag]`) that the capability broker resolves to a concrete
	 * provider app at bind time. Distinct from [`apps`]: an `apps` edge names a
	 * specific plugin id; a `capabilities` edge names an abstract capability and
	 * lets the binding registry pick (or the user override) which enabled provider
	 * serves it. Each is lowered to an app-id graph edge once bound, so the
	 * topological enable/disable/cycle machinery is shared. Empty for the common
	 * case.
	 *
	 * [`apps`]: Requires::apps
	 */
	capabilities?: CapabilityReq[];
	/**
	 * Permission grants implied by the dependencies. Declaration only — the
	 * Gateway remains the sole authority on what a grant *allows* (Core decides
	 * what runs; the Gateway decides what is permitted).
	 */
	grants?: string[];
}
/**
 * A single plugin-to-plugin dependency edge.
 */
export interface AppDependency {
	/**
	 * The `id` of the plugin this one depends on.
	 */
	id: string;
	/**
	 * Optional **minimum** version the dependency must satisfy.
	 *
	 * A bare version (`"1.2.0"`) is a *minimum*, i.e. `">=1.2.0"` — deliberately
	 * NOT semver's default caret (`^1.2.0`), which would reject `2.0.0`. Explicit
	 * comparator syntax (`">=1.2, <2"`, `"^1.2"`, `"~1.2"`) is honoured verbatim.
	 * See [`parse_min_version`], the single parser both validation and resolution
	 * use.
	 */
	min_version?: string | null;
}
/**
 * One **required capability** edge (in [`Requires::capabilities`]).
 *
 * Names an abstract capability plus an optional minimum *capability* version. The
 * version floor is checked at bind time against the bound provider's
 * [`ProvidesEntry::version`] — NOT against the provider plugin's own semver — so a
 * lowered graph edge carries no `min_version` (the app-version gate would compare
 * the wrong number). See the capability broker in Core.
 */
export interface CapabilityReq {
	/**
	 * The capability name (e.g. `"rag"`, `"tts"`). Matched against a provider's
	 * [`ProvidesEntry::capability`].
	 */
	capability: string;
	/**
	 * Optional minimum **capability** version the bound provider must satisfy
	 * (bare `"1.2.0"` = `">=1.2.0"`, via [`parse_min_version`]). Absent = any
	 * version of the capability is acceptable.
	 */
	min_version?: string | null;
}
/**
 * A single Runnable entry inside a `manifest.json` manifest.
 *
 * Each entry carries the identity fields from [`crate::runnable::RunnableMeta`]
 * plus an optional typed config blob. The `kind` field drives which config shape
 * is expected; validation via [`validate_runnable`] checks that
 * required-per-kind fields are present.
 */
export interface RunnableEntry {
	/**
	 * Per-kind configuration. Some kinds (e.g. `agent`) treat this as
	 * optional (sensible defaults apply); others (e.g. `tool`, `workflow`)
	 * require it. [`validate_runnable`] enforces the rules.
	 */
	config?: {
		[k: string]: unknown;
	};
	/**
	 * Stable unique identifier within this app (e.g. `"tool-web-search"`).
	 */
	id: string;
	/**
	 * Discriminant that determines which per-kind config struct is required.
	 */
	kind: "agent" | "workflow" | "tool" | "skill" | "companion" | "channel" | "engine" | "policy";
	/**
	 * Human-readable display name.
	 */
	name: string;
}
/**
 * code surface the Gateway must permit before it runs.
 */
export interface ExternalRuntimeConfig {
	/**
	 * Assets to fetch into `~/.ryu` before first run.
	 */
	assets?: AssetSpec[];
	/**
	 * The module/entrypoint to run (e.g. `"ryu_tts"` → `python -m ryu_tts`).
	 */
	entry: string;
	/**
	 * Environment variables layered onto the runtime process at spawn. Values may
	 * use `${RYU_DIR}` — expanded to the Core data dir (`~/.ryu`) at spawn — so a
	 * runtime can point caches/outputs at Core-owned paths without hardcoding an
	 * absolute path in the (portable) manifest. Nothing else is interpolated.
	 */
	env?: {
		[k: string]: string;
	};
	/**
	 * Health-check path on the runtime's server (e.g. `"/health"`).
	 */
	health_path?: string | null;
	/**
	 * Runtime kind. `"python"` is the only provisionable kind today; others are
	 * accepted (round-trip) but provisioning returns an "unsupported" error.
	 *
	 * Defaults to `"python"` so this config can be nested inside the internally
	 * `#[serde(tag = "kind")]`-tagged [`SidecarProcess::Python`] variant: there the
	 * outer enum consumes the `"kind"` key as its discriminant, so the inner field
	 * would otherwise be reported missing — the classic internally-tagged collision.
	 * Standalone use still round-trips an explicit `kind`.
	 */
	kind?: string;
	/**
	 * Port the runtime's HTTP server binds to (adopt-or-spawn check).
	 */
	port?: number | null;
	/**
	 * Optional env var the Python child reads for its **bind port**. When set, Core
	 * injects `<port_env> = profile-shifted([`SidecarSpec::port`])` at spawn, so the
	 * child binds the same profile-aware port Core health-checks + proxies to — the
	 * Python-sidecar analogue of [`LocalProcessSpec::port_env`] (without it a static
	 * port env collides across concurrent Core profiles).
	 */
	port_env?: string | null;
	/**
	 * Optional pyproject *extra* to install (`pip install -e ".[<extra>]"`).
	 */
	pyproject_extra?: string | null;
	/**
	 * Optional Python version hint (e.g. `"3.11"`). Advisory.
	 */
	python_version?: string | null;
	/**
	 * pip requirement specs to install into the venv.
	 */
	requirements?: string[];
	/**
	 * Optional **source archive** to extract into the runtime dir before the venv
	 * is built. Needed when the entry module is a *first-party package the plugin
	 * ships* (not on PyPI): a `pip install -e ".[extra]"` needs the package's
	 * `pyproject.toml` + sources on disk first. Single-file `assets` cannot deliver
	 * a source tree; this does. Omit for a pure-PyPI runtime.
	 */
	source?: SourceArchiveSpec | null;
}
/**
 * A single asset an external runtime needs, fetched before first run. Either a
 * direct https URL or an `hf:<owner>/<repo>/<path>` reference; the destination
 * is a relative directory beneath the plugin's dedicated runtime `assets/`
 * directory — the filename is derived from the source's last path segment.
 */
export interface AssetSpec {
	/**
	 * Destination directory relative to the runtime's `assets/` directory
	 * (e.g. `"models/hf"`). The fetched file lands at
	 * `<runtime>/assets/<dest_under_runtime>/<filename>`. Must be a
	 * traversal-safe relative path (no `..`, not absolute). The old
	 * `dest_under_ryu` spelling is accepted as a wire alias but is never
	 * resolved against the shared Core data directory.
	 */
	dest_under_runtime: string;
	/**
	 * Optional SHA-256 for checksum verification (direct-URL assets).
	 */
	sha256?: string | null;
	/**
	 * A direct **https** URL, or an `hf:<owner>/<repo>/<path>` reference to a
	 * single file on the Hub. A repo-only `hf:<owner>/<repo>` ref (no file path)
	 * is **not** provisionable yet — full-repo snapshot needs Hub tree-listing
	 * that is not wired into the provisioner. The provisioner
	 * (`crate::sidecar::external_runtime`) rejects `http://` and other schemes.
	 */
	source: string;
}
/**
 * A source-tree archive an external runtime extracts into its runtime dir before
 * provisioning (venv + `pip install -e .`). Distinct from [`AssetSpec`], which
 * fetches a *single file* into `~/.ryu`; this delivers a whole package tree the
 * plugin owns.
 */
export interface SourceArchiveSpec {
	/**
	 * Archive format: `"tar.gz"` or `"zip"`. Extracted whole-tree into the runtime
	 * dir so the package's `pyproject.toml` lands at its root.
	 */
	format: string;
	/**
	 * Optional lower-case-hex SHA-256 of the archive; when present the download is
	 * verified and re-fetched on mismatch (fail-closed).
	 */
	sha256?: string | null;
	/**
	 * Direct **https** URL to the archive. Non-https is rejected by the SSRF egress
	 * screen at download time.
	 */
	url: string;
}
/**
 * A declarative **managed sidecar** a plugin may declare: a long-running child
 * process Core owns end-to-end (download/provision → spawn → health-check →
 * stop), registered into the Core `SidecarManager` on enable so it rides the
 * *same* managed lifecycle (health monitor + resource sampler +
 * `/api/sidecar/status`) as a built-in sidecar.
 *
 * This is the **app ⇄ sidecar bridge**: it lets a capability sidecar (ghost,
 * shadow, a TTS engine, …) be a fully manifest-defined app instead of hardcoded
 * Rust, and lets a third-party app ship its own process under a Gateway grant.
 * Infra sidecars (llama.cpp, the gateway, embeddings) stay Core substrate and are
 * deliberately NOT expressible here.
 *
 * The process is obtained one of two ways ([`SidecarProcess`]): a downloaded
 * **binary**, or a **Python** runtime (reusing [`ExternalRuntimeConfig`] — venv +
 * pip + assets). Both are gated at enable by the `sidecar:process` grant; nothing
 * is hardcoded — the binary URL, args, env, port, and health path are all data.
 */
export interface SidecarSpec {
	/**
	 * Health-check path on the process's server (default `"/health"`). A GET to
	 * `http://127.0.0.1:<port><health_path>` returning 2xx marks it healthy.
	 */
	health_path?: string;
	/**
	 * Optional **host-API** declaration: the subset of the owning plugin's approved
	 * grants the sidecar *process* may exercise via an authenticated callback into
	 * Core (`/api/host/*`, bearer = the plugin's minted `RYU_EXT_TOKEN`). Absent =
	 * the sidecar may not call back into Core at all (deny-all). Additive.
	 */
	host_api?: HostApiSpec | null;
	/**
	 * Optional **HTTP proxy** declaration: when present, Core exposes a public
	 * reverse-proxy front (`/api/ext/<plugin_id>/*`) onto this sidecar, so a
	 * manifest-declared sidecar becomes a full first-class *app* reachable by any
	 * client — the generic form of the hand-coded `ryu-mail` proxy. Absent = the
	 * sidecar is an internal capability with no external HTTP surface (only Core's
	 * own health probe reaches it). Additive: existing sidecars get `None`.
	 */
	http?: HttpProxySpec | null;
	/**
	 * **Idle-stop timeout**, in seconds — scale-to-zero for this sidecar. When set,
	 * Core stops the process after it has served no request for this long (and has
	 * none in flight); the next proxy/broker hit wakes it again (see [`lazy`]). Must
	 * be `>= 30` (a shorter window churns the process). Absent = never idle-stopped
	 * by manifest declaration (the operator-level [`RYU_SIDECAR_IDLE_SECS`] env can
	 * still opt a sidecar in). Additive; independent of [`lazy`] — an eager sidecar
	 * may declare an idle timeout and will then wake-on-demand after a reap.
	 *
	 * [`lazy`]: SidecarSpec::lazy
	 * [`RYU_SIDECAR_IDLE_SECS`]: the manager's env-seeded idle config.
	 */
	idle_stop_secs?: number | null;
	/**
	 * **Lazy activation** — spawn-on-first-use instead of at plugin-enable. When
	 * `true` the sidecar is *registered* (claims its port, appears in
	 * `/api/sidecar/status` as not-running) at enable but its process is NOT started
	 * until the first proxy/broker hit wakes it on demand; a bounded health-wait
	 * warms it before the request is forwarded. `false` (the default) keeps the
	 * eager behaviour every existing manifest has: started at enable. Additive.
	 *
	 * **Ignored when [`provides_provider`] is set.** Such a sidecar is always started
	 * eagerly, because the two declarations are mutually exclusive by construction: a
	 * lazy sidecar's only wake trigger is a proxy/broker hit, while a provider's only
	 * client is Pi, which dials the registered `baseUrl` directly and never traverses
	 * the proxy. Nothing could ever wake it, and Core's boot purge of stale
	 * sidecar-owned provider entries would then leave the provider permanently dead.
	 * The coercion is logged at `info`; the manifest is NOT rejected.
	 *
	 * [`provides_provider`]: SidecarSpec::provides_provider
	 */
	lazy?: boolean;
	/**
	 * Local name, unique within the plugin. Namespaced to `<plugin_id>/<name>` at
	 * registration so it never collides with a built-in sidecar or another
	 * plugin's. Must be a safe single path segment (no `/`, `\`, `..`, or NUL).
	 */
	name: string;
	/**
	 * TCP port the process's HTTP server binds to, used to build the health-check
	 * URL. The plugin is responsible for choosing a free port: there is **no
	 * allocator** — this number is what Core tries (after the profile offset), and a
	 * collision is not repaired by moving anyone.
	 *
	 * There *is* a gate. `SidecarManager::claim_port` checks a live-sidecar registry
	 * and bind-probes the port, and **refuses to start** the sidecar if either fails,
	 * so a collision with a built-in (e.g. llama.cpp on 8080) surfaces as an app that
	 * does not come up rather than as silent breakage. Detection, not resolution:
	 * picking a free port is still the author's job. See `docs/port-allocation.md`
	 * for the band map.
	 */
	port: number;
	/**
	 * How Core obtains and runs the process.
	 */
	process: BinarySpec | ExternalRuntimeConfig1 | LocalProcessSpec | NodeProcessSpec;
	/**
	 * Optional **model-provider** declaration: when present, this sidecar serves an
	 * OpenAI-compatible endpoint and Core registers it as a selectable provider once
	 * the process reports healthy, then deregisters it when the plugin is disabled or
	 * uninstalled. This is what makes a third-party *auth bridge* possible without a
	 * Core change: the plugin performs its own login/refresh, serves `/v1`, and
	 * declares that fact here. Absent = the sidecar is not a model provider.
	 *
	 * A sidecar cannot self-register: it holds only `RYU_EXT_TOKEN` (scoped to the
	 * ext-proxy hop and `/api/host/*`), and the host-RPC vocabulary has no
	 * provider-registration method. Registration is therefore Core-side, driven by
	 * this declaration.
	 *
	 * **Declaring this forces eager start and disables idle-stop**, overriding
	 * [`lazy`] and [`idle_stop_secs`]. Pi bypasses the ext proxy and dials the
	 * registered `baseUrl` directly, so no request can ever wake this sidecar on
	 * demand; a sidecar that is never started never reaches the Healthy edge that
	 * registers it, and one that is scaled to zero drops out of Pi's model list until
	 * a wake that will never come. Both coercions are logged at `info` rather than
	 * rejected by the validator, so existing manifests keep loading.
	 *
	 * [`lazy`]: SidecarSpec::lazy
	 * [`idle_stop_secs`]: SidecarSpec::idle_stop_secs
	 */
	provides_provider?: ProviderRegistrationSpec | null;
}
/**
 * Declares the host-API grant subset a sidecar *process* may exercise via the
 * authenticated `/api/host/*` callback into Core. The listed grants are the ceiling;
 * Core still intersects them with the plugin's *approved* grants (post-Gateway
 * validation) at call time, so a manifest can never widen its own authority here.
 */
export interface HostApiSpec {
	/**
	 * The grant strings (same vocabulary as `permission_grants`, e.g.
	 * `"hook:side-model"`) the sidecar backend may exercise via `/api/host/*`.
	 */
	grants?: string[];
}
/**
 * Declares the reverse-proxy front Core mounts onto a [`SidecarSpec`]. This is the
 * **data** form of what `apps/core/src/sidecar/mail.rs` hand-codes: the exact set of
 * external routes and their per-route auth posture. Core rejects any request whose
 * sub-path is not one of [`routes`] (404), preserving mail's exact-route safety as a
 * declaration instead of a hardcoded router.
 *
 * [`routes`]: HttpProxySpec::routes
 */
export interface HttpProxySpec {
	/**
	 * Maximum request body Core will buffer and forward, in bytes. Absent ⇒ Core's
	 * conservative default. Caps the proxy's memory exposure per request.
	 */
	max_body_bytes?: number | null;
	/**
	 * Optional path prefix prepended to the forwarded sub-path when Core builds the
	 * upstream URL on the sidecar (e.g. `mount = "/api/mail"` turns an external
	 * `/api/ext/<id>/status` into an upstream `/api/mail/status`). Absent/empty ⇒
	 * the sub-path after `/api/ext/<plugin_id>` is forwarded verbatim. Must start
	 * with `/` when present.
	 */
	mount?: string | null;
	/**
	 * Optional **public mount** — a stable, externally-committed URL prefix under
	 * which Core ALSO exposes this sidecar's routes, instead of only the generic
	 * `/api/ext/<plugin_id>/*` catch-all (e.g. `"/api/mail"` for a mail app whose
	 * inbound-webhook URL is baked into an external forwarder). Registered at
	 * `create_router` build time and only honoured for **built-in** manifests
	 * (axum routers are immutable after serve, so a runtime-installed third-party
	 * app cannot claim a custom prefix — it keeps `/api/ext/<id>/*`). Absent = no
	 * public mount (the common case). The routes + per-route auth are the SAME
	 * [`routes`] list; this only changes the public prefix they answer on.
	 *
	 * [`routes`]: HttpProxySpec::routes
	 */
	public_mount?: string | null;
	/**
	 * The exact set of proxied routes. Each entry's [`RouteSpec::path`] is matched
	 * against the incoming sub-path (the segment after `/api/ext/<plugin_id>`),
	 * supporting `:param` and trailing `*rest` wildcards. A request whose sub-path
	 * matches **none** of these is refused with 404 — undeclared paths are never
	 * forwarded (the security property that makes this a safe generalization of the
	 * mail proxy's fixed route list).
	 */
	routes?: RouteSpec[];
}
/**
 * One declared proxied route: a path pattern plus its auth posture.
 */
export interface RouteSpec {
	/**
	 * Auth posture for this route. Defaults to [`RouteAuth::Protected`] (secure by
	 * default): the request must carry the node bearer exactly as any other
	 * protected Core route. `public` opts a route out (e.g. an HMAC-authed inbound
	 * webhook whose external caller cannot hold the node token).
	 */
	auth?: "protected" | "public";
	/**
	 * Optional HTTP method selector for this path (canonical uppercase such as
	 * `GET` or `POST`). Absent preserves the legacy behavior and matches every
	 * method. Declare one row per method when reads and writes share a path but
	 * require different permission levels.
	 */
	method?: string | null;
	/**
	 * Path pattern for the sub-path after `/api/ext/<plugin_id>` (must start with
	 * `/`). Supports `:param` (matches one non-empty segment) and a trailing
	 * `*rest` (matches the remainder), mirroring axum/matchit patterns so a
	 * sidecar's REST routes (`/inboxes/:id`) can be declared faithfully.
	 */
	path: string;
	/**
	 * The [`PluginManifest::permission_levels`] id a caller must hold to reach this
	 * route. Absent (the default) = ungated: Core forwards exactly as it always did,
	 * so annotating is opt-in and no existing app changes behaviour.
	 *
	 * This is the only place a route→permission mapping can honestly live: Core
	 * cannot know that an app's `/tabs/:id/close` is destructive, and the sidecar
	 * cannot enforce it (it never sees the caller's identity, only Core's minted
	 * hop token). Declaring it HERE — on the same [`RouteSpec`] the proxy already
	 * matches to decide forward-or-404 — means the gate and the forward can never
	 * disagree about which route is in play.
	 *
	 * Must name a level THIS manifest declares (enforced by
	 * [`crate::manifest::validate_route_permissions`]); an app cannot gate its
	 * routes on another app's vocabulary or on a level nobody can see to grant.
	 *
	 * Never annotate an [`RouteAuth::Public`] route: a public route exists for a
	 * caller who holds no identity at all (an external webhook), and on an
	 * org-bound node an anonymous caller is refused outright — the annotation would
	 * turn a working inbound webhook into a permanent 403.
	 *
	 * [`PluginManifest::permission_levels`]: crate::manifest::PluginManifest::permission_levels
	 */
	permission?: string | null;
	/**
	 * Which `:param` of [`path`] names the resource [`permission`] is checked
	 * against, so one route can be granted per-object (`"id"` on `/tabs/:id` gates
	 * each tab separately). Absent = the whole app is the resource, which is what an
	 * admin grants when the route identifies nothing (a `/settings` POST).
	 *
	 * Only meaningful alongside [`permission`], and the named param must actually
	 * appear in [`path`] — both enforced at validation, because a typo here would
	 * silently widen a rule the author wrote as per-object into a per-app one.
	 *
	 * [`path`]: RouteSpec::path
	 * [`permission`]: RouteSpec::permission
	 */
	resource_param?: string | null;
}
/**
 * A single downloaded executable: fetched (checksum-verified) into the
 * plugin's `bin/` dir, made executable, then spawned with `args` + `env`.
 */
export interface BinarySpec {
	kind: "binary";
}
/**
 * A Python runtime: the existing external-runtime provisioner (venv + pip +
 * assets) builds the environment, then `python -m <entry>` is spawned.
 * Reuses [`ExternalRuntimeConfig`] verbatim (its `port`/`health_path` are
 * ignored here — the [`SidecarSpec`]'s own fields drive the health check).
 */
export interface ExternalRuntimeConfig1 {
	kind: "python";
}
/**
 * A binary **already present on the host** — a sibling Ryu ships alongside Core
 * (e.g. `ryu-mail`), or something on `PATH`. Spawned directly with **no download**.
 * This is the escape hatch for first-party sidecars built in the same repo, which
 * have no release-artifact URL. Not for third-party apps (they should declare a
 * downloadable [`Binary`]).
 *
 * [`Binary`]: SidecarProcess::Binary
 */
export interface LocalProcessSpec {
	kind: "local";
}
/**
 * A **managed JavaScript backend** — the extension-host runtime (RFC Option B).
 * Core spawns a small first-party bootstrap (embedded in the binary) under `bun`
 * (preferred) or `node`, which loads the plugin's declared `entry` module and
 * calls its exported `activate(context)`; the module may register an HTTP request
 * handler that the `/api/ext/<id>/*` proxy forwards to. The `entry` bundle rides
 * as the owning manifest's `backend_code` payload (mirroring `ui_code`) and is
 * written to the plugin dir + integrity-checked against `backend_sha256` at spawn.
 * Because it is still a [`SidecarSpec`] it inherits the whole managed lifecycle
 * (lazy/wake, idle-stop, health monitor, PATH cap-shims, per-plugin `RYU_EXT_*`
 * token, `RouteAuth` proxying). Gated by the experimental-plugin-runtime flag and,
 * for Community-tier plugins, by the `sidecar:process` grant exactly like a binary.
 */
export interface NodeProcessSpec {
	kind: "node";
}
/**
 * Declares that a [`SidecarSpec`] serves an OpenAI-compatible model endpoint Core
 * should register as a provider while the sidecar is healthy.
 *
 * Security posture: the declared [`id`] is validated against the built-in provider
 * table at registration and a collision is REFUSED, never merged. Without that guard
 * a plugin could claim a built-in id (`openai-codex`, `anthropic`) and silently
 * redirect the user's subscription traffic — and their live bearer token — to an
 * attacker-controlled `baseUrl`. Core also stamps [`OWNER_FIELD`] into the written
 * entry so deregistration can only ever remove an entry this plugin created.
 *
 * [`id`]: ProviderRegistrationSpec::id
 * [`OWNER_FIELD`]: crate::schema::PROVIDER_OWNER_FIELD
 */
export interface ProviderRegistrationSpec {
	/**
	 * Pi `api` type the endpoint speaks. Defaults to `"openai-completions"`.
	 */
	api?: string | null;
	/**
	 * Path prefix appended to `http://127.0.0.1:<port>` to form the provider's
	 * `baseUrl`. Defaults to `"/v1"`.
	 */
	base_path?: string | null;
	/**
	 * Provider id as it appears in the model picker. Must not collide with a built-in
	 * provider id, and must be a safe single token (lowercase alphanumerics, `-`, `_`).
	 */
	id: string;
	/**
	 * Human-readable label for the picker. Defaults to [`id`] when absent.
	 *
	 * [`id`]: ProviderRegistrationSpec::id
	 */
	label?: string | null;
	/**
	 * Optional model ids to seed the entry with, for an endpoint whose `GET /models`
	 * discovery is unavailable or slow. Absent = rely on discovery.
	 */
	models?: string[];
}
/**
 * One [`PluginManifest::surfaces`] entry: the support level plus an optional UI
 * descriptor the surface shell resolves (opaque here — pure data).
 */
export interface SurfaceEntry {
	/**
	 * Terminal subcommands this app contributes to the `cli` surface (the TUI's
	 * `ryu <app> <cmd>` dispatcher). Only meaningful on the `cli` surface entry;
	 * ignored on other surfaces. Empty/absent = the app contributes no commands.
	 */
	commands?: CliCommandSpec[];
	/**
	 * How much of the plugin this surface supports.
	 */
	support?: "full" | "limited" | "list" | "commands" | "none" | "unknown";
	/**
	 * Optional surface-specific UI descriptor (bundle id, mount point, …),
	 * interpreted by the surface's app host. Opaque to the contract.
	 */
	ui?: {
		[k: string]: unknown;
	};
}
/**
 * One terminal subcommand an app contributes to the `cli` surface (the TUI's
 * `ryu <app> <cmd>` dispatcher). Routed through Core's `ext_proxy` to the app's
 * sidecar: Core forwards `<method> /api/ext/<plugin_id><path>`. `path` MUST be a
 * route the app's sidecar declares in `http.routes`, or the proxy 404s.
 */
export interface CliCommandSpec {
	/**
	 * HTTP method for the `ext_proxy` call. Absent = `POST`.
	 */
	method?: string | null;
	/**
	 * Subcommand token, e.g. `status` in `ryu mail status`.
	 */
	name: string;
	/**
	 * Sub-path appended after `/api/ext/<plugin_id>`. Validated by
	 * [`validate_cli_command_path`] at manifest load: it MUST be an absolute
	 * (`/`-leading), traversal-free sub-path — no `..` segment in any form — so it
	 * cannot escape the plugin's proxy scope when a URL parser normalizes it.
	 */
	path: string;
	/**
	 * One-line help shown in `ryu <app>` / `ryu <app> --help`.
	 */
	summary?: string | null;
}
