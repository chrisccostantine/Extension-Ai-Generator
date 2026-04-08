# Backend Integration Notes

Current backend base URL:

- production: `https://your-railway-domain.up.railway.app`

Current endpoints already available:

- `GET /health`
- `GET /plans`
- `GET /usage`
- `GET /shop-status`
- `POST /generate-product-content`
- `POST /plan-requests`
- `GET /admin`

## Current auth state

The MVP backend uses:

- `x-extension-token` for extension requests
- `x-admin-token` for admin panel requests

## Target Shopify app auth state

Replace the shared extension token with one of these trusted signals:

1. verified installed shop session from Shopify
2. server-side shop session tied to the embedded app
3. signed backend requests using Shopify session-token verification

## Recommended transition

1. Keep current backend routes
2. Add Shopify app install/auth
3. Pass the installed shop identity from the Shopify app to the backend
4. Validate the request using Shopify session flow
5. Remove manual token entry from the user-facing UI

## Shop identity

Current store id format:

- `shopify-store:<store-handle>`

When you migrate fully, prefer storing:

- full shop domain, for example `marka-store-lb.myshopify.com`

That will be more stable and more Shopify-native than only the handle.
