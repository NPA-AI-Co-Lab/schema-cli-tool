# Audience Data Commons: Schema Mapping CLI

A command-line tool for analyzing and structuring data using Language Model APIs. This CLI processes CSV data files and outputs structured analysis results in JSON-LD format according to a customizable schema.

The tool features a modular architecture with pluggable LLM providers, making it easy to swap between different AI services while maintaining the same analysis pipeline.

## Configuration

### Environment Variables

The application uses a `.env` file for sensitive credentials only:

```bash
OPENAI_API_KEY=your_api_key_here
```

All other configuration is handled through the `config.json` file for better maintainability and deployment flexibility.

### LLM Configuration

You can customize the LLM settings in your `config.json`:

- **defaultModel**: Primary model to use (e.g., "gpt-4o-mini", "gpt-4o", "gpt-3.5-turbo")
- **fallbackModel**: Backup model when primary fails
- **temperature**: LLM sampling temperature from `0` to `2`; it now defaults to `0` to keep extraction results more
  stable and reproducible, while still remaining configurable when needed
- **uuidColumn**: Column name for UUID generation; if it is missing or empty, the CLI falls back to email fields, and if
  no valid key is available it generates a deterministic v5 UUID from a hash of the row
- **batchSize**: Number of records per API request (1-50)
- **concurrencySize**: Concurrent API requests (1-20)

The tool supports multiple LLM providers through a pluggable client architecture. Currently supports OpenAI, with easy extensibility for other providers.

## Prerequisites

- Node.js (v18 or higher)
- LLM API key (currently supports OpenAI)

## Installation

1. Clone the repository:

```bash
git clone https://github.com/<REPO_NAME>/npa-ingest-insight-cli.git
cd npa-ingest-insight-cli
```

2. Install dependencies:

```bash
npm install
```

3. Set up your LLM API key (choose one method), guide for OpenAI:

**Option A: Environment Variable**
```bash
export OPENAI_API_KEY="your-api-key-here"
```

**Option B: .env file**
```bash
# Edit the .env file and add your API key
OPENAI_API_KEY=your-api-key-here
```

4. Build the project:

```bash
npm run build
```

5. Install globally (optional):

```bash
npm install -g .
```

## Usage

### Configuration File

Create a configuration file (`config.json`) with your data and schema paths:

```json
{
  "dataPath": "./examples/sample_comments.csv",
  "schemaPath": "./examples/schema.jsonld",
  "outputPath": "./output/analysis_results.jsonld",
  "enableLogging": true,
  "hidePII": true,
  "retriesNumber": 2,
  "requiredFieldErrorsFailBatch": false,
  "batchSize": 5,
  "concurrencySize": 5,
  "defaultModel": "gpt-4o-mini",
  "fallbackModel": "gpt-4o",
  "temperature": 0,
  "uuidColumn": "primaryEmail",
    "rulesPath": "./config/sample_comments.rules.json",
    "forceReingestion": false
}
```

