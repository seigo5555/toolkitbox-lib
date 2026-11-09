import json, sys
cases = []
def C(t, ctx=None, name=None):
    cases.append({"name": name or f"b{len(cases)}", "template": t, "ctx": ctx or {}})

# ---- lexer / whitespace ----
for t in [
    "a\n", "a\n\n", "a\r\nb\r\n", "a\rb", "{% if true %}\nx\n{% endif %}\ny",
    "  {% if true %}\n  x\n  {% endif %}\n", "a  {%- if true -%}  b  {%- endif -%}  c",
    "a {{- 1 -}} b", "a {%+ if true %}b{% endif %}", "  {%+ if true %}x{% endif %}",
    "  {{ 1 }}\n", "\t{# c #}\nx", "{# multi\nline #}y", "a{#- c -#}  b", "{% raw %}{{ x }}{% endraw %}",
    "  {% raw %}\n{{ y }}\n  {% endraw %}\nz", "{%- raw -%}  a  {%- endraw -%}", "{{ 'a' 'b' }}",
    "{{ \"q\\\"x\" }}", "{{ 'a\\nb\\tc\\\\d' }}", "{{ '\\x41\\u3042\\U0001F600' }}", "{{ '\\d' }}", "{{ 'é\\é' }}",
    "{{ 1_000 }} {{ 0x1F }} {{ 0o17 }} {{ 0b101 }} {{ 1e3 }} {{ 1_0.5 }} {{ 2.5e-3 }} {{ 007 }}",
    "{{ 1.0 }} {{ 10/2 }} {{ 7//2 }} {{ -7//2 }} {{ 7%3 }} {{ -7%3 }} {{ 2**10 }} {{ 2**-1 }} {{ 7.5//2 }}",
    "{{ 1/3 }} {{ 2/3 }} {{ 1e16 }} {{ 1e15 }} {{ 0.0001 }} {{ 0.00001 }} {{ 1e22 }} {{ 123456789.123456789 }} {{ -0.0 }}",
    "{{ 0.1+0.2 }} {{ 1.5e300*1e10 }} {{ 3.0*2 }} {{ 2**100 }} {{ -2**2 }} {{ (-2)**2 }} {{ 2**3**2 }}",
    "{{ 'ab' * 3 }} {{ [1,2] * 2 }} {{ 3 * 'x' }} {{ [1] + [2] }} {{ (1,) + (2,) }} {{ 'a' ~ 1 ~ none ~ true }}",
    "{{ true }} {{ True }} {{ none }} {{ None }} {{ false and 1 }} {{ 0 or 'x' }} {{ '' or [] }} {{ not 0 }}",
    "{{ 1 if true }}|{{ 1 if false }}|{{ 1 if false else 2 }}|{{ 'a' if 0 else 'b' if 1 else 'c' }}",
    "{{ 1 < 2 < 3 }} {{ 3 > 2 > 2 }} {{ 1 == 1.0 }} {{ 'a' != 'b' }} {{ 1 in [1,2] }} {{ 'b' in 'abc' }} {{ 3 not in [1] }} {{ 'k' in {'k':1} }}",
    "{{ [1,'a',none,true,1.5,[2],{'x':(1,2)}] }}", "{{ {'a':1,'b':'c\\'d',1:2,none:3} }}", "{{ ('a',) }} {{ () }} {{ (1,2) }}",
    "{{ 'it\\'s' }}|{{ ['it\\'s', 'say \"hi\"', 'both \\'\"'] }}|{{ ['\\n\\t\\x00\\x7f\\u00e9\\u3042'] }}",
    "{{ [1.0, 1e16, 0.1, -0.0, 1e-5] }}", "{{ x }}", "{{ x.y }}", "{{ x['y'] }}",
]: C(t)

C("{{ m }}|{{ m.a }}|{{ m['a'] }}|{{ m.items }}|{{ m['items'] }}|{{ m.get('a') }}|{{ m.get('z', 5) }}|{{ m.keys() }}|{{ m.values() }}|{{ m.items() }}",
  {"m": {"a": 1, "items": [1, 2], "b": None}})
