"""``ryu.box``: Ryu Box sandboxes (hosted at ``https://box.ryuhq.com``, or your own Box).

Canonical spelling as in ``@ryuhq/services``:

==========  ===================================================================
(top)       list, get, create, delete, stop, resume, fork, wait_until_ready,
            exec, exec_stream, access_token, enable_ssh, usage, limits, run
processes   list, get, spawn, logs, follow_logs, kill, write_stdin, interrupt
files       list, read, read_text, write, mkdir, delete, download_archive,
            upload_archive
previews    list, create, delete
snapshots   list, get, create, delete
secrets     list, set, delete
prompts     list, get, create, cancel
events      list, follow
==========  ===================================================================

``create`` and ``fork`` always carry an ``Idempotency-Key`` (the server
requires one) that is reused on every retry; a replay is reported in
``meta.replayed``. ``run`` creates a Box, waits until it is usable, runs one
command over the streaming exec route and returns ``{"box", "result"}``.
Terminal and tunnel WebSockets are not part of the Python client; use
``access_token`` to get their URLs.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping, Sequence
from typing import Any, Optional, Union

from ._base import Namespace, Resource, call_options, compact, field, segment
from ._runtime import Defer, Emit, NextFrame, Now, OpenStream, Request, Sleep
from .errors import RyuConfigurationError, RyuConnectionError, RyuError, RyuTimeoutError
from .shapes import BoxCommandParts
from .transport import new_idempotency_key

DEFAULT_POLL_INTERVAL_S = 1.0
DEFAULT_READY_TIMEOUT_S = 30 * 60.0
USABLE_STATUSES = frozenset({"ready", "running"})
#: Error codes the Box service sends as ``error.code`` (lockstep with
#: packages/services/src/box/codes.ts, which tracks ``BoxErrorCode`` in apps/box/src/errors.ts).
BOX_ERROR_CODES = (
    "unauthorized",
    "invalid_json",
    "invalid_request",
    "body_too_large",
    "quota_exceeded",
    "insufficient_credits",
    "not_found",
    "conflict",
    "idempotency_conflict",
    "idempotency_key_resource_deleted",
    "box_not_ready",
    "box_busy",
    "forbidden",
    "not_supported",
    "secrets_unavailable",
    "driver_unavailable",
    "driver_not_safe",
    "driver_failed",
    "upstream_not_configured",
    "upstream_unavailable",
    "upstream_timeout",
    "upstream_account_conflict",
    "upstream_account_unverified",
    "request_failed",
    "capacity_unavailable",
    "billing_owner_mismatch",
    "stream_direct_only",
    "token_replayed",
)
#: Codes ``run`` raises itself when the Box never becomes usable.
BOX_RUN_CODES = {"failed": "box_failed", "ready_timeout": "box_ready_timeout"}
_COMMAND_LINE_SYNTAX = re.compile(r"""[\s"'\\]""")


def _seg(value: Any, name: str) -> str:
    """A Box path id; empty, ``.`` and ``..`` raise ``invalid_id`` so a dot segment never collapses
    ``/v1/boxes/<id>/previews/..`` into ``DELETE /v1/boxes/<id>``."""
    return segment("box", value, name)


def _box(box_id: str) -> str:
    return f"/v1/boxes/{_seg(box_id, 'the box id')}"


def _proc(box_id: str, process_id: str) -> str:
    return f"{_box(box_id)}/processes/{_seg(process_id, 'the process id')}"


def _absolute(config: Any, url: str) -> str:
    import httpx

    return str(httpx.URL(config.base_url.rstrip("/") + "/").join(url))


def _socket_url(config: Any, url: str) -> str:
    return re.sub(r"^http", "ws", _absolute(config, url))


def quote_command_word(word: str) -> str:
    if not _COMMAND_LINE_SYNTAX.search(word):
        return word
    return "'" + word.replace("'", "'\\''") + "'"


def command_parts(command: Union[str, Sequence[str]], args: Optional[Sequence[str]]) -> BoxCommandParts:
    """``{"command", "args"}`` for the exec route from a command string or an argv list."""
    if isinstance(command, str):
        if command.strip() == "":
            raise _invalid("box.run(): `command` must not be empty.")
        return {"command": command, "args": list(args or [])}
    parts = list(command)
    if not parts or not isinstance(parts[0], str) or parts[0].strip() == "":
        raise _invalid("box.run(): `command` must name an executable as its first element.")
    if args:
        raise _invalid("box.run(): pass the arguments either in the `command` list or in `args`, not both.")
    return {"command": quote_command_word(parts[0]), "args": parts[1:]}


