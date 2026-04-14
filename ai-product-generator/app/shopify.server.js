import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

export const STARTER_MONTHLY_PLAN = "Starter Monthly";
export const STARTER_YEARLY_PLAN = "Starter Yearly";
export const GROWTH_MONTHLY_PLAN = "Growth Monthly";
export const GROWTH_YEARLY_PLAN = "Growth Yearly";
export const SCALE_MONTHLY_PLAN = "Scale Monthly";
export const SCALE_YEARLY_PLAN = "Scale Yearly";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  billing: {
    [STARTER_MONTHLY_PLAN]: {
      lineItems: [
        {
          amount: 9,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
        },
      ],
    },
    [STARTER_YEARLY_PLAN]: {
      lineItems: [
        {
          amount: 90,
          currencyCode: "USD",
          interval: BillingInterval.Annual,
        },
      ],
    },
    [GROWTH_MONTHLY_PLAN]: {
      lineItems: [
        {
          amount: 30,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
        },
      ],
    },
    [GROWTH_YEARLY_PLAN]: {
      lineItems: [
        {
          amount: 300,
          currencyCode: "USD",
          interval: BillingInterval.Annual,
        },
      ],
    },
    [SCALE_MONTHLY_PLAN]: {
      lineItems: [
        {
          amount: 79,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
        },
      ],
    },
    [SCALE_YEARLY_PLAN]: {
      lineItems: [
        {
          amount: 790,
          currencyCode: "USD",
          interval: BillingInterval.Annual,
        },
      ],
    },
  },
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
