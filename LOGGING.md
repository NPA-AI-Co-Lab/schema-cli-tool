# Logging Documentation

This document describes the logging system for tracking analysis runs, errors, and retry attempts.

## Log Directories

When logging is enabled (`--logging`), the CLI creates five log directories:

```
logging/
├── llm_input/           # Raw data sent to LLM
├── validation_errors/   # Schema validation & required field errors
├── retry_attempts/      # Retry attempts during error recovery
├── batch_outcomes/      # Batch processing success/failure results
└── uuid_generation/     # UUID generation events and caching
```

---

## 1. LLM Input Logs (`llm_input/`)

**Purpose:** Track what data is sent to the LLM for each batch.

**Location:** `logging/llm_input/llm_input_<timestamp>.log`

**Format:**

```json
{
  "batchIndex": 0,
  "lineRange": [0, 4],
  "records": [
    {
      "userID": "123",
      "givenName": "Jane",
      "familyName": "Doe",
      ...
    }
  ]
}
```

---

## 2. Validation Error Logs (`validation_errors/`)

**Purpose:** Track schema validation failures and missing required fields.

**Location:** `logging/validation_errors/validation_errors_<timestamp>.log`

**Format:**

```json
{
  "timestamp": "2025-09-30T11:14:52.590Z",
  "error_summary": "person.demographics.gender: Required field 'gender' is missing or null",
  "batch_info": {
    "batchIndex": 0,
    "csvLineRange": "0-4",
    "specificCsvLine": 2
  },
  "field_details": {
    "expectedType": "non-null value",
    "actualValue": null,
    "errorMessage": "Required field 'gender' is missing or null"
  }
}
```

**Common Error Types:**

- **Schema mismatch:** `Expected object, received string`
- **Missing required field:** `Required field 'X' is missing or null`
- **Invalid enum:** `Invalid enum value. Expected 'male' | 'female'...`
- **Type error:** `Expected number, received string`

---

## 3. Retry Attempt Logs (`retry_attempts/`)

**Purpose:** Track retry attempts and model fallbacks during error recovery.

**Location:** `logging/retry_attempts/retry_attempts_<timestamp>.log`

### 3.1 Retry Attempt Entry

Validation error with fallback model:

```json
{
  "timestamp": "2025-09-30T14:23:45.123Z",
  "batch_info": {
    "batchIndex": 2,
    "csvLineRange": "10-14"
  },
  "retry_info": {
    "attempt": "1/2",
    "errorType": "validation_error",
    "actionTaken": "retry_with_fallback",
    "fallbackModel": "gpt-4o"
  },
  "error_summary": "Batch 2: Zod validation failed: Expected object, received string"
}
```

Rate-limit retry (with wait duration):

```json
{
  "timestamp": "2025-09-30T14:45:12.567Z",
  "batch_info": {
    "batchIndex": 5,
    "csvLineRange": "25-29"
  },
  "retry_info": {
    "attempt": "2/8",
    "errorType": "rate_limit_error",
    "actionTaken": "retry_after_wait",
    "waitMs": 5000
  },
  "error_summary": "429 Too Many Requests"
}
```

**Error Types:**

- `api_error` - Server errors (500+) or other API issues
- `rate_limit_error` - Rate limit (HTTP 429) returned by OpenAI
- `validation_error` - Schema validation failure
- `required_field_error` - Required field missing/null
- `network_error` - Other network/connection issues

**Action Taken:**

- `retry_same` - Retry with same parameters (for API errors)
- `retry_after_wait` - Rate-limited; waiting for Retry-After duration then retrying (rate-limit retries only)
- `retry_with_fallback` - Switched to fallback model (e.g., gpt-4o)
- `retry_with_context` - Retrying with error context added to prompt
- `failed` - Final failure after all retries exhausted

**Additional fields (rate-limit retries only):**

- `waitMs` - Milliseconds waited before this retry (the result of `min(rateLimitMaxWaitMs, max(Retry-After, exponential backoff)) + jitter`)

---

## 4. Batch Outcome Logs (`batch_outcomes/`)

**Purpose:** Track batch processing success/failure results and performance metrics.

**Location:** `logging/batch_outcomes/batch_outcomes_<timestamp>.log`

**Successful Batch Example:**

```json
{
  "timestamp": "2025-10-21T14:23:46.789Z",
  "batch_info": {
    "batchIndex": 2,
    "csvLineRange": "10-14"
  },
  "outcome": {
    "status": "success",
    "totalAttempts": 2,
    "processingTimeMs": 3456
  }
}
```

**Batch Status:**

- `success` - Batch processed successfully
- `failed` - Batch failed after all retries
- `partial_success` - Batch succeeded but with validation warnings

