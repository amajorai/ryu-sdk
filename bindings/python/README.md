# `ryu-sdk` — Python SDK

The `ryu-sdk` package (version 0.4.0 in `pyproject.toml`) is not yet published
to PyPI, so `pip install ryu-sdk` does not work today. Until it is, use the
pure-Python layer from a checkout of this repository:

```bash
python -m pip install "httpx>=0.24,<1"
PYTHONPATH=bindings/python python -c "import ryu_sdk.services"
```

The package has two layers:

- **The authoring surface** (pure Python, committed in `ryu_sdk/`, needs
  `httpx`; `pydantic` is an optional extra): a loop-owning `Agent` with
  `generate()` / `agenerate()` / async `stream()`, the `@tool` decorator with
  JSON Schema inferred from type hints or pydantic, structured output with
  validation and repair re-asks, `wrap_model_call` / `wrap_tool_call` /
  `after_turn` middleware, a workflow DSL that compiles to Core's JSON workflow
  graph plus a deploy/run/stream client, and clients for Core harness sessions
  (with SSE resume cursors) and the Managed Agents API. It mirrors the
  TypeScript `@ryuhq/sdk` agent loop and `@ryuhq/client` harness and
  managed-agents clients. Every client has a sync and an async (`Async*`) form.
- **The kernel binding**, **generated** from
  [`crates/sdk/uniffi`](../../crates/sdk/uniffi) via UniFFI. It exposes the
  same shared Rust kernel as the TypeScript (`crates/sdk/napi`) and Go
  (`bindings/go`) bindings, so manifest validation, the gateway egress
  blocklist, and the model/embedding transport never drift across languages.

```python
from ryu_sdk import Agent, tool


@tool
def add(a: int, b: int) -> int:
    """Add two integers."""
    return a + b


agent = Agent("calc", model="your-model-id", tools=[add])
print(agent.generate("What is 2 + 3?").text)
```

The full guide is the public
[Python SDK page](https://docs.ryuhq.com/docs/extend/develop/sdk/python).

| Module | What it holds |
|---|---|
| `ryu_sdk.agent` | `Agent`, its events, `GenerateResult`, approvals, harness-session mode (`stream_run`, `resume`, `resolve_permission`) |
| `ryu_sdk.tools` | `@tool`, `Tool`, `ryu_tool` (Core-executed remote tools) |
| `ryu_sdk.schema` | Type-hint → JSON Schema, the validator, structured-output helpers |
| `ryu_sdk.middleware` | `Middleware` and the model/tool call request types |
| `ryu_sdk.model_call` | Streamed Gateway `/v1/chat/completions` with tool-call assembly |
| `ryu_sdk.workflow` | Workflow DSL, compiler, `WorkflowClient` / `AsyncWorkflowClient` |
| `ryu_sdk.harness` | `HarnessClient` / `AsyncHarnessClient` |
| `ryu_sdk.managed_agents` | `ManagedAgentsClient` / `AsyncManagedAgentsClient` |
| `ryu_sdk.gateway` | Gateway/Core endpoint resolution and the egress rule |

The pure-Python layer imports without the native module, so it works from a
source checkout before the cdylib is built (`ryu_sdk.NATIVE_AVAILABLE` says
which). When the native module is present, the egress rule uses the Rust
kernel's `assert_allowed_egress`; otherwise it applies the same blocklist, kept
in lockstep by `tests/test_gateway.py`.

## Standalone services client (`ryu_sdk.services`)

`ryu_sdk.services` is the Python form of `@ryuhq/services`: one client for
Ryu's standalone services (Managed Agents, Messaging, Mail, Notify, Box,
Gateway, Connect, Passport, Sites), with a sync `Ryu` and an async `AsyncRyu`.

```python
from ryu_sdk.services import Ryu

ryu = Ryu(result="object")  # RYU_* env vars are read lazily, per service
data, error, meta = ryu.notify.publish({"title": "Deploy finished", "level": "success"})
if error:
    print(error.code, error.request_id, error.hint)
```

