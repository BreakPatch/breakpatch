"""Fills the report template (template.html) with a view (view.py): the small subset of Mustache
the template uses, exactly as the app's render.ts does, so both give the same bytes (the golden
file tests/fixtures/report/report.html checks both).

    {{name}}  {{a.b}}  {{.}}      the value, HTML-escaped (& < > " ')
    {{#name}} … {{/name}}         once per item of a list, or once when the value is set
    {{^name}} … {{/name}}         once when the value isn't set (None, False, "", 0, an empty list)
    {{! comment }}                left out

A name is looked up from the innermost section out, stopping at the first object that has the
key (even when its value isn't set). No partials, no unescaped output, no whitespace trimming:
the text between tags is kept exactly.
"""
from __future__ import annotations

import re

TAG = re.compile(r"\{\{!.*?\}\}|\{\{\s*([#^/]?)\s*([A-Za-z0-9_.]+|\.)\s*\}\}", re.S)
_ESCAPES = {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}


class TemplateError(ValueError):
    pass


def escape(s: str) -> str:
    return "".join(_ESCAPES.get(c, c) for c in s)


def parse(template: str) -> list:
    """The template as a tree: text, ("name", key), ("#"|"^", key, children)."""
    root: list = []
    stack: list[tuple[str | None, list]] = [(None, root)]
    pos = 0
    for m in TAG.finditer(template):
        text = template[pos:m.start()]
        if "{{" in text:
            raise TemplateError(f"a tag the report template doesn't know, near {text[text.index('{{'):][:30]!r}")
        if text:
            stack[-1][1].append(text)
        pos = m.end()
        if m.group(0).startswith("{{!"):
            continue
        kind, name = m.group(1), m.group(2)
        if kind in ("#", "^"):
            node = (kind, name, [])
            stack[-1][1].append(node)
            stack.append((name, node[2]))
        elif kind == "/":
            if stack[-1][0] != name:
                raise TemplateError(f"{{{{/{name}}}}} closes {stack[-1][0]!r}")
            stack.pop()
        else:
            stack[-1][1].append(("name", name))
    rest = template[pos:]
    if "{{" in rest:
        raise TemplateError("a tag the report template doesn't know at its end")
    if rest:
        stack[-1][1].append(rest)
    if len(stack) != 1:
        raise TemplateError(f"{{{{#{stack[-1][0]}}}}} isn't closed")
    return root


def is_set(v) -> bool:
    return not (v is None or v is False or v == "" or v == [] or (isinstance(v, (int, float)) and not isinstance(v, bool) and v == 0))


def text_of(v) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def lookup(stack: list, name: str):
    if name == ".":
        return stack[-1]
    first, *rest = name.split(".")
    for ctx in reversed(stack):
        if isinstance(ctx, dict) and first in ctx:
            v = ctx[first]
            for part in rest:
                v = v.get(part) if isinstance(v, dict) else None
            return v
    return None


def _render(nodes: list, stack: list, out: list[str]) -> None:
    for n in nodes:
        if isinstance(n, str):
            out.append(n)
        elif n[0] == "name":
            out.append(escape(text_of(lookup(stack, n[1]))))
        else:
            v = lookup(stack, n[1])
            if n[0] == "^":
                if not is_set(v):
                    _render(n[2], stack, out)
            elif isinstance(v, list):
                for item in v:
                    stack.append(item)
                    _render(n[2], stack, out)
                    stack.pop()
            elif is_set(v):
                stack.append(v if isinstance(v, dict) else stack[-1])
                _render(n[2], stack, out)
                stack.pop()


def render(template: str, view: dict) -> str:
    out: list[str] = []
    _render(parse(template), [view], out)
    return "".join(out)
