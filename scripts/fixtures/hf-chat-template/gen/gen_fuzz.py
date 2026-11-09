import json, sys, random
seed = int(sys.argv[2]); N = int(sys.argv[3])
R = random.Random(seed)
ATOMS = ["0", "1", "-3", "7", "42", "300", "2**70", "0.5", "-0.0", "1e20", "1/3", "2.5", "''", "'a'", "'Hello World'", "'é😀x'", "' x '", "'a,b,,c'", "'ABC'", "'3.5'", "'12'",
         "none", "true", "false", "[]", "[1, 2, 3]", "['b', 'A', 'c']", "[1, 'a']", "(1, 2)", "()", "{}", "{'k': 1, 'a': 'x'}", "{'b': 2, 'a': 1}", "m", "l", "s", "n", "f", "u", "m.k", "l[0]", "range(4)", "d"]
BIN = ["+", "-", "*", "/", "//", "%", "**", "~", "==", "!=", "<", ">=", "in", "not in", "and", "or"]
FILT = ["length", "upper", "lower", "title", "capitalize", "trim", "join(',')", "join", "first", "last", "list", "sort", "sort(reverse=true)", "reverse|list", "unique|list", "tojson", "tojson(indent=1)", "string", "int", "float", "abs", "round(1)", "round", "default('d')", "d(1, true)",
        "replace('a', 'b')", "center(7)", "indent(2)", "batch(2)|list", "slice(2)|list", "map('string')|list", "select|list", "reject|list", "sum", "min", "max", "dictsort", "items|list", "wordcount", "truncate(5, true, '..', 0)", "count", "e", "safe", "striptags", "wordwrap(5)", "filesizeformat", "pprint", "urlencode",
        "format(1)", "list|length", "groupby(0)|list", "selectattr('k')|list", "map(attribute='k')|list", "attr('real')", "xmlattr", "random is defined", "first|string", "title|lower"]
METH = [".split()", ".split(',')", ".strip()", ".upper()", ".startswith('a')", ".endswith(('c', 'x'))", ".replace('a', 'b')", ".get('k')", ".get('z', 0)", ".items()|list", ".keys()|list", ".values()|list", ".count('a')", ".count(1)", ".find('a')", ".index(1)", ".index('a')", ".lower()", ".title()", ".zfill(5)", ".isdigit()", ".format(1, 2)", ".join(['x', 'y'])", ".copy()", ".real", ".is_integer()", ".bit_length()", ".append(1)", ".k", ".x", "[0]", "[-1]", "[1:]", "[::-1]", "[:2]", "['k']", "[1]", "[10]"]
TESTS = ["defined", "undefined", "none", "string", "number", "integer", "float", "mapping", "sequence", "iterable", "odd", "even", "divisibleby 3", "lower", "upper", "in [1, 'a']", "eq 1", "true", "false", "boolean", "callable", "sameas none", "escaped", "gt 2", "le 'b'"]

def expr(d):
    r = R.random()
    if d <= 0 or r < 0.25: return R.choice(ATOMS)
    if r < 0.5:
        return f"({expr(d-1)} {R.choice(BIN)} {expr(d-1)})"
    if r < 0.68:
        return f"({expr(d-1)})|{R.choice(FILT)}"
    if r < 0.82:
        return f"({expr(d-1)}){R.choice(METH)}"
    if r < 0.9:
        return f"({expr(d-1)} is {'not ' if R.random()<0.3 else ''}{R.choice(TESTS)})"
    if r < 0.95:
        return f"({expr(d-1)} if {expr(d-1)} else {expr(d-1)})"
    return f"[{expr(d-1)}, {expr(d-1)}]"

cases = []
ctx = {"m": {"k": [1, 2], "a": "x"}, "l": [3, 1, 2], "s": "Hello, World", "n": 5, "f": 2.5, "d": [{"k": 2, "v": "b"}, {"k": 1, "v": "a"}, {"k": 2, "v": "c"}]}
for i in range(N):
    e = expr(R.choice([1, 2, 2, 3]))
    t = "{{ " + e + " }}" if R.random() < 0.85 else "{% for x in " + e + " %}[{{ x }}{{ loop.last }}]{% else %}E{% endfor %}"
    cases.append({"name": f"z{seed}_{i}", "template": t, "ctx": ctx})
json.dump(cases, open(sys.argv[1], "w"), ensure_ascii=False, indent=1)
print(len(cases))
