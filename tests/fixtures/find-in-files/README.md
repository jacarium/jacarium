Synthetic fixtures for the Documents "Find in Files" tests
(tests/find-in-files-search.test.mjs, tests/documents-find-in-files.test.mjs).
Nothing here comes from a real database; every title, category and line
was invented for the tests.

- documents.json   four documents: two in "Runbooks" (bash fence, an
                   indented line, a line with the token three times, a
                   "widgets"/"WIDGET_OK" pair for the Words / Match Case
                   toggles), one in "Notes" (a CRLF line), and one without a
                   category (lands in General). The token "widget" appears on
                   known lines so counts can be asserted exactly.
