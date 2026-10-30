"""Return types of the main ``ryu.<namespace>`` methods, as ``TypedDict``s.

The client returns the services' JSON as plain dicts and lists; these types
describe them for type checkers (they cost nothing at runtime). Keys are the
wire's (camelCase for most services, snake_case for Passport), as in the
TypeScript ``@ryuhq/services`` types. Every type is ``total=False``: servers
may omit fields, older servers lack newer ones, and responses can carry fields
not listed here, so read optional data with ``.get()``. The exceptions are the
values the SDK builds itself, which always carry every key:
``GatewayOpenAICompatibleConfig``, ``ConnectMcpConfig`` (and its
``ConnectMcpHeaders``), ``MailRealtimeTicket``, ``BoxCommandParts``,
``NotifyUsageWindow`` and the verified webhook envelopes (``MailWebhookEvent``,
``MessagingWebhookEvent`` and their ``Known*`` narrowings).

The namespace views in :mod:`ryu_sdk.services.views` use these types, so
``Ryu().notify.publish(...)`` is a ``NotifyEvent``,
``Ryu(result="object").notify.publish(...)`` a ``Result[NotifyEvent]``, and
``AsyncRyu().notify.publish(...)`` an ``Awaitable[NotifyEvent]``.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

try:  # Python 3.8+
    from typing import TypedDict
except ImportError:  # pragma: no cover
    from typing_extensions import TypedDict

from .managed_agents import ManagedAgentsRunResult

# ── Notify ────────────────────────────────────────────────────────────────────


class NotifyEvent(TypedDict, total=False):
    """A Notify event (``notify.publish``, ``notify.events.get``)."""

    id: str
    """The event id."""
    title: str
    """Human-readable title."""
    body: str
    """Plain-text description."""
    level: str
    """Severity: ``info``, ``success``, ``warning``, ``error`` or ``critical``."""
    priority: Any
    """1 (lowest) to 5 (urgent), as in ntfy."""
    type: str
    """The producer's event type, such as ``deploy.completed``."""
    topic: Optional[str]
    """The topic it was published to; null for none."""
    source: str
    """The producer label, such as ``github-actions``."""
    recipient: Optional[str]
    """The recipient label it is for; null for the default recipient."""
    project: Optional[str]
    """A product or project grouping label; null when unset."""
    url: Optional[str]
    """The HTTPS click-through URL; null when unset."""
    icon: Optional[str]
    """An HTTPS icon URL for clients; null when unset."""
    tags: list[str]
    """Tags for filtering and downstream adapters."""
    data: dict[str, Any]
    """A JSON object. Keys that look like credentials are redacted before storage."""
    actions: list[dict[str, Any]]
    """Link actions, each a ``label`` and an HTTPS ``url``."""
    attachment: Optional[dict[str, Any]]
    """A metadata-only HTTPS attachment reference; null when none."""
    response: Optional[dict[str, Any]]
    """The interactive response: its ``type``, ``prompt``, ``status`` (``pending`` until answered, then the answer,
    ``expired`` or ``canceled``) and ``value``; null for a plain event."""
    externalId: Optional[str]
    """Your own identifier for the event; null when unset."""
    fingerprint: Optional[str]
    """The grouping and filter hint; null when unset."""
    occurredAt: str
    """ISO 8601 timestamp."""
    createdAt: str
    """ISO 8601 timestamp."""
    acknowledgedAt: Optional[str]
    """When the event was acknowledged; null until then."""
    archivedAt: Optional[str]
    """When the event was archived; null until then."""


class NotifyEventPage(TypedDict, total=False):
    """One page of ``notify.events.list``; pass ``nextCursor`` as ``before`` for the next."""

    events: list[NotifyEvent]
    nextCursor: Optional[str]


#: ``notify.usage``: accepted events in a window of whole UTC hours (``from`` is a keyword, hence
#: the functional form).
NotifyUsageReport = TypedDict("NotifyUsageReport", {"from": str, "to": str, "meters": dict[str, int]}, total=False)


#: ``tools.default_notify_usage_window()``: ISO 8601 UTC times on whole hours, every key set.
NotifyUsageWindow = TypedDict("NotifyUsageWindow", {"from": str, "to": str})


class NotifyApprovalResult(TypedDict, total=False):
    """``notify.request_approval``."""

    approved: bool
    status: str
    """``approved``, ``denied``, ``yes``, ``no``, ``expired``, ``canceled`` or ``pending``."""
    value: Any
    timed_out: bool
    event: NotifyEvent


class NotifyTopic(TypedDict, total=False):
    """One row of ``notify.topics.list``: a topic and its event count."""

    topic: str
    count: int


# ── Mail ──────────────────────────────────────────────────────────────────────


class MailStatus(TypedDict, total=False):
    """``mail.status``: the Mail deployment's configuration, not what a key may do.

    ``ryu.mail.status()`` returns the server's reply as sent: self-hosted Mail sends no
    ``domain`` and hosted Mail no ``inboxCount``, and a count can arrive as text. The
    ``mail_status`` tool fills both in and reads the count, as the TypeScript ``status()`` does.
    """

    apiVersion: str
    """The Mail API version."""
    configured: bool
    """Whether Mail is configured on this deployment."""
    sendConfigured: bool
    """Whether a sending transport is configured."""
    domain: Optional[str]
    """The domain hosted inboxes use; null when unset."""
    domainMode: str
    """``managed``: Ryu's domain. ``byo``: your own domain."""
    inbound: str
    """How inbound mail arrives: ``sns``, ``webhook`` or ``imap``."""
    inboxCount: int
    """How many inboxes exist, where the deployment reports it."""