C("{{ l[0] }}{{ l[-1] }}{{ l[1:] }}{{ l[::-1] }}{{ l[:-1] }}{{ l[5] }}|{{ l.0 }}|{{ l[1:2:1] }}|{{ s[1:3] }}{{ s[::-1] }}{{ s[-2] }}",
  {"l": [1, 2, 3], "s": "héllo😀"})
C("{{ s|length }} {{ s[4] }} {{ s|list }} {{ s|reverse }}", {"s": "a😀b"})
C("{{ l.append(1) }}", {"l": [1]})
C("{% set x = l.append %}ok", {"l": [1]})
C("{{ m.update({'a':2}) }}", {"m": {}})
C("{{ m.pop('a') }}", {"m": {"a": 1}})
C("{{ l.index(2) }} {{ l.count(1) }} {{ l.copy() }} {{ m.copy() }}", {"l": [1, 2, 1], "m": {"a": 1}})
C("{{ ''.__class__ }}")
C("{{ x._private }}", {"x": {"_private": 1}})
C("{{ x['_private'] }}", {"x": {"_private": 1}})

# ---- str methods ----
for t in [
    "{{ ' a b '.strip() }}|{{ 'xxaxx'.strip('x') }}|{{ ' a'.lstrip() }}|{{ 'a '.rstrip() }}|{{ 'a,b,,c'.split(',') }}|{{ ' a  b '.split() }}|{{ 'a b c'.split(' ', 1) }}|{{ 'a b c'.rsplit(' ', 1) }}",
    "{{ 'Hello'.upper() }} {{ 'Hello'.lower() }} {{ 'hello world'.title() }} {{ 'hELLO'.capitalize() }} {{ 'Hi'.swapcase() }} {{ 'ß'.upper() }} {{ 'İ'.lower()|length }}",
    "{{ 'abc'.startswith('a') }} {{ 'abc'.startswith(('x','a')) }} {{ 'abc'.endswith('bc') }} {{ 'abc'.startswith('b', 1) }}",
    "{{ 'aXbXc'.replace('X','-') }} {{ 'aXbXc'.replace('X','-',1) }} {{ 'abc'.find('c') }} {{ 'abc'.find('z') }} {{ 'abcabc'.rfind('b') }} {{ 'abc'.index('b') }} {{ 'aaa'.count('a') }}",
    "{{ 'abc'.index('z') }}",
    "{{ '-'.join(['a','b']) }} {{ ', '.join(l) }} {{ 'x'.center(5) }}|{{ 'x'.ljust(3) }}|{{ 'x'.rjust(3,'*') }}|{{ '5'.zfill(3) }} {{ '-5'.zfill(4) }}",
    "{{ 'a1'.isalnum() }} {{ 'a'.isalpha() }} {{ '12'.isdigit() }} {{ ' '.isspace() }} {{ 'abc'.islower() }} {{ 'ABC'.isupper() }} {{ 'Ab Cd'.istitle() }} {{ ''.isalpha() }} {{ '١٢'.isdigit() }} {{ 'x_1'.isidentifier() }}",
    "{{ 'a\\nb\\r\\nc'.splitlines() }} {{ 'a\\nb\\n'.splitlines(true) }} {{ 'a=b=c'.partition('=') }} {{ 'a=b=c'.rpartition('=') }} {{ 'prefix_x'.removeprefix('prefix_') }} {{ 'x.py'.removesuffix('.py') }}",
    "{{ '{} and {}'.format(1, 'b') }}|{{ '{0}{1}{0}'.format('a','b') }}|{{ '{x}!'.format(x=3) }}|{{ '{:>5}|{:<5}|{:^5}'.format('a','b','c') }}|{{ '{:.2f} {:5d} {:05.1f} {:x} {:e} {:,}'.format(3.14159, 42, 2.5, 255, 12345.678, 1234567) }}",
    "{{ '{!r} {!s}'.format('a', 'b') }}|{{ '{0[a]} {0[b]}'.format({'a':1,'b':2}) }}|{{ '{{x}}'.format() }}|{{ '{:%}'.format(0.25) }}|{{ '{:g}'.format(1e20) }}|{{ '{:+d}'.format(5) }}",
    "{{ '%s and %s' % ('a', 'b') }}|{{ '%d%%' % 50 }}|{{ '%5.2f' % 3.14159 }}|{{ '%r' % 'x' }}|{{ '%(a)s' % {'a': 1} }}|{{ '%x %o %e %g %c' % (255, 8, 1234.5, 0.00001, 65) }}|{{ '%-5s|' % 'a' }}",
    "{{ '%s' % [1,2] }}|{{ '%s %s' % [1,2] }}",
    "{{ 'abc'|upper }} {{ 'ABC'|lower }} {{ 'hello world'|title }} {{ 'hello WORLD'|capitalize }} {{ '  x  '|trim }}|{{ 'xxaxx'|trim('x') }} {{ 'a b'|replace(' ', '_') }} {{ 'aaa'|replace('a','b',2) }}",
    "{{ 'x'|center(5) }}|{{ 'hello world foo bar'|truncate(9) }}|{{ 'hello world foo bar'|truncate(9, true) }}|{{ 'hello world foo bar'|truncate(11, false, '..', 0) }}|{{ 'abc'|truncate(5) }}",
    "{{ 'one two three'|wordcount }} {{ 'a\\nb\\nc'|indent }}|{{ 'a\\n\\nb'|indent(2, true) }}|{{ 'a\\n\\nb'|indent(2, false, true) }}|{{ 'a\\nb'|indent('>> ') }}",
    "{{ 'The quick brown fox jumps over the lazy dog'|wordwrap(10) }}|{{ 'abcdefghijklmnop'|wordwrap(5) }}|{{ 'abcdefghij klmnop'|wordwrap(5, false) }}|{{ 'a-b-c-d-e-f-g'|wordwrap(4) }}|{{ 'a b'|wordwrap(10, wrapstring='<br>') }}",
    "{{ '<b>x</b> &amp; y'|striptags }}|{{ '<a>'|e }}|{{ '<a>'|escape }}|{{ '<a>'|forceescape }}|{{ ('<a>'|safe) ~ '<b>' }}|{{ ('<a>'|safe) + '<b>' }}|{{ '<a>'|safe|e }}",
    "{{ 'a b&c'|urlencode }} {{ {'a':'x y','b':1}|urlencode }} {{ [('a',1),('b','é')]|urlencode }} {{ '/path?q=1'|urlencode }}",
    "{{ 'see http://example.com and www.foo.org or mail@x.com'|urlize }}|{{ 'http://example.com/very/long/path'|urlize(15) }}|{{ 'https://a.b'|urlize(nofollow=true, target='_blank') }}",
    "{{ '%s-%s'|format('a', 'b') }} {{ '%(x)s'|format(x=1) }}",
    "{{ 1000|filesizeformat }} {{ 1|filesizeformat }} {{ 999|filesizeformat }} {{ 1500000|filesizeformat }} {{ 1024|filesizeformat(true) }} {{ 1e30|filesizeformat }}",
    "{{ {'a':1}|xmlattr }}|{{ {'a':'<x>', 'b': none, 'c': true}|xmlattr(false) }}",
]: C(t, {"l": ["x", "y"]})

