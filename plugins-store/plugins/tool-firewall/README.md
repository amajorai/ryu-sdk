# Tool Firewall

A worked reference for pre- and post-tool hooks: the pre hook denies any tool call whose input matches a destructive pattern (`rm -rf`, `DROP TABLE`, `mkfs`), and the post hook notes what each tool returned. The pattern set is deliberately tiny — copy this directory as the starting point for your own tool policy.

Definition lives in `manifest.json`, its sandboxed hook bodies in `hooks/post.js` and `hooks/pre.js`; Core compiles them all in from this package directory. Published to the grouped `ryu-marketplace` via `tools/mirror-plugins.sh`.
