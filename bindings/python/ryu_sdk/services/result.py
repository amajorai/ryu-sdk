"""The object result form (``Result(data, error, meta)``, Resend-style).

``Ryu(result="object")`` returns a :class:`Result` from every call instead of
raising; in throw mode ``ryu.safe.<namespace>.<method>()`` gives the same per
call. Iterators (``iterate``, streams) are never wrapped: they raise
:class:`~ryu_sdk.services.errors.RyuError` in both modes.

A :class:`Result` unpacks like a tuple::

    data, error, meta = ryu.notify.publish({"title": "Deployed"})
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional, TypeVar

from .errors import RyuError
from .transport import Deprecation, RateLimit

T = TypeVar("T")


@dataclass(frozen=True)
class ResponseMeta:
    """Facts about a call.

    ``attempts``, ``deprecation``, ``rate_limit``, ``request_id`` and ``status``
    describe its last HTTP response; ``idempotency_key`` and ``replayed``
    describe its idempotent write, even when reads followed it
    (``box.run()``, ``notify.request_approval()``).
    """

    attempts: int = 0
    deprecation: Optional[Deprecation] = None
    idempotency_key: Optional[str] = None
    rate_limit: Optional[RateLimit] = None
    #: The server answered the call's idempotent write with its stored result.
    replayed: bool = False
    request_id: Optional[str] = None
    status: int = 0

    def to_dict(self) -> dict[str, Any]:
        """The TypeScript ``RyuResponseMeta`` shape (camelCase keys)."""
        return {
            "attempts": self.attempts,
            "deprecation": self.deprecation.to_dict() if self.deprecation else None,
            "idempotencyKey": self.idempotency_key,
            "rateLimit": self.rate_limit.to_dict() if self.rate_limit else None,
            "replayed": self.replayed,
            "requestId": self.request_id,
            "status": self.status,
        }


#: Meta for a successful call that made no HTTP request.
EMPTY_META = ResponseMeta()


class Result(tuple[Optional[T], Optional[RyuError], Optional[ResponseMeta]]):
    """A call's outcome without raising. Exactly one of ``data`` and ``error`` is set.

    ``meta`` is always set on success and may be ``None`` on an error that
    happened before any response (configuration, connection).

    A ``Result`` is an immutable ``(data, error, meta)`` tuple, so unpacking it
    keeps each element's type for type checkers::

        data, error, meta = ryu.notify.publish({"title": "Deployed"})
        # data: NotifyEvent | None, error: RyuError | None, meta: ResponseMeta | None
    """

    __slots__ = ()

    def __new__(cls, data: Optional[T], error: Optional[RyuError], meta: Optional[ResponseMeta]) -> Result[T]:
        return tuple.__new__(cls, (data, error, meta))

    def __getnewargs__(self) -> tuple[Optional[T], Optional[RyuError], Optional[ResponseMeta]]:
        # tuple's own __getnewargs__ would call __new__ with one argument (copy, pickle).
        return (self[0], self[1], self[2])

    @property
    def data(self) -> Optional[T]:
        return self[0]

    @property
    def error(self) -> Optional[RyuError]:
        return self[1]

    @property
    def meta(self) -> Optional[ResponseMeta]:
        return self[2]

    @property
    def ok(self) -> bool:
        return self[1] is None

    def _asdict(self) -> dict[str, Any]:
        """``{"data", "error", "meta"}``: the keyed form serializers (``to_jsonable``) emit."""
        return {"data": self[0], "error": self[1], "meta": self[2]}

    def unwrap(self) -> T:
        """``data``, or raise ``error``."""
        if self[1] is not None:
            raise self[1]
        return self[0]  # type: ignore[return-value]

    def __repr__(self) -> str:
        return f"Result(data={self[0]!r}, error={self[1]!r}, meta={self[2]!r})"
