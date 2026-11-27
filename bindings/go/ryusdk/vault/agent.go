package vault

import (
	"context"
	"fmt"
)

const agentPrefix = "/api/vault/agent"

// AgentClient calls `/api/vault/agent/*` with a machine vault token. It sends
// only x-ryu-vault-token, never the node bearer.
type AgentClient struct {
	t     *transport
	token string
}

// NewAgent returns a machine-token client for a node URL. Only WithHTTPClient applies.
func NewAgent(baseURL, vaultToken string, opts ...Option) (*AgentClient, error) {
	t, err := newTransport(baseURL, opts)
	if err != nil {
		return nil, err
	}
	t.token, t.userJWT = "", ""
	return &AgentClient{t: t, token: vaultToken}, nil
}

// String never shows the vault token.
func (a *AgentClient) String() string {
	return fmt.Sprintf("vault.AgentClient{url: %q, token: %s}", a.t.base, Redacted)
}

// GoString keeps %#v from printing the token.
func (a *AgentClient) GoString() string { return a.String() }

func (a *AgentClient) send(ctx context.Context, method, path string, body any, out any) error {
	return a.t.machine(ctx, a.token, method, path, body, out)
}

// Self returns the token's principal.
func (a *AgentClient) Self(ctx context.Context) (Object, error) {
	var out Object
	return out, a.send(ctx, "GET", agentPrefix+"/self", nil, &out)
}

// LookupSelf returns the token's metadata and effective policies.
func (a *AgentClient) LookupSelf(ctx context.Context) (Object, error) {
	var out Object
	return out, a.send(ctx, "GET", agentPrefix+"/self/lookup", nil, &out)
}

// RenewSelf extends the token; incrementSecs 0 uses its TTL.
func (a *AgentClient) RenewSelf(ctx context.Context, incrementSecs int) (Object, error) {
	body := map[string]any{}
	if incrementSecs > 0 {
		body["incrementSecs"] = incrementSecs
	}
	var out Object
	return out, a.send(ctx, "POST", agentPrefix+"/self/renew", body, &out)
}

// RevokeSelf revokes the token.
func (a *AgentClient) RevokeSelf(ctx context.Context) (Object, error) {
	var out Object
	return out, a.send(ctx, "POST", agentPrefix+"/self/revoke", nil, &out)
}

// CreateChild mints a narrower child token (policy subset; TTL capped by the parent).
func (a *AgentClient) CreateChild(ctx context.Context, request TokenRequest) (*IssuedToken, error) {
	var out issuedTokenReply
	if err := a.send(ctx, "POST", agentPrefix+"/self/child", request, &out); err != nil {
		return nil, err
	}
	return &out.Token, nil
}

func agentSecretPath(name, environment, path string) (string, error) {
	seg, err := segment(name)
	if err != nil {
		return "", err
	}
	return agentPrefix + "/secrets/" + seg + query("environment", environment, "path", path), nil
}

// Secret reads one node-scoped value.
func (a *AgentClient) Secret(ctx context.Context, name, environment, path string) (Secret, error) {
	target, err := agentSecretPath(name, environment, path)
	if err != nil {
		return "", err
	}
	var out struct {
		Value Secret `json:"value"`
	}
	return out.Value, a.send(ctx, "GET", target, nil, &out)
}

// WrapSecret reads a value wrapped behind a single-use token by Core.
func (a *AgentClient) WrapSecret(ctx context.Context, name, environment, path, ttl string) (*WrapInfo, error) {
	target, err := agentSecretPath(name, environment, path)
	if err != nil {
		return nil, err
	}
	var out wrapReply
	if err := a.t.machine(ctx, a.token, "GET", target, nil, &out, wrapTTL(ttl)...); err != nil {
		return nil, err
	}
	return &out.WrapInfo, nil
}

// ExportInput selects the node-scoped values to export.
type ExportInput struct {
	Environment string   `json:"environment,omitempty"`
	Path        string   `json:"path,omitempty"`
	Format      string   `json:"format,omitempty"`
	Names       []string `json:"names,omitempty"`
	ProjectID   string   `json:"projectId,omitempty"`
}