def _invalid(message: str) -> RyuConfigurationError:
    return RyuConfigurationError(message, service="box", code="invalid_input")


def default_run_name(idempotency_key: Optional[str]) -> str:
    if idempotency_key is None:
        return f"run-{new_idempotency_key()[:8]}"
    return f"run-{hashlib.sha256(idempotency_key.encode('utf-8')).hexdigest()[:12]}"


def stream_event(frame: Any) -> Optional[dict[str, Any]]:
    """One exec/log SSE frame as ``{"type": "stdout"|"stderr"|"exit"|"process", ...}``."""
    data = json.loads(frame.data) if frame.data else {}
    if not isinstance(data, dict):
        data = {}
    if frame.event == "process":
        return {"type": "process", "process": data}
    if frame.event in ("stdout", "stderr"):
        return {"type": frame.event, "data": str(data.get("data", "")), "seq": int(frame.id or 0)}
    if frame.event == "exit":
        return {
            "type": "exit",
            "durationMs": data.get("durationMs"),
            "exitCode": data.get("exitCode"),
            "status": data.get("status"),
        }
    return None


def _command_stream(path: str, body: Mapping[str, Any], method: str = "POST") -> Any:
    """Generator: opens a command/log SSE stream and emits its events."""
    request = (
        Request(method, path, json=dict(body), headers={"accept": "text/event-stream"})
        if method == "POST"
        else Request(method, path, params=dict(body), headers={"accept": "text/event-stream"})
    )
    stream = yield OpenStream(request)
    yield Defer(stream.close)
    while True:
        frame = yield NextFrame(stream)
        if frame is None:
            return
        item = stream_event(frame)
        if item is not None:
            yield Emit(item)


class ProcessesResource(Resource):
    def __call__(self, box_id: str) -> Any:
        return self.list(box_id)

    def list(self, box_id: str) -> Any:
        return self._b.call(lambda _c: Request("GET", f"{_box(box_id)}/processes", decode=field("processes")))

    def get(self, box_id: str, process_id: str) -> Any:
        return self._b.call(lambda _c: Request("GET", _proc(box_id, process_id), decode=field("process")))

    def spawn(self, box_id: str, input: Mapping[str, Any]) -> Any:
        """Starts a background command; returns the process."""
        return self._b.call(
            lambda _c: Request(
                "POST", f"{_box(box_id)}/commands", json=dict(input, background=True), decode=field("process")
            )
        )

    def logs(self, box_id: str, process_id: str, after: int = 0) -> Any:
        return self._b.call(lambda _c: Request("GET", f"{_proc(box_id, process_id)}/logs", params={"after": after}))

    def follow_logs(self, box_id: str, process_id: str, *, after: Optional[int] = None) -> Any:
        params = compact({"after": after, "follow": "true"})
        return self._b.stream(lambda _c: _command_stream(f"{_proc(box_id, process_id)}/logs", params, "GET"))

    def kill(self, box_id: str, process_id: str) -> Any:
        return self._b.call(lambda _c: Request("POST", f"{_proc(box_id, process_id)}/kill", decode=field("process")))

    def write_stdin(self, box_id: str, process_id: str, data: str, *, close: bool = False) -> Any:
        return self._b.call(
            lambda _c: Request(
                "POST",
                f"{_proc(box_id, process_id)}/stdin",
                json={"close": close, "data": data},
                decode=lambda _v: None,
            )
        )

    def interrupt(self, box_id: str) -> Any:
        """Kills every running process; returns how many were killed."""
        return self._b.call(lambda _c: Request("POST", f"{_box(box_id)}/interrupt", decode=field("killed")))


