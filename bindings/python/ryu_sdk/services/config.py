"""Constructor options, the environment variables each service reads, and lazy resolution.

Mirrors ``packages/services/src/config.ts`` (``ENV_VARS``, ``AVAILABILITY``, default hosts,
precedence and the configuration errors), so one set of environment variables
configures both SDKs the same way:

- Managed Agents and Messaging use the control-plane ``ryu_`` key
  (``RYU_API_KEY``), organization (``RYU_ORGANIZATION_ID``) and origin
  (``RYU_API_URL``, default ``https://api.ryuhq.com``);
- hosted Mail uses the control-plane origin with a node gateway key or a
  ``ryu_`` key; self-hosted Mail needs ``RYU_MAIL_URL`` and its bearer;
- Box and Notify default to their hosted origins; Gateway to the local
  ``http://127.0.0.1:7981``; Connect, Passport and Sites have no default;
- the ``ryu_`` key is never sent to another service or origin.

Precedence everywhere: the service's own option, then the top-level option,
then the environment variable, then the default. Empty and whitespace-only
values count as unset.
"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Callable, Optional, Union, cast

# Re-exported: `from ryu_sdk.services.config import SERVICE_TITLES` predates _service_titles.py.
from ._service_titles import SERVICE_TITLES as SERVICE_TITLES  # noqa: PLC0414 - explicit re-export
from .errors import RyuConfigurationError
from .transport import origin_of

#: The documented control-plane host.
CONTROL_PLANE_URL = "https://api.ryuhq.com"
#: Hosted Ryu Box. Keys are provisioned by Ryu.
DEFAULT_BOX_URL = "https://box.ryuhq.com"
#: Hosted Ryu Notify. Keys are provisioned by Ryu.
DEFAULT_NOTIFY_URL = "https://notify.ryuhq.com"
#: Local Ryu Gateway.
DEFAULT_GATEWAY_URL = "http://127.0.0.1:7981"
#: Where each service's SDK page lives.
SDK_DOCS_URL = "https://docs.ryuhq.com/docs/standalone/sdk"

#: Python attribute name -> service id (``RyuError.service``).
NAMESPACE_SERVICES: dict[str, str] = {
    "managed_agents": "managedAgents",
    "messaging": "messaging",
    "mail": "mail",
    "notify": "notify",
    "box": "box",
    "gateway": "gateway",
    "connect": "connect",
    "passport": "passport",
    "sites": "sites",
}

SERVICE_DOC_SLUGS: dict[str, str] = {
    "box": "box",
    "connect": "connect",
    "gateway": "gateway",
    "mail": "mail",
    "managedAgents": "managed-agents",
    "messaging": "messaging",
    "notify": "notify",
    "passport": "passport",
    "sites": "sites",
}


#: How each service can be reached today (lockstep with ``AVAILABILITY`` in config.ts).
AVAILABILITY: dict[str, str] = {
    "managedAgents": "Preview: off until your organization turns on the Managed Agents feature.",
    "mail": ("Available: hosted with a Ryu API key that has Mail scopes or a Ryu node gateway key, or self-hosted."),
    "notify": (
        "Early access: hosted at https://notify.ryuhq.com with keys provisioned by Ryu; "
        "the self-hosted service is not yet published."
    ),
    "box": (
        "Early access: hosted at https://box.ryuhq.com and enabled per organization by Ryu; "
        "the self-hosted service is not yet published."
    ),
    "gateway": "Self-hosted: run Ryu Gateway with your own provider keys.",
    "connect": "Early access: hosted keys are provisioned by Ryu; the self-hosted service is not yet published.",
    "passport": "Early access: hosted keys are provisioned by Ryu; the self-hosted service is not yet published.",
    "sites": (
        "Early access: self-hosted process only, and standalone mode needs a ryu-sites release after 0.4.0, "
        "which is not published yet; there is no Ryu-hosted offer."
    ),
    "messaging": (
        "Early access: hosted on the Ryu control plane; Ryu enables it per organization, and the organization "
        "must also turn on its Ryu Messaging feature (off by default); there is no self-hosted service."
    ),
}


@dataclass(frozen=True)
class EnvVar:
    """One documented environment variable."""

    service: str
    name: str
    role: str
    default: Optional[str]


#: Every environment variable the SDK reads (lockstep with ``ENV_VARS`` in config.ts).
ENV_VARS: tuple[EnvVar, ...] = (
    EnvVar("managedAgents", "RYU_API_URL", "url", CONTROL_PLANE_URL),
    EnvVar("managedAgents", "RYU_API_KEY", "key", None),
    EnvVar("managedAgents", "RYU_ORGANIZATION_ID", "organization", None),
    EnvVar("mail", "RYU_MAIL_URL", "url", None),
    EnvVar("mail", "RYU_MAIL_GATEWAY_KEY", "gateway-key", None),
    EnvVar("mail", "RYU_MAIL_API_KEY", "key", None),
    EnvVar("notify", "RYU_NOTIFY_URL", "url", DEFAULT_NOTIFY_URL),
    EnvVar("notify", "RYU_NOTIFY_API_KEY", "key", None),
    EnvVar("box", "RYU_BOX_URL", "url", DEFAULT_BOX_URL),
    EnvVar("box", "RYU_BOX_API_KEY", "key", None),
    EnvVar("gateway", "RYU_GATEWAY_URL", "url", DEFAULT_GATEWAY_URL),
    EnvVar("gateway", "RYU_GATEWAY_TOKEN", "key", None),
    EnvVar("connect", "RYU_CONNECT_URL", "url", None),
    EnvVar("connect", "RYU_CONNECT_API_KEY", "key", None),
    EnvVar("connect", "RYU_CONNECT_MANAGEMENT_KEY", "management-key", None),
    EnvVar("passport", "RYU_PASSPORT_URL", "url", None),
    EnvVar("passport", "RYU_PASSPORT_API_KEY", "key", None),
    EnvVar("passport", "RYU_PASSPORT_RUNTIME_KEY", "runtime-key", None),
    EnvVar("sites", "RYU_SITES_URL", "url", None),
    EnvVar("sites", "RYU_SITES_API_KEY", "key", None),
    EnvVar("messaging", "RYU_API_URL", "url", CONTROL_PLANE_URL),
    EnvVar("messaging", "RYU_API_KEY", "key", None),
    EnvVar("messaging", "RYU_ORGANIZATION_ID", "organization", None),
)

#: The ``Ryu(...)`` argument that sets each env var.
ENV_OPTION_NAMES: dict[str, str] = {
    "RYU_API_URL": "base_url",
    "RYU_API_KEY": "api_key",
    "RYU_ORGANIZATION_ID": "organization_id",
    "RYU_MAIL_URL": "mail.base_url",
    "RYU_MAIL_GATEWAY_KEY": "mail.gateway_key",
    "RYU_MAIL_API_KEY": "mail.api_key",
    "RYU_NOTIFY_URL": "notify.base_url",
    "RYU_NOTIFY_API_KEY": "notify.api_key",
    "RYU_BOX_URL": "box.base_url",
    "RYU_BOX_API_KEY": "box.api_key",
    "RYU_GATEWAY_URL": "gateway.base_url",
    "RYU_GATEWAY_TOKEN": "gateway.api_key",
    "RYU_CONNECT_URL": "connect.base_url",
    "RYU_CONNECT_API_KEY": "connect.api_key",
    "RYU_CONNECT_MANAGEMENT_KEY": "connect.management_key",
    "RYU_PASSPORT_URL": "passport.base_url",
    "RYU_PASSPORT_API_KEY": "passport.api_key",
    "RYU_PASSPORT_RUNTIME_KEY": "passport.runtime_key",
    "RYU_SITES_URL": "sites.base_url",
    "RYU_SITES_API_KEY": "sites.api_key",
}

EnvSource = Union[Mapping[str, Optional[str]], bool, None]


def service_docs_url(service: str) -> str:
    return f"{SDK_DOCS_URL}/{SERVICE_DOC_SLUGS[service]}"


def env_reader(source: EnvSource) -> Callable[[str], Optional[str]]:
    """A reader over ``source``: ``False`` reads nothing, a mapping reads it, ``None`` reads ``os.environ``."""
    if source is False:
        return lambda _name: None
    values: Mapping[str, Optional[str]] = os.environ if source is None or source is True else source

    def read(name: str) -> Optional[str]:
        try:
            value = values.get(name)
        except Exception:  # noqa: BLE001 - a hostile mapping must not break configuration
            return None
        if not isinstance(value, str):
            return None
        trimmed = value.strip()
        return trimmed or None

    return read


def option_value(value: Any) -> Optional[str]:
    """A constructor option as a value, or ``None`` when unset, empty or whitespace."""
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    return trimmed or None


@dataclass
class ResolvedConfig:
    """One service's connection after options, env and defaults are applied."""

    service: str
    base_url: str
    api_key: Optional[str]
    #: ``bearer``, ``x-api-key`` or ``x-gateway-key``.
    auth: str
    mail_mode: Optional[str] = None
    management_key: Optional[str] = None
    organization_id: Optional[str] = None
    runtime_key: Optional[str] = None
    extra: dict[str, Any] = field(default_factory=dict)


