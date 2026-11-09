import json, sys, random
seed = int(sys.argv[2]); N = int(sys.argv[3])
R = random.Random(seed)
VARS = ["a", "b", "x", "i", "item", "loop", "ns", "m", "msgs"]
EXPRS = ["a", "b", "x", "i", "item", "1", "'s'", "a + 1", "x ~ '!'", "loop.index", "loop.first", "ns.c", "msgs|length", "item.role", "item['content']", "m(1)", "caller()", "varargs", "kwargs", "none", "[1, 2]", "a is defined", "x|default('d')"]
def stmt(d):
    r = R.random()
    if d <= 0 or r < 0.25:
        return R.choice(["{{ %s }}" % R.choice(EXPRS), "T", "\n", "  ", "{# c #}", "{{- %s -}}" % R.choice(EXPRS)])
    if r < 0.4:
        return "{%% set %s = %s %%}" % (R.choice(["a", "b", "x"]), R.choice(EXPRS))
    if r < 0.47:
        return "{%% set ns.c = %s %%}" % R.choice(["ns.c + 1", "1", "x", "a"])
    if r < 0.62:
        return "{%% for %s in %s %%}%s%s{%% endfor %%}" % (R.choice(["i", "item", "x"]), R.choice(["range(3)", "msgs", "[1, 2]", "'ab'", "[]"]), body(d-1), R.choice(["", "{% else %}E"]))
    if r < 0.75:
        return "{%% if %s %%}%s{%% elif %s %%}%s{%% else %%}%s{%% endif %%}" % (R.choice(EXPRS), body(d-1), R.choice(EXPRS), body(d-1), body(d-1))
    if r < 0.82:
        return "{%% macro m(p, q=2) %%}%s{%% endmacro %%}" % body(d-1)
    if r < 0.87:
        return "{%% call m(3) %%}%s{%% endcall %%}" % body(d-1)
    if r < 0.92:
        return "{%% with x = %s %%}%s{%% endwith %%}" % (R.choice(EXPRS), body(d-1))
    if r < 0.96:
        return "{%% if %s %%}{%% break %%}{%% endif %%}" % R.choice(EXPRS) if R.random() < 0.5 else "{% continue %}"
    return "{%% filter upper %%}%s{%% endfilter %%}" % body(d-1)
def body(d):
    return "".join(stmt(d) for _ in range(R.randint(1, 3)))
cases = []
ctx = {"msgs": [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "yo"}], "b": 5}
for k in range(N):
    t = "{% set ns = namespace(c=0) %}" + body(R.choice([2, 3, 3, 4]))
    cases.append({"name": f"s{seed}_{k}", "template": t, "ctx": ctx})
json.dump(cases, open(sys.argv[1], "w"), ensure_ascii=False, indent=1)
print(len(cases))
