/**
 * Synthetic markdown documents for the PDF export tests. Everything below
 * is made up (example hosts, placeholder prose); nothing comes from a real
 * system or customer document.
 */

/** 2x2 PNG (4 opaque pixels) as a data: URL - the image pipeline's input. */
export const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVQIW2P8z8DwnwEIGBgYGP4DAB8aA/3qoKqxAAAAAElFTkSuQmCC';

const para = (n) => `Paragraph ${n}: placeholder prose about an example-daemon on example-host-${n} that restarts every ${n} minutes and writes to /var/log/example.log.`;

/**
 * One document exercising every export feature: header/footer bands, ToC
 * with internal links, external + mailto links, highlighted code, inline
 * code, a table, nested lists, an image, two Mermaid diagrams (one invalid),
 * a form control, [[pagebreak]], [[blankpage]] and [[centerpage]].
 */
export const FULL_FEATURE_DOC = `[[header]]
**Example Runbook** · internal copy
[[/header]]

[[footer]]
Generated for the example team
[[/footer]]

[[centerpage]]
# Example Runbook

Cover page for the export tests
[[/centerpage]]

[[toc]]

## Table of Contents

- [Overview](#overview)
- [Procedure](#procedure)
  - [Diagrams](#diagrams)
- [Appendix](#appendix)
[[/toc]]

## Overview

${para(1)} See [the vendor docs](https://docs.example.com/runbook?id=1) or write to [the team](mailto:team@example.com). Jump to [Appendix](#appendix).

${para(2)} Inline code like \`systemctl restart example\` and **bold text** and *emphasis*.

| Service | State | Restarts |
| --- | --- | --- |
| example-a.service | active | 3 |
| example-b.service | failed | 12 |

- First item
  - Nested item one
  - Nested item two
- Second item
1. Ordered one
2. Ordered two

![Example image](${TINY_PNG})

[[checkbox:ack:Acknowledged]]

[[pagebreak]]

## Procedure

\`\`\`python
def restart(service):
    """Restart one example service."""
    return run(["systemctl", "restart", service])
\`\`\`

${para(3)}

${para(4)}

### Diagrams

\`\`\`mermaid
graph TD
  Intake[Intake queue] --> Triage[Triage]
  Triage --> Escalated[Escalated]
\`\`\`

\`\`\`mermaid
graph TD
  Broken --> boom oops --> [[
\`\`\`

[[blankpage]]

## Appendix

${Array.from({ length: 14 }, (_, i) => para(10 + i)).join('\n\n')}
`;

/** A short document without any directive: single page, links only. */
export const SIMPLE_DOC = `# Simple note

${para(1)}

A [link](https://example.com/simple) and \`code\`.
`;
