# Contributing to Ryu SDK

Thanks for helping improve the public Ryu SDK surface.

## Source of truth

This repository is generated from the Ryu monorepo. Open a pull request here for a public SDK
fix or documentation improvement; maintainers port accepted changes to the monorepo and the next
sync will publish the resulting canonical tree. A sync can rewrite generated files and `main`.

Do not hand-edit generated binding files. Change the Rust UniFFI/C-ABI source or the generator
inputs, then run the relevant binding shell.

## Local checks

```bash
bun install --frozen-lockfile --ignore-scripts
bun run build:native
bun run check
cargo fmt --all --check
cargo test --workspace --locked --all-targets
```

Run the language-specific command for the binding you changed. Binding scripts generate ignored
files into their language project and execute the committed example and tests.

## Public contract rules

- Keep the Rust kernel as the source of truth for shared validation and Gateway egress rules.
- Preserve the existing package/crate version train and update compatibility notes for breaking
  changes.
- Keep examples credential-free and use a Gateway token only through the documented runtime
  configuration.
- Update the relevant Fumadocs SDK page in the Ryu monorepo when a public API, package, binding,
  or release behavior changes.
- Add a focused test for every contract or generation change.

## License

Contributions are licensed under Apache-2.0. See [LICENSE](./LICENSE).