- **dataPath** specifies the path to the input CSV file (legacy, single-file mode);
- **dataPaths** specifies an array of input CSV file paths (multi-file mode) - see [Multi-File Processing](#multi-file-processing) below;
- **schemaPath** specifies the path to schema that the output will be based on;
- **outputPath** specifies the path where results will be saved. Required when using `--config` argument, optional for interactive mode;
- **databasePath** (optional) specifies where the SQLite database should be created. Auto-derived from outputPath if omitted;
- **resumeMode** (optional) controls resume behavior: `"auto"` (default), `"fresh"`, or `"resume"`;
- **enableLogging** enables/disables logging of AI prompts and error messages into separate files;
- **hidePII** enables/disables PII handling logic.
- **retriesNumber** specifies how many retries the program will make on an erroneous API response before stopping the analysis.
- **requiredFieldErrorsFailBatch** is an optional flag specifying how the tool should handle missing required fields - similarly to other validation errors if true, or by simply logging them if false.
- **batchSize** - Number of data rows sent per request to the LLM API;
- **concurrencySize** - Maximum number of asynchronous prompts that can run at once;
- **defaultModel** - The model that will analyze the data by default (it is possible to change LLM versions as you like);
- **fallbackModel** - The model that will handle analysis when the default model fails;
- **temperature** - Optional LLM sampling temperature in range `0..2`; it now defaults to `0` to keep extraction
  results more stable and reproducible, while still remaining configurable when needed;
- **uuidColumn** - The column name to use for UUID generation. If it is missing or empty, the CLI falls back to email
  fields (primaryEmail, email, etc.), and if no valid key is available it generates a deterministic v5 UUID from a hash
  of the row so the same row keeps the same ID across reruns. For this row-digest fallback, changing a column name or
  value changes the UUID, while changing the file name, schema, or rules does not.
- **rulesPath** - Optional path to a deterministic mapping file. When provided, the CLI will map rows rule-first and only invoke the LLM for unresolved fields.

### Multi-File Processing

The tool supports processing multiple CSV files in a single run. You can provide either a single `dataPath` (legacy single-file mode) or an array `dataPaths` to process multiple files together. When multiple files are provided the pipeline:

- assigns a global, stable UUID per record (based on the configured `uuidColumn`, a default set of email fields, or a
  deterministic v5 UUID derived from the row when no key is available),
- stores raw rows and intermediate results in a local SQLite database, and
- merges records with the same UUID into a single JSON-LD output entity.

Example configuration (multi-file):

```json
{
    "dataPaths": [
        "./data/file1.csv",
        "./data/file2.csv",
        "./data/file3.csv"
    ],
    "schemaPath": "./schema.jsonld",
    "outputPath": "./output/results.jsonld",
    "databasePath": "./output/results.db",
    "uuidColumn": "primaryEmail"
}
```

Behavior notes:

- Database persistence: the pipeline writes ingestion state, per-row LLM results, and merged output into an SQLite database. The `databasePath` can be provided in the config or is auto-derived from `outputPath`.
- Output provenance: the JSON-LD output includes a metadata entry with the CLI name/version, generation timestamp,
  config hash, model settings, source files, and key runtime options so each file can be traced back to the exact run
  that produced it.
- Resume and interruption: processing can be interrupted (Ctrl+C). On the next run the pipeline will resume from the last saved state when possible; intermediate results are not lost.
- File tracking: files are tracked by content hash so identical files are skipped and each file's status is recorded.
- Row-digest UUID rules: when the fallback UUID is used, it is derived only from the normalized row contents and column
  names. Changing a column name or value changes the UUID, while changing the file name, schema, or rules does not.
- Warning handling: validation warnings are written to both the log files and `stderr`, and include the source file,
  original CSV line, and UUID when available so scripts can detect partial failures and trace the exact row even if
  batch grouping changes between runs. The CLI exits with code `2` when warnings are present.

Behavior for edited files and partial ingests:

- If a file with the same content hash was already ingested and status is `completed`, the file is skipped.
- If a previous ingest exists for the same content but is incomplete/failed, the pipeline will remove the previous partial record and re-ingest the file (resume behavior for same-hash files).
- If a previous ingest exists for the same file path but the content hash differs (the file was edited after a partial ingest), the default behavior is to throw a clear error and refuse to overwrite existing partial data to avoid accidental data loss. Use the `forceReingestion: true` configuration option to allow the CLI to delete the previous partial records and re-ingest the edited file.

Resume modes (configurable via `resumeMode`):

- `auto` (default): resume when the saved pipeline config matches the current run; if the config changed the pipeline starts fresh.
- `fresh`: clear the existing database and start from scratch.
- `resume`: attempt to resume and fail if the saved configuration differs from the current run.

Backward compatibility: single-file configs using `dataPath` are still supported and are internally normalized to `dataPaths: [dataPath]`.

### Deterministic rules file

Rules live in a separate JSON file so you can iterate on deterministic mappings without touching the schema. A simplified example (`config/sample_comments.rules.json`) is shown below:

```json
{
  "schema": "../examples/schema.jsonld",
  "llm": {
    "default": false,
    "fields": []
  },
  "fields": {
    "person.userID": {
      "source": "userID",
      "transforms": ["trim"]
    },
    "action.published": {
      "source": ["action_published", "obj_published"],
      "transforms": ["trim"]
    }
  }
}
```

- `schema` is resolved relative to the rules file and must match the JSON-LD used at runtime.
- Startup validation: when the rules file is loaded, the CLI validates it against the active schema. Rules for unknown
  schema fields are skipped, schema mismatches are reported, fields with no deterministic or LLM coverage are surfaced
  immediately, and the run fails fast if any required schema field has no rule or LLM coverage.
- `llm.default` toggles whether the LLM is used by default. When set to `false`, only fields listed in `llm.fields` are delegated to the model (e.g. `"fields": ["person.intent", "object.summary"]`).
- `fields` maps schema paths to CSV columns. Each rule can try multiple sources (`source` accepts an array), apply transforms, reference taxonomy enums, and define literal fallbacks.
- When fields are delegated to the LLM, the CLI builds a minimal prompt/schema for just those paths and merges the model’s answers back into the deterministic record.

> **Important:** The streaming processor merges output records using the schema’s identifier property (the one declared via `idProp`). Because the CLI injects a synthetic column based on your configured `uuidColumn` (or fallback email), make sure your deterministic rules map that value into the corresponding schema field. In the sample schema the id property is `person.userID`, so we include `"person.userID": { "source": "userID", "transforms": ["trim"] }`. Without that mapping, otherwise-deterministic rows will be skipped as “missing UUIDs.”

Supported transforms are:

- `trim` – remove leading/trailing whitespace from strings (runs element-wise for arrays).
- `lowercase` / `uppercase` – change casing; when arrays are provided the change applies to each string item.
- `split` – break a string into an array; accepts `delimiter` (defaults to `,`), `trimItems` (default `true`), and `filterEmpty` (default `true`).
- `map` – substitute values via a dictionary; optional `caseInsensitive` flag (default `true`) performs case-insensitive matching and also applies to array items.
- `toNumber` – convert numeric strings to JavaScript numbers; empty strings resolve to `undefined`.
- `secondsToDuration` – convert numeric seconds into ISO-8601 duration strings (e.g. `300` → `PT300S`).
- `filterEmpty` – drop empty/blank items from string arrays.
- `unique` – deduplicate array entries (case-insensitive for strings).

Required schema fields are wrapped automatically as `{ value, present }` so they validate against the "present" convention and are unwrapped before writing JSON-LD.

### CLI overrides

Deterministic behaviour can be tuned per run:

- `--rules <file>` – use a different rules file for the current invocation.
- `--llm-fields field1,field2` – force specific schema paths through the LLM even if rules exist.
- `--no-llm-fields field1,field2` – keep the listed paths deterministic for this run.

With a complete rules file you can run the CLI without an `OPENAI_API_KEY`; the pipeline skips LLM calls when every row is satisfied deterministically.

### Schema file

A proper schema file should be a JSONLD with the following structure:

```json
{
    "@context": {
        "@vocab": "https://schema.org/",
        "activitystream": "https://www.w3.org/ns/activitystreams#",
        "userID": "identifier",
        "personID": "identifier",
        "objectID": "identifier",
        "primaryEmail": "email",
        "additionalEmails": "email",
        "engagementScore": "ratingValue",
        "donorStatus": "category",
        "lastDonationDate": "dateCreated",
        "tags": "keywords",
        "dataSource": "isBasedOn"
    },
    "entities": {
        "person": {
            "@type": "Person",
            "idProp": "userID",
            "properties": {
                "userID": {
                    "type": "string",
                    "description": "Global user ID",
                    "format": "uuid",
                    "required": true
                },
                "givenName": {
                    "type": "string",
                    "description": "First name of the user"
                },
                "familyName": {
                    "type": "string",
                    "description": "Last name of the user"
                },
                "primaryEmail": {
                    "type": "string",
                    "description": "The primary contact address for the user. If the user has authenticated, this should be supplied. Otherwise it will be blank or undefined."
                },
                "additionalEmails": {
                    "type": "array",
                    "items": {
                        "type": "string"
                    },
                    "description": "An array of additional addresses, for the purposes of matching."
                },
                "engagementScore": {
                    "type": "number",
                    "minimum": 1,
                    "maximum": 5,
                    "description": "A numeric score from 1-5 representing the user’s engagement with the newsroom’s content."
                },
                "tags": {
                    "type": "array",
                    "items": {
                        "type": "string"
                    },
                    "description": "An array of tags that could also represent MailChimp lists."
                },
                "dataSource": {
                    "type": "string",
                    "description": "Where this record originated",
                    "required": true
                },
                "consentDate": {
                    "type": "string",
                    "description": "Date-time when user gave consent"
                },
                "consentType": {
                    "type": "string",
                    "enumFromTaxonomy": "ConsentType-v1",
                    "description": "The type of consent the user has given"
                },
                "demographics": {
                    "type": "object",
                    "properties": {
                        "ageGroup": {
                            "type": "string",
                            "enumFromTaxonomy": "AgeGroup-v1",
                            "description": "Age group of the user"
                        },
                        "gender": {
                            "type": "string",
                            "enumFromTaxonomy": "Gender-v1",
                            "description": "Gender of the user"
                        },
                        "educationLevel": {
                            "type": "string",
                            "enumFromTaxonomy": "EducationLevel-v1",
                            "description": "Education level of the user"
                        },
                        "incomeBracket": {
                            "type": "string",
                            "enumFromTaxonomy": "IncomeBracket-v1",
                            "description": "Income bracket of the user"
                        }
                    }
                },
                "location": {
                    "type": "object",
                    "properties": {
                        "postalCode": {
                            "type": "string",
                            "description": "A deliberately freeform field that can take postal code in a variety of local forms. (US zip codes are numeric, but national systems vary.) "
                        },
                        "addressCountry": {
                            "type": "string",
                            "description": "Two-letter ISO 3166-1 country code"
                        },
                        "addressLocality": {
                            "type": "string",
                            "description": "City or locality"
                        }
                    }
                },
                "behavior": {
                    "type": "object",
                    "properties": {
                        "donorStatus": {
                            "type": "string",
                            "enumFromTaxonomy": "DonorStatus-v1",
                            "description": "An indicator whether the user is a donor"
                        },
                        "lastDonationDate": {
                            "type": "string",
                            "description": "formatted date-time representing when the user last donated."
                        }
                    }
                },
                "interests": {
                    "type": "object",
                    "properties": {
                        "topics": {
                            "type": "array",
                            "items": {
                                "type": "string"
                            },
                            "description": "An array of topics that the user is interested in."
                        },
                        "commentedOn": {
                            "type": "array",
                            "items": {
                                "type": "string"
                            },
                            "description": "An array of topics that the user has commented on."
                        }
                    }
                }
            }
        }
    }
}
```

Here **idProp** specifies which of the properties will constitute the **@id** of resulting JSONLD entity; required properties are specified via **"required": true**.

You can also find examples of [config](./config.json) and [schema](./examples/schema.jsonld) files in the repository.

### PII encoding file

```
{
  "name": { "placeholder": "NAME_{ind}" },
  "names": { "placeholder": "NAME_{ind}", "multi": true },

  "email": { "placeholder": "EMAIL_{ind}@GMAIL.COM" },
  "emailaddress": { "placeholder": "EMAIL_{ind}@GMAIL.COM" },
  "primaryemail": { "placeholder": "EMAIL_{ind}@GMAIL.COM" },
  "emails": { "placeholder": "EMAIL_{ind}@GMAIL.COM", "multi": true },

  "phone": { "placeholder": "PHONE_{ind}" },
  "phonenumber": { "placeholder": "PHONE_{ind}" },
  "phonenumbers": { "placeholder": "PHONE_{ind}", "multi": true }
}
```

This file is located inside the **./static** folder. It specifies which columns will be encoded, and what placeholder will the agent see in their place. There is also an optional **multi** attribute, which allows parsing of several PII entities, separated by a delimiter, in a single column.

***Important***:

If there are other PII fields you want to hide - please, add them to the file. For column names, use lower case, with no spaces. Placeholder has to contain "{ind}".
Example: Email Address -> “emailaddress”: { “placeholder”: “EMAIL_{ind}@GMAIL.COM” }.


### Restrictions

There are several ways to enforce rules onto the fields of your schema. Most important among them:
- **required** defines if the field can be left empty;
- **format** enables enforcement of one of several basic string formats ($email$, $date$, $time$, $datetime$, $duration$, $uuid$);
- **pattern** allows enforcement of other formats via a regex expression;
- **enumFromTaxonomy** restricts possible field values to those of the correspoding taxonomy located in [the taxonomies folder](./taxonomies).

### Environment Configuration

The application uses a `.env` file for configuration. Key settings include:

- **OPENAI_API_KEY** - Your LLM API key (currently OpenAI, alternative to environment variable)

Example `.env` file:
```bash
OPENAI_API_KEY=your_api_key_here
```

### Running the CLI

#### Interactive Mode (for manual use):

```bash
# If installed globally:
npa-insight analyze

# Using npm:
npm run start analyze

# Alternative if npm run start doesn't work:
node dist/cli.js analyze
```

The CLI will prompt you for:
- **Configuration file path**: Path to your config.json
- **Output file path**: Where to save results (.jsonld) (only if not specified in config)

#### Automated Mode (for scripts and automation):

```bash
# Using config file argument (no prompts):
npa-insight analyze --config ./path/to/config.json

# Using npm:
npm run start analyze -- --config ./path/to/config.json

# Alternative if npm run start doesn't work:
node dist/cli.js analyze --config ./path/to/config.json
```

When using the `--config` argument:
- No interactive prompts will be shown
- All configuration must be specified in the config file, including `outputPath`
- Perfect for automation, CI/CD pipelines, and integration with other systems

## Code Quality

### Linting and Formatting

The project uses ESLint for code linting and Prettier for consistent code formatting:

```bash
# Run ESLint
npm run lint

# Run Prettier formatting
npm run format

# Check Prettier formatting
npm run format:check
```

For details on linting configuration, please refer to [typescript-eslint](https://typescript-eslint.io/getting-started).

### Testing

The project includes a comprehensive test suite with 100% coverage across all core functionality:

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage report
npm run test:coverage
```

**Test Coverage:**
- **Validation testing** - Length checks, Zod schema validation, required fields
- **Error handling** - Retry logic, error classification, complex scenarios
- **PII handling** - Detection, encoding/decoding, data protection
- **Batch processing** - Memory management, large dataset handling
- **LLM client** - API integration, fallback mechanisms
- **Schema conversion** - Data transformation and validation

## Project Structure

## Project Structure

```
├── src/
│   ├── analysis/           # Analysis and processing logic
│   ├── cli/                # Modular CLI components
│   ├── clients/            # LLM client implementations
│   │   └── openai-client.ts # OpenAI client implementation
│   ├── interfaces/         # Type definitions and contracts
│   │   └── llm-client.ts   # LLM client interface
│   ├── types/           # Type definitions
│   ├── jsonld/          # input/output files processing
│   ├── utils/              # Utility functions
│   ├── cli.ts              # Main CLI entry point
│   ├── ...
├── examples/                   # Sample data files for testing
├── static/
│   ├── pii_field_map.json  # PII field mapping configuration
│   ├── skeleton.json       # Base schema for LLM processing
│   └── instructions.txt    # LLM model instructions
├── examples/               # Sample files
├── taxonomies/             # Structures of taxonomies present in the schema
├── .env                    # Contains global constants
├── config.json             # Example config
├── CHANGELOG.md
└── README.md

```
### Versioning

This project follows [Semantic Versioning 2.0.0](https://semver.org/).

### Support

For issues and questions, please check the [CHANGELOG.md](CHANGELOG.md) for recent updates or open an issue in the repository.

---

**Note**: This tool processes data using LLM APIs (currently OpenAI). Be mindful of data privacy and API usage costs when processing large datasets.
