"""The Secret Vault client: exact wire contract (paths, headers, camelCase bodies) and redaction."""

from __future__ import annotations

import base64
import json
from typing import Any, Callable, Optional

import httpx
import pytest

from ryu_sdk.services.errors import RyuInvalidRequestError, RyuNotFoundError, RyuPermissionError, RyuServerError
from ryu_sdk.services.vault import VaultAgentClient, VaultClient

URL = "http://node.test:7980/"


class Recorder:
    def __init__(self, reply: Optional[Callable[[httpx.Request], httpx.Response]] = None) -> None:
        self.requests: list[httpx.Request] = []
        self._reply = reply or (lambda _request: httpx.Response(200, json={"ok": True}))

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self._reply(request)

    @property
    def last(self) -> httpx.Request:
        return self.requests[-1]

    def body(self) -> Any:
        content = self.last.content
        return json.loads(content) if content else None

    def target(self) -> str:
        url = self.last.url
        return url.raw_path.decode("ascii")


def human(recorder: Recorder, **options: Any) -> VaultClient:
    return VaultClient(
        URL, token="node-bearer", http_client=httpx.Client(transport=httpx.MockTransport(recorder)), **options
    )


def agent(recorder: Recorder) -> VaultAgentClient:
    return VaultAgentClient(URL, "rvt_.machine", http_client=httpx.Client(transport=httpx.MockTransport(recorder)))


def test_secret_values_use_core_paths_and_camelcase_coordinates():
    rec = Recorder(lambda _r: httpx.Response(200, json={"value": "s3cret"}))
    vault = human(rec, user_jwt="user-jwt")
    reply = vault.secrets.get("DB URL", scope="team", scope_id="t1", environment="prod", binding_id="mcp1", version=3)
    assert rec.last.method == "POST"
    assert rec.target() == "/api/vault/secrets/DB%20URL/reveal"
    assert rec.body() == {
        "scope": "team",
        "scopeId": "t1",
        "environment": "prod",
        "binding": {"id": "mcp1", "kind": "mcp"},
        "version": 3,
    }
    assert rec.last.headers["authorization"] == "Bearer node-bearer"
    assert rec.last.headers["x-ryu-user-jwt"] == "user-jwt"
    assert reply["value"] == "s3cret"
    assert "s3cret" not in repr(reply) and "s3cret" not in str(reply)

    vault.secrets.list(environment="prod", recursive=False, include_deleted=True)
    assert rec.target() == "/api/vault/secrets?environment=prod&recursive=false&includeDeleted=true"
    vault.secrets.put("K", scope="node", value="v", metadata={"tags": ["a"]}, expected_version=2)
    assert (rec.last.method, rec.body()) == (
        "PUT",
        {"scope": "node", "value": "v", "metadata": {"tags": ["a"]}, "expectedVersion": 2},
    )
    vault.secrets.delete("K", scope="node", path="/app")
    assert (rec.last.method, rec.target(), rec.body()) == (
        "DELETE",
        "/api/vault/secrets/K",
        {"scope": "node", "path": "/app"},
    )
    vault.secrets.versions("K", scope="node", binding_id="m")
    assert rec.target() == "/api/vault/secrets/K/versions?scope=node&mcpId=m"
    vault.secrets.rollback("K", 4, scope="node")
    assert (rec.target(), rec.body()) == ("/api/vault/secrets/K/rollback", {"scope": "node", "version": 4})
    vault.secrets.restore("K", scope="node")
    assert rec.target() == "/api/vault/secrets/K/restore"
    vault.secrets.destroy("K", scope="node", versions=[1, 2])
    assert rec.body() == {"scope": "node", "versions": [1, 2]}
    vault.secrets.wrap("K", "5m", scope="node")
    assert rec.last.headers["x-ryu-wrap-ttl"] == "5m"


def test_dynamic_credentials_and_leases():
    rec = Recorder(
        lambda _r: httpx.Response(200, json={"credential": {"data": {"password": "pw"}, "lease": {"id": "l1"}}})
    )
    vault = human(rec)
    reply = vault.dynamic.issue("db", ttl_secs=60)
    assert (rec.target(), rec.body()) == ("/api/vault/dynamic/issue/db", {"ttlSecs": 60})
    assert reply["credential"]["data"]["password"] == "pw"
    assert "pw" not in repr(reply) and "'l1'" in repr(reply)
    vault.dynamic.issue("db")
    assert rec.body() == {}
    vault.dynamic.put_role("db", {"kind": "random", "charset": "hex", "length": 8}, default_ttl_secs=30)
    assert (rec.last.method, rec.body()) == (
        "PUT",
        {"defaultTtlSecs": 30, "provider": {"kind": "random", "charset": "hex", "length": 8}},
    )
    vault.dynamic.revoke_all("db")
    assert (rec.target(), rec.last.content) == ("/api/vault/dynamic/roles/db/revoke-all", b"")
    vault.dynamic.delete_role("db")
    assert rec.last.method == "DELETE"
    vault.leases.list(role="db", include_revoked=True)
    assert rec.target() == "/api/vault/leases?role=db&includeRevoked=true"
    vault.leases.renew("l1", ttl_secs=10)
    assert (rec.target(), rec.body()) == ("/api/vault/leases/l1/renew", {"ttlSecs": 10})
    vault.leases.revoke("l1")
    assert (rec.target(), rec.body()) == ("/api/vault/leases/l1/revoke", {})


