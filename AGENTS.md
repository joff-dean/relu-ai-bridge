# RELU AI Bridge engineering contract

This repository is an independent implementation. Do not copy, vendor, download, dynamically load, or execute code from Chat On Steroids or another agent project. RELU core is generic and Perfetto is Connector #1. The only supported Perfetto baseline is the official `google/perfetto` `v58.2` tag resolved to `add693d8b338ba9599dbcbc3e300b1ab8c000897`; never replace it with an unverified moving branch.

## Non-negotiable security invariants

- Keep the MCP service loopback-only by default.
- Accept Perfetto WebSocket connections only from exact configured HTTP(S) origins and authenticate the first application message.
- Keep browser `/relu/ws` and native `/relu/desktop/ws` separate. Desktop upgrades must reject every Origin header and bind mutual HMAC to one allowlisted app ID, a stable opaque instance ID, fresh nonces, and the desktop audience.
- Never place bearer tokens, tunnel keys, API keys, credentials, transcripts, local configs, or audit data in Git.
- Preserve canonical path containment, direct-symlink rejection, protected paths, size limits, and atomic edit transactions.
- Command execution must use argument arrays with `shell: false`. Arbitrary commands remain disabled by default.
- Mutating operations must pass the local approval policy. The new-install `trusted_always` policy may auto-authorize only requests that permit an `always` decision; once-only ambiguous-operation reconciliation remains interactive. Manual persistent grants stay scope-limited and locally revocable.
- Do not add telemetry, remote code loading, wildcard extension hosts, or runtime package dependencies without explicit security review.
- Browser content is untrusted input. It cannot approve permissions or expand local capabilities.
- Keep service connector credentials separate from MCP/admin control credentials and from Data Plane API credentials.
- The server registry, never a browser advertisement or model argument, owns capability schemas, effects, origins, endpoints, timeouts, and concurrency.
- Never add arbitrary URL/method/header/script/selector/command proxy capabilities.
- Treat trace metadata, selections, SQL cells, WebSocket messages, imported bundles, and company integration repositories as untrusted input.
- Keep persistent desktop resource bindings separate from execution guards. Legacy browser services without explicit guard fields retain strict whole-context version checks.
- Skills are analysis instructions, not permission sources. Never let Connector data supply runtime prompts, Skill URLs, or approval decisions. Install only manifest-verified regular files from a trusted release without overwriting modified destinations.
- Keep public/external code free of company paths, hostnames, trace data, commit metadata, product names, and company-only adapters.
- Preserve SQL byte/row limits, single-read-statement enforcement, WebSocket message limits, request timeouts, alignment operation limits, and integer-string timestamps.
- Tool arguments are not audited by default because they may contain source code or stdin secrets.

## Required verification

Run syntax checks for `src`, `bin`, `scripts`, extension, and alignment JavaScript, verify the Skill source inventory, then run the complete Node test suite. Build the .NET 8 Desktop Connector solution and run its shared HMAC vector test. Overlay into an exact v58.2 checkout and run the Perfetto UI TypeScript/unit/build checks for plugin or adapter changes. Add regression tests for security-boundary changes.

## Documentation

Update `README.md`, `docs/SECURITY.md`, `docs/TOOLS.md`, and the Korean internal sync guide whenever a network destination, tool, permission scope, protected-path behavior, compatibility baseline, release artifact, or stored-data category changes.
