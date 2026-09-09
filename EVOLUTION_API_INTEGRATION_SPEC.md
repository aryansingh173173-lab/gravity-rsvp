# Gravity RSVP — Evolution API WhatsApp Integration Specification

**Status:** Application implementation complete; external provisioning and pilot pending  
**Target volume:** Approximately 200 invitees  
**Primary RSVP system of record:** Existing Google Sheet  
**WhatsApp provider:** Evolution API using `WHATSAPP-BAILEYS`  
**Initial hosting:** Render Web Service  
**Evolution database:** Supabase PostgreSQL  

## 1. Objective

Extend the existing RSVP system so that an attending guest who explicitly consents to WhatsApp delivery receives the same personalised invitation PDF that is currently sent by email.

The integration must not replace, bypass, or weaken the existing form-to-Google-Sheet pipeline. A WhatsApp, Evolution API, Render, or Supabase outage must never prevent an RSVP from being saved to the Google Sheet.

## 2. Scope

### In scope

- Preserve every current RSVP field and existing spreadsheet record.
- Preserve the current email ticket workflow.
- Add explicit WhatsApp consent to the RSVP form.
- Normalise and validate recipient phone numbers.
- Add an independent WhatsApp delivery queue and delivery statuses.
- Generate the current personalised invitation PDF for WhatsApp delivery.
- Deploy one Evolution API instance on Render.
- Store Evolution's internal instance/session state in Supabase PostgreSQL.
- Pair one WhatsApp Business number through Linked Devices.
- Send the PDF through Evolution API's media endpoint.
- Retry temporary failures without resending successful emails.
- Record provider message IDs and operational errors in the Google Sheet.
- Provide connection-health and manual-retry procedures.

### Out of scope for version 1

- Replacing Google Sheets with Supabase.
- Copying RSVP guest records into Supabase.
- Bulk-importing contacts who did not submit the RSVP form.
- Chatbot or automated reply handling.
- Group messaging or broadcasts.
- Marketing messages.
- Meta Cloud API, WABA, message templates, or blue-tick verification.
- Converting the ticket PDF into an inline WhatsApp image.
- A customer-service inbox such as Chatwoot.

## 3. Existing architecture

```text
Browser form
  -> POST /api/rsvp
  -> Vercel or local Node proxy
  -> Google Apps Script doPost()
  -> Google Sheet append
  -> Email status = Pending
  -> background Apps Script trigger
  -> Google Slides ticket rendering
  -> PDF export
  -> MailApp.sendEmail()
```

The current Google Sheet contains these columns and they must remain in the same order:

| Column | Name |
|---|---|
| A | Timestamp |
| B | Unique ID |
| C | Full Name |
| D | Email Address |
| E | Mobile Number |
| F | Attending |
| G | Guest Count |
| H | Meal Preference |
| I | Special Requirements |
| J | Ticket Status |

Column J remains the existing email-ticket status. It must not be reused for WhatsApp state.

## 4. Target architecture

```text
Guest browser
  -> Vercel /api/rsvp
  -> Apps Script doPost()
  -> Google Sheet (always saved first)
       |-> Existing email queue -> MailApp -> guest email
       `-> WhatsApp queue -> Evolution API on Render
                              -> linked WhatsApp Business account
                              -> guest WhatsApp

Evolution API on Render
  -> Supabase PostgreSQL for Evolution instance/session state only