class FilesResource(Resource):
    def list(self, box_id: str, path: str = ".") -> Any:
        return self._b.call(
            lambda _c: Request("GET", f"{_box(box_id)}/files", params={"path": path}, decode=field("entries"))
        )

    def read(self, box_id: str, path: str) -> Any:
        """A file's bytes."""
        return self._b.call(lambda _c: Request("GET", f"{_box(box_id)}/files/content", params={"path": path}, raw=True))

    def read_text(self, box_id: str, path: str) -> Any:
        """A file decoded as UTF-8."""
        return self._b.call(
            lambda _c: Request(
                "GET",
                f"{_box(box_id)}/files/content",
                params={"path": path},
                raw=True,
                decode=lambda value: value.decode("utf-8", errors="replace"),
            )
        )

    def write(self, box_id: str, path: str, data: Union[bytes, str]) -> Any:
        content = data.encode("utf-8") if isinstance(data, str) else bytes(data)
        return self._b.call(
            lambda _c: Request(
                "PUT",
                f"{_box(box_id)}/files/content",
                params={"path": path},
                content=content,
                headers={"content-type": "application/octet-stream"},
                decode=lambda _v: None,
            )
        )

    def mkdir(self, box_id: str, path: str) -> Any:
        return self._b.call(
            lambda _c: Request("POST", f"{_box(box_id)}/files/directories", json={"path": path}, decode=lambda _v: None)
        )

    def delete(self, box_id: str, path: str) -> Any:
        return self._b.call(
            lambda _c: Request("DELETE", f"{_box(box_id)}/files", params={"path": path}, decode=lambda _v: None)
        )

    def download_archive(self, box_id: str, path: str = ".") -> Any:
        """A tar archive of ``path``, as bytes."""
        return self._b.call(lambda _c: Request("GET", f"{_box(box_id)}/files/archive", params={"path": path}, raw=True))

    def upload_archive(self, box_id: str, path: str, tar: bytes) -> Any:
        return self._b.call(
            lambda _c: Request(
                "PUT",
                f"{_box(box_id)}/files/archive",
                params={"path": path},
                content=bytes(tar),
                headers={"content-type": "application/x-tar"},
                decode=lambda _v: None,
            )
        )


class PreviewsResource(Resource):
    def list(self, box_id: str) -> Any:
        return self._b.call(
            lambda config: Request(
                "GET",
                f"{_box(box_id)}/previews",
                decode=lambda value: [dict(item, url=_absolute(config, item["url"])) for item in value["previews"]],
            )
        )

    def create(self, box_id: str, port: int, visibility: str = "private") -> Any:
        return self._b.call(
            lambda config: Request(
                "POST",
                f"{_box(box_id)}/previews",
                json={"port": port, "visibility": visibility},
                decode=lambda value: dict(value["preview"], url=_absolute(config, value["preview"]["url"])),
            )
        )

    def delete(self, box_id: str, token: str) -> Any:
        return self._b.call(
            lambda _c: Request(
                "DELETE", f"{_box(box_id)}/previews/{_seg(token, 'the preview token')}", decode=lambda _v: None
            )
        )


class SnapshotsResource(Resource):
    def list(self) -> Any:
        return self._b.call(lambda _c: Request("GET", "/v1/snapshots", decode=field("snapshots")))

    def get(self, snapshot: str) -> Any:
        return self._b.call(
            lambda _c: Request("GET", f"/v1/snapshots/{_seg(snapshot, 'the snapshot id')}", decode=field("snapshot"))
        )

    def create(self, box_id: str, name: Optional[str] = None) -> Any:
        return self._b.call(
            lambda _c: Request(
                "POST", f"{_box(box_id)}/snapshots", json={"name": name} if name else {}, decode=field("snapshot")
            )
        )

    def delete(self, snapshot: str) -> Any:
        return self._b.call(
            lambda _c: Request("DELETE", f"/v1/snapshots/{_seg(snapshot, 'the snapshot id')}", decode=lambda _v: None)
        )


class SecretsResource(Resource):
    def list(self) -> Any:
        return self._b.call(lambda _c: Request("GET", "/v1/secrets", decode=field("secrets")))

    def set(self, name: str, value: str) -> Any:
        return self._b.call(
            lambda _c: Request(
                "PUT", f"/v1/secrets/{_seg(name, 'the secret name')}", json={"value": value}, decode=lambda _v: None
            )
        )

    def delete(self, name: str) -> Any:
        return self._b.call(
            lambda _c: Request("DELETE", f"/v1/secrets/{_seg(name, 'the secret name')}", decode=lambda _v: None)
        )


class PromptsResource(Resource):
    def __call__(self, box_id: str, limit: Optional[int] = None) -> Any:
        return self.list(box_id, limit)

    def list(self, box_id: str, limit: Optional[int] = None) -> Any:
        return self._b.call(
            lambda _c: Request(
                "GET", f"{_box(box_id)}/prompts", params=compact({"limit": limit}), decode=field("prompts")
            )
        )

    def get(self, box_id: str, run_id: str) -> Any:
        return self._b.call(
            lambda _c: Request("GET", f"{_box(box_id)}/prompts/{_seg(run_id, 'the run id')}", decode=field("run"))
        )

    def create(self, box_id: str, input: Mapping[str, Any]) -> Any:
        return self._b.call(lambda _c: Request("POST", f"{_box(box_id)}/prompt", json=dict(input), decode=field("run")))

    def cancel(self, box_id: str, run_id: str) -> Any:
        return self._b.call(
            lambda _c: Request(
                "POST", f"{_box(box_id)}/prompts/{_seg(run_id, 'the run id')}/cancel", decode=field("run")
            )
        )


