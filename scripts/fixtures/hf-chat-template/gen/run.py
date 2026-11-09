"""Render jinja cases with the transformers chat-template environment and record results."""
import json, sys, traceback, re, warnings
warnings.simplefilter("ignore")
from transformers.utils.chat_template_utils import _compile_jinja_template, render_jinja_template
import jinja2

ADDR = re.compile(r" at 0x[0-9a-f]+")

def tpl_lineno(e):
    if isinstance(e, jinja2.TemplateSyntaxError):
        return e.lineno
    ln = None
    for fr in traceback.extract_tb(e.__traceback__):
        if fr.filename == "<template>":
            ln = fr.lineno
    return ln

def run_case(c):
    try:
        if c.get("mode") == "vars":
            from jinja2 import meta as jmeta
            t = _compile_jinja_template(c["template"])
            return {"vars": sorted(jmeta.find_undeclared_variables(t.environment.parse(c["template"])))}
        if c.get("mode") == "select":
            from transformers.tokenization_utils_base import PreTrainedTokenizerBase
            class T: pass
            o = T(); o.chat_template = c["templates"]
            return {"out": PreTrainedTokenizerBase.get_chat_template(o, c.get("case"), c.get("tools"))}
        if c.get("chat"):
            ch = c["chat"]
            kw = dict(ch.get("kwargs") or {})
            if ch.get("continue_final_message") and ch.get("add_generation_prompt"):
                raise ValueError("continue_final_message and add_generation_prompt are not compatible. Use continue_final_message when you want the model to continue the final message, and add_generation_prompt when you want to add a header that will prompt it to start a new assistant message instead.")
            if not ch["messages"]:
                raise ValueError("Cannot apply chat template to an empty conversation. Provide at least one message.")
            out, idx = render_jinja_template(
                conversations=[ch["messages"]], tools=ch.get("tools"), documents=ch.get("documents"),
                chat_template=c["template"], add_generation_prompt=ch.get("add_generation_prompt", False),
                continue_final_message=ch.get("continue_final_message", False),
                return_assistant_tokens_mask=bool(c.get("gen")), **kw)
            r = {"out": out[0]}
            if c.get("gen"): r["gen"] = [list(x) for x in idx[0]]
            return r
        t = _compile_jinja_template(c["template"])
        out = t.render(**json.loads(json.dumps(c.get("ctx") or {})))
        return {"out": ADDR.sub(" at 0x0", out)}
    except Exception as e:
        msg = str(e)
        if isinstance(e, jinja2.TemplateSyntaxError):
            msg = e.message
        return {"error": type(e).__name__, "message": ADDR.sub(" at 0x0", msg), "line": tpl_lineno(e)}

if __name__ == "__main__":
    src, dst = sys.argv[1], sys.argv[2]
    cases = json.load(open(src))
    for c in cases:
        c["expected"] = run_case(c)
    json.dump(cases, open(dst, "w"), ensure_ascii=False, indent=1)
    print(len(cases), "cases")
