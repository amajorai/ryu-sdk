package vault

import (
	"context"
	"encoding/base64"
	"strconv"
)

type sendFunc func(ctx context.Context, method, path string, body any, out any) error

// TransitOptions are shared by the transit operations. AssociatedData and
// Context are base64 strings; KeyVersion 0 means the latest.
type TransitOptions struct {
	AssociatedData     string
	Context            string
	KeyVersion         int
	SignatureAlgorithm string
}

func (o TransitOptions) body() map[string]any {
	body := map[string]any{}
	if o.AssociatedData != "" {
		body["associatedData"] = o.AssociatedData
	}
	if o.Context != "" {
		body["context"] = o.Context
	}
	if o.KeyVersion > 0 {
		body["keyVersion"] = o.KeyVersion
	}
	if o.SignatureAlgorithm != "" {
		body["signatureAlgorithm"] = o.SignatureAlgorithm
	}
	return body
}

func b64(data []byte) string { return base64.StdEncoding.EncodeToString(data) }

// transit runs the operations under one prefix (human or agent).
type transit struct {
	send   sendFunc
	prefix string
}

func (t transit) op(ctx context.Context, op, key string, body map[string]any, out any) error {
	seg, err := segment(key)
	if err != nil {
		return err
	}
	return t.send(ctx, "POST", t.prefix+"/"+op+"/"+seg, body, out)
}

func (t transit) encrypt(ctx context.Context, key string, plaintext []byte, o TransitOptions) (string, error) {
	body := o.body()
	body["plaintext"] = b64(plaintext)
	var out struct {
		Ciphertext string `json:"ciphertext"`
	}
	return out.Ciphertext, t.op(ctx, "encrypt", key, body, &out)
}

func (t transit) decrypt(ctx context.Context, key, ciphertext string, o TransitOptions) (Secret, error) {
	body := o.body()
	body["ciphertext"] = ciphertext
	var out struct {
		Plaintext Secret `json:"plaintext"`
	}
	return out.Plaintext, t.op(ctx, "decrypt", key, body, &out)
}

func (t transit) rewrap(ctx context.Context, key, ciphertext string, o TransitOptions) (string, error) {
	body := o.body()
	body["ciphertext"] = ciphertext
	var out struct {
		Ciphertext string `json:"ciphertext"`
	}
	return out.Ciphertext, t.op(ctx, "rewrap", key, body, &out)
}

func (t transit) sign(ctx context.Context, key string, input []byte, o TransitOptions) (string, error) {
	body := o.body()
	body["input"] = b64(input)
	var out struct {
		Signature string `json:"signature"`
	}
	return out.Signature, t.op(ctx, "sign", key, body, &out)
}

func (t transit) verify(ctx context.Context, key string, input []byte, signature, hmac string, o TransitOptions) (bool, error) {
	body := o.body()
	body["input"] = b64(input)
	if signature != "" {
		body["signature"] = signature
	}
	if hmac != "" {
		body["hmac"] = hmac
	}
	var out struct {
		Valid bool `json:"valid"`
	}
	return out.Valid, t.op(ctx, "verify", key, body, &out)
}

func (t transit) hmac(ctx context.Context, key string, input []byte, o TransitOptions) (string, error) {
	body := o.body()
	body["input"] = b64(input)
	var out struct {
		HMAC string `json:"hmac"`
	}
	return out.HMAC, t.op(ctx, "hmac", key, body, &out)
}