class MailInboxCreatedWith(TypedDict):
    """The credential that created a hosted Mail inbox (ids only, never a secret)."""

    via: str
    """How the inbox was created: ``session``, ``api_key``, ``oauth`` or ``gateway_key``."""
    apiKeyId: Optional[str]
    """The Ryu API key's id (never the key), when ``via`` is ``api_key``."""
    serviceAccountId: Optional[str]
    """The service account an API key acted as, or null."""
    oauthClientId: Optional[str]
    """The OAuth client id of the hosted MCP app, when ``via`` is ``oauth``."""
    gatewayCredentialId: Optional[str]
    """The node gateway credential's id, when ``via`` is ``gateway_key``."""


class MailInbox(TypedDict, total=False):
    """A Mail inbox (``mail.inboxes.list``/``get``/``create``)."""

    id: str
    """The inbox id."""
    address: str
    """The inbox's email address."""
    name: str
    """Display name, also the sender name."""
    description: Optional[str]
    """A note about the inbox."""
    provider: str
    """How mail arrives: a signed relay webhook or IMAP."""
    agentId: Optional[str]
    """The agent that owns this inbox, when it is an agent's own inbox."""
    clientId: Optional[str]
    """Your own id for the inbox, or null."""
    podId: Optional[str]
    """The pod the inbox is in, or null."""
    metadata: dict[str, Any]
    """Your own key-value data."""
    webhookUrl: Optional[str]
    """Null unless the caller may manage Mail: hosted Mail returns it to a Ryu API key only with mail:manage."""
    webhookConfigured: bool
    """Whether a ``webhookUrl`` is set."""
    webhookSigned: bool
    """Whether ``webhookUrl`` deliveries are signed; false for an inbox webhook set before signing until its secret
    is rotated."""
    webhookSecret: str
    """Returned once, by the call that minted it. Reads never include it."""
    createdWith: Optional[MailInboxCreatedWith]
    """Hosted Mail only: which credential created the inbox, or null for an inbox created before this was recorded.
    Returned on every inbox reply (reads, lists, creates, agent-inbox replays, updates and address changes) only to
    callers who may manage Mail: a Ryu API key with mail:manage whose principal holds mail.manage, a member with
    mail.manage, or the owner of a personal account. Omitted for mail:read keys, read-only members, hosted MCP apps
    and node gateway keys."""
    createdAt: str
    """ISO 8601 timestamp."""
    updatedAt: str
    """ISO 8601 timestamp."""


class MailAttachment(TypedDict, total=False):
    id: Optional[str]
    """The id to download it with (``GET /api/mail/attachments/{id}``)."""
    filename: Optional[str]
    """The file name, or null when it has none."""
    contentType: Optional[str]
    """The MIME type, or null when unknown."""
    contentId: Optional[str]
    """The Content-ID an inline part is referenced by (``cid:``), or null."""
    inline: bool
    """Whether it is an inline part."""
    size: int
    """Size in bytes."""


#: ``MailMessage``'s ``from`` key: a keyword, so it is declared in functional form.
_MailMessageFrom = TypedDict(
    "_MailMessageFrom",
    {
        #: The sender address.
        "from": Optional[str],
    },
    total=False,
)


class MailMessage(_MailMessageFrom, total=False):
    """A Mail message (``mail.send``, ``mail.messages.list``/``get``); ``from`` is on its base."""

    id: str
    """The message id Mail assigned."""
    inboxId: str
    """The inbox it belongs to."""
    clientId: Optional[str]
    """The ``clientId`` it was sent with, or null."""
    threadId: Optional[str]
    """The conversation it belongs to."""
    messageId: Optional[str]
    """The RFC 5322 ``Message-ID`` header."""
    direction: str
    """``inbound`` or ``outbound``."""
    status: str
    """Delivery state: ``received`` for inbound mail; outbound moves through ``queued``, ``sent``, ``delivered`` and
    ``opened``, or ends ``bounced``, ``complained`` or ``failed`` (hosted Mail)."""
    to: list[str]
    """Recipients."""
    cc: list[str]
    """Copy recipients."""
    bcc: list[str]
    """Blind-copy recipients (outbound only)."""
    replyTo: Optional[str]
    """The Reply-To address, or null."""
    subject: Optional[str]
    """The subject line."""
    text: Optional[str]
    """The plain-text body."""
    html: Optional[str]
    """The HTML body."""
    extractedText: Optional[str]
    """The plain-text body Mail extracted from an inbound message."""
    extractedHtml: Optional[str]
    """The HTML body Mail extracted from an inbound message."""
    preview: Optional[str]
    """The start of the text body, whitespace collapsed."""
    labels: list[str]
    """Labels, such as ``sent`` or your own."""
    headers: dict[str, str]
    """MIME headers, by name."""
    attachments: list[MailAttachment]
    """Attachment metadata."""
    inReplyTo: Optional[str]
    """The ``Message-ID`` it answers, or null."""
    references: list[str]
    """The ``References`` Message-IDs, oldest first."""
    read: bool
    """Whether it is marked read."""
    error: Optional[str]
    """Why a send failed, or null."""
    openedAt: Optional[str]
    """When a tracked message was first opened, or null."""
    createdAt: str
    """ISO 8601 timestamp."""
    updatedAt: str
    """ISO 8601 timestamp."""


