package vault

import "context"

type issuedTokenReply struct {
	Token IssuedToken `json:"token"`
}

type wrapReply struct {
	WrapInfo WrapInfo `json:"wrapInfo"`
}

// ListTokens lists token metadata, optionally for one machine identity.
func (c *Client) ListTokens(ctx context.Context, identity string) (Object, error) {
	var out Object
	return out, c.send(ctx, "GET", "/api/vault/tokens"+query("identity", identity), nil, &out)
}

// CreateToken mints a token for a machine identity. The `rvt_.` token is shown once.
func (c *Client) CreateToken(ctx context.Context, identity string, request TokenRequest) (*IssuedToken, error) {
	body := struct {
		TokenRequest
		Identity string `json:"identity"`
	}{request, identity}
	var out issuedTokenReply
	if err := c.send(ctx, "POST", "/api/vault/tokens", body, &out); err != nil {
		return nil, err
	}
	return &out.Token, nil
}

// LookupToken returns a token's metadata by accessor.
func (c *Client) LookupToken(ctx context.Context, accessor string) (Object, error) {
	return c.named(ctx, "GET", "/api/vault/tokens/", accessor, "", nil)
}

// RenewToken extends a token; incrementSecs 0 uses its TTL.
func (c *Client) RenewToken(ctx context.Context, accessor string, incrementSecs int) (Object, error) {
	body := map[string]any{}
	if incrementSecs > 0 {
		body["incrementSecs"] = incrementSecs
	}
	return c.named(ctx, "POST", "/api/vault/tokens/", accessor, "/renew", body)
}

// RevokeToken revokes a token and its children.
func (c *Client) RevokeToken(ctx context.Context, accessor string) (Object, error) {
	return c.named(ctx, "POST", "/api/vault/tokens/", accessor, "/revoke", nil)
}

// RevokeTokenOrphan revokes a token but keeps its children as orphans.
func (c *Client) RevokeTokenOrphan(ctx context.Context, accessor string) (Object, error) {
	return c.named(ctx, "POST", "/api/vault/tokens/", accessor, "/revoke-orphan", nil)
}

// ListTokenRoles lists token roles.
func (c *Client) ListTokenRoles(ctx context.Context) (Object, error) {
	var out Object
	return out, c.send(ctx, "GET", "/api/vault/token-roles", nil, &out)
}

// GetTokenRole returns one token role.
func (c *Client) GetTokenRole(ctx context.Context, name string) (Object, error) {
	return c.named(ctx, "GET", "/api/vault/token-roles/", name, "", nil)
}

// PutTokenRole creates or replaces a token role from its camelCase fields.
func (c *Client) PutTokenRole(ctx context.Context, name string, role map[string]any) (Object, error) {
	return c.named(ctx, "PUT", "/api/vault/token-roles/", name, "", role)
}

// DeleteTokenRole deletes a token role.
func (c *Client) DeleteTokenRole(ctx context.Context, name string) (Object, error) {
	return c.named(ctx, "DELETE", "/api/vault/token-roles/", name, "", nil)
}

// Wrap wraps a JSON object behind a single-use token; ttl "" uses Core's wrap TTL.
func (c *Client) Wrap(ctx context.Context, data any, ttl string) (*WrapInfo, error) {
	var out wrapReply
	if err := c.t.human(ctx, "POST", "/api/vault/sys/wrapping/wrap", data, &out, wrapTTL(ttl)...); err != nil {
		return nil, err
	}
	return &out.WrapInfo, nil
}

func wrapTTL(ttl string) []string {
	if ttl == "" {
		return nil
	}
	return []string{WrapTTLHeader, ttl}
}

// Unwrap consumes a wrapping token and returns the original response. It is a
// public route: the node bearer is not sent.
func (c *Client) Unwrap(ctx context.Context, wrapToken string) (SecretJSON, error) {
	var out SecretJSON
	err := c.t.machine(ctx, "", "POST", "/api/vault/sys/wrapping/unwrap", map[string]string{"token": wrapToken}, &out)
	return out, err
}

// WrapLookup describes a wrapping token without consuming it (public route).
func (c *Client) WrapLookup(ctx context.Context, wrapToken string) (*WrapInfo, error) {
	return c.wrapping(ctx, "lookup", wrapToken)
}

// WrapRewrap moves a wrapped response to a new token, consuming the old one (public route).
func (c *Client) WrapRewrap(ctx context.Context, wrapToken string) (*WrapInfo, error) {
	return c.wrapping(ctx, "rewrap", wrapToken)
}

func (c *Client) wrapping(ctx context.Context, op, wrapToken string) (*WrapInfo, error) {
	var out wrapReply
	err := c.t.machine(ctx, "", "POST", "/api/vault/sys/wrapping/"+op, map[string]string{"token": wrapToken}, &out)
	if err != nil {
		return nil, err
	}
	return &out.WrapInfo, nil
}