# ---- numeric filters ----
for t in [
    "{{ -3|abs }} {{ (-3.5)|abs }} {{ '42'|int }} {{ '4.7'|int }} {{ 'x'|int }} {{ 'x'|int(7) }} {{ '0x1A'|int(0, 16) }} {{ 'ff'|int(base=16) }} {{ 3.9|int }} {{ true|int }} {{ none|int }}",
    "{{ '3.5'|float }} {{ 'x'|float }} {{ 2|float }} {{ 'inf'|float }} {{ 'nan'|float }} {{ '1e3'|float }}",
    "{{ 2.5|round }} {{ 3.5|round }} {{ 2.675|round(2) }} {{ 2.1|round(0, 'ceil') }} {{ 2.9|round(method='floor') }} {{ 5|round }} {{ 1234|round(-2) }} {{ 15|round(-1) }}",
    "{{ [3,1,2]|sum }} {{ [1.5,2]|sum }} {{ [{'v':1},{'v':2}]|sum(attribute='v') }} {{ [[1],[2]]|sum(start=[]) }} {{ []|sum }}",
    "{{ [3,1,2]|max }} {{ [3,1,2]|min }} {{ ['B','a','C']|max }} {{ ['B','a','C']|max(true) }} {{ []|max }}|{{ [{'n':2},{'n':5}]|max(attribute='n') }}",
    "{{ 7 is odd }} {{ 7 is even }} {{ 9 is divisibleby 3 }} {{ 9 is divisibleby(2) }} {{ 1 is number }} {{ 1.5 is float }} {{ 1 is integer }} {{ true is integer }} {{ true is boolean }} {{ none is none }}",
]: C(t)