class MailRealtimeTicket(TypedDict):
    """A one-use hosted Mail realtime ticket (``mail.create_realtime_ticket``). The SDK builds it
    from the reply and fills a missing field with its default, so every key is present."""

    ticket: str
    """The single-use ticket; it is spent by the first upgrade that offers it."""
    expiresAt: str
    """ISO 8601 timestamp."""
    expiresIn: int
    """Seconds until the ticket expires unused."""
    path: str
    """The WebSocket path to open, relative to the Mail origin."""
    protocols: list[str]
    """The WebSocket subprotocols to offer, in order: ``ryu-mail.v1`` and ``ryu-ticket.<ticket>``."""
    url: str
    """The absolute ``wss://`` socket URL; it carries no credential."""


#: Every Mail webhook event type this SDK knows (``MAIL_EVENT_TYPES``).
MailEventType = Literal[
    "message.received",
    "message.received.spam",
    "message.received.blocked",
    "message.received.unauthenticated",
    "message.sent",
    "message.delivered",
    "message.bounced",
    "message.complained",
    "message.rejected",
    "message.opened",
    "domain.verified",
]


class MailWebhookEvent(TypedDict):
    """A verified Mail delivery (``verify_mail_webhook``). ``event_type`` may be newer than
    ``MAIL_EVENT_TYPES``: ``if is_known_mail_webhook_event(event):`` narrows it to a
    ``KnownMailWebhookEvent``, whose ``event_type`` is a ``MailEventType``."""

    type: Literal["event"]
    event_id: str
    """The event id; also the ``webhook-id`` header. Dedupe on it: deliveries are retried."""
    event_type: str
    data: dict[str, Any]
    """Message events carry ``message`` plus delivery details (``recipients``, ``reason``)."""


class KnownMailWebhookEvent(TypedDict):
    """A verified Mail delivery of a type this SDK knows (``is_known_mail_webhook_event``)."""

    type: Literal["event"]
    event_id: str
    """The event id; also the ``webhook-id`` header. Dedupe on it: deliveries are retried."""
    event_type: MailEventType
    data: dict[str, Any]
    """Message events carry ``message`` plus delivery details (``recipients``, ``reason``)."""


# ── Messaging ─────────────────────────────────────────────────────────────────


#: ``MessagingMessage``'s ``from`` key: a keyword, so it is declared in functional form.
_MessagingMessageFrom = TypedDict(
    "_MessagingMessageFrom",
    {
        #: The sender: your number, your WhatsApp sender's number, or the inbound party (E.164 for phone channels).
        "from": str,
    },
    total=False,
)


class MessagingMessage(_MessagingMessageFrom, total=False):
    """A Messaging message record (``messaging.sms.send``, ``messaging.messages.get``); ``from`` is on
    its base."""

    id: str
    """The message id."""
    organizationId: str
    """The organization that owns the message."""
    channel: str
    """``sms``, ``mms``, ``voice`` or ``whatsapp``."""
    direction: str
    """``outbound`` for a message you sent, ``inbound`` for one received on your number or sender."""
    status: str
    """``queued`` → ``sending`` → ``accepted`` → ``delivered`` | ``failed``. ``unresolved``: the outcome is unknown
    (it may have been sent). ``refused``: Ryu or AWS declined it before sending. Inbound messages are ``received``."""
    to: str
    """The recipient (E.164 for phone channels)."""
    isoCountryCode: Optional[str]
    """The remote party's country (ISO 3166-1 alpha-2): the destination outbound, the origin inbound."""
    numberId: Optional[str]
    """Your leased number used for SMS, MMS or voice; null otherwise."""
    whatsappSenderId: Optional[str]
    """Your WhatsApp sender used; null for other channels."""
    body: Optional[str]
    """The text, voice SSML or caption; null when there is none."""
    bodyType: str
    """What ``body`` holds: ``text``, voice ``ssml``, a WhatsApp ``template``, or ``media``."""
    encoding: Optional[str]
    """The SMS encoding the quote used (``GSM`` or ``UCS2``, which fits fewer characters per segment); null for other
    channels."""
    segments: int
    """How many SMS parts the quote counted; 0 for other channels."""
    template: Optional[dict[str, Optional[str]]]
    """The WhatsApp template's ``name`` and ``language``; null when none was sent."""
    hasMedia: bool
    """True when the message carries MMS or WhatsApp media."""
    providerMessageId: Optional[str]
    """AWS's message id (outbound) or the inbound provider id; null until known."""
    providerStatus: Optional[str]
    """The latest status string AWS reported; null until one arrives."""
    providerStatusDescription: Optional[str]
    """AWS's description of ``providerStatus``; null until one arrives."""
    heldMicroUsd: int
    """Micro-USD (1 USD = 1,000,000)."""
    priceMicroUsd: Optional[int]
    """The settled price; null until it is known."""
    chargedMicroUsd: int
    """Micro-USD (1 USD = 1,000,000)."""
    absorbedMicroUsd: int
    """The part of the price Ryu absorbed."""
    chargeState: str
    """Billing state: ``none`` (nothing charged), ``held`` (the ceiling is held on your credit), ``settling`` (the
    price is fixed and the debit is being written), ``settled`` (debited and the hold released), ``released`` (the
    hold was released with no debit), or ``absorbed`` (Ryu absorbed the whole charge)."""
    estimated: bool
    """True when the charge settled at the price-list estimate because AWS reported no final price."""
    ttlSeconds: Optional[int]
    """The time to live sent to AWS, in seconds; null for channels without one."""
    metadata: dict[str, str]
    """Your own string key-value data, as sent."""
    error: Optional[str]
    """Why the message failed or was refused, for a person; null otherwise."""
    createdAt: str
    """When the message was created."""
    updatedAt: str
    """When the message last changed."""