// MachineInput creates a machine identity. Auth is {"kind": "approle", "roleId": ...}
// or {"kind": "jwt", "issuer": ...}.
type MachineInput struct {
	Name         string         `json:"name"`
	Auth         map[string]any `json:"auth"`
	Policies     []string       `json:"policies,omitempty"`
	TokenTTLSecs int            `json:"tokenTtlSecs,omitempty"`
}

// MachinePatch updates a machine identity; nil fields are unchanged.
type MachinePatch struct {
	Disabled     *bool    `json:"disabled,omitempty"`
	Policies     []string `json:"policies,omitempty"`
	TokenTTLSecs *int     `json:"tokenTtlSecs,omitempty"`
}

// ListMachines lists machine identities.
func (c *Client) ListMachines(ctx context.Context) (Object, error) {
	var out Object
	return out, c.send(ctx, "GET", "/api/vault/machines", nil, &out)
}

// CreateMachine creates a machine identity.
func (c *Client) CreateMachine(ctx context.Context, input MachineInput) (Object, error) {
	var out Object
	return out, c.send(ctx, "POST", "/api/vault/machines", input, &out)
}

// UpdateMachine patches a machine identity.
func (c *Client) UpdateMachine(ctx context.Context, id string, patch MachinePatch) (Object, error) {
	return c.named(ctx, "PATCH", "/api/vault/machines/", id, "", patch)
}

// DeleteMachine deletes a machine identity.
func (c *Client) DeleteMachine(ctx context.Context, id string) (Object, error) {
	return c.named(ctx, "DELETE", "/api/vault/machines/", id, "", nil)
}

// ListSecretIDs lists a machine's AppRole secret ids (metadata only).
func (c *Client) ListSecretIDs(ctx context.Context, machineID string) (Object, error) {
	return c.named(ctx, "GET", "/api/vault/machines/", machineID, "/secret-ids", nil)
}

// IssueSecretID issues an AppRole secret id; zero ttl/uses keep Core's defaults.
func (c *Client) IssueSecretID(ctx context.Context, machineID string, ttlSecs, uses int) (*IssuedSecretID, error) {
	seg, err := segment(machineID)
	if err != nil {
		return nil, err
	}
	body := map[string]any{}
	if ttlSecs > 0 {
		body["ttlSecs"] = ttlSecs
	}
	if uses > 0 {
		body["uses"] = uses
	}
	var out IssuedSecretID
	if err := c.send(ctx, "POST", "/api/vault/machines/"+seg+"/secret-ids", body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// RevokeSecretID revokes an AppRole secret id by accessor.
func (c *Client) RevokeSecretID(ctx context.Context, accessor string) (Object, error) {
	return c.named(ctx, "DELETE", "/api/vault/secret-ids/", accessor, "", nil)
}

// AWSLogin is a presigned sts:GetCallerIdentity request; each field is base64
// except the method (default POST).
type AWSLogin struct {
	HTTPRequestMethod string
	RequestURL        string
	RequestBody       string
	RequestHeaders    string
}

func (c *Client) login(ctx context.Context, method string, body any) (*IssuedToken, error) {
	var out issuedTokenReply
	if err := c.t.machine(ctx, "", "POST", "/api/vault/auth/"+method+"/login", body, &out); err != nil {
		return nil, err
	}
	return &out.Token, nil
}

// LoginAppRole exchanges an AppRole role id and secret id for a vault token.
func (c *Client) LoginAppRole(ctx context.Context, roleID, secretID string) (*IssuedToken, error) {
	return c.login(ctx, "approle", map[string]string{"roleId": roleID, "secretId": secretID})
}

// LoginJWT exchanges an OIDC JWT (for example a GitHub Actions ID token).
func (c *Client) LoginJWT(ctx context.Context, identity, jwt string) (*IssuedToken, error) {
	return c.login(ctx, "jwt", map[string]string{"identity": identity, "jwt": jwt})
}

// LoginKubernetes exchanges a Kubernetes service-account token (checked with a TokenReview).
func (c *Client) LoginKubernetes(ctx context.Context, identity, jwt string) (*IssuedToken, error) {
	return c.login(ctx, "kubernetes", map[string]string{"identity": identity, "jwt": jwt})
}

// LoginCert logs in with a TLS client certificate and a proof-of-possession JWT.
func (c *Client) LoginCert(ctx context.Context, identity, certificatePEM, proof string) (*IssuedToken, error) {
	return c.login(ctx, "cert", map[string]string{"identity": identity, "certificatePem": certificatePEM, "proof": proof})
}

// LoginAWS logs in with a presigned sts:GetCallerIdentity request.
func (c *Client) LoginAWS(ctx context.Context, identity string, request AWSLogin) (*IssuedToken, error) {
	method := request.HTTPRequestMethod
	if method == "" {
		method = "POST"
	}
	return c.login(ctx, "aws", map[string]string{
		"identity":             identity,
		"iamHttpRequestMethod": method,
		"iamRequestUrl":        request.RequestURL,
		"iamRequestBody":       request.RequestBody,
		"iamRequestHeaders":    request.RequestHeaders,
	})
}
