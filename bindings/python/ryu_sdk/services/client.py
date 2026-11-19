"""``Ryu`` and ``AsyncRyu``: one entry point for every Ryu standalone service.

Mirrors ``new Ryu()`` from ``@ryuhq/services``::

    from ryu_sdk.services import Ryu

    ryu = Ryu()  # reads RYU_* environment variables lazily, per service
    event = ryu.notify.publish({"title": "Deploy finished", "level": "success"})

    ryu = Ryu(result="object")  # every call returns Result(data, error, meta)
    data, error, meta = ryu.notify.publish({"title": "Deploy finished"})

Namespaces: ``managed_agents``, ``messaging``, ``mail``, ``notify``, ``box``,
``gateway``, ``connect``, ``passport``, ``sites``; plus ``safe`` (object-mode
view of every namespace), ``webhooks`` (verifiers) and ``is_configured()``.
Nothing is read or sent until a namespace is first called, and a missing
setting fails that call with a ``RyuConfigurationError`` naming the env var.
``AsyncRyu`` has the same surface with coroutine methods and async iterators.

Static types: ``Ryu()`` is a ``Ryu[Literal["throw"]]`` and ``Ryu(result="object")`` a
``Ryu[Literal["object"]]``; each namespace attribute then reads as the matching view
from :mod:`ryu_sdk.services.views` (``NotifyAPI``, ``NotifyResultAPI``, ``AsyncNotifyAPI``,
``AsyncNotifyResultAPI``), whose main methods return the shapes in
:mod:`ryu_sdk.services.shapes` (or ``Result[...]``, or ``Awaitable[...]``).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, Callable, Generic, Literal, Optional, TypedDict, TypeVar, overload

from ._runtime import Binding, ClientCore
from .box import BoxNamespace
from .config import ENV_VARS, EnvSource, Settings
from .connect import ConnectNamespace, decorate_connect_error
from .errors import RyuConfigurationError, RyuError
from .gateway import GatewayNamespace, refine_gateway_error
from .mail import CREDENTIAL_FREE_METHODS as MAIL_CREDENTIAL_FREE_METHODS
from .mail import MailNamespace, mail_error_code
from .managed_agents import (
    ManagedAgentsNamespace,
    decorate_managed_agents_error,
    managed_agents_response_error,
)
from .messaging import CREDENTIAL_FREE_METHODS as MESSAGING_CREDENTIAL_FREE_METHODS
from .messaging import MessagingNamespace, decorate_messaging_error
from .notify import NotifyNamespace
from .passport import PassportNamespace, passport_capability_probe
from .sites import SitesNamespace, decorate_sites_error, refine_sites_error
from .webhooks import Webhooks

if TYPE_CHECKING:
    from typing_extensions import Unpack

    from .views import (
        AsyncBoxAPI,
        AsyncBoxResultAPI,
        AsyncConnectAPI,
        AsyncConnectResultAPI,
        AsyncGatewayAPI,
        AsyncGatewayResultAPI,
        AsyncMailAPI,
        AsyncMailResultAPI,
        AsyncManagedAgentsAPI,
        AsyncManagedAgentsResultAPI,
        AsyncMessagingAPI,
        AsyncMessagingResultAPI,
        AsyncNotifyAPI,
        AsyncNotifyResultAPI,
        AsyncPassportAPI,
        AsyncPassportResultAPI,
        AsyncSafeView,
        AsyncSitesAPI,
        AsyncSitesResultAPI,
        BoxAPI,
        BoxResultAPI,
        ConnectAPI,
        ConnectResultAPI,
        GatewayAPI,
        GatewayResultAPI,
        MailAPI,
        MailResultAPI,
        ManagedAgentsAPI,
        ManagedAgentsResultAPI,
        MessagingAPI,
        MessagingResultAPI,
        NotifyAPI,
        NotifyResultAPI,
        PassportAPI,
        PassportResultAPI,
        SafeView,
        SitesAPI,
        SitesResultAPI,
    )


class RyuOptions(TypedDict, total=False):
    """Every ``Ryu``/``AsyncRyu`` constructor option except ``result``, for type checkers
    (``**options: Unpack[RyuOptions]``)."""

    api_key: Optional[str]
    base_url: Optional[str]
    organization_id: Optional[str]
    env: EnvSource
    managed_agents: Optional[Mapping[str, Any]]
    messaging: Optional[Mapping[str, Any]]
    mail: Optional[Mapping[str, Any]]
    notify: Optional[Mapping[str, Any]]
    box: Optional[Mapping[str, Any]]
    gateway: Optional[Mapping[str, Any]]
    connect: Optional[Mapping[str, Any]]
    passport: Optional[Mapping[str, Any]]
    sites: Optional[Mapping[str, Any]]
    timeout: Optional[float]
    max_retries: int
    max_retry_delay: float
    auto_idempotency: bool
    hooks: Optional[Mapping[str, Callable[[dict[str, Any]], None]]]
    user_agent: Any
    transport: Any
    http_client: Any


#: ``"throw"`` raises RyuError; ``"object"`` returns ``Result(data, error, meta)`` from every call.
ResultMode = Literal["throw", "object"]

DEFAULT_MAX_RETRIES = 2
DEFAULT_MAX_RETRY_DELAY = 30.0
DEFAULT_TIMEOUT = 60.0

#: Python attribute -> (service id, namespace class).
NAMESPACES: dict[str, Any] = {
    "managed_agents": ("managedAgents", ManagedAgentsNamespace),
    "messaging": ("messaging", MessagingNamespace),
    "mail": ("mail", MailNamespace),
    "notify": ("notify", NotifyNamespace),
    "box": ("box", BoxNamespace),
    "gateway": ("gateway", GatewayNamespace),
    "connect": ("connect", ConnectNamespace),
    "passport": ("passport", PassportNamespace),
    "sites": ("sites", SitesNamespace),
}

_SERVICE_OPTION_KEYS = {
    "managed_agents": ("api_key", "base_url", "organization_id"),
    "messaging": ("api_key", "base_url", "organization_id"),
    "mail": ("api_key", "base_url", "gateway_key"),
    "notify": ("api_key", "base_url"),
    "box": ("api_key", "base_url"),
    "gateway": ("api_key", "base_url"),
    "connect": ("api_key", "base_url", "management_key"),
    "passport": ("api_key", "base_url", "runtime_key"),
    "sites": ("api_key", "base_url"),
}


if TYPE_CHECKING:
    # PEP 696 default: a bare ``Ryu``/``AsyncRyu`` annotation means the default ``result="throw"``
    # client (not ``Ryu[Any]``, whose namespaces would all read as ``Any``). typing_extensions is
    # a type-checking-only import; the runtime TypeVar on Python 3.9 takes no ``default``.
    from typing_extensions import TypeVar as _DefaultedTypeVar

    _Mode = _DefaultedTypeVar("_Mode", bound=str, default=Literal["throw"])
else:
    _Mode = TypeVar("_Mode", bound=str)
_Sync = TypeVar("_Sync")
_SyncResult = TypeVar("_SyncResult")
_Async = TypeVar("_Async")
_AsyncResult = TypeVar("_AsyncResult")
# PYI019 would have `__enter__`/`__aenter__` return `typing_extensions.Self`, but `Self` exists in
# `typing` only from 3.11 and typing_extensions is not a runtime dependency, so a TYPE_CHECKING-only
# `Self` makes `typing.get_type_hints(Ryu.__enter__)` raise NameError on the supported 3.9/3.10. A
# module-level TypeVar keeps the annotations evaluable at runtime (pinned in test_services_namespaces).
_Self = TypeVar("_Self")


class _NamespaceAttribute(Generic[_Sync, _SyncResult, _Async, _AsyncResult]):
    """``ryu.<namespace>``: the namespace in the instance's result mode.

    The type parameters are its four views; a type checker picks one from the
    client class (``Ryu``/``AsyncRyu``) and its ``result`` mode.
    """

    def __init__(self, attribute: str) -> None:
        self._attribute = attribute

    @overload
    def __get__(self, obj: None, owner: Any) -> _NamespaceAttribute[_Sync, _SyncResult, _Async, _AsyncResult]: ...
    @overload
    def __get__(self, obj: Ryu[Literal["throw"]], owner: Any) -> _Sync: ...
    @overload
    def __get__(self, obj: Ryu[Literal["object"]], owner: Any) -> _SyncResult: ...
    @overload
    def __get__(self, obj: AsyncRyu[Literal["throw"]], owner: Any) -> _Async: ...
    @overload
    def __get__(self, obj: AsyncRyu[Literal["object"]], owner: Any) -> _AsyncResult: ...
    @overload
    def __get__(self, obj: _RyuBase, owner: Any) -> Any: ...
    def __get__(self, obj: Any, owner: Any) -> Any:
        if obj is None:
            return self
        return obj._namespace(self._attribute, obj.result)


class _SafeView:
    """``ryu.safe.<namespace>``: the namespace in object mode, whatever the instance mode."""

    def __init__(self, owner: _RyuBase) -> None:
        self._owner = owner

    def __getattr__(self, name: str) -> Any:
        if name not in NAMESPACES:
            raise AttributeError(f"ryu.safe has no namespace {name!r}")
        return self._owner._namespace(name, "object")


class _RyuBase:
    _is_async = False

    def __init__(
        self,
        *,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        organization_id: Optional[str] = None,
        result: ResultMode = "throw",
        env: EnvSource = None,
        managed_agents: Optional[Mapping[str, Any]] = None,
        messaging: Optional[Mapping[str, Any]] = None,
        mail: Optional[Mapping[str, Any]] = None,
        notify: Optional[Mapping[str, Any]] = None,
        box: Optional[Mapping[str, Any]] = None,
        gateway: Optional[Mapping[str, Any]] = None,
        connect: Optional[Mapping[str, Any]] = None,
        passport: Optional[Mapping[str, Any]] = None,
        sites: Optional[Mapping[str, Any]] = None,
        timeout: Optional[float] = DEFAULT_TIMEOUT,
        max_retries: int = DEFAULT_MAX_RETRIES,
        max_retry_delay: float = DEFAULT_MAX_RETRY_DELAY,
        auto_idempotency: bool = True,
        hooks: Optional[Mapping[str, Callable[[dict[str, Any]], None]]] = None,
        user_agent: Any = None,
        transport: Any = None,
        http_client: Any = None,
    ) -> None:
        if result not in ("throw", "object"):
            raise RyuConfigurationError(
                f"Ryu: result must be 'throw' or 'object' (got {result!r}).",
                service="managedAgents",
                code="invalid_option",
            )
        services = {
            "managedAgents": managed_agents,
            "messaging": messaging,
            "mail": mail,
            "notify": notify,
            "box": box,
            "gateway": gateway,
            "connect": connect,
            "passport": passport,
            "sites": sites,
        }
        for attribute, (service, _cls) in NAMESPACES.items():
            unknown = sorted(set(services[service] or {}) - set(_SERVICE_OPTION_KEYS[attribute]))
            if unknown:
                raise RyuConfigurationError(
                    f"Ryu: unknown {attribute} option(s) {', '.join(unknown)}; expected "
                    f"{', '.join(_SERVICE_OPTION_KEYS[attribute])}.",
                    service=service,
                    code="invalid_option",
                )
        self.result: ResultMode = result
        self._core = ClientCore(
            Settings(
                api_key=api_key,
                base_url=base_url,
                organization_id=organization_id,
                services={key: value or {} for key, value in services.items()},
                env=env,
            ),
            is_async=self._is_async,
            transport=transport,
            http_client=http_client,
            timeout=timeout,
            max_retries=max_retries,
            max_retry_delay=max_retry_delay,
            auto_idempotency=auto_idempotency,
            hooks=hooks or {},
            user_agent=user_agent,
        )
        self._core.decorators.update(
            {
                "managedAgents": decorate_managed_agents_error,
                "messaging": decorate_messaging_error,
                "connect": decorate_connect_error,
                "sites": decorate_sites_error,
            }
        )
        self._core.refiners["mail"] = mail_error_code
        self._core.error_refiners["gateway"] = refine_gateway_error
        self._core.error_refiners["sites"] = refine_sites_error
        self._core.capability_probes["passport"] = passport_capability_probe
        self._core.credential_free["messaging"] = MESSAGING_CREDENTIAL_FREE_METHODS
        self._core.credential_free["mail"] = MAIL_CREDENTIAL_FREE_METHODS
        self._core.response_errors["managedAgents"] = managed_agents_response_error
        self._namespaces: dict[Any, Any] = {}
        self.safe: Any = _SafeView(self)
        self.webhooks = Webhooks(object_mode=result == "object")

    def _namespace(self, attribute: str, mode: str) -> Any:
        cache_key = (attribute, mode)
        namespace = self._namespaces.get(cache_key)
        if namespace is None:
            service, cls = NAMESPACES[attribute]
            namespace = cls(Binding(self._core, service, mode))
            self._namespaces[cache_key] = namespace
        return namespace

    managed_agents: _NamespaceAttribute[
        ManagedAgentsAPI, ManagedAgentsResultAPI, AsyncManagedAgentsAPI, AsyncManagedAgentsResultAPI
    ] = _NamespaceAttribute("managed_agents")
    messaging: _NamespaceAttribute[MessagingAPI, MessagingResultAPI, AsyncMessagingAPI, AsyncMessagingResultAPI] = (
        _NamespaceAttribute("messaging")
    )
    mail: _NamespaceAttribute[MailAPI, MailResultAPI, AsyncMailAPI, AsyncMailResultAPI] = _NamespaceAttribute("mail")
    notify: _NamespaceAttribute[NotifyAPI, NotifyResultAPI, AsyncNotifyAPI, AsyncNotifyResultAPI] = _NamespaceAttribute(
        "notify"
    )
    box: _NamespaceAttribute[BoxAPI, BoxResultAPI, AsyncBoxAPI, AsyncBoxResultAPI] = _NamespaceAttribute("box")
    gateway: _NamespaceAttribute[GatewayAPI, GatewayResultAPI, AsyncGatewayAPI, AsyncGatewayResultAPI] = (
        _NamespaceAttribute("gateway")
    )
    connect: _NamespaceAttribute[ConnectAPI, ConnectResultAPI, AsyncConnectAPI, AsyncConnectResultAPI] = (
        _NamespaceAttribute("connect")
    )
    passport: _NamespaceAttribute[PassportAPI, PassportResultAPI, AsyncPassportAPI, AsyncPassportResultAPI] = (
        _NamespaceAttribute("passport")
    )
    sites: _NamespaceAttribute[SitesAPI, SitesResultAPI, AsyncSitesAPI, AsyncSitesResultAPI] = _NamespaceAttribute(
        "sites"
    )

    @staticmethod
    def _service_id(service: str, method: str) -> str:
        """The service id of ``service`` (a namespace name or a service id); an unknown name raises
        ``RyuConfigurationError`` (``invalid_option``) rather than reading as unconfigured."""
        service_ids = {service_id for service_id, _cls in NAMESPACES.values()}
        if service not in NAMESPACES and service not in service_ids:
            raise RyuConfigurationError(
                f"Ryu: {method}() got an unknown service {service!r}; expected one of "
                f"{', '.join(sorted(NAMESPACES))} (or a service id: {', '.join(sorted(service_ids))}).",
                service="managedAgents",
                code="invalid_option",
            )
        return NAMESPACES[service][0] if service in NAMESPACES else service

    def is_configured(self, service: str) -> bool:
        """Whether ``service`` (``"notify"``, ``"managed_agents"``, or a service id) resolves *and* was
        set explicitly, by an env var or option, not by a built-in default alone (Gateway's local URL).
        Resolves settings only; sends nothing. An unknown name (a typo such as ``"managed-agents"``)
        raises ``RyuConfigurationError`` (``invalid_option``) rather than reading as unconfigured."""
        service_id = self._service_id(service, "is_configured")
        try:
            resolved = self._core.engine(service_id).config
        except RyuError:
            return False
        if service_id == "mail" and resolved.auth == "x-api-key":
            return True
        settings = self._core.settings
        if any(row.service == service_id and settings.env(row.name) is not None for row in ENV_VARS):
            return True
        if any(value is not None for value in settings.services.get(service_id, {}).values()):
            return True
        return service_id in ("managedAgents", "messaging") and settings.api_key is not None

    def can_call_without_credentials(self, service: str) -> bool:
        """Whether ``service`` has methods whose route needs no credential (Messaging ``status()``,
        and hosted Mail ``status()`` on the control-plane origin) and this client can call them: the
        service's URL resolves even though its credentials may not, and those calls then send no
        key. ``False`` for every other service, for self-hosted Mail (whose status route needs its
        bearer) and for an invalid URL. Resolves settings only; sends nothing. Mirrors the
        TypeScript ``ryu.canCallWithoutCredentials``."""
        service_id = self._service_id(service, "can_call_without_credentials")
        if not self._core.credential_free.get(service_id):
            return False
        try:
            self._core.engine(service_id, credentials="optional")
        except RyuError:
            return False
        return True


class Ryu(_RyuBase, Generic[_Mode]):
    """Synchronous client for every Ryu standalone service.

    Every argument is optional; environment variables fill the rest:

    - ``api_key`` / ``base_url`` / ``organization_id``: the control-plane ``ryu_``
      key (``RYU_API_KEY``), origin (``RYU_API_URL``) and organization
      (``RYU_ORGANIZATION_ID``) for Managed Agents, Messaging and hosted Mail;
    - per-service dicts (``mail={"gateway_key": ...}``, ``notify={"api_key": ...}``,
      ``passport={"runtime_key": ...}``...) win over the top-level values;
    - ``result``: ``"throw"`` (default) raises RyuError; ``"object"`` returns
      ``Result(data, error, meta)`` from every call;
    - ``env``: a mapping to read instead of ``os.environ``, or ``False`` for none;
    - ``timeout`` (seconds per attempt until response headers arrive, default 60;
      ``None`` or ``0`` disables it), ``max_retries`` (default 2),
      ``max_retry_delay`` (the longest server-requested wait honoured, default 30 s),
      ``auto_idempotency`` (default True);
    - ``hooks``: ``{"on_request", "on_response", "on_retry", "on_deprecation"}``
      callables receiving an event dict (a raising hook is ignored);
    - ``user_agent``: appended to the SDK User-Agent, or ``False`` to send none;
    - ``transport`` (an ``httpx.BaseTransport``) or ``http_client`` (an
      ``httpx.Client``; redirects are never followed either way).
    """

    if TYPE_CHECKING:
        #: Every namespace in object mode, whatever ``result`` is.
        safe: SafeView

        @overload
        def __init__(
            self: Ryu[Literal["throw"]], *, result: Literal["throw"] = ..., **options: Unpack[RyuOptions]
        ) -> None: ...
        @overload
        def __init__(
            self: Ryu[Literal["object"]], *, result: Literal["object"], **options: Unpack[RyuOptions]
        ) -> None: ...
        def __init__(self, *, result: ResultMode = "throw", **options: Any) -> None: ...

    def close(self) -> None:
        """Closes the HTTP client the instance created (not one you passed)."""
        self._core.close_sync()

    def __enter__(self: _Self) -> _Self:  # noqa: PYI019 - see `_Self` above
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


class AsyncRyu(_RyuBase, Generic[_Mode]):
    """``Ryu`` with coroutine methods and async iterators; pass an ``httpx.AsyncBaseTransport``.

    For type checkers its namespace methods return ``Awaitable[...]``.
    """

    _is_async = True

    if TYPE_CHECKING:
        #: Every namespace in object mode, whatever ``result`` is.
        safe: AsyncSafeView

        @overload
        def __init__(
            self: AsyncRyu[Literal["throw"]], *, result: Literal["throw"] = ..., **options: Unpack[RyuOptions]
        ) -> None: ...
        @overload
        def __init__(
            self: AsyncRyu[Literal["object"]], *, result: Literal["object"], **options: Unpack[RyuOptions]
        ) -> None: ...
        def __init__(self, *, result: ResultMode = "throw", **options: Any) -> None: ...

    async def aclose(self) -> None:
        await self._core.close_async()

    async def __aenter__(self: _Self) -> _Self:  # noqa: PYI019 - see `_Self` above
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.aclose()


#: The type of ``Ryu(result="object")``: annotate a helper that takes an object-mode client with
#: it (``def helper(ryu: ObjectRyu)``), where a bare ``Ryu`` means the default throw mode.
ObjectRyu = Ryu[Literal["object"]]
#: The type of ``AsyncRyu(result="object")``; see ``ObjectRyu``.
AsyncObjectRyu = AsyncRyu[Literal["object"]]
