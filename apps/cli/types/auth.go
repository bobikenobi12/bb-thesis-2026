package types

// ExchangeResponse defines the structure of the JSON response from the token exchange endpoint.
type ExchangeResponse struct {
	AccessToken   string `json:"access_token"`
	RefreshToken  string `json:"refresh_token"`
	ProviderToken string `json:"provider_token,omitempty"`
	UserEmail     string `json:"user_email"`
}
