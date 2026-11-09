/**
 * Ollama Template Tester の例。
 *  - qwen2.5:7b: 手元の Ollama 0.40.11 で ollama show --template qwen2.5:7b が出したもの
 *  - Llama 3: ollama/ollama v0.40.15 の template/llama3-instruct.gotmpl(MIT)
 *  - ChatML・Mistral(ツール)・CodeLlama(穴埋め): docs.ollama.com/template の例
 */
export type TemplateExample = { id: "qwen25" | "llama3" | "chatml" | "mistral" | "codellama"; label: string; template: string; endpoint: "chat" | "generate" };

export const TEMPLATE_EXAMPLES: TemplateExample[] = [
  { id: "qwen25", label: "qwen2.5:7b", template: "{{- if .Messages }}\n{{- if or .System .Tools }}<|im_start|>system\n{{- if .System }}\n{{ .System }}\n{{- end }}\n{{- if .Tools }}\n\n# Tools\n\nYou may call one or more functions to assist with the user query.\n\nYou are provided with function signatures within <tools></tools> XML tags:\n<tools>\n{{- range .Tools }}\n{\"type\": \"function\", \"function\": {{ .Function }}}\n{{- end }}\n</tools>\n\nFor each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:\n<tool_call>\n{\"name\": <function-name>, \"arguments\": <args-json-object>}\n</tool_call>\n{{- end }}<|im_end|>\n{{ end }}\n{{- range $i, $_ := .Messages }}\n{{- $last := eq (len (slice $.Messages $i)) 1 -}}\n{{- if eq .Role \"user\" }}<|im_start|>user\n{{ .Content }}<|im_end|>\n{{ else if eq .Role \"assistant\" }}<|im_start|>assistant\n{{ if .Content }}{{ .Content }}\n{{- else if .ToolCalls }}<tool_call>\n{{ range .ToolCalls }}{\"name\": \"{{ .Function.Name }}\", \"arguments\": {{ .Function.Arguments }}}\n{{ end }}</tool_call>\n{{- end }}{{ if not $last }}<|im_end|>\n{{ end }}\n{{- else if eq .Role \"tool\" }}<|im_start|>user\n<tool_response>\n{{ .Content }}\n</tool_response><|im_end|>\n{{ end }}\n{{- if and (ne .Role \"assistant\") $last }}<|im_start|>assistant\n{{ end }}\n{{- end }}\n{{- else }}\n{{- if .System }}<|im_start|>system\n{{ .System }}<|im_end|>\n{{ end }}{{ if .Prompt }}<|im_start|>user\n{{ .Prompt }}<|im_end|>\n{{ end }}<|im_start|>assistant\n{{ end }}{{ .Response }}{{ if .Response }}<|im_end|>{{ end }}", endpoint: "chat" },
  { id: "llama3", label: "Llama 3", template: "{{- range .Messages }}<|start_header_id|>{{ .Role }}<|end_header_id|>\n\n{{ .Content }}<|eot_id|>\n{{- end }}<|start_header_id|>assistant<|end_header_id|>", endpoint: "chat" },
  { id: "chatml", label: "ChatML", template: "{{- range .Messages }}<|im_start|>{{ .Role }}\n{{ .Content }}<|im_end|>\n{{ end }}<|im_start|>assistant\n", endpoint: "chat" },
  { id: "mistral", label: "Mistral (tools)", template: "{{- range $index, $_ := .Messages }}\n{{- if eq .Role \"user\" }}\n{{- if and (le (len (slice $.Messages $index)) 2) $.Tools }}[AVAILABLE_TOOLS] {{ json $.Tools }}[/AVAILABLE_TOOLS]\n{{- end }}[INST] {{ if and (eq (len (slice $.Messages $index)) 1) $.System }}{{ $.System }}\n\n{{ end }}{{ .Content }}[/INST]\n{{- else if eq .Role \"assistant\" }}\n{{- if .Content }} {{ .Content }}</s>\n{{- else if .ToolCalls }}[TOOL_CALLS] [\n{{- range .ToolCalls }}{\"name\": \"{{ .Function.Name }}\", \"arguments\": {{ json .Function.Arguments }}}\n{{- end }}]</s>\n{{- end }}\n{{- else if eq .Role \"tool\" }}[TOOL_RESULTS] {\"content\": {{ .Content }}}[/TOOL_RESULTS]\n{{- end }}\n{{- end }}", endpoint: "chat" },
  { id: "codellama", label: "CodeLlama (fill-in-middle)", template: "<PRE> {{ .Prompt }} <SUF>{{ .Suffix }} <MID>", endpoint: "generate" },
];

export const EXAMPLE_MESSAGES = `[
  { "role": "system", "content": "You are a helpful assistant." },
  { "role": "user", "content": "What is the weather in Tokyo?" },
  { "role": "assistant", "content": "", "tool_calls": [
    { "function": { "name": "get_weather", "arguments": { "city": "Tokyo" } } }
  ] },
  { "role": "tool", "content": "{\\"temperature\\": 20}", "tool_name": "get_weather" },
  { "role": "assistant", "content": "It is 20°C in Tokyo." },
  { "role": "user", "content": "Thanks!" }
]`;

export const EXAMPLE_TOOLS = `[
  { "type": "function", "function": {
    "name": "get_weather",
    "description": "Get the current weather for a city",
    "parameters": {
      "type": "object",
      "properties": { "city": { "type": "string", "description": "City name" } },
      "required": ["city"]
    }
  } }
]`;