def test_transit_operations_encode_bytes_as_base64():
    rec = Recorder(lambda _r: httpx.Response(200, json={"plaintext": "c2VjcmV0", "ciphertext": "ryu:v1:x"}))
    vault = human(rec)
    vault.transit.encrypt("k", b"hello", context=b"ctx", key_version=2)
    assert rec.target() == "/api/vault/transit/encrypt/k"
    assert rec.body() == {
        "plaintext": base64.b64encode(b"hello").decode(),
        "context": base64.b64encode(b"ctx").decode(),
        "keyVersion": 2,
    }
    reply = vault.transit.datakey("k")
    assert (rec.target(), rec.body()) == ("/api/vault/transit/datakey/k", {})
    assert "c2VjcmV0" not in repr(reply) and "ryu:v1:x" in repr(reply)
    for op, call in (
        ("decrypt", lambda: vault.transit.decrypt("k", "ryu:v1:x")),
        ("rewrap", lambda: vault.transit.rewrap("k", "ryu:v1:x")),
        ("sign", lambda: vault.transit.sign("k", "aGk=", signature_algorithm="pss")),
        ("verify", lambda: vault.transit.verify("k", "aGk=", hmac="ryu:v1:h")),
        ("hmac", lambda: vault.transit.hmac("k", b"hi")),
        ("rotate", lambda: vault.transit.rotate("k")),
    ):
        call()
        assert rec.target() == f"/api/vault/transit/{op}/k"
    assert vault.transit.verify("k", "aGk=", signature="sig") and rec.body() == {"signature": "sig", "input": "aGk="}
    vault.transit.create_key("k", type="ed25519")
    assert (rec.target(), rec.body()) == ("/api/vault/transit/keys", {"name": "k", "type": "ed25519"})
    vault.transit.configure_key("k", deletion_allowed=True, min_decryption_version=2)
    assert (rec.last.method, rec.body()) == ("PATCH", {"deletionAllowed": True, "minDecryptionVersion": 2})


def test_tokens_wrapping_machines_and_logins():
    rec = Recorder(lambda _r: httpx.Response(200, json={"token": {"token": "rvt_.secret", "accessor": "acc"}}))
    vault = human(rec)
    issued = vault.tokens.create("ci", policies=["read"], ttl_secs=60, num_uses=1)
    assert (rec.target(), rec.body()) == (
        "/api/vault/tokens",
        {"policies": ["read"], "ttlSecs": 60, "numUses": 1, "identity": "ci"},
    )
    assert "rvt_.secret" not in repr(issued) and "'acc'" in repr(issued)
    vault.tokens.lookup("acc")
    assert (rec.last.method, rec.target()) == ("GET", "/api/vault/tokens/acc")
    vault.tokens.renew("acc", increment_secs=30)
    assert (rec.target(), rec.body()) == ("/api/vault/tokens/acc/renew", {"incrementSecs": 30})
    vault.tokens.revoke("acc")
    assert rec.target() == "/api/vault/tokens/acc/revoke"
    vault.tokens.revoke_orphan("acc")
    assert rec.target() == "/api/vault/tokens/acc/revoke-orphan"
    vault.tokens.list(identity="ci")
    assert rec.target() == "/api/vault/tokens?identity=ci"

    vault.wrapping.wrap({"a": 1}, ttl=300)
    assert (rec.target(), rec.body(), rec.last.headers["x-ryu-wrap-ttl"]) == (
        "/api/vault/sys/wrapping/wrap",
        {"a": 1},
        "300",
    )
    for verb in ("unwrap", "lookup", "rewrap"):
        getattr(vault.wrapping, verb)("wrap-tok")
        assert (rec.target(), rec.body()) == (f"/api/vault/sys/wrapping/{verb}", {"token": "wrap-tok"})
        assert "authorization" not in rec.last.headers
    assert "rvt_.secret" not in repr(vault.wrapping.unwrap("w"))

    vault.machines.create("ci", {"kind": "approle", "roleId": "r"}, policies=["p"], token_ttl_secs=60)
    assert rec.body() == {
        "auth": {"kind": "approle", "roleId": "r"},
        "name": "ci",
        "policies": ["p"],
        "tokenTtlSecs": 60,
    }
    vault.machines.issue_secret_id("m1", uses=1)
    assert (rec.target(), rec.body()) == ("/api/vault/machines/m1/secret-ids", {"uses": 1})
    vault.machines.revoke_secret_id("sa")
    assert (rec.last.method, rec.target()) == ("DELETE", "/api/vault/secret-ids/sa")

    for method, call, body in (
        ("approle", lambda: vault.auth.approle("r", "s"), {"roleId": "r", "secretId": "s"}),
        ("jwt", lambda: vault.auth.jwt("gh", "j"), {"identity": "gh", "jwt": "j"}),
        ("kubernetes", lambda: vault.auth.kubernetes("k8s", "sa"), {"identity": "k8s", "jwt": "sa"}),
        ("cert", lambda: vault.auth.cert("c", "PEM", "p"), {"identity": "c", "certificatePem": "PEM", "proof": "p"}),
    ):
        call()
        assert (rec.target(), rec.body()) == (f"/api/vault/auth/{method}/login", body)
        assert "authorization" not in rec.last.headers
    vault.auth.aws("aws", iam_request_url="dQ==", iam_request_body="Yg==", iam_request_headers="e30=")
    assert rec.body()["iamHttpRequestMethod"] == "POST" and rec.target() == "/api/vault/auth/aws/login"