class MessagingMessagePage(TypedDict, total=False):
    """One page of ``messaging.messages.list``; pass ``nextCursor`` as ``cursor`` for the next."""

    messages: list[MessagingMessage]
    """Messages, newest first."""
    nextCursor: Optional[str]
    """Pass as ``cursor`` for the next (older) page; null on the last page."""


class MessagingNumber(TypedDict, total=False):
    """A leased phone number (``messaging.numbers.list``)."""

    id: str
    """The number id."""
    organizationId: str
    """The organization that leases the number."""
    phoneNumber: Optional[str]
    """E.164; null until AWS confirms the purchase."""
    isoCountryCode: str
    """The number's country (ISO 3166-1 alpha-2)."""
    numberType: str
    """The kind of number, as AWS End User Messaging names it."""
    messageType: str
    """The AWS message type the number was requested for: ``TRANSACTIONAL`` or ``PROMOTIONAL``."""
    capabilities: list[str]
    """What the number can send."""
    status: str
    """``pending`` until AWS confirms the purchase, ``active`` while leased and paid for the current period,
    ``suspended`` when a renewal could not be paid (outbound is refused, inbound is still stored until
    ``graceEndsAt``), ``releasing`` while it is given back, ``released`` once given back, ``failed`` when the
    purchase produced no number."""
    label: Optional[str]
    """Your name for the number; null when unset."""
    twoWayEnabled: bool
    """Whether inbound SMS to the number is received and stored."""
    registrationId: Optional[str]
    """The 10DLC or toll-free registration; US numbers of those types cannot send without one."""
    monthlyLeaseMicroUsd: int
    """Micro-USD (1 USD = 1,000,000)."""
    leasePeriod: int
    """The current lease period, counted from 0; each period is charged once."""
    currentPeriodEndsAt: Optional[str]
    """When the paid period ends; the next period is charged before then. Null until active."""
    graceEndsAt: Optional[str]
    """When a suspended number is released if still unpaid; null when it is not suspended."""
    suspendedAt: Optional[str]
    """When the number was suspended; null when it is not."""
    releasedAt: Optional[str]
    """When the number was released; null until then."""
    error: Optional[str]
    """Why the purchase or a renewal failed, for a person; null otherwise."""
    createdAt: str
    """When the purchase was requested."""
    updatedAt: str
    """When the number last changed."""


class MessagingCredit(TypedDict, total=False):
    availableMicroUsd: int
    """Credits minus open holds, in micro-USD (a sum of buckets, not always whole)."""
    heldMicroUsd: int
    """Credit held by open holds, in micro-USD; ``availableMicroUsd`` already excludes it."""


class MessagingQuote(TypedDict, total=False):
    """``messaging.quote``: the hold a send would place (the most it can cost), in micro-USD."""

    channel: str
    """The channel quoted: ``sms``, ``mms``, ``voice`` or ``whatsapp``."""
    quote: dict[str, Any]
    """What the hold is made of for this channel; every amount is in micro-USD."""
    credit: MessagingCredit
    """The organization's credit."""


class MessagingStatus(TypedDict, total=False):
    """``messaging.status``."""

    apiVersion: str
    """The Messaging API version."""
    configured: bool
    """Whether Messaging is configured on this server at all."""
    channels: dict[str, bool]
    """Whether each channel can be used on this server."""


#: Every Messaging webhook event type this SDK knows (``MESSAGING_EVENT_TYPES``).
MessagingEventType = Literal[
    "message.received",
    "message.delivered",
    "message.failed",
    "number.suspended",
    "number.released",
]


class MessagingWebhookEvent(TypedDict):
    """A verified Messaging delivery (``verify_messaging_webhook``). ``event_type`` may be newer
    than ``MESSAGING_EVENT_TYPES``: ``if is_known_messaging_webhook_event(event):`` narrows it to a
    ``KnownMessagingWebhookEvent``. A known ``message.*`` event carries ``data["message"]`` and a
    ``number.*`` event ``data["number"]``, each with an ``id``."""

    type: Literal["event"]
    event_id: str
    """Deterministic per provider event; also the ``webhook-id`` header. Dedupe on it."""
    event_type: str
    data: dict[str, Any]


class KnownMessagingWebhookEvent(TypedDict):
    """A verified Messaging delivery of a type this SDK knows (``is_known_messaging_webhook_event``)."""

    type: Literal["event"]
    event_id: str
    """Deterministic per provider event; also the ``webhook-id`` header. Dedupe on it."""
    event_type: MessagingEventType
    data: dict[str, Any]
    """``{"message": {...}}`` for ``message.*`` events, ``{"number": {...}}`` for ``number.*``."""


# ── Box ───────────────────────────────────────────────────────────────────────


