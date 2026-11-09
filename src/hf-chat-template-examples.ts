/**
 * HF Chat Template Tester の見本。テンプレートはどれもこのサイトで書いたもの(実在のモデルのものを写したものではない)。
 * よくある書き方(ChatML とツール・考える部分の切り替え・役割の順の確認・{% generation %})を短く示す。
 * scripts/check-hf-chat-template.ts で、本物の transformers で描画した結果と突き合わせている。
 */

export type TemplateExample = {
  id: string;
  label: string;
  template: string;
  /** この見本と組みにする会話。 */
  messages: string;
  tools?: string;
  extra?: string;
  specialTokens?: Record<string, string>;
};

export const CHATML_TOOLS = `{%- if tools %}
  {{- '<|im_start|>system\\n' }}
  {%- if messages[0].role == 'system' %}
    {{- messages[0].content + '\\n\\n' }}
  {%- endif %}
  {{- '# Tools\\n\\nYou can call these functions:\\n<tools>' }}
  {%- for tool in tools %}
    {{- '\\n' + tool | tojson }}
  {%- endfor %}
  {{- '\\n</tools>\\n\\nTo call one, reply with JSON inside <tool_call></tool_call>.<|im_end|>\\n' }}
{%- elif messages[0].role == 'system' %}
  {{- '<|im_start|>system\\n' + messages[0].content + '<|im_end|>\\n' }}
{%- endif %}
{%- for message in messages %}
  {%- if message.role == 'system' and loop.first %}
  {%- elif message.role == 'tool' %}
    {{- '<|im_start|>user\\n<tool_response>\\n' + message.content + '\\n</tool_response><|im_end|>\\n' }}
  {%- else %}
    {{- '<|im_start|>' + message.role + '\\n' + (message.content or '') }}
    {%- for call in message.tool_calls or [] %}
      {{- '\\n<tool_call>\\n' + {'name': call.function.name, 'arguments': call.function.arguments} | tojson + '\\n</tool_call>' }}
    {%- endfor %}
    {{- '<|im_end|>\\n' }}
  {%- endif %}
{%- endfor %}
{%- if add_generation_prompt %}
  {{- '<|im_start|>assistant\\n' }}
{%- endif %}
`;

export const THINKING = `{%- for message in messages %}
  {%- if message.role == 'assistant' %}
    {{- '<|assistant|>' }}
    {%- if message.reasoning_content and loop.last %}
      {{- '<think>' + message.reasoning_content + '</think>' }}
    {%- endif %}
    {{- message.content + '<|end|>' }}
  {%- else %}
    {{- '<|' + message.role + '|>' + message.content + '<|end|>' }}
  {%- endif %}
{%- endfor %}
{%- if add_generation_prompt %}
  {{- '<|assistant|>' }}
  {%- if enable_thinking is defined and not enable_thinking %}
    {{- '<think></think>' }}
  {%- endif %}
{%- endif %}
`;

export const STRICT_ROLES = `{{- bos_token }}
{%- for message in messages %}
  {%- if (message.role == 'user') != (loop.index0 % 2 == 0) %}
    {{- raise_exception('Conversation roles must alternate user/assistant/user/assistant/...') }}
  {%- endif %}
  {%- if message.role == 'user' %}
    {{- '[INST] ' + message.content | trim + ' [/INST]' }}
  {%- elif message.role == 'assistant' %}
    {{- ' ' + message.content | trim + eos_token }}
  {%- endif %}
{%- endfor %}
`;

export const GENERATION = `{%- for message in messages %}
  {{- '<|' + message.role + '|>\\n' }}
  {%- if message.role == 'assistant' %}
    {%- generation %}
      {{- message.content + '<|end|>\\n' }}
    {%- endgeneration %}
  {%- else %}
    {{- message.content + '<|end|>\\n' }}
  {%- endif %}
{%- endfor %}
{%- if add_generation_prompt %}
  {{- '<|assistant|>\\n' }}
{%- endif %}
`;

export const MESSAGES_TOOLS = `[
  {"role": "system", "content": "You are a helpful assistant."},
  {"role": "user", "content": "What's the weather in Paris?"},
  {"role": "assistant", "content": "", "tool_calls": [
    {"type": "function", "function": {"name": "get_weather", "arguments": {"city": "Paris"}}}
  ]},
  {"role": "tool", "name": "get_weather", "content": "{\\"temperature\\": 22}"}
]`;

export const TOOLS = `[
  {
    "type": "function",
    "function": {
      "name": "get_weather",
      "description": "Get the current weather in a city.",
      "parameters": {
        "type": "object",
        "properties": {"city": {"type": "string", "description": "City name"}},
        "required": ["city"]
      }
    }
  }
]`;

export const MESSAGES_REASONING = `[
  {"role": "user", "content": "What is 17 * 3?"},
  {"role": "assistant", "content": "51", "reasoning_content": "17 * 3 = 51."},
  {"role": "user", "content": "And 17 * 4?"}
]`;

export const MESSAGES_SIMPLE = `[
  {"role": "user", "content": "Hello!"},
  {"role": "assistant", "content": "Hi! How can I help?"},
  {"role": "user", "content": "Tell me a joke."}
]`;

export const MESSAGES_MULTIMODAL = `[
  {"role": "user", "content": [
    {"type": "image"},
    {"type": "text", "text": "What is in this picture?"}
  ]}
]`;

export const TEMPLATE_EXAMPLES: TemplateExample[] = [
  { id: "chatml-tools", label: "ChatML + tools", template: CHATML_TOOLS, messages: MESSAGES_TOOLS, tools: TOOLS },
  { id: "thinking", label: "enable_thinking", template: THINKING, messages: MESSAGES_REASONING, extra: `{"enable_thinking": false}` },
  { id: "strict-roles", label: "[INST] + raise_exception", template: STRICT_ROLES, messages: MESSAGES_SIMPLE, specialTokens: { bos_token: "<s>", eos_token: "</s>" } },
  { id: "generation", label: "{% generation %}", template: GENERATION, messages: MESSAGES_SIMPLE },
];

/** 会話の見本(どのテンプレートにも使える)。 */
export const MESSAGE_PRESETS: { id: string; messages: string; tools?: string }[] = [
  { id: "simple", messages: MESSAGES_SIMPLE },
  { id: "tools", messages: MESSAGES_TOOLS, tools: TOOLS },
  { id: "reasoning", messages: MESSAGES_REASONING },
  { id: "multimodal", messages: MESSAGES_MULTIMODAL },
];