def test_agent_client_sends_only_the_vault_token():
    rec = Recorder(lambda _r: httpx.Response(200, json={"value": "agent-secret"}))
    client = agent(rec)
    reply = client.secret("API_KEY", environment="prod")
    assert rec.target() == "/api/vault/agent/secrets/API_KEY?environment=prod"
    assert rec.last.headers["x-ryu-vault-token"] == "rvt_.machine"
    assert "authorization" not in rec.last.headers
    assert "agent-secret" not in repr(reply)
    assert "rvt_.machine" not in repr(client)
    for path, call, body in (
        ("/api/vault/agent/dynamic/db", lambda: client.issue_dynamic("db", ttl_secs=5), {"ttlSecs": 5}),
        ("/api/vault/agent/leases/l1/renew", lambda: client.leases.renew("l1"), {}),
        ("/api/vault/agent/transit/encrypt/k", lambda: client.transit.encrypt("k", "aGk="), {"plaintext": "aGk="}),
        ("/api/vault/agent/self/child", lambda: client.create_child(policies=["p"]), {"policies": ["p"]}),
        ("/api/vault/agent/export", lambda: client.export(names=["A"]), {"names": ["A"]}),
        (
            "/api/vault/agent/pki/issue/web",
            lambda: client.pki("issue", "web", {"commonName": "a"}),
            {"commonName": "a"},
        ),
        ("/api/vault/agent/ssh/sign/ops", lambda: client.ssh_sign("ops", {"publicKey": "k"}), {"publicKey": "k"}),
        ("/api/vault/agent/cubbyhole/x", lambda: client.cubbyhole_put("x", {"n": 1}), {"n": 1}),
    ):
        call()
        assert (rec.target(), rec.body()) == (path, body)
    client.wrap_secret("API_KEY", "1h")
    assert rec.last.headers["x-ryu-wrap-ttl"] == "1h" and rec.last.method == "GET"
    login = {"token": {"token": "rvt_.from-login"}}
    assert VaultAgentClient.from_login(URL, login)._vault_token == "rvt_.from-login"
    with pytest.raises(ValueError):
        client.pki("revoke", "web", {})


def test_vault_client_agent_shares_the_node_url():
    rec = Recorder()
    vault = human(rec)
    vault.agent("rvt_.child").self_()
    assert rec.target() == "/api/vault/agent/self"
    assert rec.last.headers["x-ryu-vault-token"] == "rvt_.child"
    assert "authorization" not in rec.last.headers


@pytest.mark.parametrize(
    ("status", "body", "error", "code"),
    [
        (403, {"error": "denied by policy"}, RyuPermissionError, None),
        (404, {"error": {"code": "not_found", "message": "no such value"}}, RyuNotFoundError, "not_found"),
        (400, {"code": "bad", "error": "bad input"}, RyuInvalidRequestError, "bad"),
        (500, "", RyuServerError, None),
    ],
)
def test_errors_map_status_and_core_codes(status: int, body: Any, error: type, code: Optional[str]):
    rec = Recorder(lambda _r: httpx.Response(status, json=body) if body else httpx.Response(status))
    with pytest.raises(error) as raised:
        human(rec).secrets.list()
    assert raised.value.status == status
    assert raised.value.service == "vault"
    if code:
        assert raised.value.code == code


def test_invalid_ids_are_refused_before_any_request():
    rec = Recorder()
    with pytest.raises(RyuInvalidRequestError):
        human(rec).secrets.get("..", scope="node")
    assert rec.requests == []