class EventsResource(Resource):
    def __call__(self, box_id: str, limit: Optional[int] = None) -> Any:
        return self.list(box_id, limit)

    def list(self, box_id: str, limit: Optional[int] = None) -> Any:
        return self._b.call(
            lambda _c: Request(
                "GET", f"{_box(box_id)}/events", params=compact({"limit": limit}), decode=field("events")
            )
        )

    def follow(self, box_id: str, *, after: Optional[int] = None) -> Any:
        """The Box's event log, then new events as they happen (SSE)."""
        params = compact({"after": after, "follow": "true"})

        def op(_config: Any) -> Any:
            stream = yield OpenStream(
                Request("GET", f"{_box(box_id)}/events", params=params, headers={"accept": "text/event-stream"})
            )
            yield Defer(stream.close)
            while True:
                frame = yield NextFrame(stream)
                if frame is None:
                    return
                yield Emit(json.loads(frame.data))

        return self._b.stream(op)


class BoxNamespace(Namespace):
    """``ryu.box``."""

    def __init__(self, binding: Any) -> None:
        super().__init__(binding)
        self.processes = ProcessesResource(binding)
        self.files = FilesResource(binding)
        self.previews = PreviewsResource(binding)
        self.snapshots = SnapshotsResource(binding)
        self.secrets = SecretsResource(binding)
        self.prompts = PromptsResource(binding)
        self.events = EventsResource(binding)

    def list(self) -> Any:
        return self._b.call(lambda _c: Request("GET", "/v1/boxes", decode=field("boxes")))

    def get(self, box_id: str) -> Any:
        return self._b.call(lambda _c: Request("GET", _box(box_id), decode=field("box")))

    def create(self, input: Mapping[str, Any], idempotency_key: Optional[str] = None) -> Any:
        """``POST /v1/boxes``. Always carries an ``Idempotency-Key`` (yours, or a generated one)."""
        return self._b.call(
            lambda _c: Request("POST", "/v1/boxes", json=dict(input), decode=field("box")),
            call_options(idempotency_key),
        )

    def delete(self, box_id: str) -> Any:
        return self._b.call(lambda _c: Request("DELETE", _box(box_id), decode=lambda _v: None))

    def stop(self, box_id: str) -> Any:
        return self._b.call(lambda _c: Request("POST", f"{_box(box_id)}/stop", decode=lambda _v: None))

    def resume(self, box_id: str) -> Any:
        return self._b.call(lambda _c: Request("POST", f"{_box(box_id)}/resume", decode=field("box")))

    def fork(
        self, box_id: str, input: Optional[Mapping[str, Any]] = None, idempotency_key: Optional[str] = None
    ) -> Any:
        """``POST /v1/boxes/:id/fork``. Always carries an ``Idempotency-Key``."""
        return self._b.call(
            lambda _c: Request("POST", f"{_box(box_id)}/fork", json=dict(input or {}), decode=field("box")),
            call_options(idempotency_key),
        )

    def wait_until_ready(self, box_id: str, *, interval: float = 1.0, timeout: float = 30 * 60.0) -> Any:
        """Polls until the Box leaves ``provisioning``; raises when it ends in ``error``."""

        def op(_config: Any) -> Any:
            started = yield Now()
            box = yield Request("GET", _box(box_id), decode=field("box"))
            return (yield from _wait_for_box(box, interval, timeout, started))

        return self._b.call(op)

    def exec(self, box_id: str, input: Mapping[str, Any]) -> Any:
        """Runs a command to completion: ``{"stdout", "stderr", "exitCode", "durationMs"}``."""
        return self._b.call(
            lambda _c: Request("POST", f"{_box(box_id)}/commands", json=dict(input), decode=field("result"))
        )

    def exec_stream(self, box_id: str, input: Mapping[str, Any]) -> Any:
        """Runs a command and yields ``stdout``/``stderr``/``exit`` events as they happen."""
        return self._b.stream(lambda _c: _command_stream(f"{_box(box_id)}/commands", dict(input, stream=True)))

    def access_token(self, box_id: str, scope: str, port: Optional[int] = None) -> Any:
        """A short-lived terminal or tunnel token; ``url`` is the WebSocket URL."""
        return self._b.call(
            lambda config: Request(
                "POST",
                f"{_box(box_id)}/access-tokens",
                json=compact({"port": port, "scope": scope}),
                decode=lambda value: dict(value, url=_socket_url(config, value["url"])),
            )
        )

    def enable_ssh(self, box_id: str, public_key: str) -> Any:
        return self._b.call(
            lambda config: Request(
                "POST",
                f"{_box(box_id)}/ssh",
                json={"publicKey": public_key},
                decode=lambda value: dict(value["ssh"], tunnelUrl=_socket_url(config, value["ssh"]["tunnelUrl"])),
            )
        )

    def usage(self, **window: Any) -> Any:
        return self._b.call(lambda _c: Request("GET", "/v1/usage", params=compact(window)))

    def limits(self) -> Any:
        """``GET /v1/limits``: the tenant's running and stored Boxes and resource units against its limits."""
        return self._b.call(lambda _c: Request("GET", "/v1/limits"))

    def run(
        self,
        input: Mapping[str, Any],
        *,
        idempotency_key: Optional[str] = None,
        poll_interval: Optional[float] = None,
        ready_timeout: Optional[float] = None,
    ) -> Any:
        """Creates a Box, waits until it is usable, runs one command and returns ``{"box", "result"}``.

        ``input`` holds the ``create`` fields (``size``, ``name``, ...) and the
        command fields (``command`` as a string or argv list, ``args``,
        ``cwd``, ``stdin``, ``timeoutSecs``, ``user``). With an
        ``idempotency_key`` a retried run reuses the Box the first one created.
        """
        body = dict(input)
        command = body.pop("command", None)
        args = body.pop("args", None)
        command_fields = {key: body.pop(key) for key in ("cwd", "stdin", "timeoutSecs", "user") if key in body}
        name = body.pop("name", None)
        key = idempotency_key if idempotency_key is not None else self._b.options.idempotency_key

        def op(_config: Any) -> Any:
            parts = command_parts(command if command is not None else "", args)
            create = dict(body, name=name if name is not None else default_run_name(key))
            started = yield Now()
            created = yield Request("POST", "/v1/boxes", json=create, decode=field("box"))
            box = yield from _wait_for_box(
                created,
                poll_interval if poll_interval is not None else DEFAULT_POLL_INTERVAL_S,
                ready_timeout if ready_timeout is not None else DEFAULT_READY_TIMEOUT_S,
                started,
            )
            result = yield from _collect_exec(
                _command_stream(f"{_box(box['id'])}/commands", dict(parts, **command_fields, stream=True)), box["id"]
            )
            return {"box": box, "result": result}

        return self._b.call(op, call_options(idempotency_key))


