#!/usr/bin/env python3
"""
backend/url_fetch.py turns a fetched page into Markdown for the AI context with markdownify
(markdownify(html, heading_style="ATX"), then a squeeze of blank lines and a strip). This pins that output at the
version requirements.lock holds - 1.2.3 since the 3.4.9 major batch, 0.14.1 before - on representative HTML:
headings, links and images, nested lists, inline and block code, tables with and without <thead>, nested tags,
scripts / styles / nav / header / footer removed, escaping, line breaks and rules, a definition list, entities.

0.14.1 -> 1.2.3 changed exactly two things on this corpus, both kept (they are improvements): a <pre> whose text
ends with a newline no longer gets a blank line before its closing fence, and <dl>/<dt>/<dd> renders as a
definition list ("Term" / ":   Definition") instead of the words run together. Everything else is identical.
(The 1.0.0 breaking change - the convert_<tag>() function interface - does not reach us: no custom converter.)

Also the route itself (/api/fetch-url, the network replaced by a stub of safe_url.safe_request): the <title>,
the <main> element chosen over the page body, the stripped elements, the newline squeeze and the 50 000
character truncation marker.

Run: backend/venv/bin/python tests/markdownify_output.test.py
"""
import os
import re
import sys
from importlib import metadata

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BACKEND = os.path.join(REPO, 'backend')
sys.path.insert(0, BACKEND)
os.environ.setdefault('APP_AUTH_TOKEN', 'test-token')

try:
    from bs4 import BeautifulSoup
    from flask import Flask
    from markdownify import markdownify as md
except ImportError:
    print('Missing dependency. Run with the backend venv: backend/venv/bin/python tests/markdownify_output.test.py')
    sys.exit(1)

results = []


def check(name, passed, detail=''):
    results.append((name, passed))
    print(f"{'PASS' if passed else 'FAIL'} - {name}{f' ({detail})' if detail else ''}")


locked = re.search(r'^markdownify==([\d.]+)', open(os.path.join(BACKEND, 'requirements.lock'), encoding='utf-8').read(), re.M)
installed = metadata.version('markdownify')
check(f'the installed markdownify ({installed}) is the locked one', locked is not None and installed == locked.group(1), f'lock {locked and locked.group(1)}')


def convert(html):
    """Exactly url_fetch.py's steps after the fetch."""
    soup = BeautifulSoup(html, 'html.parser')
    for s in soup(['script', 'style', 'nav', 'footer', 'header']):
        s.decompose()
    text = md(str(soup), heading_style='ATX')
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


