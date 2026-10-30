"""Webhook verification beyond the TypeScript vectors: options, header shapes, ryu.webhooks."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math

import pytest

from ryu_sdk.services import (
    Ryu,
    RyuConfigurationError,
    RyuWebhookVerificationError,
    is_known_mail_webhook_event,
    is_known_messaging_webhook_event,
    verify_mail_webhook,
    verify_notify_webhook,
    verify_webhook,
)

SECRET = "whsec_" + base64.b64encode(b"python-webhook-test-key").decode()
NOW = 1_800_000_000


def sign(secret: str, delivery_id: str, timestamp: int, body: str) -> str:
    key = base64.b64decode(secret[len("whsec_") :])
    digest = hmac.new(key, f"{delivery_id}.{timestamp}.{body}".encode(), hashlib.sha256).digest()
    return "v1," + base64.b64encode(digest).decode()


def mail_delivery(event_type: str = "message.received"):
    body = json.dumps({"type": "event", "event_type": event_type, "event_id": "evt_1", "data": {}})
    headers = {
        "Webhook-Id": "evt_1",
        "Webhook-Timestamp": str(NOW),
        "Webhook-Signature": sign(SECRET, "evt_1", NOW, body),
    }
    return body, headers


def test_mail_delivery_verifies_with_mixed_case_headers_and_bytes():
    body, headers = mail_delivery()
    event = verify_mail_webhook(payload=body.encode(), headers=headers, secret=SECRET, now=NOW)
    assert event["event_id"] == "evt_1" and is_known_mail_webhook_event(event)


def test_newer_event_types_verify_but_are_not_known():
    body, headers = mail_delivery("message.teleported")
    event = verify_mail_webhook(payload=body, headers=headers, secret=SECRET, now=NOW)
    assert not is_known_mail_webhook_event(event)
    assert not is_known_messaging_webhook_event({"event_type": "number.ported"})


def test_repeated_signature_headers_are_joined():
    body, headers = mail_delivery()
    signature = headers.pop("Webhook-Signature")
    pairs = list(headers.items()) + [("webhook-signature", "v1,AAAA"), ("webhook-signature", signature)]
    assert verify_mail_webhook(payload=body, headers=pairs, secret=SECRET, now=NOW)["event_id"] == "evt_1"


@pytest.mark.parametrize("tolerance", [-1, math.inf, math.nan, 86_401, True, 10**400, -(10**400)])
def test_unsafe_tolerances_are_refused(tolerance):
    body, headers = mail_delivery()
    with pytest.raises(RyuConfigurationError) as raised:
        verify_mail_webhook(payload=body, headers=headers, secret=SECRET, now=NOW, tolerance_seconds=tolerance)
    assert raised.value.code == "invalid_tolerance"


@pytest.mark.parametrize("now", [10**400, -(10**400), math.inf, -math.inf])
def test_a_now_past_float_range_is_a_timestamp_error_not_an_overflow(now):
    # TypeScript reads such a ``now`` as Infinity, so the skew check refuses the delivery.
    body, headers = mail_delivery()
    with pytest.raises(RyuWebhookVerificationError) as raised:
        verify_mail_webhook(payload=body, headers=headers, secret=SECRET, now=now)
    assert raised.value.code == "webhook_timestamp_out_of_range"
    assert "Infinitys from now" in str(raised.value)


def test_a_nan_now_fails_closed_instead_of_skipping_the_replay_check():
    # TypeScript refuses an Invalid Date ``now`` the same way (``standard.test.ts``).
    body, headers = mail_delivery()
    with pytest.raises(RyuWebhookVerificationError) as raised:
        verify_mail_webhook(payload=body, headers=headers, secret=SECRET, now=math.nan)
    assert raised.value.code == "webhook_timestamp_out_of_range"
    assert "NaNs from now" in str(raised.value)


def test_reserialized_json_fails_verification():
    body, headers = mail_delivery()
    reserialized = json.dumps(json.loads(body), indent=2)
    with pytest.raises(RyuWebhookVerificationError) as raised:
        verify_mail_webhook(payload=reserialized, headers=headers, secret=SECRET, now=NOW)
    assert raised.value.code == "webhook_invalid_signature" and raised.value.retryable is False


def test_notify_body_only_signature_is_refused_unless_explicitly_allowed():
    body = json.dumps({"deliveryId": "dlv_1", "event": {"id": "evt_1"}, "type": "notification"})
    signature = "sha256=" + hmac.new(b"s3cret", body.encode(), hashlib.sha256).hexdigest()
    headers = {"x-ryu-notify-signature": signature}
    # A captured delivery with the webhook-* headers dropped must not replay: refused by default.
    with pytest.raises(RyuWebhookVerificationError) as refused:
        verify_notify_webhook(payload=body, headers=headers, secret="s3cret")
    assert refused.value.code == "webhook_missing_headers"
    assert "allow_body_only_signature" in str(refused.value)
    delivery = verify_notify_webhook(payload=body, headers=headers, secret="s3cret", allow_body_only_signature=True)
    assert delivery.replay_protected is False and delivery.delivery_id == "dlv_1" and delivery.event_id == "evt_1"
    # ``require_timestamp=False`` is the same explicit opt-in.
    assert (
        verify_notify_webhook(payload=body, headers=headers, secret="s3cret", require_timestamp=False).replay_protected
        is False
    )
    # ``require_timestamp=True`` wins over the opt-in, and ``allow_body_only_signature=False`` stays refused.
    for options in (
        {"require_timestamp": True},
        {"require_timestamp": True, "allow_body_only_signature": True},
        {"allow_body_only_signature": False},
    ):
        with pytest.raises(RyuWebhookVerificationError):
            verify_notify_webhook(payload=body, headers=headers, secret="s3cret", **options)
    with pytest.raises(RyuWebhookVerificationError):
        verify_webhook(service="notify", payload=body, headers=headers, secret="s3cret")
    assert (
        verify_webhook(
            service="notify", payload=body, headers=headers, secret="s3cret", allow_body_only_signature=True
        ).replay_protected
        is False
    )


def test_ryu_webhooks_dispatches_by_service():
    body, headers = mail_delivery()
    ryu = Ryu(env=False)
    assert (
        ryu.webhooks.verify(service="mail", payload=body, headers=headers, secret=SECRET, now=NOW)["event_id"]
        == "evt_1"
    )
    assert (
        verify_webhook(service="mail", payload=body, headers=headers, secret=SECRET, now=NOW)["event_type"]
        == "message.received"
    )
    with pytest.raises(RyuConfigurationError):
        verify_webhook(service="box", payload=body, headers=headers, secret=SECRET)


def test_ryu_webhooks_return_results_in_object_mode():
    body, headers = mail_delivery()
    ryu = Ryu(env=False, result="object")
    ok = ryu.webhooks.verify(service="mail", payload=body, headers=headers, secret=SECRET, now=NOW)
    assert ok.error is None and ok.data["event_id"] == "evt_1"
    bad = ryu.webhooks.verify(service="mail", payload=body + " ", headers=headers, secret=SECRET, now=NOW)
    assert bad.data is None and isinstance(bad.error, RyuWebhookVerificationError)


def test_ryu_webhooks_matches_typescript_and_the_per_service_aliases_are_deprecated():
    # TypeScript's RyuWebhooks has verify() only; the Python-only aliases warn and still work.
    deprecated = {"verify_mail", "verify_messaging", "verify_notify"}
    public = {name for name in dir(Ryu(env=False).webhooks) if not name.startswith("_")}
    assert public - deprecated == {"verify"}
    body, headers = mail_delivery()
    for mode in ("throw", "object"):
        ryu = Ryu(env=False, result=mode)
        with pytest.warns(DeprecationWarning, match=r'verify\(service="mail"'):
            verified = ryu.webhooks.verify_mail(payload=body, headers=headers, secret=SECRET, now=NOW)
        assert (verified if mode == "throw" else verified.data)["event_id"] == "evt_1"
    with pytest.warns(DeprecationWarning) as caught:
        result = Ryu(env=False, result="object").webhooks.verify_mail(
            payload=body + " ", headers=headers, secret=SECRET, now=NOW
        )
    assert caught[0].filename == __file__  # the warning points at the caller
    assert isinstance(result.error, RyuWebhookVerificationError)


@pytest.mark.parametrize("kind", ["Destination", "approval", "", None])
def test_an_unknown_notify_kind_is_refused_before_any_downgrade(kind):
    body = json.dumps({"deliveryId": "dlv_1", "event": {"id": "evt_1"}})
    signature = "sha256=" + hmac.new(b"notify-secret", body.encode(), hashlib.sha256).hexdigest()
    with pytest.raises(RyuConfigurationError) as raised:
        verify_notify_webhook(
            payload=body,
            headers={"x-ryu-notify-signature": signature},
            secret="notify-secret",
            kind=kind,
            require_timestamp=True,
        )
    assert raised.value.code == "invalid_option"
    # The same delivery with the right kind is refused for lacking a timestamp.
    with pytest.raises(RyuWebhookVerificationError) as refused:
        verify_notify_webhook(
            payload=body,
            headers={"x-ryu-notify-signature": signature},
            secret="notify-secret",
            kind="destination",
            require_timestamp=True,
        )
    assert refused.value.code == "webhook_missing_headers"


@pytest.mark.parametrize("scheme", ["Legacy", "svix", ""])
def test_an_unknown_scheme_is_refused(scheme):
    body, headers = mail_delivery()
    with pytest.raises(RyuConfigurationError) as raised:
        verify_mail_webhook(payload=body, headers=headers, secret=SECRET, scheme=scheme, now=NOW)
    assert raised.value.code == "invalid_option"
    result = Ryu(env=False, result="object").webhooks.verify(
        service="mail", payload=body, headers=headers, secret=SECRET, scheme=scheme, now=NOW
    )
    assert result.error.code == "invalid_option"


@pytest.mark.parametrize(
    ("service", "title"), [("mail", "Ryu Mail"), ("messaging", "Ryu Messaging"), ("notify", "Ryu Notify")]
)
@pytest.mark.parametrize("secret", [None, "", 42])
def test_an_unset_secret_is_webhook_invalid_secret_not_attribute_error(service, title, secret):
    # os.environ.get("MAIL_WEBHOOK_SECRET") gives None when the variable is unset.
    body, headers = mail_delivery()
    for delivery_headers in (headers, {}):
        with pytest.raises(RyuWebhookVerificationError) as caught:
            verify_webhook(service=service, payload=body, headers=delivery_headers, secret=secret, now=NOW)
        assert caught.value.code == "webhook_invalid_secret"
        assert caught.value.message == f"{title} webhook: the signing secret is empty."
