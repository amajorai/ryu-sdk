package vault

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

type seen struct {
	method  string
	target  string
	headers http.Header
	body    any
}

type fake struct {
	t        *testing.T
	server   *httptest.Server
	requests []seen
	reply    func(r *http.Request) (int, string)
}

func newFake(t *testing.T, reply func(r *http.Request) (int, string)) *fake {
	t.Helper()
	f := &fake{t: t, reply: reply}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body any
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &body); err != nil {
				t.Errorf("non-JSON body %q", raw)
			}
		}
		f.requests = append(f.requests, seen{r.Method, r.URL.RequestURI(), r.Header.Clone(), body})
		status, text := 200, `{"ok":true}`
		if f.reply != nil {
			status, text = f.reply(r)
		}
		w.WriteHeader(status)
		_, _ = io.WriteString(w, text)
	}))
	t.Cleanup(f.server.Close)
	return f
}

func (f *fake) last() seen { return f.requests[len(f.requests)-1] }

func (f *fake) expect(method, target string, body any) {
	f.t.Helper()
	got := f.last()
	if got.method != method || got.target != target {
		f.t.Fatalf("got %s %s, want %s %s", got.method, got.target, method, target)
	}
	want, _ := json.Marshal(body)
	var normalized any
	_ = json.Unmarshal(want, &normalized)
	if body == nil {
		normalized = nil
	}
	if !reflect.DeepEqual(got.body, normalized) {
		f.t.Fatalf("%s %s body = %#v, want %#v", method, target, got.body, normalized)
	}
}