It mirrors the TypeScript SDK where behaviour matters: the same environment
variables and precedence (`ENV_VARS`), default hosts, auth header per service
and mode, idempotent route tables with one `Idempotency-Key` reused across
retries (Passport's `connections.create` is keyed only after
`GET /v1/capabilities` lists `features.idempotency_keys`, cached per instance
for five minutes), non-replay-safe writes (Messaging `settings.update`), the
credential-free Messaging `status()`, Gateway `error.upstream_status` as
`details["upstreamStatus"]`, replay-safe retry rules and non-retryable codes, `Retry-After` and
`RateLimit` parsing, redirect refusal, origin scoping, the `RyuError`
hierarchy and envelope detection order, `Result(data, error, meta)` object
mode, and Standard Webhooks / Notify webhook verification with
`hmac.compare_digest`. Names are snake_case (`ryu.managed_agents`,
`messages.reply_all`), `with_options(idempotency_key=...)` replaces
`.with()`, and `timeout` / `max_retry_delay` are seconds. Managed Agents
requests are built by `ryu_sdk.managed_agents` and sent through the services
transport; its resumable stream is reused for `sessions.follow()` and
`sessions.run()`.

`AsyncRyu` has the same surface with coroutine methods and async iterators.
Close an `async for` you leave early (or wrap it in `contextlib.aclosing`, Python 3.10+), or
its stream stays open until the iterator is garbage-collected:

```python
import asyncio
from contextlib import aclosing

from ryu_sdk.services import AsyncRyu


async def main() -> None:
    async with AsyncRyu() as ryu:
        await ryu.notify.publish({"title": "Deploy finished"})
        run = await ryu.managed_agents.sessions.run({"agentId": "magt_<id>", "environmentId": "menv_<id>", "message": "Summarize the deploy"})
        async with aclosing(ryu.managed_agents.sessions.follow(run["session"]["id"])) as events:
            async for event in events:
                print(event["type"])


asyncio.run(main())
```

### Agent tools (`ryu_sdk.services.tools`)

The same tool registry as `@ryuhq/services/tools` and `ryu-services mcp`:
37 tools with the same names, descriptions, argument JSON Schemas and
annotations. Only read-only tools are exposed unless you pass `read_only=False`.
Tools that are not read-only, or that reach outside Ryu, carry
`needs_approval`. Results are `{"data", "error", "meta"}` JSON, and a service
failure or a rejected argument is returned as data, not raised.
`to_ryu_agent_tools` returns a `{name: Tool}` dict (merge it with
`[my_tool, *tools.values()]`). The function-calling `execute` refuses a tool
that needs approval with an `approval_required` error until the host passes
`approved=True` (or an `approve=` callback on the adapter allows the call).
Pass the function-calling list straight to the vendor SDK as `tools=`; it
passes `mypy --strict` with the OpenAI and Anthropic SDKs, no `cast` needed:

```python
from ryu_sdk import Agent
from ryu_sdk.services import Ryu
from ryu_sdk.services.tools import to_anthropic_tools, to_openai_tools, to_ryu_agent_tools

ryu = Ryu()
agent = Agent("ops", model="openai/gpt-4o-mini", tools=to_ryu_agent_tools(ryu))

tools = to_openai_tools(ryu, services=["notify"])  # or api="responses"; to_anthropic_tools(ryu)
name, arguments = call.function.name, call.function.arguments
# needs_approval is False for a name that is not offered: execute answers unknown_tool without asking.
approved = tools.needs_approval(name) and ask_user(name, arguments)  # your own prompt
result = tools.execute(name, arguments, approved=approved)  # await tools.aexecute(...) on AsyncRyu
```

### Static types