```

Google Sheets remains the authoritative source for:

- RSVP form data
- ticket ID
- email status
- WhatsApp consent
- WhatsApp delivery status
- retry/error history

Supabase must not become a second RSVP database.

## 5. Spreadsheet schema extension

Append the following columns after column J. Do not rename, move, clear, or overwrite columns A–J.

| Column | Name | Purpose |
|---|---|---|
| K | WhatsApp Consent | `Yes` or `No` from the form |
| L | WhatsApp Number | Normalised country-code number, digits only |
| M | WhatsApp Status | Independent delivery state |
| N | WhatsApp Message ID | Evolution/WhatsApp provider message identifier |
| O | WhatsApp Attempts | Number of completed send attempts |
| P | WhatsApp Last Error | Sanitised latest error |
| Q | WhatsApp Updated At | Timestamp of latest state change |

Allowed WhatsApp status values:

- `Not required`
- `No consent`
- `Invalid number`
- `Pending`
- `Sending`
- `Sent`
- `Delivered`
- `Read`
- `Unknown`
- `Retry N`
- `Disconnected`
- `Failed`

### Existing rows

- Existing rows must remain unchanged in columns A–J.
- Existing rows have no recorded WhatsApp consent and must default to `No consent`.
- No historical guest may receive WhatsApp automatically unless consent is collected separately and column K is explicitly changed to `Yes`.

## 6. Form data contract

The frontend submission payload becomes:

```json
{
  "fullName": "Aryan Singh",
  "email": "guest@example.com",
  "mobile": "+91 98765 43210",
  "attending": "Attending",
  "guestCount": "2",
  "meal": "",
  "specialRequirements": "",
  "whatsappConsent": true
}
```

The existing fields and meanings must remain backward-compatible.

### Consent control

Add an unchecked checkbox with this text:

> I agree to receive my Gravity Annual Day invitation and event updates on WhatsApp at the mobile number entered above.

WhatsApp delivery is queued only when all of the following are true:

- `attending === "Attending"`
- `whatsappConsent === true`
- the phone number normalises successfully

Consent is not inferred from entering a phone number.

## 7. Phone-number normalisation

The normaliser must:

1. Trim whitespace.
2. Remove spaces, hyphens, parentheses, and a leading `+`.
3. Convert a valid ten-digit Indian mobile number to `91XXXXXXXXXX`.
4. Preserve a valid international country-code number.
5. Reject alphabetic input, extensions, obviously invalid lengths, and all-zero values.
6. Store the original form value in column E and the normalised value in column L.

The initial implementation targets Indian numbers while retaining explicit international numbers.

## 8. Submission requirements

`doPost()` must follow this order:

1. Parse and validate the request.
2. Append the complete RSVP row to Google Sheets.
3. Flush the spreadsheet write.
4. Queue email if currently required.
5. Derive WhatsApp eligibility and initial WhatsApp status.
6. Schedule background workers.
7. Return success to the website.

The request handler must not call Evolution API synchronously. The user-facing form succeeds when the RSVP is safely stored, not when downstream delivery finishes.

Suggested success response:

```json
{
  "result": "success",
  "id": "GRV-2026-1042",
  "email": "queued",
  "whatsapp": "queued"
}
```

## 9. Supabase PostgreSQL specification

Supabase is an acceptable alternative to Neon for this workload.

### Usage boundary

Supabase is used only because Evolution API requires persistent PostgreSQL storage. It stores Evolution tables, instance metadata, and authentication/session state. It does not receive the Gravity RSVP form payload or act as the event guest database.

### Project configuration

- Create a dedicated Supabase project for Evolution API.
- Select a region close to the Render service region.
- Generate a strong unique database password.
- Create a dedicated database role for Evolution/Prisma where practical.
- Use the Supavisor **Session pooler** connection string on port `5432` for the persistent Render container.
- Require SSL.
- Store the connection string only as Render's `DATABASE_CONNECTION_URI` secret.
- Do not expose Supabase service-role keys because Evolution needs only PostgreSQL access.

Connection shape:

```text
postgresql://USER.PROJECT_REF:PASSWORD@REGION.pooler.supabase.com:5432/postgres?sslmode=require
```

Passwords must be URL-encoded when they contain reserved URL characters.

### Evolution persistence configuration

Required intent:

```text
DATABASE_PROVIDER=postgresql
DATABASE_SAVE_DATA_INSTANCE=true
DATABASE_SAVE_DATA_NEW_MESSAGE=false
DATABASE_SAVE_MESSAGE_UPDATE=false
DATABASE_SAVE_DATA_CONTACTS=false
DATABASE_SAVE_DATA_CHATS=false
DATABASE_SAVE_DATA_HISTORIC=false
DATABASE_SAVE_DATA_LABELS=false
DATABASE_SAVE_IS_ON_WHATSAPP=false
```

Actual variable names must be checked against the pinned Evolution release before deployment.

### Free-tier limitations

The Supabase Free plan is sufficient for the expected database size, but:

- It includes 500 MB database storage.
- It may pause after approximately seven days of low activity.
- Free projects do not provide downloadable automatic backups.
- The project must be checked and, if needed, resumed before the RSVP campaign.

This is acceptable only because Google Sheets—not Supabase—contains the RSVP business records. Losing the Evolution database may require another QR pairing, but must not lose guest submissions.

## 10. Render deployment specification

### Initial service

- Service type: Web Service
- Runtime: Docker
- Source: private deployment repository or a controlled fork
- Evolution image: pinned stable release, not `latest`
- Region: same or close to Supabase
- Public URL: Render-generated HTTPS URL
- Health check: Evolution server health endpoint
- Instance count: one

### Render environment variables

At minimum:

```text
SERVER_URL=https://SERVICE.onrender.com
SERVER_PORT=10000
DATABASE_PROVIDER=postgresql
DATABASE_CONNECTION_URI=<Supabase session-pooler URI>
DATABASE_CONNECTION_CLIENT_NAME=gravity_rsvp_evolution
AUTHENTICATION_API_KEY=<strong random secret>
AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES=false
CACHE_REDIS_ENABLED=false
CACHE_REDIS_SAVE_INSTANCES=false
CACHE_LOCAL_ENABLED=true
SERVER_DISABLE_DOCS=true
TELEMETRY_ENABLED=false
```

The service must bind to Render's assigned port. Confirm the pinned Evolution version respects the configured server port before launch.

### Free-service constraint

Render Free is a proof-of-concept environment, not the live-event target. It sleeps after inactivity and has no persistent disk. A sleeping or restarted service can disconnect the WhatsApp Web session.

Mandatory acceptance test:

1. Pair the WhatsApp account.
2. Send a test PDF.
3. Restart/redeploy Render.
4. Confirm Evolution reconnects without another QR scan.
5. Let the free service sleep.
6. Wake it with an API request.
7. Confirm connection recovery and successful delivery.

If either restart test fails, do not launch on Render Free. Use an always-on paid service or a VPS with persistent storage.

## 11. Evolution instance specification

- Instance name: `gravity-rsvp`
- Integration: `WHATSAPP-BAILEYS`
- QR pairing: enabled during setup
- Full history sync: disabled
- Automatic contact/chat history storage: disabled
- Always-online presence: disabled unless operationally required
- Read-message automation: disabled
- Reject calls: optional
- One linked WhatsApp Business number only

After pairing:

- Confirm instance state is `open` or `connected`.
- Send one text message to an internal number.
- Send one PDF to an internal number.
- Disable the public manager UI after setup or otherwise restrict access.
- Retain a documented QR re-pairing procedure.

## 12. Apps Script configuration

Store these values in Apps Script Properties, never in source code:

```text
EVOLUTION_BASE_URL
EVOLUTION_API_KEY
EVOLUTION_INSTANCE_NAME
WHATSAPP_DEFAULT_COUNTRY_CODE=91
WHATSAPP_BATCH_SIZE=10
```

Add these functions:

- `normalizeWhatsAppNumber(rawNumber)`
- `isWhatsAppEligible(row)`
- `getEvolutionConnectionState()`
- `sendTicketWhatsApp(fullName, number, uniqueID, pdfBlob)`
- `processPendingWhatsApp()`
- `sweepPendingWhatsApp()`
- `retryFailedWhatsAppRows()`
- `testEvolutionText()`
- `testEvolutionPdf()`

The existing email functions remain independently callable and retain their current status column.

## 13. WhatsApp media request

Endpoint:

```text
POST {EVOLUTION_BASE_URL}/message/sendMedia/{EVOLUTION_INSTANCE_NAME}
```

Authentication:

```text
apikey: {EVOLUTION_API_KEY}
```

Multipart fields:

| Field | Value |
|---|---|
| number | Normalised value from column L |
| mediatype | `document` |
| media | Existing personalised PDF Blob |
| fileName | `Gravity_Pass_<safe-name>_<ticket-id>.pdf` |
| caption | Personalised event confirmation and ticket ID |

Caption format:

```text
Hello <name>, thank you for confirming your RSVP for Gravity Annual Day 2026. Your personalised entry pass is attached. Ticket ID: <ticket-id>.
```

The API key must never be sent to the browser.

## 14. Queue, retry, and duplicate prevention

The WhatsApp queue must be separate from the existing email queue.

Default processing rules:

- Maximum batch size: 10 rows per trigger execution.
- Concurrency: one Apps Script worker guarded by a script lock.
- Only rows in `Pending` or `Retry N` are processed.
- Set status to `Sending` immediately before the API request.
- On a successful API response, store the message ID and set `Sent`.
- Retry temporary connection errors and HTTP `5xx` responses.
- Do not retry invalid-number, authentication, or malformed-request errors automatically.
- Maximum automatic attempts: three.
- Use increasing backoff between attempts.
- If Apps Script times out after transmitting the request, set `Unknown`; do not resend automatically until an operator verifies whether the message was delivered.

Ticket ID is the business idempotency key. Before sending, the worker must refuse to send when column N already contains a message ID.

## 15. Delivery status webhooks

Version 1 may mark a message `Sent` when Evolution accepts it. Production delivery tracking should add a protected webhook for:

- connection-state changes
- sent-message updates
- delivered/read updates when provided
- send failures

Recommended path:

```text
Evolution webhook
  -> Vercel /api/evolution-webhook
  -> validate shared secret/signature
  -> Apps Script status-update endpoint
  -> locate row by WhatsApp Message ID
  -> update M/Q or P