func human(t *testing.T, f *fake) *Client {
	t.Helper()
	c, err := New(f.server.URL+"/", WithToken("node-bearer"), WithUserJWT("user-jwt"))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// ok unwraps a (value, error) result; a failed call panics, which fails the test.
func ok[T any](value T, err error) T {
	if err != nil {
		panic(err)
	}
	return value
}

func TestSecretsMirrorTheWireContract(t *testing.T) {
	ctx := context.Background()
	f := newFake(t, func(*http.Request) (int, string) { return 200, `{"value":"s3cret"}` })
	c := human(t, f)
	coords := Coords{Scope: "team", ScopeID: "t1", Environment: "prod", BindingID: "mcp1"}
	value := ok(c.RevealSecret(ctx, "DB URL", coords, 3))
	f.expect("POST", "/api/vault/secrets/DB%20URL/reveal", map[string]any{
		"scope": "team", "scopeId": "t1", "environment": "prod",
		"binding": map[string]any{"id": "mcp1", "kind": "mcp"}, "version": 3,
	})
	if got := f.last().headers; got.Get("Authorization") != "Bearer node-bearer" || got.Get(UserJWTHeader) != "user-jwt" {
		t.Fatalf("headers = %v", got)
	}
	if value.Reveal() != "s3cret" {
		t.Fatalf("value = %q", value.Reveal())
	}
	for _, format := range []string{"%v", "%s", "%q", "%#v", "%+v"} {
		if strings.Contains(fmt.Sprintf(format, struct{ V Secret }{value}), "s3cret") {
			t.Fatalf("%s leaked the value", format)
		}
	}
	if encoded, _ := json.Marshal(value); strings.Contains(string(encoded), "s3cret") {
		t.Fatal("MarshalJSON leaked the value")
	}

	yes, no := true, false
	ok(c.ListSecrets(ctx, ListQuery{Environment: "prod", Recursive: &no, IncludeDeleted: &yes}))
	f.expect("GET", "/api/vault/secrets?environment=prod&recursive=false&includeDeleted=true", nil)
	v := "v"
	ok(c.PutSecret(ctx, "K", PutSecretInput{Coords: Coords{Scope: "node"}, Value: &v, ExpectedVersion: 2}))
	f.expect("PUT", "/api/vault/secrets/K", map[string]any{"scope": "node", "value": "v", "expectedVersion": 2})
	ok(c.DeleteSecret(ctx, "K", Coords{Scope: "node", Path: "/app"}))
	f.expect("DELETE", "/api/vault/secrets/K", map[string]any{"scope": "node", "path": "/app"})
	ok(c.SecretVersions(ctx, "K", Coords{Scope: "node", BindingID: "m"}))
	f.expect("GET", "/api/vault/secrets/K/versions?scope=node&mcpId=m", nil)
	ok(c.RollbackSecret(ctx, "K", Coords{Scope: "node"}, 4))
	f.expect("POST", "/api/vault/secrets/K/rollback", map[string]any{"scope": "node", "version": 4})
	ok(c.RestoreSecret(ctx, "K", Coords{Scope: "node"}))
	f.expect("POST", "/api/vault/secrets/K/restore", map[string]any{"scope": "node"})
	ok(c.DestroySecret(ctx, "K", Coords{Scope: "node"}, []int{1, 2}))
	f.expect("POST", "/api/vault/secrets/K/destroy", map[string]any{"scope": "node", "versions": []int{1, 2}})
	ok(c.WrapSecret(ctx, "K", Coords{Scope: "node"}, 0, "5m"))
	if f.last().headers.Get(WrapTTLHeader) != "5m" {
		t.Fatal("wrap TTL header missing")
	}
}

func TestDynamicCredentialsAndLeases(t *testing.T) {
	ctx := context.Background()
	f := newFake(t, func(*http.Request) (int, string) {
		return 200, `{"credential":{"data":{"password":"pw"},"lease":{"id":"l1","expiresAt":1700000000}},"lease":{"id":"l1"}}`
	})
	c := human(t, f)
	cred := ok(c.IssueDynamic(ctx, "db", 60))
	f.expect("POST", "/api/vault/dynamic/issue/db", map[string]any{"ttlSecs": 60})
	if cred.Data["password"].Reveal() != "pw" || cred.Lease.ExpiresAt != "1700000000" {
		t.Fatalf("credential = %+v", cred.Lease)
	}
	if strings.Contains(fmt.Sprintf("%v %+v", cred, *cred), "pw") {
		t.Fatal("credential printed its data")
	}
	ok(c.IssueDynamic(ctx, "db", 0))
	f.expect("POST", "/api/vault/dynamic/issue/db", map[string]any{})
	ok(c.PutDynamicRole(ctx, "db", map[string]any{"kind": "random", "charset": "hex", "length": 8}, 30, 0))
	f.expect("PUT", "/api/vault/dynamic/roles/db", map[string]any{
		"defaultTtlSecs": 30, "provider": map[string]any{"kind": "random", "charset": "hex", "length": 8},
	})
	ok(c.RevokeAllLeases(ctx, "db"))
	f.expect("POST", "/api/vault/dynamic/roles/db/revoke-all", nil)
	ok(c.ListLeases(ctx, "db", true))
	f.expect("GET", "/api/vault/leases?role=db&includeRevoked=true", nil)
	ok(c.RenewLease(ctx, "l1", 10))
	f.expect("POST", "/api/vault/leases/l1/renew", map[string]any{"ttlSecs": 10})
	ok(c.RevokeLease(ctx, "l1"))
	f.expect("POST", "/api/vault/leases/l1/revoke", map[string]any{})
}

func TestTransitOperations(t *testing.T) {
	ctx := context.Background()
	f := newFake(t, func(*http.Request) (int, string) {
		return 200, `{"ciphertext":"ryu:v1:x","plaintext":"c2VjcmV0","valid":true}`
	})
	c := human(t, f)
	ct := ok(c.Encrypt(ctx, "k", []byte("hello"), TransitOptions{Context: "Y3R4", KeyVersion: 2}))
	f.expect("POST", "/api/vault/transit/encrypt/k", map[string]any{
		"plaintext": base64.StdEncoding.EncodeToString([]byte("hello")), "context": "Y3R4", "keyVersion": 2,
	})
	if ct != "ryu:v1:x" {
		t.Fatalf("ciphertext = %q", ct)
	}
	key := ok(c.DataKey(ctx, "k"))
	f.expect("POST", "/api/vault/transit/datakey/k", map[string]any{})
	if key.Plaintext.Reveal() != "c2VjcmV0" || strings.Contains(fmt.Sprintf("%+v", *key), "c2VjcmV0") {
		t.Fatal("data key plaintext not redacted")
	}
	if valid := ok(c.Verify(ctx, "k", []byte("hi"), "", "ryu:v1:h", TransitOptions{})); !valid {
		t.Fatal("verify should be true")
	}
	f.expect("POST", "/api/vault/transit/verify/k", map[string]any{"input": "aGk=", "hmac": "ryu:v1:h"})
	ok(c.Sign(ctx, "k", []byte("hi"), TransitOptions{SignatureAlgorithm: "pss"}))
	f.expect("POST", "/api/vault/transit/sign/k", map[string]any{"input": "aGk=", "signatureAlgorithm": "pss"})
	ok(c.Decrypt(ctx, "k", "ryu:v1:x", TransitOptions{}))
	f.expect("POST", "/api/vault/transit/decrypt/k", map[string]any{"ciphertext": "ryu:v1:x"})
	ok(c.Rewrap(ctx, "k", "ryu:v1:x", TransitOptions{}))
	f.expect("POST", "/api/vault/transit/rewrap/k", map[string]any{"ciphertext": "ryu:v1:x"})
	ok(c.HMAC(ctx, "k", []byte("hi"), TransitOptions{}))
	f.expect("POST", "/api/vault/transit/hmac/k", map[string]any{"input": "aGk="})
	ok(c.RotateTransitKey(ctx, "k"))
	f.expect("POST", "/api/vault/transit/rotate/k", map[string]any{})
	ok(c.CreateTransitKey(ctx, "k", "ed25519"))
	f.expect("POST", "/api/vault/transit/keys", map[string]any{"name": "k", "type": "ed25519"})
	ok(c.ConfigureTransitKey(ctx, "k", map[string]any{"deletionAllowed": true}))
	f.expect("PATCH", "/api/vault/transit/keys/k", map[string]any{"deletionAllowed": true})
}

func TestTokensWrappingMachinesAndLogins(t *testing.T) {
	ctx := context.Background()
	f := newFake(t, func(*http.Request) (int, string) {
		return 200, `{"token":{"token":"rvt_.secret","accessor":"acc","expiresAt":"2026-01-01T00:00:00Z"},` +
			`"wrapInfo":{"token":"wrap","accessor":"wa","ttlSecs":60},"secretId":"sid","info":{"accessor":"sa"}}`
	})
	c := human(t, f)
	issued := ok(c.CreateToken(ctx, "ci", TokenRequest{Policies: []string{"read"}, TTLSecs: 60, NumUses: 1}))
	f.expect("POST", "/api/vault/tokens", map[string]any{"policies": []string{"read"}, "ttlSecs": 60, "numUses": 1, "identity": "ci"})
	if issued.Token.Reveal() != "rvt_.secret" || strings.Contains(fmt.Sprintf("%+v", *issued), "rvt_.secret") {
		t.Fatal("issued token not redacted")
	}
	ok(c.RenewToken(ctx, "acc", 30))
	f.expect("POST", "/api/vault/tokens/acc/renew", map[string]any{"incrementSecs": 30})
	ok(c.RevokeToken(ctx, "acc"))
	f.expect("POST", "/api/vault/tokens/acc/revoke", nil)
	ok(c.RevokeTokenOrphan(ctx, "acc"))
	f.expect("POST", "/api/vault/tokens/acc/revoke-orphan", nil)
	ok(c.ListTokens(ctx, "ci"))
	f.expect("GET", "/api/vault/tokens?identity=ci", nil)

	ok(c.Wrap(ctx, map[string]any{"a": 1}, "300"))
	f.expect("POST", "/api/vault/sys/wrapping/wrap", map[string]any{"a": 1})
	if f.last().headers.Get(WrapTTLHeader) != "300" {
		t.Fatal("wrap TTL header missing")
	}
	unwrapped := ok(c.Unwrap(ctx, "wrap-tok"))
	f.expect("POST", "/api/vault/sys/wrapping/unwrap", map[string]any{"token": "wrap-tok"})
	if f.last().headers.Get("Authorization") != "" || strings.Contains(fmt.Sprint(unwrapped), "rvt_") {
		t.Fatal("unwrap sent the bearer or printed its response")
	}
	var decoded map[string]any
	if err := unwrapped.Decode(&decoded); err != nil || decoded["secretId"] != "sid" {
		t.Fatalf("decode = %v %v", decoded, err)
	}
	ok(c.WrapLookup(ctx, "w"))
	f.expect("POST", "/api/vault/sys/wrapping/lookup", map[string]any{"token": "w"})
	ok(c.WrapRewrap(ctx, "w"))
	f.expect("POST", "/api/vault/sys/wrapping/rewrap", map[string]any{"token": "w"})

	ok(c.CreateMachine(ctx, MachineInput{Name: "ci", Auth: map[string]any{"kind": "approle", "roleId": "r"}, TokenTTLSecs: 60}))
	f.expect("POST", "/api/vault/machines", map[string]any{"name": "ci", "auth": map[string]any{"kind": "approle", "roleId": "r"}, "tokenTtlSecs": 60})
	sid := ok(c.IssueSecretID(ctx, "m1", 0, 1))
	f.expect("POST", "/api/vault/machines/m1/secret-ids", map[string]any{"uses": 1})
	if sid.SecretID.Reveal() != "sid" {
		t.Fatal("secret id not decoded")
	}
	ok(c.RevokeSecretID(ctx, "sa"))
	f.expect("DELETE", "/api/vault/secret-ids/sa", nil)

	logins := []struct {
		method string
		call   func() (*IssuedToken, error)
		body   map[string]any
	}{
		{"approle", func() (*IssuedToken, error) { return c.LoginAppRole(ctx, "r", "s") }, map[string]any{"roleId": "r", "secretId": "s"}},
		{"jwt", func() (*IssuedToken, error) { return c.LoginJWT(ctx, "gh", "j") }, map[string]any{"identity": "gh", "jwt": "j"}},
		{"kubernetes", func() (*IssuedToken, error) { return c.LoginKubernetes(ctx, "k8s", "sa") }, map[string]any{"identity": "k8s", "jwt": "sa"}},
		{"cert", func() (*IssuedToken, error) { return c.LoginCert(ctx, "c", "PEM", "p") }, map[string]any{"identity": "c", "certificatePem": "PEM", "proof": "p"}},
		{"aws", func() (*IssuedToken, error) {
			return c.LoginAWS(ctx, "aws", AWSLogin{RequestURL: "dQ==", RequestBody: "Yg==", RequestHeaders: "e30="})
		}, map[string]any{"identity": "aws", "iamHttpRequestMethod": "POST", "iamRequestUrl": "dQ==", "iamRequestBody": "Yg==", "iamRequestHeaders": "e30="}},
	}
	for _, login := range logins {
		ok(login.call())
		f.expect("POST", "/api/vault/auth/"+login.method+"/login", login.body)
		if f.last().headers.Get("Authorization") != "" {
			t.Fatalf("%s login sent the node bearer", login.method)
		}
	}
}

func TestAgentClientSendsOnlyTheVaultToken(t *testing.T) {
	ctx := context.Background()
	f := newFake(t, func(*http.Request) (int, string) {
		return 200, `{"value":"agent-secret","certificate":{"certificate":"C","issuingCa":"CA","notAfter":"x","privateKey":"PK","serial":"1"}}`
	})
	a, err := NewAgent(f.server.URL, "rvt_.machine")
	if err != nil {
		t.Fatal(err)
	}
	value := ok(a.Secret(ctx, "API_KEY", "prod", ""))
	f.expect("GET", "/api/vault/agent/secrets/API_KEY?environment=prod", nil)
	if h := f.last().headers; h.Get(TokenHeader) != "rvt_.machine" || h.Get("Authorization") != "" {
		t.Fatalf("agent headers = %v", h)
	}
	if value.Reveal() != "agent-secret" || strings.Contains(fmt.Sprintf("%v %#v", a, a), "rvt_.machine") {
		t.Fatal("agent leaked its token or lost the value")
	}
	ok(a.IssueDynamic(ctx, "db", 5))
	f.expect("POST", "/api/vault/agent/dynamic/db", map[string]any{"ttlSecs": 5})
	ok(a.RenewLease(ctx, "l1", 0))
	f.expect("POST", "/api/vault/agent/leases/l1/renew", map[string]any{})
	ok(a.Encrypt(ctx, "k", []byte("hi"), TransitOptions{}))
	f.expect("POST", "/api/vault/agent/transit/encrypt/k", map[string]any{"plaintext": "aGk="})
	ok(a.CreateChild(ctx, TokenRequest{Policies: []string{"p"}}))
	f.expect("POST", "/api/vault/agent/self/child", map[string]any{"policies": []string{"p"}})
	ok(a.Export(ctx, ExportInput{Names: []string{"A"}}))
	f.expect("POST", "/api/vault/agent/export", map[string]any{"names": []string{"A"}})
	cert := ok(a.PKI(ctx, "issue", "web", map[string]any{"commonName": "a"}))
	f.expect("POST", "/api/vault/agent/pki/issue/web", map[string]any{"commonName": "a"})
	if cert.PrivateKey.Reveal() != "PK" || cert.Serial != "1" {
		t.Fatalf("cert = %+v", cert)
	}
	ok(a.CubbyholePut(ctx, "x", map[string]any{"n": 1}))
	f.expect("PUT", "/api/vault/agent/cubbyhole/x", map[string]any{"n": 1})
	ok(a.WrapSecret(ctx, "API_KEY", "", "", "1h"))
	if f.last().headers.Get(WrapTTLHeader) != "1h" || f.last().method != "GET" {
		t.Fatal("wrap secret request")
	}
	if _, err := a.PKI(ctx, "revoke", "web", nil); err == nil {
		t.Fatal("PKI accepted an unknown op")
	}

	c := human(t, f)
	ok(c.Agent("rvt_.child").Self(ctx))
	f.expect("GET", "/api/vault/agent/self", nil)
	if h := f.last().headers; h.Get(TokenHeader) != "rvt_.child" || h.Get("Authorization") != "" {
		t.Fatalf("Client.Agent headers = %v", h)
	}
}

func TestErrorsCarryStatusAndCoreCodes(t *testing.T) {
	cases := []struct {
		status        int
		body          string
		code, message string
	}{
		{403, `{"error":"denied by policy"}`, "", "denied by policy"},
		{404, `{"error":{"code":"not_found","message":"no such value"}}`, "not_found", "no such value"},
		{400, `{"code":"bad","error":"bad input"}`, "bad", "bad input"},
		{500, ``, "", ""},
	}
	for _, tc := range cases {
		f := newFake(t, func(*http.Request) (int, string) { return tc.status, tc.body })
		_, err := human(t, f).ListSecrets(context.Background(), ListQuery{})
		var apiErr *Error
		if !errors.As(err, &apiErr) || apiErr.Status != tc.status || apiErr.Code != tc.code || apiErr.Message != tc.message {
			t.Fatalf("status %d: err = %#v", tc.status, err)
		}
	}
}

func TestInvalidIDsAreRefusedBeforeAnyRequest(t *testing.T) {
	f := newFake(t, nil)
	if _, err := human(t, f).RevealSecret(context.Background(), "..", Coords{Scope: "node"}, 0); !errors.Is(err, ErrInvalidID) {
		t.Fatalf("err = %v", err)
	}
	if len(f.requests) != 0 {
		t.Fatal("a request was sent")
	}
	if _, err := New(""); err == nil {
		t.Fatal("New accepted an empty url")
	}
}