The package ships `py.typed`. `Ryu()` is a `Ryu[Literal["throw"]]` and
`Ryu(result="object")` a `Ryu[Literal["object"]]`. Each namespace then
reads as its view from `ryu_sdk.services.views`, so the main methods return
the `TypedDict` shapes in `ryu_sdk.services.shapes`:

| Client | `ryu.notify.publish(...)` |
|---|---|
| `Ryu()` | `NotifyEvent` |
| `Ryu(result="object")`, or `ryu.safe.notify` | `Result[NotifyEvent]` |
| `AsyncRyu()` | `Awaitable[NotifyEvent]` |
| `AsyncRyu(result="object")` | `Awaitable[Result[NotifyEvent]]` |

A bare `Ryu` or `AsyncRyu` annotation means the default `result="throw"`
client, so `def helper(ryu: Ryu)` keeps these types (and passes `mypy --strict`).
Annotate a helper that takes an object-mode client with `ObjectRyu` or
`AsyncObjectRyu`, short names for `Ryu[Literal["object"]]` and
`AsyncRyu[Literal["object"]]`. The aliases are for annotations only:
`isinstance(client, ObjectRyu)` raises `TypeError`, so check the mode at run
time with `client.result == "object"`.
Every method is declared on the views, so a misspelled method or argument is a
type error; a method without a listed return type returns `Any`.
Constructor options are checked through `RyuOptions`, so a misspelled option is
a type error. `gateway.chat.completions.create(...)` returns a
`GatewayChatCompletion`, or an iterator of chunks with `stream=True`. The tool
adapters accept only a `result="throw"` client, so a type checker rejects
`to_openai_tools(Ryu(result="object"))`.

