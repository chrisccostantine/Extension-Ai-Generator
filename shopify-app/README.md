# Shopify App Migration Scaffold

This folder is the next-step structure for moving the project from a Chrome extension MVP into a real Shopify app.

## Goal

Replace:

- manual backend URL entry
- shared popup access token
- standalone browser-extension flow

With:

- Shopify app install flow
- store-level authentication
- embedded admin UI
- Shopify admin action on product pages

## What is in this folder

- `shopify.app.toml.example`: example Shopify app config
- `.env.example`: env variables for local app development
- `package.json`: starter scripts for Shopify CLI workflow
- `web/`: embedded app starter UI contract
- `extensions/product-generator-action/`: admin action extension scaffold

## How this maps to the current backend

Your Railway backend remains the source of truth for:

- AI generation
- plans
- subscriptions
- usage limits
- manual plan requests
- admin approval panel

The future Shopify app will:

1. install on a shop through Shopify auth
2. know which shop is logged in
3. call the backend with trusted shop identity
4. render product-generation UI inside Shopify admin

## Recommended migration order

1. Create the real Shopify app in your Partner dashboard
2. Copy `shopify.app.toml.example` into `shopify.app.toml`
3. Fill `.env` from `.env.example`
4. Install Shopify CLI locally
5. Run `npm run dev`
6. Replace the Chrome extension flow with the admin action UI

## Important note

This is a scaffold and integration contract, not a full generated Shopify CLI app. The official app bootstrap still needs to be created with Shopify CLI, but this folder gives you the file layout, extension direction, and backend contract we want to preserve.
