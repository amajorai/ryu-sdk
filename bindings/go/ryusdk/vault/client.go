// Package vault is the Go client for Ryu Core's Secret Vault (`/api/vault/*`),
// the Go form of the TypeScript `@ryu/core-client` vault module.
//
// It is pure Go (net/http, no cgo), so it builds without the Rust FFI the
// parent ryusdk package links.
//
// Wire conventions: JSON is camelCase. Human routes send the node bearer in
// `Authorization` (plus the optional `x-ryu-user-jwt`). Machine routes
// (`/api/vault/auth/*` logins, `/api/vault/agent/*`, and the wrapping
// unwrap/lookup/rewrap routes) are public mounts that authenticate in-handler:
// they send only `x-ryu-vault-token` (or the wrapping token in the body) and
// never the node bearer.
//
// Secret material (revealed values, issued tokens, dynamic credentials,
// transit plaintext, secret ids, unwrapped responses) is typed as [Secret] or
// [SecretJSON], whose String, GoString and MarshalJSON never show the value.
// Call Reveal to read it.
package vault

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	// TokenHeader carries a machine vault token (`rvt_.`) on the public routes.
	TokenHeader = "x-ryu-vault-token"
	// WrapTTLHeader asks Core to wrap a response (`300`, `300s`, `5m` or `1h`).
	WrapTTLHeader = "x-ryu-wrap-ttl"
	// UserJWTHeader carries the end user's JWT beside the node bearer.
	UserJWTHeader = "x-ryu-user-jwt"
	// Redacted is what secret values print as.
	Redacted = "[redacted]"
)

// Object is a decoded JSON object. Core never puts secret values in the
// listing, metadata and status replies returned as an Object.
type Object = map[string]any

// Option configures a [Client] or [AgentClient].
type Option func(*options)

type options struct {
	token   string
	userJWT string
	http    *http.Client
}

// WithToken sets the node bearer sent on human routes.
func WithToken(token string) Option { return func(o *options) { o.token = token } }

// WithUserJWT sets the end-user JWT (sent as x-ryu-user-jwt, and as the
// bearer when no node token is set).
func WithUserJWT(jwt string) Option { return func(o *options) { o.userJWT = jwt } }

// WithHTTPClient sets the HTTP client (default: 30 s timeout).
func WithHTTPClient(client *http.Client) Option { return func(o *options) { o.http = client } }

// Error is a non-2xx reply from Core. Message is Core's error text.
type Error struct {
	Status  int
	Code    string
	Message string
	Method  string
	Path    string
}

func (e *Error) Error() string {
	text := fmt.Sprintf("vault: %s %s failed: %d", e.Method, e.Path, e.Status)
	if e.Message != "" {
		text += " (" + e.Message + ")"
	}
	return text
}

// ErrInvalidID is returned, before any request, for an empty, "." or ".." path id.
var ErrInvalidID = errors.New(`vault: ids must be non-empty and not "." or ".."`)

type transport struct {
	base    string
	token   string
	userJWT string
	http    *http.Client
}

func newTransport(baseURL string, opts []Option) (*transport, error) {
	if strings.TrimSpace(baseURL) == "" {
		return nil, errors.New("vault: pass the node url")
	}
	o := options{}
	for _, opt := range opts {
		opt(&o)
	}
	if o.http == nil {
		o.http = &http.Client{Timeout: 30 * time.Second}
	}
	return &transport{base: strings.TrimRight(baseURL, "/"), token: o.token, userJWT: o.userJWT, http: o.http}, nil
}

func (t *transport) humanHeaders() http.Header {
	h := http.Header{}
	h.Set("Content-Type", "application/json")
	bearer := t.token
	if bearer == "" && strings.TrimSpace(t.userJWT) != "" {
		bearer = t.userJWT
	}
	if bearer != "" {
		h.Set("Authorization", "Bearer "+bearer)
	}
	if t.userJWT != "" {
		h.Set(UserJWTHeader, t.userJWT)
	}
	return h
}

func machineHeaders(vaultToken string) http.Header {
	h := http.Header{}
	h.Set("Content-Type", "application/json")
	if vaultToken != "" {
		h.Set(TokenHeader, vaultToken)
	}
	return h
}

