"""Ryu SDK for Python.

Two layers ship in this package:

- The **native kernel** lives in the GENERATED sibling module `ryu_sdk.py`
  (emitted by `uniffi-bindgen` from `crates/sdk/uniffi`; gitignored). This
  committed `__init__.py` re-exports it so callers `import ryu_sdk` and reach the
  surface directly (`ryu_sdk.validate_plugin_id`, `ryu_sdk.ModelClient`,
  `ryu_sdk.RyuError`, ...), matching the smoke test + pyproject. Without this
  file Python 3 would treat `ryu_sdk/` as an empty namespace package.
- The **pure-Python authoring surface** (committed; needs `httpx`): `Agent`, the
  `tool` decorator, structured output, middleware, the workflow DSL and client,
  and the Core harness and Managed Agents clients.

The native module is optional at import time so the pure-Python layer works
from a source checkout before the cdylib is built. When the generated module is
present it must load: a broken native library still raises.
"""

import importlib.util as _importlib_util

if _importlib_util.find_spec(f"{__name__}.ryu_sdk") is not None:
    from .ryu_sdk import *  # noqa: F401,F403  (re-export the generated UniFFI surface)
    from .ryu_sdk import __all__ as _native_all

    NATIVE_AVAILABLE = True
else:  # source checkout without the generated module
    _native_all = []
    NATIVE_AVAILABLE = False

from .agent import (  # noqa: E402, F401
    Agent,
    AgentError,
    AgentEvent,
    ApprovalRequest,
    ApprovalRequestedEvent,
    AuthRequiredEvent,
    ErrorEvent,
    GenerateResult,
    OutputRepairEvent,
    ResultEvent,
    TextEvent,
    ToolCallEvent,
    ToolResultEvent,
)
from .gateway import EgressNotAllowedError  # noqa: E402, F401
from .harness import AsyncHarnessClient, HarnessClient  # noqa: E402, F401
from .managed_agents import (  # noqa: E402, F401
    AsyncManagedAgentsClient,
    ManagedAgentsClient,
    ManagedAgentsError,
)
from .middleware import (  # noqa: E402, F401
    Middleware,
    ModelCallRequest,
    ModelCallResult,
    ToolCallRequest,
    ToolCallResult,
    TurnSummary,
)
from .schema import SchemaIssue, StructuredOutputError, json_schema_for  # noqa: E402, F401
from . import services  # noqa: E402, F401
from .services import AsyncRyu, Ryu  # noqa: E402, F401
from .tools import RemoteTool, Tool, ryu_tool, tool  # noqa: E402, F401
from .workflow import AsyncWorkflowClient, Workflow, WorkflowClient, when  # noqa: E402, F401

# A literal `__all__` so type checkers (mypy --strict has implicit re-export off) see
# every pure-Python name as an explicit re-export; the native names join it at runtime.
__all__ = [
    "NATIVE_AVAILABLE",
    "Agent",
    "AgentError",
    "AgentEvent",
    "ApprovalRequest",
    "ApprovalRequestedEvent",
    "AsyncHarnessClient",
    "AsyncManagedAgentsClient",
    "AsyncRyu",
    "AsyncWorkflowClient",
    "AuthRequiredEvent",
    "EgressNotAllowedError",
    "ErrorEvent",
    "GenerateResult",
    "HarnessClient",
    "ManagedAgentsClient",
    "ManagedAgentsError",
    "Middleware",
    "ModelCallRequest",
    "ModelCallResult",
    "OutputRepairEvent",
    "RemoteTool",
    "ResultEvent",
    "Ryu",
    "SchemaIssue",
    "StructuredOutputError",
    "TextEvent",
    "Tool",
    "ToolCallEvent",
    "ToolCallRequest",
    "ToolCallResult",
    "ToolResultEvent",
    "TurnSummary",
    "Workflow",
    "WorkflowClient",
    "json_schema_for",
    "ryu_tool",
    "services",
    "tool",
    "when",
]

_PURE_ALL = tuple(__all__)
__all__ += [name for name in _native_all if name not in _PURE_ALL]