# ---- sequence filters ----
for t in [
    "{{ l|first }} {{ l|last }} {{ []|first }}|{{ l|length }} {{ l|count }} {{ l|list }} {{ l|join(',') }} {{ l|reverse|list }} {{ l|sort }} {{ l|sort(reverse=true) }} {{ l|unique|list }}",
    "{{ ['b','A','a','C']|sort }} {{ ['b','A','a','C']|sort(case_sensitive=true) }} {{ ['b','A','a']|unique|list }} {{ ['b','A','a']|unique(true)|list }}",
    "{{ d|sort(attribute='n') }} {{ d|sort(attribute='n,s') }} {{ d|map(attribute='s')|list }} {{ d|map(attribute='z', default='-')|list }} {{ d|selectattr('n','gt',1)|list }} {{ d|rejectattr('n','eq',1)|list }} {{ d|selectattr('flag')|list }} {{ d|map(attribute='s')|join('|') }}",
    "{{ l|map('upper')|list }} {{ l|select('equalto','b')|list }} {{ l|reject('equalto','b')|list }} {{ [0,1,'',2,none]|select|list }} {{ [1,2,3,4]|select('odd')|list }} {{ [1,2,3]|map('string')|join }}",
    "{{ l|batch(2)|list }} {{ l|batch(2, 'X')|list }} {{ [1,2,3,4,5]|slice(2)|list }} {{ [1,2,3,4,5]|slice(3, 0)|list }}",
    "{% for g in d|groupby('n') %}[{{ g.grouper }}:{{ g.list|map(attribute='s')|join }}]{% endfor %}{{ d|groupby('n') }}",
    "{% for k, v in {'b':1,'A':2,'a':3}|dictsort %}{{ k }}={{ v }};{% endfor %}|{{ {'b':1,'a':3}|dictsort(by='value', reverse=true) }}|{{ {'x':1}|items|list }}|{{ none|items|list }}",
    "{{ l|map('upper') }}", "{{ l|select }}", "{{ (l|map('upper'))|length }}", "{{ l|reverse }}", "{{ {'a':1}|items }}", "{{ l|unique }}", "{{ range(3) }} {{ range(1,10,3)|list }} {{ range(3)|length }} {{ range(5)[1:3] }}",
    "{{ l|random in l }}", "{{ l|pprint }}", "{{ d|pprint }}", "{{ {'k': 'v'*50, 'k2': ['x'*30, 'y'*30, {'z': 1}]}|pprint }}",
    "{{ l|string }} {{ 1|string }} {{ none|string }} {{ l|attr('count') }} {{ l|attr('nope') }}|{{ d[0]|attr('n') }}|",
]: C(t, {"l": ["a", "b", "c"], "d": [{"n": 2, "s": "x", "flag": True}, {"n": 1, "s": "y"}, {"n": 2, "s": "z", "flag": 0}]})

