# Healthtech-1 Form Ingestion Take-Home

This project implements a resilient form ingestion API for unreliable third-party registration forms.

The system stores raw payloads, validates the current provider contract at runtime, transforms valid forms into the FORM-BOT schema, geocodes postcodes, sends a notification email, and keeps failed forms retryable.

## What Was Built

- `POST /ingest` accepts third-party form submissions.
- `POST /retry/:id` retries one failed form.
- `POST /retry` retries all retryable forms, optionally filtered by status.
- `GET /forms/:id` reads one stored form.
- `GET /forms` lists stored forms, optionally filtered by status.
- SQLite persistence for raw ingests, transformed forms, and email notification state.
- Runtime schema validation with `zod`.
- Idempotency through database uniqueness constraints and payload hashing.
- Structured validation failure details for schema drift investigation.
- Deterministic transformation from the ingested schema to the FORM-BOT schema.
- Retryable handling for validation, geocoding, transformation, and email failures.
- Tests covering happy path, duplicates, schema drift, empty requests, retry flows, filtering, and read endpoints.

## Design Goals

The important requirement is not just accepting JSON. The third-party provider is unreliable, and the data is healthcare data, so the system needs to preserve information and avoid unsafe side effects.

This implementation prioritizes:

- **Durability**: raw payloads are stored even when validation or processing fails.
- **Idempotency**: duplicate submissions do not create duplicate transformed forms or duplicate notification records.
- **Retryability**: failures are recorded with status and error details so they can be retried after a transient recovery or code change.
- **Determinism**: schema validation and transformation are explicit code paths, not AI guesses.
- **Auditability**: each form has a clear processing status and stored error details.

## Data Model

SQLite is used as the backing database. By default, the local database is created at:

```text
data/forms.sqlite
```

Tables:

- `ingested_forms`: raw provider payload, dedupe keys, processing status, and failure details.
- `transformed_forms`: FORM-BOT-ready payload, unique per ingested form.
- `email_notifications`: durable notification state so email retries do not duplicate transformed forms.

Important constraints:

- `ingested_forms.session_id` is unique.
- `ingested_forms.application_reference` is unique.
- `ingested_forms.payload_hash` is unique.
- `transformed_forms.ingested_form_id` is unique.
- `email_notifications.ingested_form_id` is unique.

These constraints enforce the "never process the same form twice" requirement at the database layer.

## Statuses

Forms move through explicit statuses:

- `received`
- `ready`
- `validation_failed`
- `geocoding_failed`
- `transform_failed`
- `email_failed`

Retryable statuses:

- `validation_failed`
- `geocoding_failed`
- `transform_failed`
- `email_failed`

Validation failures include structured issues:

```json
{
  "code": "SCHEMA_VALIDATION_FAILED",
  "message": "Payload does not match the agreed provider schema",
  "issues": [
    {
      "path": "email",
      "message": "Invalid email address"
    }
  ]
}
```

## Running Locally

Install dependencies:

```bash
bun install
```

Run the app:

```bash
bun run dev
```

Run all checks:

```bash
bun run c
```

`bun run c` runs build, lint, typecheck, and tests.

## API Examples

Ingest an example form:

```bash
curl -X POST http://localhost:3000/ingest \
  -H "Content-Type: application/json" \
  --data @src/forms/examples/person_one.json
```

Fetch one form:

```bash
curl http://localhost:3000/forms/1
```

List forms:

```bash
curl http://localhost:3000/forms
```

List forms by status:

```bash
curl "http://localhost:3000/forms?status=validation_failed"
```

Retry one form:

```bash
curl -X POST http://localhost:3000/retry/1
```

Retry all retryable forms:

```bash
curl -X POST http://localhost:3000/retry
```

Retry retryable forms by status:

```bash
curl -X POST "http://localhost:3000/retry?status=email_failed"
```

## Deterministic Failure Testing

The provided mock providers are intentionally flaky. For manual testing and demos, failures can be forced with environment variables.

Force postcode lookup failure:

```bash
MOCK_IDEALPOSTCODES_STATUS=500 bun run dev
```

Force email failure:

```bash
MOCK_SENDGRID_STATUS=500 bun run dev
```

Then ingest a form and retry it after restarting without the failure variable.

## Trade-Offs

This is intentionally a compact v1. Processing currently happens synchronously inside the request path so the behavior is easy to inspect and test for a take-home submission.

For production, I would split ingestion and processing:

- `/ingest` would persist the raw payload and return quickly.
- Background workers would validate, geocode, transform, notify, and deliver to FORM-BOT.
- External side effects would use durable outbox records and idempotency keys.
- Failed jobs would retry with backoff and max-attempt limits.
- Repeated failures would move to a poison queue for human/AI-assisted review rather than retrying forever.

## Production Improvements With More Time

- **Transactional outbox and worker processing**: avoid request timeouts and make provider/email side effects crash-safe.
- **FORM-BOT delivery table**: model delivery to the bot separately from transformation so "ready" and "delivered" are distinct states.
- **Append-only audit log**: preserve every status transition for healthcare traceability.
- **Poison queue**: after repeated failures, route forms for human/AI-assisted review.
- **Schema versioning**: record the provider schema version or inferred contract version for long-term explainability.
- **Observability**: metrics and alerts for duplicate rate, validation failures, geocoding failures, email failures, and retry volume.
- **PII controls**: redact sensitive values from logs, restrict DB access, and define data retention behavior.
- **Pagination**: add pagination to `GET /forms` before the table grows.

## Submission Notes

The implementation is deterministic by design. AI is not used in the correctness path. If AI were introduced in production, it would be limited to assisting review of quarantined payloads, never making unaudited decisions about healthcare form correctness.
