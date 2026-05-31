---
name: store-ops
description: Control and inspect the live "product-trends" dropshipping automation system (5 Shopify stores, CJ fulfillment, scheduler, monitoring jobs, alerts). Use when the user wants to check orders, run or toggle jobs, change autonomy, reprice/inventory status, link CJ suppliers, view the audit log, or operate the deployed system. The system is the cockpit's execution layer; this skill drives it.
---

# Store Ops Control

This skill drives the deployed automation system. **Claude is the control plane; the Node app is the always-on executor.** Never put Claude in the per-order hot path — use these endpoints to inspect and command the system.

## Base URLs
- **Production (Railway, 24/7):** `https://product-trends-production.up.railway.app`
- **Local dev:** `http://localhost:3000` (only while `node server.js` runs)

Use production by default. Set `BASE` accordingly in commands.

## Auth
- Most control endpoints are open on the instance. **Admin endpoints** (`/api/admin/*`) require header `x-admin-token: $ADMIN_TOKEN` (the Railway env var `ADMIN_TOKEN`; locally saved at `/tmp/ptadmtok`).

## The scheduler & autonomy (safety first)
- `GET /api/scheduler` → list jobs (fulfillment-sweep, inventory-sync, price-margin-monitor, ad-metrics, api-health, product-research, daily-summary), their cron, enabled, lastRun/lastResult, and current autonomy.
- `POST /api/scheduler/:name` `{enabled, cron}` → enable/disable or reschedule a job.
- `POST /api/scheduler/:name/run` `{dryRun:true}` → **run once. ALWAYS dry-run first** for mutating jobs (inventory-sync, price-margin-monitor) to preview planned actions before enabling.
- `POST /api/scheduler/autonomy` `{mode}` → `full` (act+report) | `suggest` (alert only) | `off` (kill-switch). Env `AUTONOMY_DISABLED=1` hard-forces off.

**Guardrail:** mutating jobs only act when autonomy is `full` AND not dry-run. Money/listing-changing jobs (reprice, hide) are bounded (≤±15% price/run, margin floor, ≤1 reprice/product/day, per-run caps). Before enabling any mutating job live, dry-run it and review `planned`.

## Orders & fulfillment
- `GET /api/orders?status=&storeId=&limit=` → order records (status: received | unverified | held | submitted | failed | needs_human).
- `POST /api/orders/:orderId/retry` → retry a failed order.
- `POST /api/orders/simulate` `{storeId, lineItems?, submit?}` → dry-run the CJ fulfillment path (or `submit:true` to place a real order — avoid in testing).
- `POST /api/stores/:storeId/auto-order` `{enabled}` → arm/disarm auto-fulfillment per store.
- Fulfillment replays the stored webhook payload (no read_orders scope needed; works cross-org).

## CJ supplier linking (required before fulfillment/repricing works)
- `POST /api/stores/:storeId/cj-link` `{productHash?}` → auto-match store products to CJ suppliers (sets cjProductId, resolves cjVariantId, caches cjUnitCost). Omit productHash to link all unlinked.

## Monitoring & audit
- `GET /api/actions?store=&type=&limit=` → audit trail of every autonomous action.
- `GET /api/alerts/recent` → recent alerts. `POST /api/alerts/test` → send a test alert.
- `POST /api/config/alert-webhook` `{url}` → set the Slack/Discord webhook (or prod env `ALERT_WEBHOOK_URL`).
- `GET /api/inventory/alerts`, `GET /api/price-alerts` → read-only monitors.

## Webhook setup (per store, cross-org)
- In each store's Shopify admin → Settings → Notifications → Webhooks → "Order creation" → `{BASE}/api/webhooks/shopify/orders/create`.
- Register the store's signing secret: `POST /api/shopify/webhook-secret` `{storeId, secret}`.

## Admin / deploy
- `GET /api/admin/state-summary` (admin token) → store count, CJ token present, key presence, DATA_DIR.
- `POST /api/admin/restore-state` (admin token) `{stores, config}` → seed/restore volume state.
- Redeploy after code changes: `railway up --detach` (service `product-trends`, linked).

## Common requests → what to do
- "How are the stores doing?" → `GET /api/scheduler` + `GET /api/orders?limit=20` + `GET /api/actions?limit=20`; summarize.
- "Turn on monitoring" → dry-run inventory-sync & price-margin-monitor, review planned, then `POST /api/scheduler/:name {enabled:true}` for each (autonomy already `full`).
- "Something's wrong / stop everything" → `POST /api/scheduler/autonomy {mode:"off"}`.
- "Find suppliers for store X" → `POST /api/stores/X/cj-link`.

## Related
- Shopify deep work: use the `shopify-dev-mcp` MCP (GraphQL schema/docs) and `shopify` CLI (`store execute` for live Admin GraphQL, `theme push/publish`).
- Cross-platform trend/competitor data: use the `scrape-creators` MCP (27+ platforms).
