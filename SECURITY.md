# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub: **Security → Report a vulnerability** on
<https://github.com/wyzz973/web-research-mcp>. If that button is not shown, open an issue that only
says a security contact is needed, without any detail, and a maintainer will reach out.

Include what you sent, what came back, and the version (`web-research --version`). A report that
comes with a failing test or a minimal page that triggers the problem is the fastest to fix.

## What counts

This tool downloads pages chosen by a language model and hands their text back to that model, so
the following are in scope and treated as vulnerabilities:

- **Request forgery.** Any way to make `web_fetch` connect to a private, loopback, link-local, or
  cloud-metadata address, including through redirects, DNS rebinding, IPv6 forms, or unusual URL
  syntax.
- **Envelope escape.** Page or search-result text that ends an `untrusted` block early, forges a
  header or footer line written by the server, or otherwise appears to the model as server output.
- **Resource exhaustion** from a single hostile page: unbounded memory, CPU, disk, or time.
- **Secret exposure.** API keys reaching logs, error messages, tool output, stored state, or Git.
- **Writes outside the state directory.**

Out of scope: a model that decides on its own to fetch a URL containing data it should not send.
The default configuration cannot prevent that; restrict the tool at the harness level if it matters
in your setting (see the Safety section of the README).

## Supported versions

Only the latest release of the 2.x line receives fixes. The 0.x line (tag `legacy-v0.5.0`) is
archived.
