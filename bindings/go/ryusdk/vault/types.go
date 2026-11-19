package vault

import (
	"encoding/json"
	"strconv"
)

// Secret is a secret string from a vault reply. Printing it with fmt (%v, %s,
// %q, %#v) or encoding it with encoding/json shows [Redacted]; Reveal returns
// the value.
type Secret string

// Reveal returns the secret value.
func (s Secret) Reveal() string { return string(s) }

func (s Secret) String() string { return Redacted }

// GoString keeps %#v redacted.
func (s Secret) GoString() string { return strconv.Quote(Redacted) }

// MarshalJSON keeps a logged reply redacted. Use Reveal to send the value on.
func (s Secret) MarshalJSON() ([]byte, error) { return json.Marshal(Redacted) }

// UnmarshalJSON reads the value as Core sends it.
func (s *Secret) UnmarshalJSON(data []byte) error {
	var text string
	if err := json.Unmarshal(data, &text); err != nil {
		return err
	}
	*s = Secret(text)
	return nil
}

// SecretJSON is secret JSON (an unwrapped response, a cubbyhole value) that
// prints and encodes as [Redacted]. Reveal or Decode read it.
type SecretJSON []byte

// Reveal returns the raw JSON.
func (s SecretJSON) Reveal() json.RawMessage { return json.RawMessage(s) }

// Decode unmarshals the JSON into v.
func (s SecretJSON) Decode(v any) error { return json.Unmarshal(s, v) }

func (s SecretJSON) String() string { return Redacted }

// GoString keeps %#v redacted.
func (s SecretJSON) GoString() string { return strconv.Quote(Redacted) }

// MarshalJSON keeps a logged reply redacted.
func (s SecretJSON) MarshalJSON() ([]byte, error) { return json.Marshal(Redacted) }

// UnmarshalJSON keeps a copy of the raw JSON.
func (s *SecretJSON) UnmarshalJSON(data []byte) error {
	*s = append((*s)[0:0], data...)
	return nil
}

// Timestamp is Core's rendered time: an RFC 3339 string, or a raw epoch
// number when it is out of range.
type Timestamp string

// UnmarshalJSON accepts a string or a number.
func (t *Timestamp) UnmarshalJSON(data []byte) error {
	var text string
	if err := json.Unmarshal(data, &text); err == nil {
		*t = Timestamp(text)
		return nil
	}
	var number json.Number
	if err := json.Unmarshal(data, &number); err != nil {
		return err
	}
	*t = Timestamp(number.String())
	return nil
}

// IssuedToken is a minted vault token. Token (`rvt_.`) is shown once.
type IssuedToken struct {
	Accessor   string    `json:"accessor"`
	ExpiresAt  Timestamp `json:"expiresAt"`
	IdentityID string    `json:"identityId"`
	Policies   []string  `json:"policies"`
	Token      Secret    `json:"token"`
}

// Lease is a dynamic-credential lease.
type Lease struct {
	ID           string     `json:"id"`
	Role         string     `json:"role"`
	Provider     string     `json:"provider"`
	IssuedTo     *string    `json:"issuedTo"`
	Renewable    bool       `json:"renewable"`
	CreatedAt    Timestamp  `json:"createdAt"`
	ExpiresAt    Timestamp  `json:"expiresAt"`
	MaxExpiresAt Timestamp  `json:"maxExpiresAt"`
	RevokedAt    *Timestamp `json:"revokedAt"`
}

// DynamicCredential is an issued credential. Data is returned once.
type DynamicCredential struct {
	Data  map[string]Secret `json:"data"`
	Lease Lease             `json:"lease"`
}

// WrapInfo describes a single-use wrapping token. Token is absent from lookups.
type WrapInfo struct {
	Accessor     string    `json:"accessor"`
	CreatedAt    Timestamp `json:"createdAt"`
	CreationPath string    `json:"creationPath"`
	ExpiresAt    Timestamp `json:"expiresAt"`
	Token        Secret    `json:"token,omitempty"`
	TTLSecs      int64     `json:"ttlSecs"`
}

// DataKey is a transit data key: Plaintext (base64) and its Ciphertext.
type DataKey struct {
	Plaintext  Secret `json:"plaintext"`
	Ciphertext string `json:"ciphertext"`
}

// IssuedSecretID is an AppRole secret id, returned exactly once.
type IssuedSecretID struct {
	SecretID Secret `json:"secretId"`
	Info     Object `json:"info"`
}

// ExportResult is an export. Content holds the values.
type ExportResult struct {
	Content     Secret `json:"content"`
	ContentType string `json:"contentType"`
	Count       int    `json:"count"`
	Environment string `json:"environment"`
	Format      string `json:"format"`
	Path        string `json:"path"`
}

// Certificate is an issued or signed PKI certificate. PrivateKey is set once for `issue`.
type Certificate struct {
	Certificate string    `json:"certificate"`
	IssuingCA   string    `json:"issuingCa"`
	NotAfter    Timestamp `json:"notAfter"`
	PrivateKey  Secret    `json:"privateKey,omitempty"`
	Serial      string    `json:"serial"`
}

// TokenRequest is the camelCase VaultTokenRequest body; zero fields are omitted.
type TokenRequest struct {
	Policies           []string `json:"policies,omitempty"`
	TTLSecs            int      `json:"ttlSecs,omitempty"`
	ExplicitMaxTTLSecs int      `json:"explicitMaxTtlSecs,omitempty"`
	PeriodSecs         int      `json:"periodSecs,omitempty"`
	NumUses            int      `json:"numUses,omitempty"`
	Renewable          *bool    `json:"renewable,omitempty"`
	Orphan             *bool    `json:"orphan,omitempty"`
	Role               string   `json:"role,omitempty"`
	BoundCIDRs         []string `json:"boundCidrs,omitempty"`
}

// Coords are a value's coordinates. Environment defaults to `default` and
// Path to `/` on the server; BindingID scopes the value to an MCP binding.
type Coords struct {
	Scope       string
	ScopeID     string
	Environment string
	Path        string
	BindingID   string
}

func (c Coords) body() map[string]any {
	body := map[string]any{"scope": c.Scope}
	if c.ScopeID != "" {
		body["scopeId"] = c.ScopeID
	}
	if c.Environment != "" {
		body["environment"] = c.Environment
	}
	if c.Path != "" {
		body["path"] = c.Path
	}
	if c.BindingID != "" {
		body["binding"] = map[string]string{"id": c.BindingID, "kind": "mcp"}
	}
	return body
}