class Box(TypedDict, total=False):
    """A Box (``box.list``/``get``/``create``/``resume``/``fork``)."""

    id: str
    """The Box id (``bx_<32 hex>``)."""
    name: str
    """The name given at creation."""
    size: str
    """``small``, ``default`` or ``large``; a larger size has more vCPU and memory and counts for more resource
    units."""
    status: str
    """``provisioning`` while the machine is created and set up, ``ready`` once commands can run, ``running`` while a
    foreground command runs, ``stopped`` after a stop (resume it to run again), ``error`` when provisioning or a
    resume failed (see ``lastError``), ``deleted`` once removed."""
    image: str
    """The container image the Box booted from."""
    driver: str
    """The driver that runs the Box, such as ``docker``."""
    network: str
    """``none``: no outbound network. ``egress``: any outbound host. ``allowlist``: only ``allowedHosts``."""
    allowedHosts: list[str]
    """Hosts reachable with the ``allowlist`` network."""
    envNames: list[str]
    """Names of the environment variables set at creation; values are never returned."""
    secrets: list[str]
    """Names of the tenant secrets exposed to every command."""
    repo: Optional[dict[str, Any]]
    """The repository cloned at creation, without credentials, or null."""
    snapshotId: Optional[str]
    """The snapshot the Box booted from, or null."""
    ttlSeconds: Optional[int]
    """Lifetime from creation before the Box expires; null for none."""
    lastError: Optional[str]
    """Why the Box last failed or needs attention, for a person; null when nothing is wrong."""
    stoppedAt: Optional[str]
    """When the Box was last stopped; null while it is not stopped."""
    createdAt: str
    """When the Box was created."""
    updatedAt: str
    """When the Box last changed."""


class BoxExecResult(TypedDict, total=False):
    """``box.exec``: a finished command."""

    exitCode: int
    """The command's exit code."""
    stdout: str
    """Everything written to stdout (truncated past the output limit)."""
    stderr: str
    """Everything written to stderr (truncated past the output limit)."""
    durationMs: int
    """How long the command ran, in milliseconds."""


class BoxCommandParts(TypedDict):
    """The exec route's ``command`` (one shell word or line) and its ``args`` (``box.command_parts``)."""

    command: str
    args: list[str]


class BoxRun(TypedDict, total=False):
    """``box.run``: the Box as last read and the command's result."""

    box: Box
    result: BoxExecResult


# ── Gateway ───────────────────────────────────────────────────────────────────


class GatewayModel(TypedDict, total=False):
    id: str
    object: str
    owned_by: str
    created: int


class GatewayModelList(TypedDict, total=False):
    """``gateway.models.list``, in the OpenAI ``{object, data}`` shape."""

    object: str
    data: list[GatewayModel]


class GatewayChatCompletion(TypedDict, total=False):
    """A non-streamed chat completion in the OpenAI shape."""

    id: str
    object: str
    created: int
    model: str
    choices: list[dict[str, Any]]
    """``[{"index", "message": {"role", "content", "tool_calls"?}, "finish_reason"}]``."""
    usage: Optional[dict[str, Any]]


class GatewayOpenAICompatibleConfig(TypedDict):
    """``gateway.openai_compatible()``: the keyword arguments ``openai.OpenAI`` takes."""

    base_url: str
    """The Gateway base URL plus ``/v1``."""
    api_key: str
    """``RYU_GATEWAY_TOKEN``, or ``""`` when none is configured."""


# ── Connect ───────────────────────────────────────────────────────────────────


class ConnectMcpHeaders(TypedDict):
    """``connect.mcp()["headers"]``."""

    Authorization: str
    """``"Bearer <runtime key>"``."""


class ConnectMcpConfig(TypedDict):
    """``connect.mcp()``: MCP client settings for Connect's own MCP server."""

    type: Literal["http"]
    """Streamable HTTP, as MCP client configs name it."""
    url: str
    """The Connect base URL plus ``/mcp``."""
    headers: ConnectMcpHeaders
    """``{"Authorization": "Bearer <runtime key>"}``."""


class ConnectUsageLine(TypedDict, total=False):
    """One billing receipt line (``connect.usage``, ``connect.usage.iterate``)."""

    at: str
    transactionId: str
    usage: dict[str, Any]


class ConnectUnresolvedReceipt(TypedDict, total=False):
    """A receipt that can never be read; listed on the first page only."""

    at: str
    reason: str
    transactionId: str


#: ``ConnectUsageReport``'s ``from`` key: a keyword, so it is declared in functional form.
_ConnectUsageReportFrom = TypedDict(
    "_ConnectUsageReportFrom",
    {
        #: Window start, clipped to retained data.
        "from": str,
    },
    total=False,
)


class ConnectUsageReport(_ConnectUsageReportFrom, total=False):
    """``connect.usage``: one page of billing receipts in a window; ``from`` is on its base."""

    ok: Literal[True]
    """Always ``true``."""
    type: Literal["usage.report"]
    """Always ``usage.report``."""
    to: str
    """Window end."""
    lines: list[ConnectUsageLine]
    """One page of billed Composio calls: when (``at``), the provider ``transactionId``, and its ``usage`` metadata."""
    nextCursor: Optional[str]
    """Repeat the request with the same window and ``cursor`` set to it."""
    unresolved: list[ConnectUnresolvedReceipt]
    """Receipts that can never be read; first page only."""


# ── Passport ──────────────────────────────────────────────────────────────────


class PassportConnection(TypedDict, total=False):
    """A connection's status metadata; Passport never returns credential state."""

    id: str
    """``conn_…``."""
    profile_id: str
    """Your own id for whose credentials these are."""
    domain: str
    """The host the connection may fetch."""
    status: str
    """Durable state: ``AUTHENTICATED`` holds sealed credential state; ``NEEDS_AUTH`` needs a login."""
    flow_status: str
    """Transient login-flow state."""
    source: str
    """The credential source that captured it; ``manual`` by default."""
    last_checked: int
    """Unix seconds of the last health check; 0 when never checked."""
    created_at: int
    """Unix seconds."""
    updated_at: int
    """Unix seconds."""


