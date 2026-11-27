"""Ryu's standalone services as agent tools (the Python form of ``@ryuhq/services/tools``).

One registry, the same tools as the TypeScript package and ``ryu-services
mcp``: names, descriptions, argument JSON Schemas and annotations come from
``manifest.json``, exported from the TypeScript registry. Adapters::

    from ryu_sdk import Agent
    from ryu_sdk.services import Ryu
    from ryu_sdk.services.tools import to_openai_tools, to_ryu_agent_tools

    ryu = Ryu()
    agent = Agent(name="ops", model="openai/gpt-4o-mini", tools=to_ryu_agent_tools(ryu))

    tools = to_openai_tools(ryu, services=["notify"])  # pass as `tools=`
    result = tools.execute(call.function.name, call.function.arguments)

Read-only tools only unless ``read_only=False``; tools that are not read-only
or are open-world carry ``needs_approval``. Results are
``{"data", "error", "meta"}`` JSON and never raise for a service failure.
"""

from ..shapes import NotifyUsageWindow
from ._bodies import default_notify_usage_window, gateway_chat_body, sites_deploy_body
from ._manifest import CONSTANTS, ToolAnnotations, ToolSpec
from ._run import (
    RYU_TOOL_PREFIXES,
    RYU_TOOL_SERVICES,
    RYU_TOOLS,
    RYU_TOOLS_BY_SERVICE,
    CredentialProbe,
    RyuTool,
    ToolErrorJSON,
    ToolMetaJSON,
    ToolResultJSON,
    arun_ryu_tool,
    credential_free_ryu_tools,
    default_needs_approval,
    get_ryu_tool,
    invalid_tool_input,
    run_ryu_tool,
    ryu_tool_passes_filter,
    select_ryu_tools,
    to_plain_json,
    to_tool_error_json,
    to_tool_meta_json,
    to_tool_result_json,
)
from ._validate import ToolInputIssue, parse_arguments
from .adapters import (
    ApprovalOption,
    OpenAIApi,
    RyuFunctionTools,
    RyuServiceTool,
    to_anthropic_tools,
    to_openai_tools,
    to_ryu_agent_tools,
)

__all__ = [
    "CONSTANTS",
    "RYU_TOOLS",
    "RYU_TOOLS_BY_SERVICE",
    "RYU_TOOL_PREFIXES",
    "RYU_TOOL_SERVICES",
    "ApprovalOption",
    "CredentialProbe",
    "NotifyUsageWindow",
    "OpenAIApi",
    "RyuFunctionTools",
    "RyuServiceTool",
    "RyuTool",
    "ToolAnnotations",
    "ToolErrorJSON",
    "ToolInputIssue",
    "ToolMetaJSON",
    "ToolResultJSON",
    "ToolSpec",
    "arun_ryu_tool",
    "credential_free_ryu_tools",
    "default_needs_approval",
    "default_notify_usage_window",
    "gateway_chat_body",
    "get_ryu_tool",
    "invalid_tool_input",
    "parse_arguments",
    "run_ryu_tool",
    "ryu_tool_passes_filter",
    "select_ryu_tools",
    "sites_deploy_body",
    "to_anthropic_tools",
    "to_openai_tools",
    "to_plain_json",
    "to_ryu_agent_tools",
    "to_tool_error_json",
    "to_tool_meta_json",
    "to_tool_result_json",
]
