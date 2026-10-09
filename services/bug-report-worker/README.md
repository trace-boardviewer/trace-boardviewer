# Private report receiver

This module accepts a reviewed report from the desktop app and stores it in a separate D1 database. It has no account, issue-publishing, email, or payment integration. It does not expose report reads over HTTP.

## Dashboard deployment checklist

1. Create a dedicated Worker named `trace-bug-report` and a dedicated D1 database named `trace-bug-reports`. Do not bind or reuse the support/payment database.
2. Run `schema.sql` against the new database before deploying the Worker. Keep the binding name frozen as `BUG_REPORT_DB`.
3. Build the single readable module with `node scripts/build-bug-report-worker.cjs`. Paste `services/bug-report-worker/bundle.mjs` into the dashboard module editor. Record its SHA-256 and compare it with the reviewed build output before saving.
4. Bind the D1 database to the Worker as `BUG_REPORT_DB`. Configure exactly one daily Cron trigger for `0 4 * * *`; it runs bounded retention cleanup. Check the account has a free Cron slot and enough Workers/D1 headroom alongside existing services before enabling anything.
5. Turn off Worker invocation/request logs and body observability. Do not add secrets, API tokens, routes, a public report listing, read replication, or external forwarding.
6. The app remains disabled until the deployed endpoint hostname and exact `/v1/reports` route are verified, the contract and bundle hash are reviewed, and a packaged app has been explicitly configured by the root coordinator.
7. During acceptance, send only synthetic content through the actual Worker. Inspect the committed D1 row in the authenticated dashboard, retry the identical report id and verify the same receipt with one row, then verify a changed payload with that id receives a conflict. Never paste the contents into logs, issues, release text, or public artifacts.
8. Monitor aggregate Workers/D1 usage and disable the new Worker if the shared free account approaches its limits. The per-source and daily counters bound ordinary intake, not distributed denial of service; Cloudflare observes network connections. Do not change payment bindings, webhooks, keys, receipts, or service settings.

The proposed endpoint is not verified by this source package. A successful response is issued only after D1 admission and the durable report write have completed. Reports are kept for up to 30 days when the daily cleanup runs normally: the internal expiry is 29 days and cleanup runs at 04:00 UTC, with a 500-report batch. A missed or delayed run, or a larger backlog, can extend physical retention beyond 30 days. D1 recovery history can retain deleted content for up to seven additional days after deletion. Daily source salts, hashed source buckets, admissions and counters are eligible after 24 hours and are removed within 48 hours under normal daily cadence; missed runs can extend that period. Cleanup removes at most 2,500 rows per run from each high-volume ephemeral table, enough for the 2,000-admission daily cap; after an outage backlog, it repays at least 500 excess rows per normal day while intake remains at the cap. No raw source IP is stored or logged by this code.

The shared contract rejects descriptions over 8,192 raw UTF-16 code units before Unicode counting, UTF-8 encoding, or normalization. It then enforces at most 2,000 code points and 8 KiB UTF-8 on the validated description. This bounded allowance supports CRLF normalization while keeping normalization work capped.

## Local proof

Run `node --test tests/bug-report-contract-checks.cjs tests/bug-report-worker-checks.cjs`. These checks use synthetic payloads and Node's actual `node:sqlite` implementation; they do not contact a deployed service or use user report data.