def _required_hint(service: str, missing: list[str]) -> str:
    options = " and ".join(ENV_OPTION_NAMES.get(name, name) for name in missing)
    return f"Set {' and '.join(missing)} (or pass {options} to Ryu()). See {service_docs_url(service)}."


def configuration_error(
    service: str, missing: list[str], message: str, hint: Optional[str] = None
) -> RyuConfigurationError:
    return RyuConfigurationError(
        message,
        service=service,
        code="configuration_error",
        details={"missing": list(missing)},
        docs=service_docs_url(service),
        hint=hint if hint is not None else _required_hint(service, missing),
    )


def _describe_invalid_url(url: str) -> str:
    match = re.match(r"^([a-z][a-z0-9+.-]*):", url, re.IGNORECASE)
    if match is None:
        return f"invalid value, {len(url)} chars"
    return f"invalid {match.group(1)}: value, {len(url)} chars"


#: The hint for a URL value written without its scheme (``127.0.0.1:8021``, ``localhost:8021``).
MISSING_URL_SCHEME_HINT = "Add the scheme, for example http://127.0.0.1:8021 or https://api.example.com."

_SCHEMELESS_AUTHORITY = re.compile(
    r"^(?:\[[^\]\s]*\](?::[0-9]+)?|[^:/\s]+:[0-9]+|[^:/\s]+\.[^:/\s]+|localhost)$", re.IGNORECASE
)


