# Support payment verification

This optional Worker confirms Stripe and Ko-fi support payments. A local signed receipt hides the support popup and heart button until one calendar year after payment, including offline use. It grants no access to application features.

The app creates a random reference, adds it to its fixed Stripe Payment Link as `client_reference_id`, and displays `TRACE-<reference>` for a Ko-fi payment message. The supporter returns to the app and clicks Verify payment. Only that explicit action makes a network request. The payment page alone never grants a receipt. A missing reference cannot be linked automatically; support made before this integration needs a separately verified recovery process.

Deploy `worker.mjs` as a module Worker. Create a D1 database, execute `schema.sql`, and bind it as `DB`. Stay on the Free plan; no paid upgrade is needed by this setup. Add these secrets directly in the provider dashboard, never to source or logs:

- `RECEIPT_PRIVATE_JWK`: the private P-256 JWK created by `node scripts/create-support-receipt-key.cjs <absolute-private-directory>`.
- `KOFI_VERIFICATION_TOKEN`: the existing Ko-fi webhook verification token.
- `STRIPE_WEBHOOK_SECRET`: the Stripe endpoint signing secret.

Add a text variable `STRIPE_PAYMENT_LINK_ID` matching the application's Payment Link. Configure Stripe snapshot events `checkout.session.completed` and `checkout.session.async_payment_succeeded` to POST to `/webhooks/stripe`. Configure Ko-fi to POST to `/webhooks/kofi`. Use only live Stripe payment events for production; test-mode events are ignored. Stripe signatures require the raw body and a timestamp within five minutes. Ko-fi uses its shared verification token. Never send a test payment with a real user's reference.

Ko-fi support types `Tip`, `Donation` and `Subscription` are accepted when the amount is positive and exactly one valid app reference appears in the message. Shop orders and commissions do not grant a support receipt.

Set a daily scheduled trigger to remove records 30 days after expiry. Payment records store only a hash of the provider transaction ID, random reference, payment time and expiry. Two bounded health rows store the provider name and most recent successful webhook authentication time; they contain no supporter or transaction information and are available only in the database dashboard. No supporter names, email addresses, amounts or payment bodies are stored. Turn off Workers observability request/body logging before connecting payments. No refunds are issued or payment account settings changed by this service.

Run `node scripts/check-support-worker.cjs` after deployment to verify that the server can sign a fresh health challenge with the application's pinned key. Health proofs use a separate signing domain and cannot serve as payment receipts. Provider-generated test events should update the corresponding `support_webhook_checks` row without creating a payment receipt when the message lacks an app reference.

Ship the matching **public** JWK and verified endpoint in `electron/support-verification.json`. Keep `enabled` false until deployment, secrets, signing-key proof, payment destinations and a provider-generated test event have been checked. Check the first live Stripe delivery separately if the dashboard offers no test delivery for a live endpoint. The public key stays pinned; do not generate a new key for each build. Changing the key needs an explicit receipt migration plan.

Test with `node --test tests/support-verification-checks.cjs` and the standard desktop suites. The cryptography and persistence use the common Electron main process on Windows, Linux and macOS. Actual builds and smoke tests on each platform remain necessary.

The local reference and signed receipt live in `support-receipt.json` in the selected app profile. Removing that file forgets the receipt and brings reminders back. Copying an entire profile carries the receipt to that profile. Without the original reference, an old payment is not claimed by entering an email address or clicking “already supported”.

Protocol references: [Stripe reference IDs](https://docs.stripe.com/payment-links/url-parameters), [Stripe webhook verification](https://docs.stripe.com/webhooks/signature), [Ko-fi webhooks](https://help.ko-fi.com/hc/en-us/articles/360004162298-Does-Ko-fi-have-an-API-or-webhook).
