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
| `rag-prompt.ts` | Numbers retrieved passages as sources and builds an Ollama `/api/chat` request that asks for an answer with citations (optionally as JSON with `format`, and with `truncate: false` so an overlong prompt fails instead of being cut) | [RAG Prompt Builder](https://toolkitbox.net/en/tools/rag-prompt-builder) |
| `rag-citations.ts` | Checks the citations in a RAG answer against the sources: source numbers that do not exist, quotes that are not in their source, sentences without a source number, sources never cited, answers cut off by `num_predict` | [RAG Citation Checker](https://toolkitbox.net/en/tools/rag-citation-checker) |
| `modelfile.ts` | Builds an Ollama Modelfile | [Ollama Modelfile Generator](https://toolkitbox.net/en/tools/ollama-modelfile-generator) |
| `ollama-systemd.ts` | Builds a systemd drop-in that sets Ollama's environment variables | [Ollama systemd Override Generator](https://toolkitbox.net/en/tools/ollama-systemd-override) |
| `ollama-nginx.ts` | Builds an nginx server block in front of Ollama (authentication, HTTPS, streaming) | [Ollama nginx Config Generator](https://toolkitbox.net/en/tools/ollama-nginx-config) |
| `ollama-api-request.ts` | Builds the JSON body and curl command for Ollama's `/api/chat` | [Ollama API Request Builder](https://toolkitbox.net/en/tools/ollama-api-request-builder) |
| `ollama-openai.ts` | Converts chat requests between Ollama's `/api/chat` and its OpenAI-compatible `/v1/chat/completions` in both directions, and an `/api/chat` response into the OpenAI form, following Ollama's own conversion code (`openai/openai.go`); lists renamed, dropped and unmatched fields | [Ollama OpenAI Converter](https://toolkitbox.net/en/tools/ollama-openai-converter) |
| `ollama-stream.ts` | Reads a streamed Ollama response (newline-delimited JSON from `/api/chat` or `/api/generate`, or server-sent events from `/v1/chat/completions`) and joins the text, thinking and tool calls back together; reports the stop reason, cut-off streams and errors, and the generation and prompt speed (counting only the prompt tokens that were not in the cache) | [Ollama Stream Reader](https://toolkitbox.net/en/tools/ollama-stream-reader) |
| `ollama-log.ts` | Reads an Ollama server log (`server.log`, `journalctl -u ollama`, `docker logs`): memory per model load (weights, KV cache, compute buffers, per device), layers on the GPU, context length, requests, the speed llama-server reports, and explained warnings such as prompt truncation, an oversized `num_ctx`, models that do not fit in memory and reloads. The check script runs against three real logs in `scripts/fixtures/ollama-log/` | [Ollama Log Reader](https://toolkitbox.net/en/tools/ollama-log-reader) |
| `ollama-show.ts` | Reads the model details from Ollama's `/api/show` response or from `ollama show` (with or without `--verbose`): size, quantization, longest context, layers and attention heads, capabilities (the ten that Ollama v0.40.15 defines), thinking levels, the parameters, system prompt and license stored in the model, and the KV cache size (f16) at each context length. The KV cache formula matches the sizes Ollama logs; the check script runs against three real outputs and the example in Ollama's documentation in `scripts/fixtures/ollama-show/` | [Ollama Model Info Reader](https://toolkitbox.net/en/tools/ollama-model-info-reader) |
| `gguf.ts` | Reads the header of a GGUF model file (the format of llama.cpp and Ollama) without the weights: every metadata entry and tensor, quantization (`general.file_type`), parameter count, model shape, tokenizer and special tokens, chat template and the KV cache size per context length. It runs the same checks as llama.cpp's reader (`gguf.cpp`) and model loader, such as version, byte order, duplicates, alignment, tensor types, tensor positions and a file shorter than its header says. If the bytes given are not enough, it throws `GgufNeedMore` with the length needed. The check script compares it with Ollama's own `/api/show` output for a real file (when that file is on the machine) and with hand-built files | [GGUF Metadata Viewer](https://toolkitbox.net/en/tools/gguf-metadata-viewer) |
| `safetensors.ts` | Reads the header of a safetensors file (the weights format of Hugging Face) without the weights: every tensor with its data type, shape and position, the parameter count (counted the way the Hugging Face Hub counts it), the size of the weights and `__metadata__`. It runs the same checks as the official safetensors library 0.8.0 (header length, UTF-8, JSON, the 22 data types, gaps and overlaps, size against type and shape, the end of the file) and marks what breaks the specification but the library still accepts. With `model.safetensors.index.json` it finds missing files and tensors that are not where the index says in a split model, and with `config.json` it computes the KV cache per context length. The check script compares it with the official library's verdicts on 52 files and with the real headers of Qwen2.5-7B-Instruct and Qwen2.5-0.5B-Instruct (parameter counts from the Hub's API, file sizes, `total_size`) | [Safetensors Metadata Viewer](https://toolkitbox.net/en/tools/safetensors-metadata-viewer) |
| `go-template.ts`, `ollama-template.ts` | `go-template.ts` is Go's `text/template` (lexer, parser, executor, built-in functions, `fmt` printing and `encoding/json` output, with Go's error messages) ported to TypeScript. `ollama-template.ts` runs an Ollama Modelfile `TEMPLATE` the way Ollama does: the data it passes (messages, tool calls, tools, think), its three ways of running a template, how it joins system messages and turns, image tags, when it refuses tools or thinking, and whether it uses `TEMPLATE` or the GGUF chat template. The check script compares it with Go 1.26.6 running Ollama's template code on 243 cases (which match Ollama's own test outputs for its 20 built-in templates) and with 379 prompts returned by Ollama 0.40.11 with `_debug_render_only` | [Ollama Template Tester](https://toolkitbox.net/en/tools/ollama-template-tester) |

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

`ollama-log-examples.ts` and `ollama-show-examples.ts` hold the excerpts of those logs and outputs that the site uses as examples, `gguf-example.ts` rebuilds the header of qwen2.5:7b (without its token list and chat template) for the GGUF example, `safetensors-example.ts` rebuilds the headers, `model.safetensors.index.json` and `config.json` of Qwen2.5-7B-Instruct for the safetensors example, and `ollama-template-examples.ts` holds the example templates (from Ollama's documentation, Ollama's built-in templates and `ollama show --template qwen2.5:7b`). The template fixtures include Ollama's built-in templates, which are MIT-licensed by Ollama. `locales.ts`, `robots-txt-messages.ts` and `unicode-inspect-messages.ts` hold the message text that the robots.txt and Unicode modules use in 14 languages.

## Running the checks

```bash
npm install
npm run check
```

`npm run check` runs every `scripts/check-*.ts` and fails if any of them fails. `npm run typecheck` runs the TypeScript compiler.

## License

[MIT](LICENSE)