def _invalid_url_hint(url: str) -> Optional[str]:
    """The missing-scheme hint when the part before the first ``/`` looks like a host.

    That is ``host:port``, a dotted host, ``localhost`` or ``[ipv6]``. A value that already names a
    scheme (``http:/x``, ``mailto:x``), a bare word (``nope``) or one with whitespace gets no hint. Never echoes the value. Matches the TypeScript ``invalidUrlHint``.
    """
    if any(char.isspace() for char in url):
        return None
    authority = url.split("/", 1)[0]
    return MISSING_URL_SCHEME_HINT if _SCHEMELESS_AUTHORITY.fullmatch(authority) else None


def _checked_url(service: str, url: str, env_name: str) -> str:
    if origin_of(url) is None:
        raise RyuConfigurationError(
            f"{SERVICE_TITLES[service]}: {env_name} is not an absolute URL ({_describe_invalid_url(url)}).",
            service=service,
            code="invalid_url",
            details={"invalid": [env_name]},
            docs=service_docs_url(service),
            hint=_invalid_url_hint(url),
        )
    return url


class Settings:
    """The options handed to ``Ryu(...)``, with env reads, used to resolve each service lazily."""

    def __init__(
        self,
        *,
        api_key: Optional[str],
        base_url: Optional[str],
        organization_id: Optional[str],
        services: Mapping[str, Mapping[str, Any]],
        env: EnvSource,
    ) -> None:
        self.api_key = api_key
        self.base_url = base_url
        self.organization_id = organization_id
        self.services = {key: dict(value or {}) for key, value in services.items()}
        self.env = env_reader(env)

    def scoped(self, service: str, key: str) -> Optional[str]:
        return option_value(self.services.get(service, {}).get(key))

    def control_plane_url(self) -> str:
        return option_value(self.base_url) or self.env("RYU_API_URL") or CONTROL_PLANE_URL

    def organization(self, scoped: Optional[str] = None) -> Optional[str]:
        return option_value(scoped) or option_value(self.organization_id) or self.env("RYU_ORGANIZATION_ID")

    def control_plane_key(self, scoped: Optional[str] = None) -> Optional[str]:
        return option_value(scoped) or option_value(self.api_key) or self.env("RYU_API_KEY")

    # ── per service ──────────────────────────────────────────────────────────

    def resolve(self, service: str, credentials: str = "required") -> ResolvedConfig:
        """``service``'s config. ``credentials="optional"`` resolves the URL alone when the
        credentials are missing, for a credential-free route (Messaging ``status()``, and hosted
        Mail ``status()`` on the control-plane origin); every other service, and self-hosted
        Mail, resolves as ``"required"``."""
        if service == "messaging":
            return self._resolve_messaging(credentials)
        if service == "mail":
            return self._resolve_mail(credentials)
        resolver = getattr(self, f"_resolve_{service}", None)
        if resolver is not None:
            return cast(ResolvedConfig, resolver())
        if service in _BEARER_SPECS:
            return self._resolve_bearer(service)
        raise RyuConfigurationError(f"Unknown Ryu service {service!r}.", service=service)

    def _resolve_managedAgents(self) -> ResolvedConfig:
        base_url = self.scoped("managedAgents", "base_url") or self.control_plane_url()
        api_key = self.control_plane_key(self.scoped("managedAgents", "api_key"))
        if not api_key:
            raise configuration_error(
                "managedAgents",
                ["RYU_API_KEY"],
                "Ryu Managed Agents needs a ryu_ key: set RYU_API_KEY or pass api_key.",
            )
        return ResolvedConfig(
            service="managedAgents",
            base_url=_checked_url("managedAgents", base_url, "RYU_API_URL"),
            api_key=api_key,
            auth="x-api-key",
            organization_id=self.organization(self.scoped("managedAgents", "organization_id")),
        )

    def _resolve_messaging(self, credentials: str = "required") -> ResolvedConfig:
        base_url = self.scoped("messaging", "base_url") or self.control_plane_url()
        api_key = self.control_plane_key(self.scoped("messaging", "api_key"))
        organization_id = self.organization(self.scoped("messaging", "organization_id"))
        missing = []
        if not api_key:
            missing.append("RYU_API_KEY")
        if not organization_id:
            missing.append("RYU_ORGANIZATION_ID")
        complete = not missing
        if not complete and credentials != "optional":
            raise configuration_error(
                "messaging",
                missing,
                f"Ryu Messaging needs a ryu_ key and the organization it acts for: set {' and '.join(missing)}.",
            )
        # A credential-free call without the full pair sends neither.
        return ResolvedConfig(
            service="messaging",
            base_url=_checked_url("messaging", base_url, "RYU_API_URL"),
            api_key=api_key if complete else None,
            auth="x-api-key",
            organization_id=organization_id if complete else None,
        )

    def _resolve_mail(self, credentials: str = "required") -> ResolvedConfig:
        url = self.scoped("mail", "base_url") or self.env("RYU_MAIL_URL")
        control_plane = self.control_plane_url()
        url_is_control_plane = url is not None and origin_of(url) == origin_of(control_plane)
        candidates = [
            ("gateway", self.scoped("mail", "gateway_key")),
            ("self-hosted", self.scoped("mail", "api_key")),
            ("api-key", option_value(self.api_key)),
            ("gateway", self.env("RYU_MAIL_GATEWAY_KEY")),
            ("self-hosted", self.env("RYU_MAIL_API_KEY")),
            ("api-key", self.env("RYU_API_KEY")),
        ]
        candidates = [(kind, key) for kind, key in candidates if key]
        has_self_hosted_key = any(kind == "self-hosted" for kind, _ in candidates)

        def acceptable(kind: str) -> bool:
            if kind == "gateway":
                return not (url is not None and not url_is_control_plane and has_self_hosted_key)
            if kind == "self-hosted":
                return True
            return url is None or url_is_control_plane

        chosen = next(((kind, key) for kind, key in candidates if acceptable(kind)), None)
        if chosen is not None and chosen[0] == "self-hosted":
            if url is None:
                raise configuration_error(
                    "mail",
                    ["RYU_MAIL_URL"],
                    "Self-hosted Ryu Mail has no default URL: set RYU_MAIL_URL (or mail.base_url) to your Mail server.",
                )
            return ResolvedConfig(
                service="mail",
                base_url=_checked_url("mail", url, "RYU_MAIL_URL"),
                api_key=chosen[1],
                auth="bearer",
                mail_mode="self-hosted",
            )
        if chosen is not None and chosen[0] == "gateway":
            return ResolvedConfig(
                service="mail",
                base_url=_checked_url("mail", url or control_plane, "RYU_MAIL_URL"),
                api_key=chosen[1],
                auth="x-gateway-key",
                mail_mode="hosted",
            )
        if chosen is not None:
            base = (
                _checked_url("mail", control_plane, "RYU_API_URL")
                if url is None
                else _checked_url("mail", url, "RYU_MAIL_URL")
            )
            return ResolvedConfig(
                service="mail",
                base_url=base,
                api_key=chosen[1],
                auth="x-api-key",
                mail_mode="hosted",
                organization_id=self.organization(),
            )
        if credentials == "optional" and (url is None or url_is_control_plane):
            # A credential-free call (hosted ``GET /api/mail/status``) with no Mail key: the
            # control-plane origin, sending no key and no organization. Self-hosted Mail guards
            # its status route, so it still needs a bearer.
            base = (
                _checked_url("mail", control_plane, "RYU_API_URL")
                if url is None
                else _checked_url("mail", url, "RYU_MAIL_URL")
            )
            return ResolvedConfig(service="mail", base_url=base, api_key=None, auth="x-api-key", mail_mode="hosted")
        if url_is_control_plane:
            # RYU_MAIL_URL names the control-plane origin: that is hosted Mail, which takes the
            # ryu_ key or a node gateway key, never a self-hosted bearer.
            raise configuration_error(
                "mail",
                ["RYU_API_KEY", "RYU_MAIL_GATEWAY_KEY"],
                "Hosted Ryu Mail needs a key: RYU_API_KEY (a ryu_ key with Mail scopes) or RYU_MAIL_GATEWAY_KEY "
                "(a node gateway key). RYU_MAIL_URL is the control-plane origin, so RYU_MAIL_API_KEY does not apply.",
                "Set RYU_API_KEY (or pass api_key) to a ryu_ key with Mail scopes, or RYU_MAIL_GATEWAY_KEY "
                f"(or mail.gateway_key) for a node gateway key. See {service_docs_url('mail')}.",
            )
        if url is not None:
            raise configuration_error(
                "mail",
                ["RYU_MAIL_API_KEY"],
                "Self-hosted Ryu Mail needs its bearer token: set RYU_MAIL_API_KEY (or mail.api_key). "
                "The ryu_ key is sent only to hosted Mail on the control-plane origin.",
            )
        raise configuration_error(
            "mail",
            ["RYU_API_KEY", "RYU_MAIL_GATEWAY_KEY", "RYU_MAIL_API_KEY"],
            "Ryu Mail needs a key: RYU_API_KEY (a ryu_ key with Mail scopes) or RYU_MAIL_GATEWAY_KEY (a node "
            "gateway key) for hosted Mail, or RYU_MAIL_URL and RYU_MAIL_API_KEY for a self-hosted server.",
            "Set RYU_API_KEY (or pass api_key) to a ryu_ key with Mail scopes for hosted Mail, or "
            "RYU_MAIL_GATEWAY_KEY (or mail.gateway_key) for a node gateway key, or RYU_MAIL_URL and "
            "RYU_MAIL_API_KEY (or mail.base_url and mail.api_key) for a self-hosted server. "
            f"See {service_docs_url('mail')}.",
        )

    def _resolve_connect(self) -> ResolvedConfig:
        config = self._resolve_bearer("connect")
        config.management_key = self.scoped("connect", "management_key") or self.env("RYU_CONNECT_MANAGEMENT_KEY")
        return config

    def _resolve_passport(self) -> ResolvedConfig:
        runtime_key = self.scoped("passport", "runtime_key") or self.env("RYU_PASSPORT_RUNTIME_KEY")
        config = self._resolve_bearer("passport", key_optional=runtime_key is not None)
        config.runtime_key = runtime_key
        return config

    def _resolve_bearer(self, service: str, key_optional: bool = False) -> ResolvedConfig:
        url_env, key_env, default_url, spec_optional = _BEARER_SPECS[service]
        url = self.scoped(service, "base_url") or self.env(url_env) or default_url
        api_key = self.scoped(service, "api_key") or self.env(key_env)
        missing = []
        if url is None:
            missing.append(url_env)
        if api_key is None and not (spec_optional or key_optional):
            missing.append(key_env)
        if missing:
            suffix = " It has no default URL." if url is None else ""
            raise configuration_error(
                service,
                missing,
                f"{SERVICE_TITLES[service]} is not configured: set {' and '.join(missing)}.{suffix}",
            )
        assert url is not None
        return ResolvedConfig(
            service=service, base_url=_checked_url(service, url, url_env), api_key=api_key, auth="bearer"
        )


