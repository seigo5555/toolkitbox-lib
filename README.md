# toolkitbox-lib

The TypeScript modules behind the free browser tools on [toolkitbox.net](https://toolkitbox.net/en): checks for LLM output and AI API input, helpers for local LLMs (Ollama) and RAG, and a few web standards. Each module is a single file with no runtime dependencies, and each comes with a check script that tests it against hand-worked examples, official examples or a separate implementation.

- No runtime dependencies. No network access: every module works on the input you give it.
- One file per module in `src/`. Copy the file you need.
- Facts (limits, defaults, field names) come from the official documentation named in each file's header comment, with the date it was checked.
- Code comments are in Japanese.

## Modules

### LLM output and AI API input

| Module | What it does | Try it on the site |
|---|---|---|
| `json-repair.ts` | Turns the "almost JSON" an LLM returns (code fences, trailing commas, comments, single quotes, cut-off output) into valid JSON, and reports each fix | [LLM JSON Repair](https://toolkitbox.net/en/tools/llm-json-repair) |
| `json-schema.ts` | Validates JSON against JSON Schema (the main parts of Draft 2020-12). Cross-checked against Ajv | [JSON Schema Validator](https://toolkitbox.net/en/tools/json-schema-validator) |
| `structured-output.ts` | Checks a JSON Schema against the Structured Outputs limits that each provider documents | [Structured Output Schema Checker](https://toolkitbox.net/en/tools/structured-output-checker) |
| `tool-definition.ts` | Checks tool (function) definitions for AI APIs against each provider's documented rules | [Tool Definition Checker](https://toolkitbox.net/en/tools/tool-definition-checker) |
| `mcp-config.ts` | Finds mistakes in MCP configuration files (`.mcp.json`, `claude_desktop_config.json`, VS Code), including secrets written inline | [MCP Config Checker](https://toolkitbox.net/en/tools/mcp-config-checker) |
| `ai-jsonl.ts` | Checks JSONL for batch APIs and fine-tuning line by line | [AI JSONL Checker](https://toolkitbox.net/en/tools/ai-jsonl-checker) |
| `prompt-redact.ts` | Replaces secrets and personal data with placeholders before you paste text into an AI, and puts them back in the answer | [Prompt Redactor](https://toolkitbox.net/en/tools/prompt-redactor) |

### Local LLMs (Ollama) and RAG

| Module | What it does | Try it on the site |
|---|---|---|
| `text-chunk.ts` | Splits text into chunks with a maximum length and an overlap (paragraph → line → sentence → space), and builds one Ollama `/api/embed` request | [RAG Text Chunker](https://toolkitbox.net/en/tools/rag-text-chunker) |
| `embedding-similarity.ts` | Reads `/api/embed` or `/v1/embeddings` responses and compares the vectors: cosine similarity, dot product, Euclidean distance, norms | [Embedding Similarity Calculator](https://toolkitbox.net/en/tools/embedding-similarity) |
| `pgvector-sql.ts` | Writes the pgvector table, HNSW or IVFFlat index and nearest-neighbor query, with the limits from the pgvector README and source | [pgvector SQL Builder](https://toolkitbox.net/en/tools/pgvector-sql-builder) |
| `pgvector-insert.ts` | Pairs embedded texts with an embedding response and writes INSERT statements for pgvector | [Embeddings to pgvector INSERT](https://toolkitbox.net/en/tools/embeddings-to-pgvector) |
| `modelfile.ts` | Builds an Ollama Modelfile | [Ollama Modelfile Generator](https://toolkitbox.net/en/tools/ollama-modelfile-generator) |
| `ollama-systemd.ts` | Builds a systemd drop-in that sets Ollama's environment variables | [Ollama systemd Override Generator](https://toolkitbox.net/en/tools/ollama-systemd-override) |
| `ollama-nginx.ts` | Builds an nginx server block in front of Ollama (authentication, HTTPS, streaming) | [Ollama nginx Config Generator](https://toolkitbox.net/en/tools/ollama-nginx-config) |
| `ollama-api-request.ts` | Builds the JSON body and curl command for Ollama's `/api/chat` | [Ollama API Request Builder](https://toolkitbox.net/en/tools/ollama-api-request-builder) |

### Crawlers and web standards

| Module | What it does | Try it on the site |
|---|---|---|
| `robots-txt.ts` | Parses robots.txt and decides whether a URL may be fetched, following RFC 9309 | [robots.txt Tester](https://toolkitbox.net/en/tools/robots-txt-tester) |
| `ai-crawlers.ts` | A list of AI crawlers with their documented purpose, and robots.txt generation for them | [AI Crawler robots.txt Generator](https://toolkitbox.net/en/tools/ai-crawler-robots-txt) |
| `llms-txt.ts` | Builds and checks llms.txt files | [llms.txt Generator](https://toolkitbox.net/en/tools/llms-txt-generator) |
| `qr.ts` | QR code generation (JIS X 0510 / ISO/IEC 18004), including Reed–Solomon error correction and mask evaluation | [QR Code Generator](https://toolkitbox.net/en/tools/qr-code) |
| `ipv6.ts` | Expands, compresses (RFC 5952) and classifies IPv6 addresses | [IPv6 Converter](https://toolkitbox.net/en/tools/ipv6-converter) |
| `unicode-inspect.ts` | Breaks a string into characters and shows what is inside (invisible characters, look-alikes, normalization) | [Unicode Inspector](https://toolkitbox.net/en/tools/unicode-inspector) |
| `csp.ts` | Reads a Content-Security-Policy header and points out weak settings | [CSP Analyzer](https://toolkitbox.net/en/tools/csp-analyzer) |
| `cron-schedule.ts` | Parses a cron expression and finds the next run times | [Cron Next Run](https://toolkitbox.net/en/tools/cron-next-run) |

`locales.ts`, `robots-txt-messages.ts` and `unicode-inspect-messages.ts` hold the message text that the robots.txt and Unicode modules use in 14 languages.

## Running the checks

```bash
npm install
npm run check
```

`npm run check` runs every `scripts/check-*.ts` and fails if any of them fails. `npm run typecheck` runs the TypeScript compiler.

## License

[MIT](LICENSE)