func (t transit) datakey(ctx context.Context, key string) (*DataKey, error) {
	var out DataKey
	if err := t.op(ctx, "datakey", key, map[string]any{}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) transit() transit { return transit{send: c.send, prefix: "/api/vault/transit"} }

// Encrypt encrypts plaintext (sent base64) and returns the ciphertext.
func (c *Client) Encrypt(ctx context.Context, key string, plaintext []byte, o TransitOptions) (string, error) {
	return c.transit().encrypt(ctx, key, plaintext, o)
}

// Decrypt returns the plaintext, base64-encoded as Core sends it.
func (c *Client) Decrypt(ctx context.Context, key, ciphertext string, o TransitOptions) (Secret, error) {
	return c.transit().decrypt(ctx, key, ciphertext, o)
}

// Rewrap re-encrypts a ciphertext under the key's latest version.
func (c *Client) Rewrap(ctx context.Context, key, ciphertext string, o TransitOptions) (string, error) {
	return c.transit().rewrap(ctx, key, ciphertext, o)
}

// Sign signs input (sent base64).
func (c *Client) Sign(ctx context.Context, key string, input []byte, o TransitOptions) (string, error) {
	return c.transit().sign(ctx, key, input, o)
}

// Verify checks a signature or (with hmac set) an HMAC over input.
func (c *Client) Verify(ctx context.Context, key string, input []byte, signature, hmac string, o TransitOptions) (bool, error) {
	return c.transit().verify(ctx, key, input, signature, hmac, o)
}

// HMAC computes an HMAC over input (sent base64).
func (c *Client) HMAC(ctx context.Context, key string, input []byte, o TransitOptions) (string, error) {
	return c.transit().hmac(ctx, key, input, o)
}

// DataKey generates a data key.
func (c *Client) DataKey(ctx context.Context, key string) (*DataKey, error) {
	return c.transit().datakey(ctx, key)
}

// RotateTransitKey adds a key version.
func (c *Client) RotateTransitKey(ctx context.Context, key string) (Object, error) {
	var out Object
	return out, c.transit().op(ctx, "rotate", key, map[string]any{}, &out)
}

// ListTransitKeys lists transit keys (public keys only).
func (c *Client) ListTransitKeys(ctx context.Context) (Object, error) {
	var out Object
	return out, c.send(ctx, "GET", "/api/vault/transit/keys", nil, &out)
}

// CreateTransitKey creates a key; keyType "" uses Core's default.
func (c *Client) CreateTransitKey(ctx context.Context, name, keyType string) (Object, error) {
	body := map[string]any{"name": name}
	if keyType != "" {
		body["type"] = keyType
	}
	var out Object
	return out, c.send(ctx, "POST", "/api/vault/transit/keys", body, &out)
}

// ConfigureTransitKey patches a key with camelCase fields (deletionAllowed, minDecryptionVersion, ...).
func (c *Client) ConfigureTransitKey(ctx context.Context, name string, patch map[string]any) (Object, error) {
	return c.named(ctx, "PATCH", "/api/vault/transit/keys/", name, "", patch)
}

// DeleteTransitKey deletes a key (deletionAllowed must be set).
func (c *Client) DeleteTransitKey(ctx context.Context, name string) (Object, error) {
	return c.named(ctx, "DELETE", "/api/vault/transit/keys/", name, "", nil)
}

// ListDynamicRoles lists dynamic-credential roles (credentials redacted by Core).
func (c *Client) ListDynamicRoles(ctx context.Context) (Object, error) {
	var out Object
	return out, c.send(ctx, "GET", "/api/vault/dynamic/roles", nil, &out)
}

// PutDynamicRole creates or replaces a role. provider is the camelCase provider
// object ({"kind": "postgres", ...}); zero TTLs keep Core's defaults.
func (c *Client) PutDynamicRole(ctx context.Context, name string, provider map[string]any, defaultTTLSecs, maxTTLSecs int) (Object, error) {
	body := map[string]any{"provider": provider}
	if defaultTTLSecs > 0 {
		body["defaultTtlSecs"] = defaultTTLSecs
	}
	if maxTTLSecs > 0 {
		body["maxTtlSecs"] = maxTTLSecs
	}
	return c.named(ctx, "PUT", "/api/vault/dynamic/roles/", name, "", body)
}

// DeleteDynamicRole deletes a role.
func (c *Client) DeleteDynamicRole(ctx context.Context, name string) (Object, error) {
	return c.named(ctx, "DELETE", "/api/vault/dynamic/roles/", name, "", nil)
}

// RevokeAllLeases revokes every live lease of a role.
func (c *Client) RevokeAllLeases(ctx context.Context, role string) (Object, error) {
	return c.named(ctx, "POST", "/api/vault/dynamic/roles/", role, "/revoke-all", nil)
}

// IssueDynamic issues a credential under a lease; ttlSecs 0 uses the role default.
func (c *Client) IssueDynamic(ctx context.Context, role string, ttlSecs int) (*DynamicCredential, error) {
	return issueDynamic(ctx, c.send, "/api/vault/dynamic/issue/", role, ttlSecs)
}

func issueDynamic(ctx context.Context, send sendFunc, prefix, role string, ttlSecs int) (*DynamicCredential, error) {
	seg, err := segment(role)
	if err != nil {
		return nil, err
	}
	var out struct {
		Credential DynamicCredential `json:"credential"`
	}
	if err := send(ctx, "POST", prefix+seg, ttlBody(ttlSecs), &out); err != nil {
		return nil, err
	}
	return &out.Credential, nil
}

// ListLeases lists leases, optionally for one role and including revoked ones.
func (c *Client) ListLeases(ctx context.Context, role string, includeRevoked bool) (Object, error) {
	revoked := ""
	if includeRevoked {
		revoked = strconv.FormatBool(true)
	}
	var out Object
	return out, c.send(ctx, "GET", "/api/vault/leases"+query("role", role, "includeRevoked", revoked), nil, &out)
}

// RenewLease extends a lease; ttlSecs 0 uses the role default.
func (c *Client) RenewLease(ctx context.Context, id string, ttlSecs int) (*Lease, error) {
	return leaseOp(ctx, c.send, "/api/vault/leases/", id, "renew", ttlSecs)
}

// RevokeLease revokes a lease.
func (c *Client) RevokeLease(ctx context.Context, id string) (*Lease, error) {
	return leaseOp(ctx, c.send, "/api/vault/leases/", id, "revoke", 0)
}

func leaseOp(ctx context.Context, send sendFunc, prefix, id, op string, ttlSecs int) (*Lease, error) {
	seg, err := segment(id)
	if err != nil {
		return nil, err
	}
	var out struct {
		Lease Lease `json:"lease"`
	}
	if err := send(ctx, "POST", prefix+seg+"/"+op, ttlBody(ttlSecs), &out); err != nil {
		return nil, err
	}
	return &out.Lease, nil
}

func (c *Client) named(ctx context.Context, method, prefix, name, suffix string, body any) (Object, error) {
	seg, err := segment(name)
	if err != nil {
		return nil, err
	}
	var out Object
	return out, c.send(ctx, method, prefix+seg+suffix, body, &out)
}