#: service -> (url env, key env, default url, key optional)
_BEARER_SPECS: dict[str, tuple[str, str, Optional[str], bool]] = {
    "notify": ("RYU_NOTIFY_URL", "RYU_NOTIFY_API_KEY", DEFAULT_NOTIFY_URL, False),
    "box": ("RYU_BOX_URL", "RYU_BOX_API_KEY", DEFAULT_BOX_URL, False),
    "gateway": ("RYU_GATEWAY_URL", "RYU_GATEWAY_TOKEN", DEFAULT_GATEWAY_URL, True),
    "connect": ("RYU_CONNECT_URL", "RYU_CONNECT_API_KEY", None, False),
    "passport": ("RYU_PASSPORT_URL", "RYU_PASSPORT_API_KEY", None, False),
    "sites": ("RYU_SITES_URL", "RYU_SITES_API_KEY", None, False),
}


# ── Hints ─────────────────────────────────────────────────────────────────────


def _env_var_for(service: str, role: str) -> Optional[str]:
    return next((row.name for row in ENV_VARS if row.service == service and row.role == role), None)


def _credential_roles(config: ResolvedConfig) -> list[str]:
    if config.service in ("managedAgents", "messaging"):
        return ["key", "organization"]
    if config.service == "mail":
        if config.auth == "x-api-key":
            return ["key", "organization"]
        return ["key" if config.mail_mode == "self-hosted" else "gateway-key"]
    if config.service == "passport":
        return ["runtime-key"] if config.api_key is None else ["key", "runtime-key"]
    if config.service == "connect":
        return ["key"] if config.management_key is None else ["key", "management-key"]
    return ["key"]


