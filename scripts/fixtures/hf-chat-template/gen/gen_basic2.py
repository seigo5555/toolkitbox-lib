import json, sys
cases = []
def C(t, ctx=None):
    cases.append({"name": f"c{len(cases)}", "template": t, "ctx": ctx or {}})

FMT = ["{:10}", "{:<10}", "{:*^9}", "{:=+8}", "{:08.3f}", "{:,.2f}", "{:_}", "{:#x}", "{:#o}", "{:#b}", "{:X}", "{:e}", "{:.0e}", "{:E}", "{:g}", "{:.3g}", "{:G}", "{:%}", "{:.1%}", "{:n}", "{:.2}", "{:.10}", "{:010,}", "{:+.1f}", "{: d}", "{:c}", "{:5s}", "{:.3s}", "{:>6.2s}", "{:z.1f}"]
VALS = ["1234.5678", "-0.0001", "42", "-42", "1e20", "0.5", "2.5", "'abc'", "True", "1e-7", "123456789", "0", "-0.0", "1.0"]
for f in FMT:
    C("|".join("{{ '%s'.format(%s) }}" % (f, v) for v in VALS[:7]))
    C("|".join("{{ '%s'.format(%s) }}" % (f, v) for v in VALS[7:]))
PCT = ["%s", "%r", "%d", "%5d", "%-5d|", "%05d", "%+d", "% d", "%x", "%X", "%#x", "%o", "%#o", "%e", "%.2e", "%E", "%f", "%.1f", "%10.3f", "%-10.3f|", "%g", "%G", "%.3g", "%c", "%%", "%i", "%u", "%a", "%5.1s|"]
for p in PCT:
    C("|".join("{{ '%s' %% (%s,) }}" % (p, v) for v in ["42", "-3.75", "1e20", "65", "0.000012345", "'x'", "True"]))
