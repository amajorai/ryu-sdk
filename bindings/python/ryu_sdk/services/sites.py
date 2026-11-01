"""``ryu.sites``: the Ryu Sites management listener (self-hosted).

``status()``, ``projects.list/create/get/delete``,
``projects.update_settings/make_public``, ``versions.create``, ``deploy(...)``
(save HTML as a version and deploy it, or deploy an existing version) and
``unpublish(...)``. Changes are guarded by ``expectedRevision``;
``deploy``, ``unpublish`` and ``update_settings`` read the current revision when
you pass none, and an error names the failed ``step`` in ``details``.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Optional

from ._base import Namespace, Resource, compact, segment
from ._runtime import Request
from .errors import (
    RyuError,
    RyuInvalidRequestError,
    RyuResponseValidationError,
    copy_ryu_error,
    message_without_hint,
)

PREFIX = "/api/sites"


#: What the Sites *visitor* listener answers for a host with no deployed Site; the management
#: listener never sends it, so a management call that gets it went to the wrong port.
_VISITOR_NOT_DEPLOYED = "Site is not deployed"
VISITOR_LISTENER_HINT = (
    "RYU_SITES_URL looks like the Sites visitor listener (RYU_SITES_VISITOR_PORT, 8022 by default), which serves "
    "deployed pages. Point it at the management listener (RYU_SITES_PORT, 8021 by default) instead."
)


#: The hint the settings route's refusal of the public audience gets (``SITES_PUBLIC_DISABLED_HINT``).
PUBLIC_DISABLED_HINT = (
    "Public Sites are off on this Sites process. The operator allows them with RYU_SITES_PUBLIC=1 or the "
    "runtime config's publicEnabled (ryu.sites.status() reports publicEnabled); until then choose private, "
    "invited or workspace."
)
#: The hint the same refusal gets when the change named no audience (``SITES_STORED_PUBLIC_HINT``).
STORED_PUBLIC_HINT = (
    "This Site is still saved with the public audience, but public Sites are now off on this Sites process, "
    "so the settings route refuses every change to it. Send an audience too (private, invited or workspace) "
    "with your change, or ask the operator to allow public Sites again."
)
_PUBLIC_DISABLED = "Public publishing is disabled by the operator"

#: Settings with their own routes: the settings route refuses any change to them.
_SEPARATELY_MANAGED = ("database", "extensions")
#: The settings the route takes as ``null`` (to clear them); every other setting refuses ``None``.
_NULLABLE_SETTINGS = frozenset({"spaceId", "workspaceId"})


def _is_public_disabled(error: RyuError) -> bool:
    return (
        error.service == "sites"
        and error.status == 403
        and error.code == "policy_denied"
        and message_without_hint(error).strip() == _PUBLIC_DISABLED
    )


def refine_sites_error(error: RyuError, _body: Any = None) -> RyuError:
    """Sites answers ``503 unavailable`` only for configuration states (identity, Space retrieval, a Ryu model
    or agent execution not connected), which a retry cannot change, so it is not retried
    (``refineSitesError``)."""
    if error.status == 503 and error.code == "unavailable" and error.retryable:
        return copy_ryu_error(error, retryable=False)
    return error


def decorate_sites_error(error: RyuError) -> RyuError:
    """Adds :data:`VISITOR_LISTENER_HINT` to the visitor listener's 404 on a management call, and
    :data:`PUBLIC_DISABLED_HINT` to the settings route's ``403 policy_denied`` for the public audience."""
    if error.hint is None and _is_public_disabled(error):
        return copy_ryu_error(error, hint=PUBLIC_DISABLED_HINT)
    if (
        error.service != "sites"
        or error.hint is not None
        or error.status != 404
        or error.message.strip() != _VISITOR_NOT_DEPLOYED
    ):
        return error
    return copy_ryu_error(error, hint=VISITOR_LISTENER_HINT)


def _project(project_id: str, action: str = "") -> str:
    path = f"{PREFIX}/projects/{segment('sites', project_id, 'the project id')}"
    return f"{path}/{action}" if action else path