# ---- default / undefined ----
for t in [
    "{{ x|default('d') }} {{ x|d('d') }} {{ ''|default('d') }} {{ ''|default('d', true) }} {{ none|default('d') }} {{ none|default('d', true) }}",
    "{{ x is defined }} {{ x is undefined }} {{ y is defined }} {{ y.z is defined }} {{ y.a is defined }} {{ y['a'] is none }}",
    "{{ x }}|{{ x|length }}|{{ x|list }}|{{ x|string }}|{% for i in x %}no{% else %}empty{% endfor %}|{{ 'a' in x }}|{{ x == x }}|{{ not x }}",
    "{{ x + 1 }}", "{{ x.a }}", "{{ x.a.b }}", "{{ y.a.b }}", "{{ y.q }}", "{{ y[0] }}", "{{ x() }}", "{{ x|upper }}", "{{ x ~ 'a' }}",
    "{{ x|int }}", "{{ x|join }}", "{{ x|trim }}", "{{ x|tojson }}", "{{ x[0] }}", "{{ y.a.missing }}", "{{ [1][5] }}|{{ 'abc'.missing }}|{{ none.x }}|",
    "{{ none.x.y }}", "{{ 1 + 'a' }}", "{{ 'a' + 1 }}", "{{ 'a' - 1 }}", "{{ [1] + 'a' }}", "{{ 1 < 'a' }}", "{{ none < 1 }}", "{{ {} < {} }}", "{{ 1/0 }}", "{{ 1//0 }}", "{{ 1%0 }}", "{{ 1.0/0 }}",
    "{{ -'a' }}", "{{ 'a'[5] }}", "{{ {}['k'] }}|", "{{ 5 in 5 }}", "{{ 1 in 'abc' }}", "{{ [1,2] < [1,3] }} {{ (1,'a') < (1,'b') }} {{ 'a' < 'b' }} {{ true < 2 }}",
    "{{ raise_exception('boom') }}", "line1\n{{ raise_exception('on line 2') }}", "{% if true %}\n\n{{ x.y.z }}{% endif %}",
]: C(t, {"y": {"a": None}})

# ---- tests ----
for t in [
    "{{ 'a' is string }} {{ 1 is string }} {{ {} is mapping }} {{ [] is mapping }} {{ [] is sequence }} {{ 'a' is sequence }} {{ {} is sequence }} {{ 1 is sequence }} {{ [] is iterable }} {{ 'a' is iterable }} {{ 1 is iterable }} {{ x is iterable }}",
    "{{ 'abc' is lower }} {{ 'ABC' is upper }} {{ 1 is callable }} {{ range is callable }} {{ 'upper' is filter }} {{ 'odd' is test }} {{ 'nope' is filter }} {{ 1 is in [1] }} {{ 1 is eq 1 }} {{ 2 is gt 1 }} {{ 2 is ge 2 }} {{ 1 is lt 2 }} {{ 1 is le 0 }} {{ 1 is ne 1 }} {{ 1 is equalto 1 }} {{ 1 is greaterthan 0 }} {{ 1 is lessthan 0 }}",
    "{{ 1 is sameas 1 }} {{ none is sameas none }} {{ [] is sameas [] }} {{ l is sameas l }} {{ true is true }} {{ 1 is true }} {{ false is false }} {{ 0 is false }} {{ '<'|safe is escaped }} {{ '<' is escaped }}",
    "{{ 1 is not none }} {{ x is not defined }} {{ 1 is nosuchtest }}", "{% if 1 is nosuchtest %}a{% endif %}", "{{ 1 is defined is defined }}",
]: C(t, {"l": [1]})