def credential_env_vars(config: ResolvedConfig) -> list[str]:
    """The env vars holding the credentials a resolved service sends."""
    owner = "managedAgents" if config.service == "mail" and config.auth == "x-api-key" else config.service
    names = []
    for role in _credential_roles(config):
        name = _env_var_for(owner, role)
        if name is not None:
            names.append(name)
    return names


def url_env_var(service: str) -> str:
    return _env_var_for(service, "url") or "RYU_API_URL"


def _check_sentence(names: list[str]) -> str:
    options = " and ".join(ENV_OPTION_NAMES.get(name, name) for name in names)
    return f"Check {' and '.join(names)} (or {options})."


def transport_failure_hint(service: str, code: str, url: Optional[str]) -> Optional[str]:
    """The hint for a request that got no response (``connection_error``) or none in time (``timeout``)."""
    if code not in ("connection_error", "timeout"):
        return None
    title = SERVICE_TITLES[service]
    target = origin_of(url or "") or "the configured URL"
    if code == "timeout":
        what = f"{title} at {target} did not respond in time (raise timeout if the call is slow)."
    else:
        what = f"Could not reach {title} at {target}."
    return f"{what} {_check_sentence([url_env_var(service)])}"


#: Services whose 403 is not about the key's scopes. Matches ``NO_DEFAULT_403_HINT`` in TypeScript.
_NO_DEFAULT_403_HINT = frozenset({"connect", "managedAgents"})