for t in [
    "{{ '%(a)s-%(b)05.1f' % {'a': 'x', 'b': 2.25} }}", "{{ '%*d|%-*d|' % (5, 42, 4, 7) }}", "{{ '%.*f' % (2, 3.14159) }}", "{{ '%s %s' % ('a',) }}", "{{ '%s' % ('a', 'b') }}", "{{ '%q' % 1 }}", "{{ '%d' % 'x' }}", "{{ '%(x)s' % 1 }}", "{{ '%s' % none }}", "{{ '%s' % {'a': 1} }}", "{{ '%' % 1 }}",
    "{{ '{0}{1}'.format(1) }}", "{{ '{}{0}'.format(1, 2) }}", "{{ '{x}'.format(1) }}", "{{ '{'.format() }}", "{{ '}'.format() }}", "{{ '{:d}'.format('a') }}", "{{ '{:s}'.format(1) }}", "{{ '{0.real} {0.imag}'.format(3) }}", "{{ '{0[0]}{0[1]}'.format('ab') }}", "{{ '{:{w}}|'.format('x', w=4) }}", "{{ '{!x}'.format(1) }}", "{{ '{0.__class__}'.format(1) }}", "{{ '{:.2f}'.format(none) }}", "{{ '{}'.format(none) }}", "{{ '{} {}'.format([1], {'a': (1,)}) }}",
    "{{ 'a{}b'.format_map({}) }}", "{{ '{x}{y}'.format_map({'x': 1, 'y': 'z'}) }}",
    "{{ 1e16 }} {{ 1.5e16 }} {{ 9999999999999998.0 }} {{ 0.1 * 3 }} {{ 1/7 }} {{ 1e-4 }} {{ 1.23e-5 }} {{ 5e-324 }} {{ 1.7976931348623157e308 }} {{ 2.0**53 }} {{ 2.0**53 + 1 }} {{ 100.0 }} {{ 123456789012345678.0 }}",
    "{{ 10 / 4 }} {{ 10 // 4 }} {{ -10 // 4 }} {{ 10 % -3 }} {{ -10 % 3 }} {{ 10.5 % 3 }} {{ -10.5 % 3 }} {{ 10.5 // -3 }} {{ 2 ** 64 }} {{ (2 ** 64) // 3 }} {{ (2 ** 70) / 3 }} {{ 10 ** 20 / 7 }} {{ 7 / 2.0 }} {{ true + true }} {{ true * 3 }} {{ true / 2 }} {{ -true }}",
    "{{ 0 ** 0 }} {{ 2 ** 0.5 }} {{ 4 ** 0.5 }} {{ (-8) ** 2 }} {{ 0.0 ** 0 }} {{ 10 ** -2 }} {{ (-2) ** -1 }}", "{{ 0 ** -1 }}", "{{ 2.0 ** 10000 }}", "{{ (-8) ** 0.5 }}",
    "{{ 3 * [1] }} {{ [1] * 0 }} {{ [1] * -1 }} {{ 'ab' * true }} {{ (1,) * 2 }}", "{{ 'a' * 1.5 }}", "{{ [1] * [1] }}", "{{ {} + {} }}", "{{ none + 1 }}", "{{ 1 - none }}", "{{ 'a' < 1 }}", "{{ [1] < (1,) }}", "{{ [1, 'a'] < [1, 2] }}",
    "{{ 'abc' < 'abd' }} {{ 'Z' < 'a' }} {{ '' < 'a' }} {{ 'é' > 'z' }} {{ '\\uffff' < '\\U0001f600' }} {{ [1,2] == [1,2] }} {{ [1,2] == (1,2) }} {{ {'a':1} == {'a':1.0} }} {{ none == none }} {{ none == false }} {{ 0 == 0.0 == false }}",
    "{{ 'ab' in 'xaby' }} {{ '' in 'x' }} {{ 1 in [1.0] }} {{ none in [none] }} {{ [1] in [[1]] }} {{ 'a' in {'a': 1} }} {{ 2 in range(3) }} {{ 'x' in none }}", "{{ [1] in {} }}", "{{ 1 in {'a': 1}.values() }} {{ 'a' in {'a':1}.keys() }} {{ ('a', 1) in {'a':1}.items() }}",
    "{{ (1, 2)[0] }} {{ (1, 2)[-1] }} {{ (1,2,3)[1:] }} {{ 'abc'[-5:] }} {{ [1,2,3][::2] }} {{ [1,2,3][5:] }} {{ range(10)[2:8:3]|list }} {{ range(10)[::-3]|list }} {{ 'abcdef'[4:1:-1] }}", "{{ [1][::0] }}", "{{ none[1:] }}", "{{ x[1:] }}", "{{ [1]['a':] }}",
    "{{ {'a': 1}.a }} {{ {'a': {'b': [1, 2]}}.a.b[1] }} {{ [[1, 2]].0.1 }} {{ {'1': 'str', 1: 'int'}[1] }} {{ {'1': 'str', 1: 'int'}['1'] }} {{ {(1,2): 'tup'}[(1,2)] }} {{ {none: 'n'}[none] }} {{ {1.0: 'f'}[1] }}",
    "{{ 'x'.upper }}", "{{ [].count }}", "{{ {}.get }}", "{{ (1,).index }}", "{{ 1.5.is_integer() }} {{ (2.0).is_integer() }} {{ 5.real }} {{ (5).bit_length() }} {{ true.real }}",
]: C(t)