# ---- control flow / scoping ----
for t in [
    "{% set x = 0 %}{% for i in range(3) %}{% set x = x + 1 %}{{ x }}{% endfor %}|{{ x }}",
    "{% set ns = namespace(x=0) %}{% for i in range(3) %}{% set ns.x = ns.x + i %}{% endfor %}{{ ns.x }}|{{ ns }}",
    "{% for i in range(3) %}{% if i == 1 %}{% set y = 'one' %}{% endif %}{{ y }},{% endfor %}",
    "{% if true %}{% set z = 5 %}{% endif %}{{ z }}",
    "{{ a }}{% set a = 1 %}{{ a }}",
    "{% for i in range(2) %}{{ q }}{% set q = i %}{% endfor %}",
    "{% for i in [1,2,3] %}{{ loop.index }}{{ loop.index0 }}{{ loop.revindex }}{{ loop.revindex0 }}{{ loop.first }}{{ loop.last }}{{ loop.length }};{% endfor %}",
    "{% for i in [1,2,3] %}{{ loop.previtem }}-{{ loop.nextitem }}-{{ loop.cycle('a','b') }}-{{ loop.changed(i > 1) }};{% endfor %}",
    "{% for i in [1,2,3] if i != 2 %}{{ i }}{{ loop.index }}{{ loop.last }};{% endfor %}",
    "{% for i in [] %}x{% else %}none{% endfor %}|{% for i in [1] if false %}x{% else %}filtered{% endfor %}",
    "{% for a, b in [(1,2),(3,4)] %}{{ a }}{{ b }}{% endfor %}|{% for k, v in {'x':1}.items() %}{{ k }}{{ v }}{% endfor %}|{% for c in 'ab' %}{{ c }}{% endfor %}|{% for k in {'p':1,'q':2} %}{{ k }}{% endfor %}",
    "{% for a, b in [(1,2,3)] %}{% endfor %}", "{% for a, b in [1] %}{% endfor %}", "{% for i in 5 %}{% endfor %}", "{% for i in none %}{% endfor %}",
    "{% for i in range(10) %}{% if i == 2 %}{% continue %}{% endif %}{% if i == 5 %}{% break %}{% endif %}{{ i }}{% endfor %}",
    "{% for i in [1,2] %}{% for j in [3,4] %}{{ loop.index }}{{ i }}{{ j }} {% endfor %}{{ loop.index }}|{% endfor %}",
    "{% for item in tree recursive %}{{ item.name }}{% if item.children %}[{{ loop(item.children) }}]{% endif %}{{ loop.depth }}{% endfor %}",
    "{% for i in range(3) %}{{ loop }}{% endfor %}", "{{ loop }}", "{% for loop in [1] %}{% endfor %}", "{% for i in [1] %}{{ i }}{% endfor %}{{ i }}",
    "{% set a, b = 1, 2 %}{{ a }}{{ b }}", "{% set a, b = [1] %}", "{% set t = 1, 2 %}{{ t }}", "{% set x %}inner {{ 1 }}{% endset %}[{{ x }}]", "{% set x | upper %}abc{% endset %}{{ x }}",
    "{% with a = 1, b = 2 %}{{ a + b }}{% endwith %}{{ a }}", "{% with %}{% set w = 1 %}{{ w }}{% endwith %}{{ w }}",
    "{% macro m(a, b=2) %}{{ a }}-{{ b }}{% endmacro %}{{ m(1) }} {{ m(1, 3) }} {{ m(b=5, a=4) }} {{ m }}",
    "{% macro m(a) %}{{ varargs }}{{ kwargs }}{% endmacro %}{{ m(1, 2, 3, x=4) }}",
    "{% macro m(a) %}{{ a }}{% endmacro %}{{ m(1, 2) }}", "{% macro m(a) %}{{ a }}{% endmacro %}{{ m(z=1) }}", "{% macro m(a) %}[{{ a }}]{% endmacro %}{{ m() }}",
    "{% macro m() %}<{{ caller() }}>{% endmacro %}{% call m() %}inside{% endcall %}",
    "{% macro m() %}{% for i in range(2) %}{{ caller(i) }}{% endfor %}{% endmacro %}{% call(x) m() %}[{{ x }}]{% endcall %}",
    "{% set g = 'G' %}{% macro m() %}{{ g }}{% endmacro %}{% set g = 'H' %}{{ m() }}",
    "{% macro m() %}{% set inner = 1 %}{{ inner }}{% endmacro %}{{ m() }}{{ inner }}",
    "{% macro outer() %}{% macro inner() %}in{% endmacro %}{{ inner() }}{% endmacro %}{{ outer() }}",
    "{% macro m(x) %}{{ x }}{% endmacro %}{{ m.name }} {{ m.arguments }} {{ m.catch_kwargs }}",
    "{% filter upper %}hello {{ 'x' }}{% endfilter %}", "{% filter replace('a', 'b') %}aaa{% endfilter %}",
    "{% if 0 %}a{% elif 1 %}b{% else %}c{% endif %}{% if none %}x{% elif false %}y{% endif %}",
    "{% set c = cycler('a','b') %}{{ c.next() }}{{ c.next() }}{{ c.next() }}{{ c.current }}{% set j = joiner('|') %}{{ j() }}a{{ j() }}b",
    "{{ dict(a=1, b=2) }} {{ dict([('x', 1)]) }} {{ dict.fromkeys(['a','b'], 0) }} {{ dict({'a':1}, c=3) }}",
    "{{ namespace(_x=1) }}", "{% set ns = namespace() %}{% set ns._y = 1 %}", "{% set ns = 1 %}{% set ns.a = 2 %}", "{% set ns = namespace(a=1) %}{{ ns.b }}|{{ ns['a'] }}|{{ ns.a }}",
    "{{ range(100001)|length }}", "{{ range(3, 0, -1)|list }}", "{{ range(0) }}", "{{ range(1, 5) }}", "{{ range(1, 5, 2) }}",
    "{% print 1, 2 %}", "{% do 1 %}", "{% foo %}", "{% if true %}", "{% for %}", "{% endif %}", "{{ 1 +  }}", "{{ (1 }}", "{{ 1 ) }}", "{{ [1, 2 }}", "{{ 'abc }}", "{# no end", "{% raw %}abc",
    "{{ }}", "{{ a.1 }}", "{{ a.'x' }}", "{% set 1 = 2 %}", "{% macro m(a=1, b) %}{% endmacro %}", "{{ 1 is }}", "{{ x is defined is defined }}", "{{ f(a=1, 2) }}", "{{ f(*a, *b) }}",
    "{% if true %}{% endfor %}", "{% for i in x %}{% endif %}", "line\n{% if x %}\n{% else %}\n{% elif y %}{% endif %}", "{{ 1 | }}", "{{ x|nosuchfilter }}", "{% if 0 %}{{ x|nosuchfilter }}{% endif %}ok",
    "{% if true %}{{ x|nosuchfilter }}{% endif %}", "{% break %}", "{% block b %}B{% endblock %}", "{% extends 'x' %}", "{% include 'x' %}", "{% import 'x' as y %}",
    "{% autoescape true %}{{ '<a>' }}{% endautoescape %}", "{{ caller }}", "{{ self }}", "{{ x.__class__ }}", "{{ ''.format }}", "{{ x is }}",
    "{% generation %}gen {{ 1 }}{% endgeneration %}after", "{%- generation -%}  g  {%- endgeneration -%}",
    "{{ strftime_now('%Y') | length }}", "{{ 'x' is string and 1 }}", "{{ -1|abs }} {{ - 1 }} {{ +1 }} {{ not not 1 }} {{ -x }}",
    "{{ [1,2,3][1:] | join(',') }}", "{{ {'a': 1}['a'] }} {{ {'a': {'b': 2}}.a.b }}", "{{ [[1,2],[3]]|map('length')|list }}", "{{ x.y if x is defined else 'no' }}",
    "{{ 'a' if x else 'b' }}", "{{ 'abc'[0] == 'a' }}", "{{ 1 == true }} {{ 0 == false }} {{ 1.0 == true }} {{ {1: 'a'}[true] }} {{ {true: 'a', 1: 'b'} }} {{ [1, 1.0, true]|unique|list }}",
]: C(t, {"tree": [{"name": "a", "children": [{"name": "b", "children": []}]}, {"name": "c"}]})

