import json, sys, glob, os
corpus, out = sys.argv[1], sys.argv[2]
cases = []
def add(case_name, **kw):
    kw["case"] = kw.pop("name", None); kw["name"] = case_name; cases.append(kw)

# 1) jinja2.meta.find_undeclared_variables for every corpus template
for p in sorted(glob.glob(corpus + "/*.jinja")):
    add("vars/" + os.path.basename(p)[:-6], mode="vars", template=open(p).read())

# 2) template selection (get_chat_template)
T = {"default": "D", "tool_use": "T"}
add("sel/default", mode="select", templates=T, name=None, tools=None)
add("sel/tools", mode="select", templates=T, name=None, tools=[{"a": 1}])
add("sel/named", mode="select", templates=T, name="tool_use", tools=None)
add("sel/rag", mode="select", templates={"default": "D", "rag": "R"}, name="rag", tools=[{}])
add("sel/nodefault", mode="select", templates={"a": "A", "b": "B"}, name=None, tools=None)
add("sel/tools_no_tooluse", mode="select", templates={"default": "D", "rag": "R"}, name=None, tools=[{}])

# 3) chat options against a small set of templates
CHATML = "{% for message in messages %}{{'<|im_start|>' + message['role'] + '\\n' + message['content'] + '<|im_end|>' + '\\n'}}{% endfor %}{% if add_generation_prompt %}{{ '<|im_start|>assistant\\n' }}{% endif %}"
GEN = "{% for m in messages %}{% if m.role == 'assistant' %}<a>{% generation %}{{ m.content }}</s>{% endgeneration %}\\n{% else %}<u>{{ m.content }}\\n{% endif %}{% endfor %}"
GEN2 = "{% macro body(x) %}{% generation %}[{{ x }}]{% endgeneration %}{% endmacro %}{% for m in messages %}{{ m.role }}:{{ body(m.content) }}{% generation %}{{ '😀' }}{% endgeneration %};{% endfor %}"
REASON = "{% for m in messages %}{{ m.role }}|{{ m.reasoning_content }}|{{ m.thinking }}|{{ m.reasoning }}|{{ m.content }}\\n{% endfor %}"
LISTC = "{% for m in messages %}{{ m.role }}:{% if m.content is string %}{{ m.content }}{% else %}{% for c in m.content %}{% if c.type == 'text' %}{{ c.text }}{% else %}<{{ c.type }}>{% endif %}{% endfor %}{% endif %}\\n{% endfor %}"
STRIP = "{% for m in messages %}{{ m.role }}: {{ m.content | trim }}\\n{% endfor %}"
U = {"role": "user", "content": "Hi"}
for nm, tpl, ch in [
  ("cont/basic", CHATML, {"messages": [U, {"role": "assistant", "content": "Hello the"}], "continue_final_message": True}),
  ("cont/trailing_space", CHATML, {"messages": [U, {"role": "assistant", "content": "Hello the "}], "continue_final_message": True}),
  ("cont/strip", STRIP, {"messages": [U, {"role": "assistant", "content": "Hello there  "}], "continue_final_message": True}),
  ("cont/field_reasoning", REASON, {"messages": [U, {"role": "assistant", "content": "x", "reasoning_content": "I think"}], "continue_final_message": "reasoning_content"}),
  ("cont/field_thinking_alias", REASON, {"messages": [U, {"role": "assistant", "content": "x", "thinking": "Hmm"}], "continue_final_message": "thinking"}),
  ("cont/field_missing", REASON, {"messages": [U, {"role": "assistant", "content": "x"}], "continue_final_message": "reasoning_content"}),
  ("cont/field_not_in_template", CHATML, {"messages": [U, {"role": "assistant", "content": "x", "reasoning_content": "r"}], "continue_final_message": "reasoning_content"}),
  ("cont/list_content", LISTC, {"messages": [U, {"role": "assistant", "content": [{"type": "text", "text": "Part one"}, {"type": "image"}, {"type": "text", "text": "Part two"}]}], "continue_final_message": True}),
  ("cont/list_no_text", LISTC, {"messages": [U, {"role": "assistant", "content": [{"type": "image"}]}], "continue_final_message": True}),
  ("cont/with_agp", CHATML, {"messages": [U], "continue_final_message": True, "add_generation_prompt": True}),
  ("cont/deleted", "{% for m in messages %}{{ m.role }}{% endfor %}", {"messages": [U, {"role": "assistant", "content": "gone"}], "continue_final_message": True}),
  ("opt/empty", CHATML, {"messages": []}),
  ("opt/tools_bad", CHATML, {"messages": [U], "tools": ["not a dict"]}),
  ("opt/docs_bad", CHATML, {"messages": [U], "documents": ["x"]}),
  ("opt/msg_not_dict", CHATML, {"messages": ["hello"]}),
  ("opt/kwargs", "{{ custom }}|{{ bos_token }}|{{ add_generation_prompt }}|{{ tools }}|{{ documents }}", {"messages": [U], "kwargs": {"custom": [1, {"a": None}], "bos_token": "<s>"}}),
  ("opt/reasoning_alias", REASON, {"messages": [{"role": "assistant", "content": "c", "reasoning": "r1"}, {"role": "assistant", "content": "c", "thinking": "t1", "reasoning_content": None}]}),
  ("opt/numbers", "{% for m in messages %}{{ m.n }} {{ m.f }} {{ m.n is integer }} {{ m.f is float }} {{ m.big }}{% endfor %}", {"messages": [{"role": "user", "content": "", "n": 3, "f": 3.0, "big": 123456789012345678901234567890}]}),
  ("gen/basic", GEN, {"messages": [U, {"role": "assistant", "content": "Yes"}, U, {"role": "assistant", "content": "No"}]}),
  ("gen/macro", GEN2, {"messages": [U, {"role": "assistant", "content": "é"}]}),
]:
    add(nm, template=tpl, chat=ch, gen=nm.startswith("gen/"))
json.dump(cases, open(out, "w"), ensure_ascii=False, indent=1)
print(len(cases))
