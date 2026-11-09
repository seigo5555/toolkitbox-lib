import json, sys, glob, os
hub, corpus, out = sys.argv[1], sys.argv[2], sys.argv[3]

def special(repo):
    p = os.path.join(hub, repo + ".tokenizer_config.json")
    if not os.path.exists(p): return {}
    c = json.load(open(p))
    r = {}
    for k in ["bos_token","eos_token","unk_token","sep_token","pad_token","cls_token","mask_token"]:
        v = c.get(k)
        if isinstance(v, dict): v = v.get("content")
        if isinstance(v, str): r[k] = v
    return r

TOOLS = [
  {"type": "function", "function": {"name": "get_weather", "description": "Get the current weather for a city.", "parameters": {"type": "object", "properties": {"city": {"type": "string", "description": "City name"}, "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]}}, "required": ["city"]}}},
  {"type": "function", "function": {"name": "search", "description": "Search the web.", "parameters": {"type": "object", "properties": {"query": {"type": "string"}, "limit": {"type": "integer", "default": 5}}, "required": ["query"]}}},
]
SYS = {"role": "system", "content": "You are a helpful assistant."}
U1 = {"role": "user", "content": "Hello! What's 2+2?"}
A1 = {"role": "assistant", "content": "2 + 2 = 4."}
U2 = {"role": "user", "content": "Thanks. And the capital of France?"}
SCEN = {
 "basic": {"messages": [SYS, U1, A1, U2], "add_generation_prompt": True},
 "user_only": {"messages": [U1], "add_generation_prompt": False},
 "user_only_gen": {"messages": [U1], "add_generation_prompt": True},
 "no_system_multi": {"messages": [U1, A1, U2, {"role": "assistant", "content": "Paris."}], "add_generation_prompt": False},
 "tools": {"messages": [SYS, {"role": "user", "content": "Weather in Paris?"},
    {"role": "assistant", "content": "", "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "get_weather", "arguments": {"city": "Paris", "unit": "celsius"}}}]},
    {"role": "tool", "tool_call_id": "call_1", "name": "get_weather", "content": "{\"temperature\": 22}"}], "tools": TOOLS, "add_generation_prompt": True},
 "tools_no_call": {"messages": [{"role": "user", "content": "Weather in Paris?"}], "tools": TOOLS, "add_generation_prompt": True},
 "continue": {"messages": [U1, {"role": "assistant", "content": "The answer is"}], "continue_final_message": True},
 "reasoning": {"messages": [U1, {"role": "assistant", "content": "4", "reasoning_content": "Two plus two is four."}, U2], "add_generation_prompt": True},
 "think_off": {"messages": [SYS, U1], "add_generation_prompt": True, "kwargs": {"enable_thinking": False}},
 "think_on": {"messages": [U1], "add_generation_prompt": True, "kwargs": {"enable_thinking": True}},
 "multimodal": {"messages": [{"role": "user", "content": [{"type": "image"}, {"type": "text", "text": "Describe this image."}]}], "add_generation_prompt": True},
 "documents": {"messages": [{"role": "user", "content": "Summarize the documents."}], "documents": [{"title": "Doc A", "text": "Alpha text."}, {"title": "Doc B", "text": "Beta text."}], "add_generation_prompt": True},
 "bad_order": {"messages": [{"role": "assistant", "content": "Hi"}, {"role": "assistant", "content": "Again"}], "add_generation_prompt": True},
 "unicode": {"messages": [{"role": "user", "content": "日本語で答えて 😀 \"quotes\" <tags> & \\ back"}], "add_generation_prompt": True},
 "empty_content": {"messages": [SYS, {"role": "user", "content": ""}], "add_generation_prompt": True},
}
cases = []
for p in sorted(glob.glob(corpus + "/*.jinja")):
    name = os.path.basename(p)[:-6]
    repo = name.split("__")[0]
    tpl = open(p).read()
    st = special(repo)
    for sn, s in SCEN.items():
        ch = json.loads(json.dumps(s))
        kw = dict(st); kw.update(ch.pop("kwargs", {}))
        ch["kwargs"] = kw
        cases.append({"name": f"{name}/{sn}", "template": tpl, "chat": ch})
json.dump(cases, open(out, "w"), ensure_ascii=False, indent=1)
print(len(cases))
