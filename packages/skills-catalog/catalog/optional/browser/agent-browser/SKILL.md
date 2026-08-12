---
name: agent-browser
description: Control Chrome from the terminal to reproduce UI flows and capture screenshots, console errors, failed requests, traces, accessibility findings, and Web Vitals.
key: paperclipai/optional/browser/agent-browser
recommendedForRoles:
  - qa
  - engineer
  - researcher
tags:
  - browser
  - cli
  - visual-testing
  - verification
---

# Agent Browser

Use the installed `agent-browser` CLI for browser-based verification. Paperclip runs it with an
isolated session per agent so parallel agents do not share tabs or browser state.

Before the first browser command in a run, load the CLI-matched instructions instead of guessing
flags:

```bash
agent-browser skills get core --full
```

## Core workflow

```bash
agent-browser open http://localhost:3000
agent-browser set viewport 1366 768
agent-browser snapshot -i
agent-browser click @e1
agent-browser snapshot -i
agent-browser screenshot evidence.png
agent-browser console
agent-browser errors
agent-browser network requests
agent-browser close
```

References such as `@e1` become stale whenever the page changes. Take a new snapshot after
navigation, submit, modal open/close, or any meaningful re-render before interacting again.

Prefer deterministic waits (`wait --text`, `wait --url`, `wait --load networkidle`, or a selector)
over arbitrary sleeps. Use semantic locators or snapshot refs before raw CSS selectors.

## Required evidence for UI acceptance

For every visual test or browser-based test case, record:

- exact URL and viewport;
- precondition and reproduction steps;
- expected and observed result;
- a screenshot for each meaningful final state;
- browser console errors and page errors;
- non-2xx requests relevant to the flow;
- PASS or FAIL for the test case.

Use `trace start`/`trace stop`, `record start`/`record stop`, `a11y`, or `vitals` when the acceptance
criteria require deeper evidence. Store evidence inside the active execution workspace and attach
important deliverables to the Paperclip issue.

## Authentication and safety

- Never put passwords, tokens, cookies, or customer data in commands, screenshots, logs, comments,
  or source files.
- Use a Paperclip secret-backed test account or the CLI auth vault when authentication is required.
- Do not reuse a customer's real authenticated browser profile.
- Do not approve a UI criterion from source inspection alone when an executable environment exists.
- Close the browser at the end of the run. Do not leave background browser sessions as a liveness
  mechanism.

If the browser cannot run, report the concrete command and error. A browser outage does not excuse
an untested visual criterion: add a deterministic component/E2E regression or return the work to
engineering with the missing evidence.