class PassportProfile(TypedDict, total=False):
    profile_id: str
    """The profile id."""
    connections: list[PassportConnection]
    """The profile's connections."""


class PassportProfileList(TypedDict, total=False):
    """``passport.profiles.list``."""

    profiles: list[PassportProfile]
    """Every profile that has a connection."""


class PassportConnectionList(TypedDict, total=False):
    """``passport.connections.list`` and ``passport.runtime.connections.list``."""

    connections: list[PassportConnection]
    """The connections."""


class PassportFetchResult(TypedDict, total=False):
    """``passport.connections.fetch``: the upstream answer, credential values redacted."""

    status: int
    """The upstream HTTP status."""
    authenticated: bool
    """Whether a credential was attached, not whether the provider accepted it."""
    content: str
    """The upstream body as text, with credential values redacted."""
    truncated: bool
    """True when ``content`` was cut to ``maxContentChars``."""
    wwwAuthenticate: list[str]
    """Upstream payment challenges on a 402."""


# ── Sites ─────────────────────────────────────────────────────────────────────


class SitesTool(TypedDict, total=False):
    """One Site tool a version exposes to agents over the Site's MCP server."""

    name: str
    """The tool name: lowercase letters, digits and underscores."""
    description: str
    """What the tool does, as agents see it."""
    operation: str
    """What the tool runs: ``records.list``, ``records.set``, ``records.delete`` or ``knowledge.search``."""
    collection: str
    """Which records collection the tool works on. Default ``data``."""


class SitesExtensions(TypedDict, total=False):
    """The Site tools saved with a version (the Site's ``extensions`` setting when it was saved).

    Sites stores every field; a version from before Site tools has no ``extensions`` at all.
    """

    mcp: bool
    """Whether the Site serves an MCP server."""
    ui: bool
    """Whether the Site's MCP server offers the Site as a UI view."""
    tools: list[SitesTool]
    """The Site's tools."""
    connections: list[str]
    """Owner connector binding ids the Site may call."""


class SitesDomainBinding(TypedDict, total=False):
    """One custom domain bound to a Site."""

    host: str
    """The custom host name."""
    status: str
    """The binding's state: ``pending_dns``, ``pending_tls``, ``active`` or ``failed``."""
    verification: str
    """The DNS verification value to publish for the host."""
    checkedAt: Optional[str]
    """When the binding was last checked, or null before the first check."""


class SitesConnection(TypedDict, total=False):
    """One owner-managed connector binding visitors may use."""

    id: str
    """The binding id."""
    label: str
    """The binding's name, as visitors see it."""
    description: str
    """What the binding is for, as visitors see it."""
    toolId: str
    """The Ryu tool the binding runs."""
    agentId: str
    """The agent the tool runs under."""
    readOnly: bool
    """Whether the binding only reads."""
    revision: int
    """Increases with every material change; a new revision asks visitors to consent again."""
    updatedAt: str
    """When the binding last changed."""
    updatedBy: str
    """Who last changed the binding."""


class SitesRemixSource(TypedDict, total=False):
    """The Site and version a Site was remixed or duplicated from."""

    siteId: str
    """The source Site's id."""
    versionId: str
    """The source version the copy was made from."""
    name: str
    """The source Site's name when the copy was made."""


class SitesVersion(TypedDict, total=False):
    id: str
    """The version id."""
    message: str
    """The note saved with the version."""
    commit: Optional[str]
    """The git commit SHA recorded with the version, or null."""
    bytes: int
    """The saved HTML's size in bytes."""
    extensions: SitesExtensions
    """The Site tools saved with the version (the Site's ``extensions`` setting when it was saved). Absent on
    versions saved before Site tools existed."""
    createdAt: str
    """When the version was saved."""


class SitesProject(TypedDict, total=False):
    """A Site (``sites.projects.list``/``get``/``create``)."""

    id: str
    """The Site id."""
    name: str
    """The Site's display name."""
    slug: str
    """The Site's URL name."""
    prompt: str
    """The Site brief."""
    template: str
    """The template the Site started from."""
    ownerId: str
    """The user who owns the Site."""
    access: str
    """What the caller may do with the Site: ``owner``, ``editor`` or ``viewer``."""
    aliases: list[str]
    """Earlier URL names that redirect here."""
    revision: int
    """Increases with every change; send it as ``expectedRevision`` so a stale change is refused with ``conflict``."""
    settings: dict[str, Any]
    """The Site's settings. Owner-only settings, such as the AI instructions, are blank for editors and viewers."""
    hasPublished: bool
    """True once any version has been deployed."""
    deploymentId: Optional[str]
    """The deployed version, or null while unpublished."""
    versions: list[SitesVersion]
    """Saved versions."""
    schemaVersion: int
    """The stored record's format version; always 1."""
    domains: list[SitesDomainBinding]
    """Custom domain bindings: each ``host``, its ``status`` (``pending_dns``, ``pending_tls``, ``active`` or
    ``failed``), its DNS ``verification`` value and when it was last checked."""
    connections: list[SitesConnection]
    """Owner-managed connector bindings visitors may use."""
    remixedFrom: Optional[SitesRemixSource]
    """The Site and version this one was remixed or duplicated from. Sites sets it only on a remix or duplicate; on
    any other Site the key is absent."""
    createdAt: str
    """When the Site was created."""
    updatedAt: str
    """When the Site last changed."""