CASES = [
    ('headings and paragraphs (ATX headings, strong / em)',
     '<h1>Title</h1><p>Intro <strong>bold</strong> and <em>em</em> text.</p><h2>Second</h2><p>More.</p><h3>Third</h3>',
     '# Title\n\nIntro **bold** and *em* text.\n\n## Second\n\nMore.\n\n### Third'),
    ('links and images (query string kept, alt and title)',
     '<p>See <a href="https://example.com/docs?a=1&amp;b=2">the docs</a> and <img src="https://example.com/x.png" alt="An image" title="T"> here.</p>',
     'See [the docs](https://example.com/docs?a=1&b=2) and ![An image](https://example.com/x.png "T") here.'),
    ('nested lists (bullets alternate, numbers kept)',
     '<ul><li>one</li><li>two <ul><li>nested a</li><li>nested b</li></ul></li></ul><ol><li>first</li><li>second</li></ol>',
     '* one\n* two\n  + nested a\n  + nested b\n\n1. first\n2. second'),
    ('inline code and fenced blocks (a trailing newline in <pre> adds no blank line before the closing fence - 1.x)',
     '<p>Run <code>ls -la</code> now.</p><pre><code class="language-bash">#!/bin/bash\necho "hi"\n</code></pre><pre>plain pre\n  indented</pre>',
     'Run `ls -la` now.\n\n```\n#!/bin/bash\necho "hi"\n```\n\n```\nplain pre\n  indented\n```'),
    ('a table with <thead> (entities decoded)',
     '<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>a</td><td>1</td></tr><tr><td>b</td><td>2 &amp; 3</td></tr></tbody></table>',
     '| Name | Value |\n| --- | --- |\n| a | 1 |\n| b | 2 & 3 |'),
    ('a table whose first row is the header without <thead>',
     '<table><tr><th>H1</th><th>H2</th></tr><tr><td>x</td><td>y</td></tr></table>',
     '| H1 | H2 |\n| --- | --- |\n| x | y |'),
    ('nested inline and block tags (div / section flattened, blockquote kept, relative link kept)',
     '<div><section><p>Outer <span>inner <b>deep</b></span> text</p><blockquote><p>quoted <a href="/rel">rel link</a></p></blockquote></section></div>',
     'Outer inner **deep** text\n\n> quoted [rel link](/rel)'),
    ('scripts and styles removed, noscript text kept',
     '<style>p{color:red}</style><p>Visible</p><script>alert(1)</script><noscript>no js</noscript>',
     'Visible\n\nno js'),
    ('nav, header and footer removed (url_fetch strips them before converting)',
     '<header>Site</header><nav><a href="/">Home</a></nav><main><p>Body</p></main><footer>(c)</footer>',
     'Body'),
    ('escaping: asterisks and underscores escaped, brackets and list-like text left alone',
     '<p>Stars * and _underscores_ and [brackets] and 1. numbered-looking and # hash</p>',
     'Stars \\* and \\_underscores\\_ and [brackets] and 1. numbered-looking and # hash'),
    ('line breaks (two trailing spaces) and a rule',
     '<p>line one<br>line two</p><hr><p>after rule</p>',
     'line one  \nline two\n\n---\n\nafter rule'),
    ('a definition list (rendered since 1.0; 0.14 ran the words together)',
     '<dl><dt>Term</dt><dd>Definition</dd></dl>',
     'Term\n:   Definition'),
    ('entities and non-breaking spaces',
     '<p>caf&eacute; &nbsp; &lt;tag&gt; &quot;quoted&quot;</p>',
     'café \xa0 <tag> "quoted"'),
]
for name, html, expected in CASES:
    got = convert(html)
    check(name, got == expected, repr(got)[:200])

# --- the route, with the network stubbed ------------------------------------
import safe_url as su  # noqa: E402
import url_fetch as uf  # noqa: E402

PAGE = ('<html><head><title>Doc Title</title><style>.x{}</style></head><body><header>Top</header><nav>Menu</nav>'
        '<main><h1>Heading</h1><p>Para with <code>code</code>.</p>\n\n\n\n<ul><li>a</li></ul></main>'
        '<aside>side</aside><footer>Bottom</footer><script>evil()</script></body></html>')
served = {'html': PAGE}
real_request, real_validate = su.safe_request, su.validate_url
su.validate_url = lambda url, **kw: (None, ['203.0.113.1'])   # the route calls it first; the stub stands in for DNS
su.safe_request = lambda method, url, **kw: su.SafeResponse(200, 'OK', {'content-type': 'text/html; charset=utf-8'}, served['html'].encode('utf-8'), url)
try:
    app = Flask(__name__)
    app.register_blueprint(uf.url_fetch)
    client = app.test_client()
    r = client.post('/api/fetch-url', json={'url': 'https://docs.example/page'})
    body = r.get_json() or {}
    check('/api/fetch-url answers 200 with content, title and url', r.status_code == 200 and set(body) >= {'content', 'title', 'url'} and body['title'] == 'Doc Title' and body['url'] == 'https://docs.example/page', body)
    check('the <main> element is converted, nav / header / footer / script / style and the aside are not',
          body.get('content') == '# Heading\n\nPara with `code`.\n\n* a', repr(body.get('content')))
    served['html'] = '<html><head><title>Long</title></head><body><p>' + ('word ' * 20000) + '</p></body></html>'
    r = client.post('/api/fetch-url', json={'url': 'https://docs.example/long'})
    content = (r.get_json() or {}).get('content', '')
    check('a long page is cut at 50 000 characters with the truncation marker', r.status_code == 200 and content.endswith('[Content truncated due to length...]') and len(content) < 50100, len(content))
finally:
    su.safe_request, su.validate_url = real_request, real_validate

failed = [n for n, p in results if not p]
print(f'\nSUMMARY: {len(results) - len(failed)}/{len(results)} passed')
sys.exit(1 if failed else 0)