def default_error_hint(status: int, code: str, url: Optional[str], config: ResolvedConfig) -> Optional[str]:
    """A default hint for an error that names none: the key env vars after a 401/403, the URL after a transport failure."""
    title = SERVICE_TITLES[config.service]
    key_envs = credential_env_vars(config)
    sent_no_key = config.api_key is None and "key" in _credential_roles(config)
    if status in (401, 403) and sent_no_key:
        options = " and ".join(ENV_OPTION_NAMES.get(name, name) for name in key_envs)
        return f"{title} requires a credential and none was sent. Set {' and '.join(key_envs)} (or {options})."
    if status == 401 and key_envs:
        return f"{title} did not accept the credentials. {_check_sentence(key_envs)}"
    # Managed Agents' ``ryu_`` key is account-wide and a Connect runtime key carries no scopes (its
    # 403s are tenant grants, which ``known_server_hint`` explains), so neither gets this hint.
    if status == 403 and config.service not in _NO_DEFAULT_403_HINT and key_envs:
        return (
            f"{title} accepted the key but it may not do this; check its scopes and tenant. {_check_sentence(key_envs)}"
        )
    if status == 0:
        service_origin = origin_of(config.base_url)
        target = url if service_origin is not None and origin_of(url or "") == service_origin else config.base_url
        return transport_failure_hint(config.service, code, target)
    return None