// Export exports the node-scoped values the token may read.
func (a *AgentClient) Export(ctx context.Context, input ExportInput) (*ExportResult, error) {
	var out ExportResult
	if err := a.send(ctx, "POST", agentPrefix+"/export", input, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Wrap wraps a JSON object behind a single-use token.
func (a *AgentClient) Wrap(ctx context.Context, data any, ttl string) (*WrapInfo, error) {
	var out wrapReply
	if err := a.t.machine(ctx, a.token, "POST", agentPrefix+"/wrapping/wrap", data, &out, wrapTTL(ttl)...); err != nil {
		return nil, err
	}
	return &out.WrapInfo, nil
}

// IssueDynamic issues a dynamic credential; ttlSecs 0 uses the role default.
func (a *AgentClient) IssueDynamic(ctx context.Context, role string, ttlSecs int) (*DynamicCredential, error) {
	return issueDynamic(ctx, a.send, agentPrefix+"/dynamic/", role, ttlSecs)
}

// RenewLease extends a lease the token issued.
func (a *AgentClient) RenewLease(ctx context.Context, id string, ttlSecs int) (*Lease, error) {
	return leaseOp(ctx, a.send, agentPrefix+"/leases/", id, "renew", ttlSecs)
}

// RevokeLease revokes a lease the token issued.
func (a *AgentClient) RevokeLease(ctx context.Context, id string) (*Lease, error) {
	return leaseOp(ctx, a.send, agentPrefix+"/leases/", id, "revoke", 0)
}

func (a *AgentClient) transit() transit {
	return transit{send: a.send, prefix: agentPrefix + "/transit"}
}

// Encrypt encrypts plaintext (sent base64).
func (a *AgentClient) Encrypt(ctx context.Context, key string, plaintext []byte, o TransitOptions) (string, error) {
	return a.transit().encrypt(ctx, key, plaintext, o)
}

// Decrypt returns the base64 plaintext.
func (a *AgentClient) Decrypt(ctx context.Context, key, ciphertext string, o TransitOptions) (Secret, error) {
	return a.transit().decrypt(ctx, key, ciphertext, o)
}

// Rewrap re-encrypts under the key's latest version.
func (a *AgentClient) Rewrap(ctx context.Context, key, ciphertext string, o TransitOptions) (string, error) {
	return a.transit().rewrap(ctx, key, ciphertext, o)
}

// Sign signs input.
func (a *AgentClient) Sign(ctx context.Context, key string, input []byte, o TransitOptions) (string, error) {
	return a.transit().sign(ctx, key, input, o)
}

// Verify checks a signature or (with hmac set) an HMAC.
func (a *AgentClient) Verify(ctx context.Context, key string, input []byte, signature, hmac string, o TransitOptions) (bool, error) {
	return a.transit().verify(ctx, key, input, signature, hmac, o)
}

// HMAC computes an HMAC over input.
func (a *AgentClient) HMAC(ctx context.Context, key string, input []byte, o TransitOptions) (string, error) {
	return a.transit().hmac(ctx, key, input, o)
}

// DataKey generates a data key.
func (a *AgentClient) DataKey(ctx context.Context, key string) (*DataKey, error) {
	return a.transit().datakey(ctx, key)
}

// PKI issues ("issue") or signs ("sign") a certificate under a role.
func (a *AgentClient) PKI(ctx context.Context, op, role string, input map[string]any) (*Certificate, error) {
	if op != "issue" && op != "sign" {
		return nil, fmt.Errorf("vault: pki op must be issue or sign, not %q", op)
	}
	seg, err := segment(role)
	if err != nil {
		return nil, err
	}
	var out struct {
		Certificate Certificate `json:"certificate"`
	}
	if err := a.send(ctx, "POST", agentPrefix+"/pki/"+op+"/"+seg, input, &out); err != nil {
		return nil, err
	}
	return &out.Certificate, nil
}

// SSHSign signs an SSH public key under a role.
func (a *AgentClient) SSHSign(ctx context.Context, role string, input map[string]any) (Object, error) {
	seg, err := segment(role)
	if err != nil {
		return nil, err
	}
	var out Object
	return out, a.send(ctx, "POST", agentPrefix+"/ssh/sign/"+seg, input, &out)
}

func cubbyholePath(key string) (string, error) {
	seg, err := segment(key)
	if err != nil {
		return "", err
	}
	return agentPrefix + "/cubbyhole/" + seg, nil
}

// CubbyholeList lists the token's cubbyhole keys.
func (a *AgentClient) CubbyholeList(ctx context.Context) (Object, error) {
	var out Object
	return out, a.send(ctx, "GET", agentPrefix+"/cubbyhole", nil, &out)
}

// CubbyholeGet reads a cubbyhole value.
func (a *AgentClient) CubbyholeGet(ctx context.Context, key string) (SecretJSON, error) {
	path, err := cubbyholePath(key)
	if err != nil {
		return nil, err
	}
	var out struct {
		Value SecretJSON `json:"value"`
	}
	return out.Value, a.send(ctx, "GET", path, nil, &out)
}

// CubbyholePut writes a cubbyhole value.
func (a *AgentClient) CubbyholePut(ctx context.Context, key string, value any) (Object, error) {
	path, err := cubbyholePath(key)
	if err != nil {
		return nil, err
	}
	var out Object
	return out, a.send(ctx, "PUT", path, value, &out)
}

// CubbyholeDelete deletes a cubbyhole value.
func (a *AgentClient) CubbyholeDelete(ctx context.Context, key string) (Object, error) {
	path, err := cubbyholePath(key)
	if err != nil {
		return nil, err
	}
	var out Object
	return out, a.send(ctx, "DELETE", path, nil, &out)
}