```

Webhook payloads must not be logged in full because they can contain phone numbers and message content.

## 16. Security requirements

- Keep all RSVP records in the existing Google Sheet.
- Remove full request-payload and Apps Script URL logging from the local Node server.
- Add rate limiting and bot protection to `/api/rsvp`.
- Add a server-side request signature/shared secret between Vercel and Apps Script.
- Store Evolution and database credentials only in secret stores.
- Use a long random Evolution API key.
- Restrict or disable Evolution Manager and API documentation after setup.
- Do not expose the Evolution API directly to browser JavaScript.
- Do not commit `.env`, database URLs, QR credentials, or API keys.
- Rotate the Evolution key after any suspected exposure.
- Keep the WhatsApp phone secured with device lock and two-step verification.

## 17. Reliability and fallback

- Email remains enabled and independent.
- RSVP submission succeeds after the spreadsheet write even when WhatsApp is down.
- WhatsApp failures appear in columns M–Q for manual action.
- A five-minute trigger retries eligible temporary failures.
- When Evolution reports disconnected, stop sending and mark queued rows `Disconnected` or leave them `Pending`.
- Provide a manual reconnect and single-row resend procedure.
- Never reset or resend all rows without filtering for unsent message IDs.

## 18. Test specification

### Unit tests

- Indian ten-digit number normalisation.
- `+91`, spaces, and hyphens.
- Explicit international number.
- Invalid and empty number.
- Consent true/false.
- Attending/not attending.
- Status transitions.
- Existing email status remains unchanged.
- Existing columns A–J remain in their original order.
- Duplicate message ID prevents resend.

### Integration tests

- Form submission saves all values to Google Sheets while Evolution is offline.
- Existing email still sends when Evolution is offline.
- Consenting attendee receives one personalised PDF on WhatsApp.
- Declining attendee receives no invitation.
- Non-consenting attendee receives email only.
- Long guest name remains fitted correctly in the PDF.
- Render restart preserves or restores the Evolution connection.
- Supabase reconnect succeeds after Render restart.
- Invalid Evolution key fails without exposing the key in logs.
- Evolution timeout becomes `Unknown`, not an automatic duplicate.

### Pilot

1. Developer's own number.
2. Three internal Gravity numbers.
3. Ten consenting pilot guests.
4. Observe for 24 hours.
5. Release to the remaining invitees only after the pilot is stable.

## 19. Acceptance criteria

The integration is ready when:

- All existing form and ticket tests still pass.
- Columns A–J and existing rows are preserved.
- New submissions always reach Google Sheets before delivery begins.
- Existing email delivery continues unchanged.
- Supabase contains no intentionally copied RSVP dataset.
- A valid consenting attendee receives exactly one personalised PDF through WhatsApp.
- A non-consenting or declining attendee receives no WhatsApp invitation.
- Render restart and cold-start tests pass.
- Secrets are absent from Git and browser code.
- Failed WhatsApp sends are visible and independently retryable.
- Ten-person pilot completes without duplicate messages or forced QR re-pairing.

## 20. Rollout plan

### Stage A — Local and infrastructure setup

- Create Supabase project and dedicated database credentials.
- Deploy Evolution API to Render Free.
- Configure secrets.
- Pair the WhatsApp number.
- Complete restart and cold-start tests.

### Stage B — Application implementation

- Append spreadsheet headers K–Q without clearing the sheet.
- Add consent and phone validation to the form.
- Add the independent WhatsApp Apps Script worker.
- Add security and logging fixes.
- Add automated tests.

### Stage C — Pilot

- Run internal tests.
- Process ten real consenting invitations.
- Observe connection and duplicate behaviour for 24 hours.

### Stage D — Production campaign

- Upgrade Render to always-on hosting for the campaign if free-tier stability is insufficient.
- Confirm Supabase is active.
- Confirm WhatsApp instance is connected.
- Publish the RSVP form.
- Review delivery statuses daily.

### Stage E — Post-event shutdown

- Disable WhatsApp triggers.
- Export required delivery audit data from Google Sheets.
- Disconnect the linked Evolution device if no longer required.
- Rotate/delete secrets.
- Delete unnecessary Evolution message/session data according to the retention policy.

## 21. Estimated effort

| Work item | Estimate |
|---|---:|
| Supabase and Render setup | 1–2 hours |
| Evolution deployment and pairing | 1–2 hours |
| Spreadsheet/form changes | 1–2 hours |
| Apps Script WhatsApp queue and delivery | 3–5 hours |
| Security and webhook work | 2–4 hours |
| Automated and internal testing | 2–3 hours |
| Pilot observation | 24 hours |

Expected implementation time is one to two working days, followed by a 24-hour pilot.

## 22. Key risks

| Risk | Impact | Mitigation |
|---|---|---|
| Baileys is not Meta's official API | Number logout or suspension | Use a separate/non-critical number; retain email fallback |
| Render Free sleeps | Delayed sends and connection loss | Cold-start retry logic; use paid always-on service during campaign |
| Render Free has no persistent disk | QR session may not survive restart | Persist Evolution instance data in Supabase; mandatory restart gate |
| Supabase Free pauses for low activity | Evolution cannot reconnect | Check/resume before launch; active campaign traffic; upgrade if required |
| Supabase Free lacks downloadable backups | Session metadata may be lost | RSVP data remains in Sheets; retain QR re-pairing procedure |
| Invalid phone formats | Failed or wrong recipient | Strict normalisation and validation; store original and normalised values |
| Timeout after send | Duplicate invitation risk | Use `Unknown` state and manual verification; message-ID guard |
| Public form abuse | Unwanted messages/account restriction | Consent, CAPTCHA, rate limiting, and signed backend requests |

## 23. Source references

- Evolution API overview and requirements: https://github.com/evolution-foundation/evolution-api
- Evolution media endpoint: https://docs.evolutionfoundation.com.br/evolution-api/send-media-message
- Evolution environment configuration: https://docs.evolutionfoundation.com.br/evolution-api/configuration/env
- Render Free limitations: https://render.com/docs/free
- Render pricing: https://render.com/pricing
- Supabase database connections: https://supabase.com/docs/guides/database/connecting-to-postgres
- Supabase Prisma connection guidance: https://supabase.com/docs/guides/database/prisma
- Supabase Free project pausing: https://supabase.com/docs/guides/platform/free-project-pausing
- Supabase pricing: https://supabase.com/pricing
- WhatsApp Business Terms: https://www.whatsapp.com/legal/business-terms