def _wait_for_box(box: dict[str, Any], interval: float, timeout: float, started: float) -> Any:
    deadline = started + timeout
    while True:
        status = box.get("status")
        if status in USABLE_STATUSES:
            return box
        if status != "provisioning":
            last_error = box.get("lastError")
            raise RyuError(
                f"Ryu Box: Box {box.get('id')} is {status}{': ' + str(last_error) if last_error else ''}.",
                service="box",
                code=BOX_RUN_CODES["failed"],
                details={"boxId": box.get("id"), "lastError": last_error, "status": status},
                retryable=False,
            )
        now = yield Now()
        if now >= deadline:
            raise RyuTimeoutError(
                f"Ryu Box: Box {box.get('id')} is still provisioning after {timeout} s.",
                service="box",
                code=BOX_RUN_CODES["ready_timeout"],
                details={"boxId": box.get("id")},
                retryable=False,
            )
        yield Sleep(interval)
        box = yield Request("GET", _box(box["id"]), decode=field("box"))


def _collect_exec(events: Any, box_id: str) -> Any:
    stdout: list[str] = []
    stderr: list[str] = []
    value: Any = None
    while True:
        try:
            step = events.send(value)
        except StopIteration:
            break
        if not isinstance(step, Emit):
            value = yield step
            continue
        value = None
        item = step.item
        if item["type"] == "stdout":
            stdout.append(item["data"])
        elif item["type"] == "stderr":
            stderr.append(item["data"])
        elif item["type"] == "exit":
            events.close()
            return {
                "durationMs": item.get("durationMs") or 0,
                "exitCode": item.get("exitCode") if item.get("exitCode") is not None else -1,
                "stderr": "".join(stderr),
                "stdout": "".join(stdout),
            }
    raise RyuConnectionError(
        f"Ryu Box: the command stream in Box {box_id} ended before the command finished.",
        service="box",
        details={"boxId": box_id},
    )
