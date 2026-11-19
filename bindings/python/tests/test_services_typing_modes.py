"""Static typing of ryu_sdk.services, continued: the Sites status shape against the Sites
sidecar's ``GET /status``, the object-mode aliases, and runtime-evaluable annotations.
"""

from __future__ import annotations

import inspect
import re
import textwrap
from pathlib import Path
from typing import Literal

import pytest
from test_services_typing import HAS_MYPY, _mypy

from ryu_sdk.services import AsyncRyu, Ryu

# The status handler lives in the sidecar's management route table module.
SITES_SIDECAR = Path(__file__).resolve().parents[3] / "apps-store" / "sites" / "sidecar" / "src" / "admin-top-routes.ts"


def _sites_status_route_keys(source: str) -> set[str]:
    start = source.index("function status(")
    body = source[start : source.index("});", start)]
    return set(re.findall(r"^\s*([A-Za-z]+)(?::|,)", body, re.MULTILINE))


@pytest.mark.skipif(not SITES_SIDECAR.exists(), reason="the Sites sidecar source is not in this checkout")
def test_sites_status_declares_every_key_the_sidecar_returns():
    from ryu_sdk.services.shapes import SitesStatus

    returned = _sites_status_route_keys(SITES_SIDECAR.read_text())
    assert "identityAvailable" in returned and "visitorPort" in returned, returned
    assert returned == set(SitesStatus.__annotations__), (
        "SitesStatus in shapes.py drifted from GET /api/sites/status in apps-store/sites/sidecar/src/admin-top-routes.ts"
    )


SITES_STATUS_SAMPLE = """
from ryu_sdk.services import Ryu

status = Ryu().sites.status()
identity: bool = status["identityAvailable"]
domains: bool = status["domainsAvailable"]
reveal_type(status["publicEnabled"])
"""


@pytest.mark.skipif(not HAS_MYPY, reason="mypy is not installed")
def test_mypy_strict_accepts_the_sites_capability_flags(tmp_path: Path):
    sample = tmp_path / "sites_status.py"
    sample.write_text(textwrap.dedent(SITES_STATUS_SAMPLE))
    completed = _mypy("--strict", "--follow-imports=silent", str(sample), cwd=tmp_path)
    assert [line for line in completed.stdout.splitlines() if ": error:" in line] == [], completed.stdout
    assert 'Revealed type is "builtins.bool"' in completed.stdout or 'Revealed type is "bool"' in completed.stdout


ALIASES_SAMPLE = """
from ryu_sdk.services import AsyncObjectRyu, AsyncRyu, ObjectRyu, Ryu


def publish(ryu: ObjectRyu) -> None:
    reveal_type(ryu)
    reveal_type(ryu.notify.publish({"title": "x"}))


async def apublish(ryu: AsyncObjectRyu) -> None:
    reveal_type(ryu)
    reveal_type(await ryu.notify.publish({"title": "x"}))


publish(Ryu(result="object"))
publish(ObjectRyu(result="object"))
publish(Ryu())


async def main() -> None:
    await apublish(AsyncRyu())
"""


def test_object_mode_aliases_are_the_subscripted_clients():
    from typing import get_args, get_origin

    from ryu_sdk.services import AsyncObjectRyu, ObjectRyu

    assert get_origin(ObjectRyu) is Ryu and get_args(ObjectRyu) == (Literal["object"],)
    assert get_origin(AsyncObjectRyu) is AsyncRyu and get_args(AsyncObjectRyu) == (Literal["object"],)
    # Calling the alias builds a plain client, so `ObjectRyu(result="object")` works too.
    client = ObjectRyu(result="object", env=False)
    assert type(client) is Ryu and client.result == "object"
    # The aliases are for annotations only (the docs say so): a class check refuses them, and the
    # mode is read from `client.result` instead.
    for alias in (ObjectRyu, AsyncObjectRyu):
        with pytest.raises(TypeError):
            isinstance(client, alias)


@pytest.mark.skipif(not HAS_MYPY, reason="mypy is not installed")
def test_mypy_reads_the_object_mode_aliases_as_object_mode_clients(tmp_path: Path):
    sample = tmp_path / "aliases.py"
    sample.write_text(ALIASES_SAMPLE)
    completed = _mypy("--strict", "--follow-imports=silent", str(sample), cwd=tmp_path)
    revealed = [line for line in completed.stdout.splitlines() if "Revealed type is" in line]
    assert len(revealed) == 4, completed.stdout
    assert "Ryu[Literal['object']]" in revealed[0]
    assert "ryu_sdk.services.result.Result[TypedDict(ryu_sdk.services.shapes.NotifyEvent," in revealed[1]
    assert "AsyncRyu[Literal['object']]" in revealed[2]
    assert "ryu_sdk.services.result.Result[TypedDict(ryu_sdk.services.shapes.NotifyEvent," in revealed[3]
    errors = [line for line in completed.stdout.splitlines() if ": error:" in line]
    # A throw-mode client is refused where the alias is expected, sync and async alike.
    assert len(errors) == 2, completed.stdout
    assert "incompatible type \"Ryu[Literal['throw']]\"" in errors[0]
    assert "incompatible type \"AsyncRyu[Literal['throw']]\"" in errors[1]


def test_every_annotation_evaluates_at_runtime():
    # requires-python is 3.9, where typing.get_type_hints (ryu_sdk.schema, a reader's own
    # introspection) cannot evaluate `X | None` (a TypeError); pyproject's keep-runtime-typing keeps
    # ruff from suggesting it. Every TypedDict and function in the package must resolve.
    import importlib
    import pkgutil
    import typing

    import ryu_sdk.services as package
    import ryu_sdk.services._gen_views as views

    # Names a module imports only under TYPE_CHECKING (to avoid an import cycle). Any other
    # NameError is a real unresolvable annotation and fails the test.
    type_checking_only = {"ManagedAgentsAPI", "SyncToolClient", "ToolClient"}
    type_checking_only.update(name for name in vars(views) if not name.startswith("_"))

    def missing_name(error: NameError) -> str:
        found = getattr(error, "name", None)  # Python 3.10+
        if found:
            return str(found)
        match = re.search(r"name '([^']+)' is not defined", str(error))
        return match.group(1) if match else ""

    checked = 0
    for info in pkgutil.walk_packages(package.__path__, f"{package.__name__}."):
        if info.name.endswith(("._gen_views", "._surface")):
            continue
        module = importlib.import_module(info.name)
        for value in vars(module).values():
            if getattr(value, "__module__", None) != module.__name__:
                continue
            targets = [value]
            if inspect.isclass(value):
                targets.extend(member for member in vars(value).values() if inspect.isfunction(member))
            elif not inspect.isfunction(value):
                continue
            for target in targets:
                try:
                    typing.get_type_hints(target)
                except NameError as error:
                    # A TYPE_CHECKING-only name; `X | None` on 3.9 is a TypeError and still fails.
                    assert missing_name(error) in type_checking_only, (target, error)
                    continue
                checked += 1
    assert checked > 500, checked
