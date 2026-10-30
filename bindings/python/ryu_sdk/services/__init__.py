"""Python client for every Ryu standalone service (the Python form of ``@ryuhq/services``).

::

    from ryu_sdk.services import Ryu, RyuError

    ryu = Ryu(result="object")
    data, error, meta = ryu.notify.publish({"title": "Deploy finished", "level": "success"})

See :mod:`ryu_sdk.services.client` for the options and
https://docs.ryuhq.com/docs/standalone/sdk for every service's page.
"""

from ._runtime import SDK_VERSION, Paginated
from .client import AsyncObjectRyu, AsyncRyu, ObjectRyu, ResultMode, Ryu, RyuOptions
from .config import AVAILABILITY, CONTROL_PLANE_URL, DEFAULT_BOX_URL, DEFAULT_GATEWAY_URL, DEFAULT_NOTIFY_URL, ENV_VARS
from .errors import (
    ERROR_CLASSES,
    RyuAbortError,
    RyuAuthenticationError,
    RyuConfigurationError,
    RyuConflictError,
    RyuConnectionError,
    RyuError,
    RyuInvalidRequestError,
    RyuNotFoundError,
    RyuPaymentRequiredError,
    RyuPermissionError,
    RyuQuotaExceededError,
    RyuRateLimitError,
    RyuRedirectError,
    RyuResponseValidationError,
    RyuServerError,
    RyuTimeoutError,
    RyuUnavailableError,
    RyuWebhookVerificationError,
    is_ryu_error,
    known_server_hint,
    message_with_hint,
    message_without_hint,
    parse_error_response,
)
from .managed_agents import (
    TOOL_APPROVAL_EVENT_TYPES,
    ManagedAgentsRunResult,
    ToolApprovalContext,
    ToolApprovalDecision,
    ToolApprovalHandler,
    pending_tool_approvals,
    tool_approval_idempotency_key,
)
from .messaging import messaging_error_record
from .result import EMPTY_META, ResponseMeta, Result
from .transport import NON_RETRYABLE_CODES, SERVICE_ROUTES, Deprecation, RateLimit
from .webhooks import (
    MAIL_EVENT_TYPES,
    MESSAGING_EVENT_TYPES,
    NotifyWebhookDelivery,
    NotifyWebhookKind,
    WebhookScheme,
    is_known_mail_webhook_event,
    is_known_messaging_webhook_event,
    verify_mail_webhook,
    verify_messaging_webhook,
    verify_notify_webhook,
    verify_standard_webhook,
    verify_webhook,
)

__all__ = [
    "AVAILABILITY",
    "CONTROL_PLANE_URL",
    "DEFAULT_BOX_URL",
    "DEFAULT_GATEWAY_URL",
    "DEFAULT_NOTIFY_URL",
    "EMPTY_META",
    "ENV_VARS",
    "ERROR_CLASSES",
    "MAIL_EVENT_TYPES",
    "MESSAGING_EVENT_TYPES",
    "NON_RETRYABLE_CODES",
    "SDK_VERSION",
    "SERVICE_ROUTES",
    "TOOL_APPROVAL_EVENT_TYPES",
    "AsyncObjectRyu",
    "AsyncRyu",
    "Deprecation",
    "ManagedAgentsRunResult",
    "NotifyWebhookDelivery",
    "NotifyWebhookKind",
    "ObjectRyu",
    "Paginated",
    "RateLimit",
    "ResponseMeta",
    "Result",
    "ResultMode",
    "Ryu",
    "RyuAbortError",
    "RyuAuthenticationError",
    "RyuConfigurationError",
    "RyuConflictError",
    "RyuConnectionError",
    "RyuError",
    "RyuInvalidRequestError",
    "RyuNotFoundError",
    "RyuOptions",
    "RyuPaymentRequiredError",
    "RyuPermissionError",
    "RyuQuotaExceededError",
    "RyuRateLimitError",
    "RyuRedirectError",
    "RyuResponseValidationError",
    "RyuServerError",
    "RyuTimeoutError",
    "RyuUnavailableError",
    "RyuWebhookVerificationError",
    "ToolApprovalContext",
    "ToolApprovalDecision",
    "ToolApprovalHandler",
    "WebhookScheme",
    "is_known_mail_webhook_event",
    "is_known_messaging_webhook_event",
    "is_ryu_error",
    "known_server_hint",
    "message_with_hint",
    "message_without_hint",
    "messaging_error_record",
    "parse_error_response",
    "pending_tool_approvals",
    "tool_approval_idempotency_key",
    "verify_mail_webhook",
    "verify_messaging_webhook",
    "verify_notify_webhook",
    "verify_standard_webhook",
    "verify_webhook",
]