class SitesSealing(TypedDict, total=False):
    """The Sites store's sealing health, in ``sites.status``."""

    store: str
    """The sealed store's name."""
    state: str
    """The store key's state, or ``unmanaged``."""
    sealing: str
    """``ok``, ``waiting for a Ryu update``, ``key mismatch``, ``no key`` or ``unmanaged``."""
    unreadableRows: int
    """How many rows cannot be read."""
    vacuumPending: bool
    """Whether a vacuum is pending."""


class SitesStatus(TypedDict, total=False):
    """``sites.status``.

    The ``*Available`` flags say which runtime services the host wired in: check
    ``identityAvailable`` before relying on signed-in visitors, ``domainsAvailable``
    before adding a custom domain (without an edge readiness check a verified
    domain stays ``pending_tls``), and so on.
    """

    apiVersion: str
    """Always ``v1``."""
    baseDomain: str
    """The visitor domain suffix; a Site answers at ``<slug>.<baseDomain>``."""
    mode: str
    """``standalone``: the Sites service runs on its own. ``core``: it runs as a Ryu Core app sidecar."""
    publicEnabled: bool
    """Whether the operator allows the public audience (``RYU_SITES_PUBLIC=1``, or the runtime config's
    ``publicEnabled`` when that variable is unset)."""
    visitorPort: int
    """The port the visitor listener serves Sites on; a ``localhost`` base domain serves
    ``http://<slug>.localhost:<visitorPort>/``."""
    limits: dict[str, int]
    """This runtime's limits, by name, such as ``projects``, ``versions``, ``totalArtifactBytes``, ``records``,
    ``files``, ``fileBytes`` and their per-visitor shares. Names ending in ``Bytes`` are sizes in bytes; names ending
    in ``Percent`` are percentages; names ending in ``PerMinute`` or ``PerDay`` are rates per minute or per UTC day,
    and ``connectionCallsPerVisitor`` is also per UTC day. Other names are counts. Read the values here rather than
    hard-coding them."""
    identityAvailable: bool
    retrievalAvailable: bool
    answersAvailable: bool
    completionsAvailable: bool
    databaseAvailable: bool
    agentAvailable: bool
    scannerAvailable: bool
    connectionsAvailable: bool
    ownerConnectionsAvailable: bool
    domainsAvailable: bool
    mcpAvailable: bool
    pluginInstallAvailable: bool
    mcpUiAvailable: bool
    sealing: SitesSealing
    """Whether the Sites store's sealed content is readable."""


class SitesDeployResult(TypedDict, total=False):
    """``sites.deploy``."""

    project: SitesProject
    version: SitesVersion
    url: str


# ── Managed Agents ────────────────────────────────────────────────────────────


class ManagedAgent(TypedDict, total=False):
    """A Managed Agents agent definition (latest version)."""

    id: str
    """``magt_…``"""
    name: str
    """The agent's name."""
    description: Optional[str]
    """What the agent does, for people; null when unset."""
    instructions: Optional[str]
    """The system instructions every session starts with; null when unset."""
    model: Optional[str]
    """The model id the backend runs; null for the backend's default."""
    reasoningEffort: Optional[str]
    """How much the model reasons before answering, where the backend supports it; null for the backend's default."""
    tools: list[dict[str, Any]]
    """The built-in and custom tools the agent may call."""
    mcpServers: list[dict[str, Any]]
    """The remote MCP servers the agent may call."""
    metadata: dict[str, str]
    """Your own string key-value data."""
    version: int
    """The latest version."""
    archivedAt: Optional[str]
    """RFC 3339 UTC with milliseconds."""
    createdAt: str
    """RFC 3339 UTC with milliseconds."""
    updatedAt: str
    """RFC 3339 UTC with milliseconds."""


class ManagedAgentPage(TypedDict, total=False):
    """One page of ``managed_agents.agents.list``."""

    data: list[ManagedAgent]
    """The agents on this page."""
    nextCursor: Optional[str]
    """Send as ``cursor`` for the next page; null on the last page."""


class ManagedAgentEnvironment(TypedDict, total=False):
    """A Managed Agents environment (``managed_agents.environments.create``/``get``)."""

    id: str
    """``menv_…``"""
    name: str
    """The environment's name, unique among the organization's non-archived environments."""
    description: Optional[str]
    """What the environment is for, for people; null when unset."""
    backend: str
    """Where sessions run: a vendor's hosted agent API, a Ryu node, or Ryu serverless."""
    credential: dict[str, Any]
    """Which credential sessions use: a stored one of your own (``byok``), the platform's, or none."""
    config: dict[str, Any]
    """The backend's settings with its defaults filled (see the Managed Agents API page)."""
    revision: int
    """Starts at 1 and increases by one per accepted update."""
    archivedAt: Optional[str]
    """RFC 3339 UTC with milliseconds."""
    createdAt: str
    """RFC 3339 UTC with milliseconds."""
    updatedAt: str
    """RFC 3339 UTC with milliseconds."""


class ManagedAgentEnvironmentPage(TypedDict, total=False):
    data: list[ManagedAgentEnvironment]
    """The environments on this page."""
    nextCursor: Optional[str]
    """Send as ``cursor`` for the next page; null on the last page."""


