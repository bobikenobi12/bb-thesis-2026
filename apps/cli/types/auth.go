package types

// ExchangeResponse defines the structure of the JSON response from the token exchange endpoint.
type ExchangeResponse struct {
	AccessToken string `json:"access_token"`
	UserEmail   string `json:"user_email"`
}