**Failed Batch Example:**

```json
{
  "timestamp": "2025-10-21T14:25:12.345Z",
  "batch_info": {
    "batchIndex": 5,
    "csvLineRange": "25-29"
  },
  "outcome": {
    "status": "failed",
    "totalAttempts": 3,
    "processingTimeMs": 8923,
    "requiredFieldErrorCount": 2
  },
  "final_error": "Batch 5: Zod validation failed: Expected string, received number"
}
```

---

## 5. UUID Generation Logs (`uuid_generation/`)

**Purpose:** Track UUID generation events, caching behavior, and fallback scenarios.

**Location:** `logging/uuid_generation/uuid_generation_<timestamp>.log`

**UUID Generated Example:**

```json
{
  "timestamp": "2025-10-21T14:20:06.087Z",
  "event_type": "generated",
  "uuid_info": {
    "column": "Respondent ID",
    "inputValues": ["nd9e9b"],
    "generatedUuid": "6bf8879c-ec19-57fb-8a10-ca9dd1addff2"
  },
  "context": {}
}
```

**UUID From Cache Example:**

```json
{
  "timestamp": "2025-10-21T14:20:06.087Z",
  "event_type": "cached",
  "uuid_info": {
    "column": "Respondent ID",
    "inputValues": ["jbyzzr"],
    "generatedUuid": "e6a9feeb-764e-5e1b-9cd1-201be0f408d5",
    "cacheSize": 3
  },
  "context": {}
}
```

**UUID Fallback Example:**

```json
{
  "timestamp": "2025-10-21T14:20:06.088Z",
  "event_type": "column_empty",
  "uuid_info": {
    "column": "customerID",
    "inputValues": ["john.doe@example.com"],
    "generatedUuid": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
  },
  "fallback_info": {
    "reason": "UUID column 'customerID' is empty or invalid, falling back to email"
  },
  "context": {}
}
```

**Event Types:**

- `generated` - New UUID generated from input values
- `cached` - UUID retrieved from cache (same input values seen before)
- `fallback_to_email` - Specified UUID column missing/empty, used email instead
- `fallback_to_random` - No valid values found, generated random UUID
- `column_missing` - Specified UUID column not found in record
- `column_empty` - Specified UUID column exists but is empty/invalid

---

## Usage

### Enable Logging

```bash
# CLI
npa-ingest-insight-cli analyze --logging

# Config file
{
  "enableLogging": true,
  ...
}
```

### Analyze Logs

```bash
# Count total retries
grep -r "retry_info" logging/retry_attempts/ | wc -l

# Find failed batches
grep -r '"status": "failed"' logging/batch_outcomes/

# Check what fields are commonly missing
grep -r "Required field" logging/validation_errors/ | cut -d: -f4 | sort | uniq -c

# See which batches needed fallback model
grep -r "retry_with_fallback" logging/retry_attempts/

# Check UUID generation patterns
grep -r "event_type" logging/uuid_generation/ | cut -d'"' -f4 | sort | uniq -c

# Find UUID fallback scenarios
grep -r "fallback_info" logging/uuid_generation/

# Check cache hit rate
echo "Generated: $(grep -c '"event_type": "generated"' logging/uuid_generation/*)"
echo "Cached: $(grep -c '"event_type": "cached"' logging/uuid_generation/*)"

# See processing performance
grep -r "processingTimeMs" logging/batch_outcomes/ | head -10
```

---

## Troubleshooting with Logs

### Issue: Analysis keeps failing

**Check:**

1. `retry_attempts/` - See error types and patterns
2. `validation_errors/` - Identify schema mismatches
3. `batch_outcomes/` - Check final success/failure status

### Issue: Slow performance

**Check:**

1. `batch_outcomes/` - Look for `processingTimeMs` to identify slow batches
2. `retry_attempts/` - Count how many batches needed retries
3. `uuid_generation/` - Check cache hit rate (more cache hits = better performance)

### Issue: Required fields missing

**Check:**

1. `validation_errors/` - See which fields are problematic
2. `batch_outcomes/` - See if errors persist after retries
3. Consider using `--required-fields-fail-batch` for stricter validation

### Issue: UUID generation problems

**Check:**

1. `uuid_generation/` - See fallback patterns and reasons
2. Look for `column_missing` or `column_empty` events
3. Consider adjusting `--uuid-column` parameter or input data quality

---

## Log Rotation

Logs are **not automatically rotated**. Each analysis run creates new log files with timestamps.

**Recommendation:** Periodically clean old logs:

```bash
# Keep only last 30 days
find logging/ -type f -mtime +30 -delete
```