# ---- tojson ----
for t in [
    "{{ v|tojson }}", "{{ v|tojson(indent=2) }}", "{{ v|tojson(indent='\\t') }}", "{{ v|tojson(separators=(',', ':')) }}", "{{ v|tojson(sort_keys=true) }}",
    "{{ v|tojson(ensure_ascii=true) }}", "{{ (1,2)|tojson }}", "{{ {1: 'a', true: 'b', none: 'c', 1.5: 'd'}|tojson }}", "{{ (1.0/3)|tojson }}", "{{ 'inf'|float|tojson }}", "{{ 'nan'|float|tojson }}",
    "{{ namespace(a=1)|tojson }}", "{{ x|tojson }}", "{{ range(3)|tojson }}", "{{ ('<a>'|safe)|tojson }}", "{{ [] |tojson(indent=2) }}{{ {}|tojson(indent=2) }}", "{{ v|tojson(indent=0) }}",
    "{{ 10**20|tojson }} {{ 1e16|tojson }} {{ -0.0|tojson }}", "{{ {'a': [1, {'b': none}]}|tojson(indent=2) }}",
]: C(t, {"v": {"b": 1, "a": "é\u2028<&>'\"\\\n", "c": [1.5, True, None, {"d": []}], "e": 1e100}})

json.dump(cases, open(sys.argv[1], "w"), ensure_ascii=False, indent=1)
print(len(cases))