As noted above, the package is not yet published to PyPI. The public guide is the
[SDK overview](https://docs.ryuhq.com/docs/standalone/sdk), where every
sample has a Python tab.

Parity is tested, not assumed:

- `tests/fixtures/services_vectors.ts` runs the TypeScript source (config,
  errors, retries, header parsing, route matching, webhook verifiers, and the
  facade surface) and writes `services_vectors.json`;
  `tests/test_services_vectors.py` replays every vector through the Python
  client and, when `bun` is installed, regenerates the file and fails if the
  committed copy is stale. Regenerate it with
  `bun bindings/python/tests/fixtures/services_vectors.ts > bindings/python/tests/fixtures/services_vectors.json`.
- `ryu_sdk/services/surface.json` lists every `ryu.<namespace>.<method>` path;
  the public docs guard checks Python samples against it, and
  `tests/test_services_surface.py` keeps it equal to the client and checks
  that every canonical TypeScript path exists here. Regenerate it with
  `PYTHONPATH=bindings/python python -m ryu_sdk.services._surface > bindings/python/ryu_sdk/services/surface.json`.
- `ryu_sdk/services/tools/manifest.json` (the tool registry) and
  `tests/fixtures/services_tools_vectors.json` (arguments run through each
  tool's zod schema) are exported by `tests/fixtures/services_tools.ts`;
  `tests/test_services_tools_registry.py` regenerates both when `bun` is
  installed and replays the vectors through the Python validator. Regenerate
  them with `bun bindings/python/tests/fixtures/services_tools.ts manifest > bindings/python/ryu_sdk/services/tools/manifest.json`
  and `bun bindings/python/tests/fixtures/services_tools.ts vectors > bindings/python/tests/fixtures/services_tools_vectors.json`.
- `ryu_sdk/services/views.py` is generated from the live client and the
  `RETURNS` table in `ryu_sdk/services/_gen_views.py`.
  `tests/test_services_typing.py` keeps the file current, runs
  `mypy --strict --config-file pyproject.toml` on `ryu_sdk.services` and on the
  whole `ryu_sdk` package when mypy is installed (no `--follow-imports=silent`),
  also in a native-built tree: `pyproject.toml` excludes the generated UniFFI
  file `ryu_sdk/ryu_sdk.py` from the checked sources and treats the module
  `ryu_sdk.ryu_sdk` as an untyped import. It also checks the types revealed
  for each client mode. Regenerate `views.py` with
  `PYTHONPATH=bindings/python python -m ryu_sdk.services._gen_views > bindings/python/ryu_sdk/services/views.py`.

## Testing the pure-Python layer

The tests use `httpx.MockTransport`, so they need no running node:

```sh
cd bindings/python
python -m pip install "httpx>=0.24,<1" "pydantic>=2.4.0,<3" "pytest>=9.0.3; python_version >= '3.10'"
PYTHONPATH=. python -m pytest -q tests
```

`tests/test_workflow.py` also checks every node the DSL emits against Core's
`NodeKind` in `apps/core/src/workflow/mod.rs` (set `RYU_CORE_WORKFLOW_RS` to
check another copy). Live round-trips against a Gateway, Core node, or the
Managed Agents API are not part of these tests.

## What is committed vs generated

- **Committed:** this README, `pyproject.toml` (packaging shell), the
  `ryu_sdk/` package's `__init__.py` and pure-Python modules, `tests/` (the
  pure-Python tests), `smoke_test.py` (the pipeline proof), `test_sdk.py` (the
  binding contract tests), and `example.py` (a no-network example project entry
  point).
- **Generated (gitignored):** the native module `ryu_sdk/ryu_sdk.py` and the
  compiled `libryu_sdk_uniffi.{so,dylib}` / `ryu_sdk_uniffi.dll` placed beside
  it.

## Regenerate locally

`ryu-sdk-uniffi` is a workspace member with its own lockfile. Commands below use
the repository root manifest path, so the shared `target/` directory is used
consistently by the Rust and foreign binding tests.

```sh
# 1. Build the cdylib.
cargo build --release --manifest-path crates/sdk/uniffi/Cargo.toml

# 2. Generate the Python module from the compiled library. The out-dir is the
#    repository-root bindings/python/ryu_sdk.
cargo run --release --manifest-path crates/sdk/uniffi/Cargo.toml \
  --bin uniffi-bindgen -- generate \
  --library target/release/libryu_sdk_uniffi.so \
  --language python --out-dir bindings/python/ryu_sdk

# 3. Copy the compiled library next to the generated module so it loads.
cp target/release/libryu_sdk_uniffi.so bindings/python/ryu_sdk/

# 4. Prove it.
cd bindings/python && PYTHONPATH=. python3 -m pytest -q tests
PYTHONPATH=. python3 smoke_test.py
PYTHONPATH=. python3 -m unittest -v test_sdk.py
PYTHONPATH=. python3 example.py
```

On Windows the artifact is `target/release/ryu_sdk_uniffi.dll` (no `lib` prefix,
not `.so`); swap the two `libryu_sdk_uniffi.so` paths above for it. A committed
`ryu_sdk/__init__.py` re-exports the generated `ryu_sdk.py` so `import ryu_sdk`
resolves the native surface directly, next to the pure-Python exports.

(The `uniffi-bindgen` bin target is `src/bin/uniffi-bindgen.rs`, calling
`uniffi::uniffi_bindgen_main()` from the `cli` feature on the `uniffi` dep. The
emitted module name is `ryu_sdk` because the crate calls
`setup_scaffolding!("ryu_sdk")` — the namespace, not the crate name
`ryu_sdk_uniffi`, drives the package name.)

## Scope

The native surface includes `validate_plugin_id`, `parse_and_validate_manifest`,
`plugin_manifest_json_schema`, `resolve_gateway_url`, `resolve_gateway_token`,
`assert_allowed_egress`, `ModelClient.chat`, `ModelClient.stream` with
`ChatSink`, and `EmbeddingClient.embed`. See the public
[Fumadocs language-binding guide](https://docs.ryuhq.com/docs/extend/develop/sdk/language-bindings).
