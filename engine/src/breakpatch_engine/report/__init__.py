"""An exported run report (issue #43): one self-contained HTML file, and JUnit XML.

The app (app/src/lib/report/) and breakpatch-ci (the Team engine) make the same files: the one
template (template.html), filled the same way (render.py, render.ts) from the same view (view.py,
view.ts), checked against the same golden files in tests/fixtures/report/.

    from breakpatch_engine import report
    view = report.build(input)            # view.py's docstring has the input
    html = report.html(view)
    xml = report.junit_xml(view)
"""
from __future__ import annotations

from functools import lru_cache
from importlib import resources

from .images import attach_images, webp_data_uri
from .junit import junit_xml
from .render import render
from .view import all_open, build

__all__ = ["attach_images", "all_open", "build", "html", "junit_xml", "render", "template", "webp_data_uri"]


@lru_cache(maxsize=1)
def template() -> str:
    return resources.files(__package__).joinpath("template.html").read_text(encoding="utf-8")


def html(view: dict) -> str:
    return render(template(), view)
