package vault

import "context"

func secretPath(name, suffix string) (string, error) {
	seg, err := segment(name)
	if err != nil {
		return "", err
	}
	return "/api/vault/secrets/" + seg + suffix, nil
}

// ListQuery filters ListSecrets. Nil booleans keep Core's defaults.
type ListQuery struct {
	Environment    string
	Path           string
	Recursive      *bool
	IncludeDeleted *bool
}

// ListSecrets returns value metadata (never values) with the node, seal and caller context.
func (c *Client) ListSecrets(ctx context.Context, q ListQuery) (Object, error) {
	var out Object
	path := "/api/vault/secrets" + query(
		"environment", q.Environment,
		"path", q.Path,
		"recursive", boolParam(q.Recursive),
		"includeDeleted", boolParam(q.IncludeDeleted),
	)
	return out, c.send(ctx, "GET", path, nil, &out)
}

func withVersion(coords Coords, version int) map[string]any {
	body := coords.body()
	if version > 0 {
		body["version"] = version
	}
	return body
}

// RevealSecret reads a value (requires `read`; audited). version 0 is the current one.
func (c *Client) RevealSecret(ctx context.Context, name string, coords Coords, version int) (Secret, error) {
	path, err := secretPath(name, "/reveal")
	if err != nil {
		return "", err
	}
	var out struct {
		Value Secret `json:"value"`
	}
	err = c.send(ctx, "POST", path, withVersion(coords, version), &out)
	return out.Value, err
}

// WrapSecret reveals a value behind a single-use wrapping token, so the
// plaintext never reaches this client. ttl is `300`, `300s`, `5m` or `1h`.
func (c *Client) WrapSecret(ctx context.Context, name string, coords Coords, version int, ttl string) (*WrapInfo, error) {
	path, err := secretPath(name, "/reveal")
	if err != nil {
		return nil, err
	}
	var out struct {
		WrapInfo WrapInfo `json:"wrapInfo"`
	}
	if err := c.t.human(ctx, "POST", path, withVersion(coords, version), &out, WrapTTLHeader, ttl); err != nil {
		return nil, err
	}
	return &out.WrapInfo, nil
}

// PutSecretInput writes a value. A nil Value is a metadata-only update.
type PutSecretInput struct {
	Coords
	Value           *string
	Metadata        map[string]any
	ExpectedVersion int
}

// PutSecret writes a value. A protected environment answers with a
// `changeRequest` instead of a `secret`.
func (c *Client) PutSecret(ctx context.Context, name string, input PutSecretInput) (Object, error) {
	path, err := secretPath(name, "")
	if err != nil {
		return nil, err
	}
	body := input.Coords.body()
	if input.Value != nil {
		body["value"] = *input.Value
	}
	if input.Metadata != nil {
		body["metadata"] = input.Metadata
	}
	if input.ExpectedVersion > 0 {
		body["expectedVersion"] = input.ExpectedVersion
	}
	var out Object
	return out, c.send(ctx, "PUT", path, body, &out)
}

// DeleteSecret soft-deletes a value (restorable). Core takes the coordinates as a JSON body.
func (c *Client) DeleteSecret(ctx context.Context, name string, coords Coords) (Object, error) {
	return c.secretOp(ctx, "DELETE", name, "", coords.body())
}

// SecretVersions lists version metadata, never values.
func (c *Client) SecretVersions(ctx context.Context, name string, coords Coords) (Object, error) {
	path, err := secretPath(name, "/versions")
	if err != nil {
		return nil, err
	}
	path += query(
		"scope", coords.Scope,
		"scopeId", coords.ScopeID,
		"mcpId", coords.BindingID,
		"environment", coords.Environment,
		"path", coords.Path,
	)
	var out Object
	return out, c.send(ctx, "GET", path, nil, &out)
}

// RollbackSecret makes an older version current.
func (c *Client) RollbackSecret(ctx context.Context, name string, coords Coords, version int) (Object, error) {
	body := coords.body()
	body["version"] = version
	return c.secretOp(ctx, "POST", name, "/rollback", body)
}

// RestoreSecret undoes a soft delete.
func (c *Client) RestoreSecret(ctx context.Context, name string, coords Coords) (Object, error) {
	return c.secretOp(ctx, "POST", name, "/restore", coords.body())
}

// DestroySecret permanently destroys versions (all when versions is empty).
func (c *Client) DestroySecret(ctx context.Context, name string, coords Coords, versions []int) (Object, error) {
	body := coords.body()
	if len(versions) > 0 {
		body["versions"] = versions
	}
	return c.secretOp(ctx, "POST", name, "/destroy", body)
}

func (c *Client) secretOp(ctx context.Context, method, name, suffix string, body any) (Object, error) {
	path, err := secretPath(name, suffix)
	if err != nil {
		return nil, err
	}
	var out Object
	return out, c.send(ctx, method, path, body, &out)
}