def site_url(slug: str, status: Mapping[str, Any]) -> str:
    """The URL a Site answers at, built the way the Sites service builds it."""
    if status.get("baseDomain") == "localhost":
        return f"http://{slug}.localhost:{status.get('visitorPort')}/"
    return f"https://{slug}.{status.get('baseDomain')}/"


def _step(step: str, context: dict[str, Any], request: Request) -> Any:
    """Generator: runs ``request``; a service error gains ``details.step`` and the context."""
    try:
        return (yield request)
    except RyuError as error:
        if error.status == 0:
            raise
        existing = error.details if isinstance(error.details, dict) else {}
        raise copy_ryu_error(error, details={**existing, **context, "step": step}) from error


class Projects(Resource):
    def list(self, *, scope: Optional[str] = None) -> Any:
        return self._b.call(lambda _c: Request("GET", f"{PREFIX}/projects", params=compact({"scope": scope})))

    def create(self, input: Mapping[str, Any]) -> Any:
        body = compact({key: input.get(key) for key in ("name", "prompt", "slug", "template")})
        return self._b.call(lambda _c: Request("POST", f"{PREFIX}/projects", json=body))

    def get(self, project_id: str) -> Any:
        return self._b.call(lambda _c: Request("GET", _project(project_id)))

    def delete(self, project_id: str, input: Mapping[str, Any]) -> Any:
        """Deletes a project: ``{"expectedRevision", "slug"}`` (the slug confirms the delete)."""
        body = compact({"expectedRevision": input.get("expectedRevision"), "slug": input.get("slug")})
        return self._b.call(lambda _c: Request("DELETE", _project(project_id), json=body))

    def update_settings(
        self, project_id: str, patch: Mapping[str, Any], *, expected_revision: Optional[int] = None
    ) -> Any:
        """Changes only the settings in ``patch`` (``updateSettings``).

        The route replaces every setting, so this reads the Site (step ``read``), lays ``patch`` over
        its current settings and sends them with ``expectedRevision`` (step ``settings``): the revision
        it read, unless you pin one. ``database`` and ``extensions`` have their own routes and are
        refused, as is an empty patch. ``None`` clears ``workspaceId`` or ``spaceId`` and is refused on
        every other setting.
        """

        def op(_config: Any) -> Any:
            changes = _settings_changes(patch)
            current = yield from _step("read", {"projectId": project_id}, Request("GET", _project(project_id)))
            stored = current.get("settings") if isinstance(current, Mapping) else None
            if not isinstance(stored, Mapping):
                # Sending only the patch would reset every other setting to its default.
                raise RyuResponseValidationError(
                    "Ryu Sites: the Site read did not include its settings, so update_settings sent nothing.",
                    service="sites",
                    details={"projectId": project_id, "step": "read"},
                )
            revision = current["revision"] if expected_revision is None else expected_revision
            settings = {**stored, **changes}
            stored_public = "audience" not in changes and stored.get("audience") == "public"
            try:
                return (
                    yield from _step(
                        "settings",
                        {"expectedRevision": revision, "projectId": project_id},
                        Request(
                            "PUT",
                            _project(project_id, "settings"),
                            json={"expectedRevision": revision, "settings": settings},
                        ),
                    )
                )
            except RyuError as error:
                # The caller did not ask for public: say why the route still refuses it.
                if stored_public and _is_public_disabled(error):
                    raise copy_ryu_error(error, hint=STORED_PUBLIC_HINT) from error
                raise

        return self._b.call(op)

    def make_public(self, project_id: str, *, expected_revision: Optional[int] = None) -> Any:
        """Opens the Site to everyone (``makePublic``): ``update_settings(id, {"audience": "public"})``.

        Sites refuses it with ``403 policy_denied`` unless the operator allows public Sites
        (``RYU_SITES_PUBLIC=1`` or the runtime config's ``publicEnabled``); ``status()["publicEnabled"]`` says
        whether it does.
        """
        return self.update_settings(project_id, {"audience": "public"}, expected_revision=expected_revision)


def _invalid_settings(message: str, details: Optional[dict[str, Any]] = None) -> RyuInvalidRequestError:
    return RyuInvalidRequestError(
        f"Ryu Sites: {message}", service="sites", code="invalid_request", details=details, retryable=False
    )