// call sends one request and decodes a JSON object reply into out (when non-nil).
func (t *transport) call(ctx context.Context, method, path string, headers http.Header, body any, out any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("vault: encode %s body: %w", path, err)
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, t.base+path, reader)
	if err != nil {
		return fmt.Errorf("vault: %w", err)
	}
	request.Header = headers
	response, err := t.http.Do(request)
	if err != nil {
		return fmt.Errorf("vault: %s %s: %w", method, path, err)
	}
	defer response.Body.Close()
	text, err := io.ReadAll(response.Body)
	if err != nil {
		return fmt.Errorf("vault: read %s reply: %w", path, err)
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return apiError(method, path, response.StatusCode, text)
	}
	if out == nil || len(bytes.TrimSpace(text)) == 0 {
		return nil
	}
	if err := json.Unmarshal(text, out); err != nil {
		return fmt.Errorf("vault: decode %s reply: %w", path, err)
	}
	return nil
}

func (t *transport) human(ctx context.Context, method, path string, body any, out any, extra ...string) error {
	headers := t.humanHeaders()
	for i := 0; i+1 < len(extra); i += 2 {
		headers.Set(extra[i], extra[i+1])
	}
	return t.call(ctx, method, path, headers, body, out)
}

func (t *transport) machine(ctx context.Context, vaultToken, method, path string, body any, out any, extra ...string) error {
	headers := machineHeaders(vaultToken)
	for i := 0; i+1 < len(extra); i += 2 {
		headers.Set(extra[i], extra[i+1])
	}
	return t.call(ctx, method, path, headers, body, out)
}

// apiError reads Core's `{error: "text"}`, `{error: {code, message}}` or `{code, error}` reply.
func apiError(method, path string, status int, text []byte) *Error {
	out := &Error{Status: status, Method: method, Path: path}
	var body struct {
		Code  string          `json:"code"`
		Error json.RawMessage `json:"error"`
	}
	if json.Unmarshal(text, &body) != nil {
		return out
	}
	out.Code = body.Code
	var message string
	if json.Unmarshal(body.Error, &message) == nil {
		out.Message = message
		return out
	}
	var structured struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if json.Unmarshal(body.Error, &structured) == nil {
		if structured.Code != "" {
			out.Code = structured.Code
		}
		out.Message = structured.Message
	}
	return out
}

func segment(value string) (string, error) {
	if value == "" || value == "." || value == ".." {
		return "", ErrInvalidID
	}
	return url.PathEscape(value), nil
}

// query builds `?a=b` from key/value pairs, skipping empty values.
func query(pairs ...string) string {
	values := url.Values{}
	keys := make([]string, 0, len(pairs)/2)
	for i := 0; i+1 < len(pairs); i += 2 {
		if pairs[i+1] != "" {
			values.Set(pairs[i], pairs[i+1])
			keys = append(keys, pairs[i])
		}
	}
	if len(keys) == 0 {
		return ""
	}
	// Keep the caller's order (url.Values.Encode sorts), matching the TypeScript client.
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, url.QueryEscape(key)+"="+url.QueryEscape(values.Get(key)))
	}
	return "?" + strings.Join(parts, "&")
}

func boolParam(value *bool) string {
	if value == nil {
		return ""
	}
	return strconv.FormatBool(*value)
}

func ttlBody(ttlSecs int) map[string]any {
	if ttlSecs <= 0 {
		return map[string]any{}
	}
	return map[string]any{"ttlSecs": ttlSecs}
}

// Client is the human (node bearer) side of the vault. The login and wrapping
// unwrap/lookup/rewrap methods never send the bearer.
type Client struct {
	t *transport
}

// New returns a client for a node URL (for example http://127.0.0.1:7980).
func New(baseURL string, opts ...Option) (*Client, error) {
	t, err := newTransport(baseURL, opts)
	if err != nil {
		return nil, err
	}
	return &Client{t: t}, nil
}

// String never shows the bearer.
func (c *Client) String() string { return fmt.Sprintf("vault.Client{url: %q}", c.t.base) }

// Agent returns a machine-token client for the same node and HTTP client.
func (c *Client) Agent(vaultToken string) *AgentClient {
	return &AgentClient{t: c.t, token: vaultToken}
}

func (c *Client) send(ctx context.Context, method, path string, body any, out any) error {
	return c.t.human(ctx, method, path, body, out)
}
