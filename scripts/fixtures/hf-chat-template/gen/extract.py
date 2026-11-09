import json, os, sys, glob
hub, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
SUF = ('.tokenizer_config.json', '.chat_template.jinja', '.chat_template.json')
repos = set()
for p in glob.glob(hub+'/*'):
    b = os.path.basename(p)
    for s in SUF:
        if b.endswith(s): repos.add(b[:-len(s)])
for r in sorted(repos):
    t = {}
    tc = os.path.join(hub, r+'.tokenizer_config.json')
    if os.path.exists(tc):
        c = json.load(open(tc)).get('chat_template')
        if isinstance(c, str): t['default'] = c
        elif isinstance(c, list):
            for x in c: t[x['name']] = x['template']
    p = os.path.join(hub, r+'.chat_template.json')
    if os.path.exists(p):
        c = json.load(open(p)).get('chat_template')
        if isinstance(c, str): t['processor'] = c
    p = os.path.join(hub, r+'.chat_template.jinja')
    if os.path.exists(p): t['default'] = open(p).read()
    for k, v in t.items():
        open(os.path.join(out, f'{r}__{k}.jinja'), 'w').write(v)
    print(r, list(t))
