#!/usr/bin/env python3
"""Convert markdown -> styled HTML -> PDF via WeasyPrint."""
import os, pathlib, markdown
from weasyprint import HTML, CSS as WP_CSS

CSS = """
@page { size: Letter; margin: 0.75in 0.85in; }
html, body {
  font-family: "Helvetica", "Arial", sans-serif;
  font-size: 10.5pt;
  line-height: 1.5;
  color: #1a1a1a;
  margin: 0;
  padding: 0;
}
h1 {
  font-size: 22pt;
  font-weight: 700;
  color: #0a0a0a;
  border-bottom: 2px solid #d97706;
  padding-bottom: 0.3em;
  margin-top: 0;
  margin-bottom: 0.6em;
  page-break-after: avoid;
}
h2 {
  font-size: 14pt;
  font-weight: 700;
  color: #0a0a0a;
  margin-top: 1.5em;
  margin-bottom: 0.4em;
  page-break-after: avoid;
}
h3 {
  font-size: 11.5pt;
  font-weight: 700;
  color: #1a1a1a;
  margin-top: 1.1em;
  margin-bottom: 0.3em;
  page-break-after: avoid;
}
h4 { font-size: 10.5pt; font-weight: 700; color: #1a1a1a; margin-top: 1em; margin-bottom: 0.25em; }
p { margin: 0.5em 0; }
strong { color: #0a0a0a; font-weight: 700; }
hr {
  border: none;
  border-top: 1px solid #d4d4d4;
  margin: 1.4em 0;
}
blockquote {
  border-left: 3px solid #d97706;
  margin: 0.9em 0;
  padding: 0.35em 0.9em;
  background: #fffaf0;
  color: #2a2a2a;
}
code {
  font-family: "Menlo", "Consolas", "Courier New", monospace;
  font-size: 9pt;
  background: #f4f4f4;
  padding: 0.08em 0.3em;
  border-radius: 3px;
  color: #b91c1c;
}
pre {
  background: #f7f7f7;
  border: 1px solid #e5e5e5;
  border-radius: 4px;
  padding: 0.8em 1em;
  page-break-inside: avoid;
  white-space: pre;
  line-height: 1.35;
  margin: 0.9em 0;
  overflow: hidden;
}
pre code {
  background: transparent;
  padding: 0;
  font-size: 8pt;
  color: #1a1a1a;
  white-space: pre;
}
table {
  border-collapse: collapse;
  width: 100%;
  margin: 0.9em 0;
  font-size: 9.5pt;
  page-break-inside: avoid;
}
th {
  background: #fafafa;
  border-bottom: 2px solid #1a1a1a;
  text-align: left;
  padding: 0.45em 0.7em;
  font-weight: 700;
  color: #0a0a0a;
}
td {
  border-bottom: 1px solid #e5e5e5;
  padding: 0.4em 0.7em;
  vertical-align: top;
}
tr:nth-child(even) td { background: #fbfbfb; }
ul, ol { margin: 0.5em 0; padding-left: 1.5em; }
li { margin: 0.22em 0; }
li > p { margin: 0.12em 0; }
td[align="right"], th[align="right"] { text-align: right; }
"""

HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>{title}</title>
</head>
<body>
{body}
</body>
</html>
"""

def convert(md_path, pdf_path):
    src = pathlib.Path(md_path).read_text(encoding="utf-8")
    html_body = markdown.markdown(
        src,
        extensions=["tables", "fenced_code", "sane_lists", "attr_list"],
    )
    title = pathlib.Path(md_path).stem
    html_str = HTML_TEMPLATE.format(title=title, body=html_body)
    HTML(string=html_str).write_pdf(pdf_path, stylesheets=[WP_CSS(string=CSS)])
    print(f"  -> {pdf_path} ({os.path.getsize(pdf_path)} bytes)")

if __name__ == "__main__":
    pairs = [
        ("docs/FOXIFY_PASS_THROUGH_PITCH.md", "docs/pdfs/FOXIFY_PASS_THROUGH_PITCH.pdf"),
        ("docs/FOXIFY_FIXED_PRICE_ANALYSIS.md", "docs/pdfs/FOXIFY_FIXED_PRICE_ANALYSIS.pdf"),
    ]
    for md, pdf in pairs:
        print(f"Converting {md} ...")
        convert(md, pdf)
    print("done")