class ManagedAgentSession(TypedDict, total=False):
    """A Managed Agents session."""

    id: str
    """``msess_…``"""
    agentId: str
    """The agent the session runs (``magt_…``)."""
    agentVersion: int
    """The agent version pinned at creation."""
    environmentId: str
    """The environment the session runs in (``menv_…``)."""
    environmentRevision: int
    """The environment revision pinned at creation."""
    backend: str
    """The environment's backend."""
    status: str
    """``pending`` until the backend is provisioned, ``running`` during a turn, ``idle`` between turns (see
    ``stopReason``), then one of the terminal statuses ``completed``, ``failed`` or ``canceled``."""
    stopReason: Optional[str]
    """Why the last turn ended; null after provisioning."""
    pendingToolUseIds: list[str]
    """Custom tool calls waiting for your ``user.custom_tool_result`` event."""
    headSeq: int
    """The last event's ``seq``. Advisory: it may lag the log briefly; the events list's ``headSeq`` is the live
    tail."""
    title: Optional[str]
    """A title to recognize the session by; null when unset."""
    metadata: dict[str, str]
    """Your own string key-value data."""
    usage: dict[str, Any]
    """Cumulative usage for the session."""
    billedMicroUsd: int
    """Platform credit debited so far, in micro-USD; 0 for your own credential (``byok``) and for nodes."""
    budget: Optional[dict[str, Any]]
    """The cap on the session's cumulative list cost (``maxCostMicroUsd``, micro-USD); when it is reached the turn
    stops with ``budget_reached``. Null for none."""
    lastError: Optional[dict[str, Any]]
    """The last error's ``code`` and ``message``; null when none."""
    closing: Optional[dict[str, Any]]
    """Set while a cancel or complete request is being applied: the terminal status it moves to (``target``) and when
    it was requested. Null otherwise."""
    startedAt: Optional[str]
    """RFC 3339 UTC with milliseconds."""
    endedAt: Optional[str]
    """RFC 3339 UTC with milliseconds."""
    createdAt: str
    """RFC 3339 UTC with milliseconds."""
    updatedAt: str
    """RFC 3339 UTC with milliseconds."""


class ManagedAgentSessionPage(TypedDict, total=False):
    """One page of ``managed_agents.sessions.list``."""

    data: list[ManagedAgentSession]
    """The sessions on this page."""
    nextCursor: Optional[str]
    """Send as ``cursor`` for the next page; null on the last page."""


class ManagedAgentEvent(TypedDict, total=False):
    """One session log event. ``type`` decides the other fields (``content``, ``toolUseId``,
    ``status``, ``stopReason``, ...)."""

    id: str
    """``mevt_…``"""
    seq: int
    """Starts at 1, gap-free and increasing per session."""
    sessionId: str
    """The session the event belongs to (``msess_…``)."""
    type: str
    """One of ``user.message``, ``user.interrupt``, ``user.custom_tool_result``, ``user.tool_approval``,
    ``agent.message``, ``agent.message.delta``, ``agent.tool_use``, ``agent.tool_result``, ``agent.custom_tool_use``,
    ``agent.tool_approval_request``, ``session.status``, ``session.error``, ``session.usage``. Ignore types you do
    not know; new ones can appear in v1."""
    createdAt: str
    """RFC 3339 UTC with milliseconds."""
    content: list[dict[str, Any]]
    toolUseId: str
    name: str
    input: Any
    status: str
    stopReason: Optional[str]
    pendingToolUseIds: list[str]
    decision: str
    message: Optional[str]


class ManagedAgentEventPage(TypedDict, total=False):
    """One page of ``managed_agents.sessions.events``."""

    data: list[ManagedAgentEvent]
    """Events in ``seq`` order."""
    hasMore: bool
    """True when more events follow ``nextAfter``."""
    nextAfter: int
    """Send as ``after`` for the next page."""
    headSeq: int
    """The log's tail at read time."""


__all__ = [
    "Box",
    "BoxCommandParts",
    "BoxExecResult",
    "BoxRun",
    "ConnectMcpConfig",
    "ConnectMcpHeaders",
    "ConnectUnresolvedReceipt",
    "ConnectUsageLine",
    "ConnectUsageReport",
    "GatewayChatCompletion",
    "GatewayModel",
    "GatewayModelList",
    "GatewayOpenAICompatibleConfig",
    "KnownMailWebhookEvent",
    "KnownMessagingWebhookEvent",
    "MailAttachment",
    "MailEventType",
    "MailInbox",
    "MailInboxCreatedWith",
    "MailMessage",
    "MailRealtimeTicket",
    "MailStatus",
    "MailWebhookEvent",
    "ManagedAgent",
    "ManagedAgentEnvironment",
    "ManagedAgentEnvironmentPage",
    "ManagedAgentEvent",
    "ManagedAgentEventPage",
    "ManagedAgentPage",
    "ManagedAgentSession",
    "ManagedAgentSessionPage",
    "ManagedAgentsRunResult",
    "MessagingCredit",
    "MessagingEventType",
    "MessagingMessage",
    "MessagingMessagePage",
    "MessagingNumber",
    "MessagingQuote",
    "MessagingStatus",
    "MessagingWebhookEvent",
    "NotifyApprovalResult",
    "NotifyEvent",
    "NotifyEventPage",
    "NotifyTopic",
    "NotifyUsageReport",
    "NotifyUsageWindow",
    "PassportConnection",
    "PassportConnectionList",
    "PassportFetchResult",
    "PassportProfile",
    "PassportProfileList",
    "SitesConnection",
    "SitesDeployResult",
    "SitesDomainBinding",
    "SitesExtensions",
    "SitesProject",
    "SitesRemixSource",
    "SitesSealing",
    "SitesStatus",
    "SitesTool",
    "SitesVersion",
]