# whitespace and lexer edge cases
for t in [
    "{%- if true %}  x  {% endif -%}  ", "x\n  {%- if true %}\n    y\n  {%- endif %}\nz", "a\n{# comment #}\nb", "a\n  {#- c -#}\n  b", "{% if true %}a{% endif %}\n\n\nb",
    "{% for i in range(2) %}\n  - {{ i }}\n{% endfor %}\n", "  {%- for i in range(2) -%}\n  {{ i }}\n  {%- endfor -%}  ", "line\n\t  {% if 1 %}tab{% endif %}", "{{ 'a' }}\n{{ 'b' }}\n", "x {%- raw %} {{ y }} {% endraw -%} z",
    "{%+ if true +%}\n x\n{%+ endif +%}\n", "  {{- 'x' }}", "{{ 'x' -}}  \n  y", "a\r\n  {% if 1 %}\r\nb\r\n  {% endif %}\r\nc\r\n", "\n\n{% set x = 1 %}\n\n", "{# a #}{# b #}x", "{{ '\\n' }}{{ \"\\t\" }}{{ '\\\\' }}{{ '\\'' }}",
    "{{ 1 }}{{\n2\n}}{{3}}", "{%if true%}t{%endif%}", "{%   if   true   %}t{%   endif   %}", "{{ a\n.b }}", "{{ [1,\n 2,\n 3]|length }}", "{{ {\n'k': 'v'\n}['k'] }}",
    "{{ x if x is defined else 'd' }}", "{% if x is not defined %}nd{% endif %}", "{{ not x is defined }}", "{{ not (x is defined) }}", "{{ -2 ** 2 }} {{ - 2 ** 2 }} {{ (-2) ** 2 }} {{ 2 ** -1 }}", "{{ 1 + 2 * 3 - 4 / 2 }}", "{{ 'a' ~ 1 + 2 }}", "{{ 1 ~ 2 * 3 }}",
    "{{ 1 if true else 2 if false else 3 }}", "{{ (1 if false) is defined }}", "{{ 'a' 'b' 'c' }}", "{{ 'a'|upper|lower|capitalize }}", "{{ [3,1,2]|sort|first }}", "{{ 'abc'|length > 2 }}", "{{ 'abc' is string and 'abc'|length }}", "{{ not 'a' in 'abc' }}", "{{ 'a' not in 'abc' }}",
    "{{ 1 is divisibleby 2 or true }}", "{{ x is defined and x.y }}", "{{ 3 is gt 2 and 1 is lt 2 }}", "{{ range(3) is iterable }}", "{{ loop is defined }}",
    "{{ 'a' if true else }}", "{{ 1 + }}", "{% set %}", "{% set x = %}", "{% for x in %}{% endfor %}", "{% if %}{% endif %}", "{% macro %}{% endmacro %}", "{% macro m( %}{% endmacro %}", "{% call %}{% endcall %}", "{% call m %}{% endcall %}", "{% filter %}{% endfilter %}",
    "{% with a %}{% endwith %}", "{% set x.y.z = 1 %}", "{% set x['a'] = 1 %}", "{% set (a, b) = (1, 2) %}{{ a }}{{ b }}", "{% for (a, b) in [(1, 2)] %}{{ a }}{{ b }}{% endfor %}", "{% for a, (b, c) in [(1, (2, 3))] %}{{ a }}{{ b }}{{ c }}{% endfor %}", "{% set a, = [1] %}{{ a }}",
    "{{ x.0 }}", "{{ x.-1 }}", "{{ [1,2].-1 }}", "{{ x.1.2 }}", "{{ 1.2.3 }}", "{{ 1..2 }}", "{{ @ }}", "{{ $x }}", "{{ x ! y }}", "{{ x && y }}", "{{ x || y }}", "{{ x ** }}", "{{ x // }}",
    "{{ 'unterminated }}", "{{ \"also }}", "{% if 'a' == \"b\" %}{% endif %}ok", "{{ x[ }}", "{{ x] }}", "{{ x( }}", "{{ (x }}", "{{ x) }}", "{{ {x }}", "{{ x} }}",
    "{% for i in range(3) %}{{ i }}{% else %}", "{% if 1 %}{% elif %}{% endif %}", "{% if 1 %}{% else %}{% else %}{% endif %}", "{% macro m() %}{% endfor %}", "{% for i in x %}{% endmacro %}", "{% block %}{% endblock %}", "{% block a-b %}{% endblock %}", "{% block a %}{% endblock b %}",
    "{% set x = 1 %}{% set x = x + 1 %}{{ x }}", "{% set x = [1] %}{% set y = x %}{{ y is sameas x }}", "{% set d = {} %}{% set _ = d.update({'a': 1}) %}{{ d }}",
    "{% for i in range(2) %}{% for j in range(2) %}{% if j == 1 %}{% break %}{% endif %}{{ i }}{{ j }} {% endfor %}{% endfor %}",
    "{% for i in [1] %}{% continue %}{% else %}ELSE{% endfor %}", "{% for i in [1, 2] %}{% if i == 1 %}{% continue %}{% endif %}x{% else %}ELSE{% endfor %}", "{% for i in [1, 2] %}{% if i == 2 %}{% break %}{% endif %}x{% else %}ELSE{% endfor %}",
    "{% for i in range(3) %}{% set j = i * 2 %}{% endfor %}{{ j }}", "{% for i in range(3) %}{{ loop.index }}{% for k in range(2) %}{{ loop.index }}{% endfor %}{{ loop.index }}|{% endfor %}",
    "{% for i in range(5) if i is odd %}{{ loop.index }}:{{ i }}{{ loop.length }}{{ loop.revindex }} {% endfor %}", "{% for c in 'héllo' %}{{ loop.index }}{{ c }}{% endfor %}", "{% for k, v in {'a': 1, 'b': 2}|dictsort(reverse=true) %}{{ k }}{{ v }}{% endfor %}",
    "{% for x in [1, 2, 3] %}{{ loop.changed(x % 2) }}{% endfor %}", "{% for x in range(3) %}{{ loop.cycle() }}{% endfor %}", "{% for x in [] %}{% endfor %}{{ loop }}", "{% for x in [1,2] %}{{ loop.nextitem is defined }}{{ loop.previtem is defined }}{% endfor %}",
    "{% for x in (y for y in []) %}{% endfor %}", "{% for i in range(2) recursive %}{{ i }}{% endfor %}", "{% for i in [[1, [2]], [3]] recursive %}<{% if i is iterable %}{{ loop(i) }}{% else %}{{ i }}{{ loop.depth0 }}{% endif %}>{% endfor %}",
    "{% for i in range(2) %}{{ loop(range(1)) }}{% endfor %}", "{% for i in range(2) recursive %}{% if loop.depth < 3 %}[{{ loop([i]) }}]{% else %}{{ i }}{% endif %}{% endfor %}",
    "{% macro m(a, b, c='C', d=a) %}{{ a }}{{ b }}{{ c }}{{ d }}{% endmacro %}{{ m(1, 2) }}|{{ m(1, 2, d=4) }}|{{ m(1) }}|{{ m(b=2, a=1) }}", "{% macro m(a=b, b=1) %}[{{ a }}][{{ b }}]{% endmacro %}{{ m() }}", "{% macro m(*args) %}{% endmacro %}",
    "{% macro m(x) %}{{ caller(x) }}{% endmacro %}{{ m(1) }}", "{% macro m() %}{{ caller() }}{% endmacro %}{{ m() }}", "{% macro m(caller) %}{{ caller() }}{% endmacro %}{% call m() %}c{% endcall %}", "{% macro m(caller=none) %}{{ caller() if caller else 'none' }}{% endmacro %}{{ m() }}|{% call m() %}c{% endcall %}",
    "{% macro m() %}{{ kwargs }}{{ varargs }}{% endmacro %}{{ m(1, 2, a=3) }}", "{% macro m(kwargs) %}{{ kwargs }}{% endmacro %}{{ m(5) }}", "{% macro m() %}x{% endmacro %}{{ m(caller=1) }}", "{% macro m() %}{{ caller() }}{% endmacro %}{% call m() %}c{% endcall %}{{ m(caller=1) }}",
    "{% macro r(n) %}{% if n > 0 %}{{ n }}{{ r(n - 1) }}{% endif %}{% endmacro %}{{ r(5) }}", "{% macro r(n) %}{{ r(n + 1) }}{% endmacro %}{{ r(0) }}", "{% macro a() %}{{ b() }}{% endmacro %}{% macro b() %}B{% endmacro %}{{ a() }}",
    "{% macro m() %}{{ x }}{% endmacro %}{% set x = 'late' %}{{ m() }}", "{% macro m() %}{% set x = 'inner' %}{{ x }}{% endmacro %}{% set x = 'outer' %}{{ m() }}{{ x }}", "{% for i in range(2) %}{% macro m() %}{{ i }}{% endmacro %}{{ m() }}{% endfor %}",
    "{% set ns = namespace(items=[]) %}{% for i in range(3) %}{% set ns.items = ns.items + [i] %}{% endfor %}{{ ns.items }}", "{% set ns = namespace(a=1, b=2) %}{{ ns.a + ns.b }}{{ ns }}", "{% set ns = namespace({'x': 1}) %}{{ ns.x }}", "{% set ns = namespace([('k', 2)]) %}{{ ns.k }}",
    "{% set ns = namespace() %}{% set ns.a, ns.b = 1, 2 %}{{ ns.a }}{{ ns.b }}", "{% set ns = namespace(n=0) %}{% macro inc() %}{% set ns.n = ns.n + 1 %}{% endmacro %}{{ inc() }}{{ inc() }}{{ ns.n }}", "{{ namespace(a=1).a }}", "{{ namespace(1) }}",
    "{% with x = 1 %}{% with y = x + 1 %}{{ x }}{{ y }}{% endwith %}{% endwith %}", "{% set x = 'o' %}{% with x = 'i', y = x %}{{ x }}{{ y }}{% endwith %}{{ x }}",
    "{% filter indent(2) %}a\nb{% endfilter %}", "{% filter tojson %}{{ 'x' }}{% endfilter %}", "{% filter nosuch %}x{% endfilter %}", "{% set v | trim | upper %}  abc  {% endset %}[{{ v }}]",
    "{{ dict() }} {{ dict(a=1)|length }} {{ dict([(1, 2), (3, 4)]) }}", "{{ dict([(1, 2, 3)]) }}", "{{ dict([1]) }}", "{{ dict(1) }}", "{{ dict({'a':1}, {'b':2}) }}",
    "{{ cycler() }}", "{% set c = cycler(1, 2) %}{{ c.next() }}{{ c.next() }}{{ c.next() }}{% do c.reset() %}", "{% set c = cycler(1, 2) %}{{ c.next() }}{{ c.reset() }}{{ c.next() }}{{ c.items }}{{ c.pos }}", "{% set j = joiner() %}{{ j() }}{{ j() }}{{ j() }}",
    "{{ range(5)|reverse|list }} {{ range(2, -2, -1)|list }} {{ range(0, 10, 3)|length }} {{ range(-3)|list }}", "{{ range(1.5) }}", "{{ range(0, 10, 0) }}", "{{ range() }}", "{{ range('a') }}",
    "{{ raise_exception() }}", "{{ raise_exception('a', 'b') }}", "{{ raise_exception(message='kw') }}", "{{ raise_exception(5) }}", "{{ strftime_now() }}", "{{ strftime_now(1) }}",
    "{{ lipsum(1, false, 3, 4)|length > 0 }}", "{{ range }}", "{{ dict }}", "{{ namespace }}", "{{ cycler }}", "{{ joiner }}", "{{ raise_exception }}", "{{ strftime_now }}", "{{ lipsum }}",
]: C(t, {"y": {"a": None}})

json.dump(cases, open(sys.argv[1], "w"), ensure_ascii=False, indent=1)
print(len(cases))