def _settings_changes(patch: Any) -> dict[str, Any]:
    """The patch as a dict; refuses an empty patch, the separately managed settings and ``None`` on a setting
    that cannot be cleared (``settingsChanges``, where ``undefined`` is dropped and ``null`` is refused)."""
    if not isinstance(patch, Mapping):
        raise _invalid_settings("update_settings needs a mapping of settings.")
    managed = [key for key in _SEPARATELY_MANAGED if key in patch]
    if managed:
        pronoun, possessive = ("it", "its") if len(managed) == 1 else ("them", "their")
        raise _invalid_settings(
            f"{' and '.join(managed)} cannot be changed with updateSettings: Sites manages {pronoun} with "
            f"{possessive} own routes.",
            {"fields": managed},
        )
    if not patch:
        raise _invalid_settings("updateSettings needs at least one setting to change.")
    nulls = [key for key, value in patch.items() if value is None and key not in _NULLABLE_SETTINGS]
    if nulls:
        raise _invalid_settings(
            f"{' and '.join(nulls)} cannot be null: only workspaceId and spaceId can be cleared with null.",
            {"fields": nulls},
        )
    return dict(patch)


class Versions(Resource):
    def create(self, project_id: str, input: Mapping[str, Any]) -> Any:
        body = compact({key: input.get(key) for key in ("commit", "expectedRevision", "html", "message")})
        return self._b.call(lambda _c: Request("POST", _project(project_id, "versions"), json=body))


class SitesNamespace(Namespace):
    """``ryu.sites``."""

    def __init__(self, binding: Any) -> None:
        super().__init__(binding)
        self.projects = Projects(binding)
        self.versions = Versions(binding)

    def status(self) -> Any:
        return self._b.call(lambda _c: Request("GET", f"{PREFIX}/status"))

    def deploy(self, input: Mapping[str, Any]) -> Any:
        """Deploys ``html`` (saved as a new version) or an existing ``versionId`` to ``projectId``.

        Returns ``{"project", "url", "version"}``.
        """
        project_id: Any = input.get("projectId")  # segment() refuses a missing id
        pinned = input.get("expectedRevision")

        def op(_config: Any) -> Any:
            revision = pinned
            if revision is None:
                project = yield from _step("read", {"projectId": project_id}, Request("GET", _project(project_id)))
                revision = project["revision"]
            status = yield from _step("status", {"projectId": project_id}, Request("GET", f"{PREFIX}/status"))
            saved_version = None
            if "html" in input:
                saved = yield from _step(
                    "version",
                    {"expectedRevision": revision, "projectId": project_id},
                    Request(
                        "POST",
                        _project(project_id, "versions"),
                        json=compact(
                            {"expectedRevision": revision, "html": input["html"], "message": input.get("message")}
                        ),
                    ),
                )
                versions = saved.get("versions") or []
                if not versions:
                    raise ValueError("Sites did not return the saved version.")
                saved_version = versions[-1]
                version_id = saved_version["id"]
                revision = saved["revision"]
            else:
                version_id = input["versionId"]
            project = yield from _step(
                "deploy",
                {"expectedRevision": revision, "projectId": project_id, "versionId": version_id},
                Request(
                    "POST",
                    _project(project_id, "deploy"),
                    json={"expectedRevision": revision, "versionId": version_id},
                ),
            )
            deployed = next(
                (item for item in project.get("versions") or [] if item.get("id") == version_id),
                saved_version if saved_version and saved_version.get("id") == version_id else None,
            )
            return {"project": project, "url": site_url(project["slug"], status), "version": deployed}

        return self._b.call(op)

    def unpublish(self, project_id: str, *, expected_revision: Optional[int] = None) -> Any:
        def op(_config: Any) -> Any:
            revision = expected_revision
            if revision is None:
                project = yield from _step("read", {"projectId": project_id}, Request("GET", _project(project_id)))
                revision = project["revision"]
            return (yield Request("POST", _project(project_id, "unpublish"), json={"expectedRevision": revision}))

        return self._b.call(op)
