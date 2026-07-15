# Security Policy

## Supported versions

PauseMesh is an experimental pre-1.0 project. Security fixes are applied to the latest release and
the `main` branch.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Report a vulnerability** flow in the
Security tab. Do not open a public issue with exploit details, tokens, payloads, or personal data.

Include the affected version, impact, reproduction steps, and any suggested mitigation. You can
expect an acknowledgement within seven days.

The bundled HTTP server is a local reference implementation. It does not provide tenant identity,
authorization, TLS termination, rate limiting, or encryption at rest; exposing it directly to the
internet is outside the supported security boundary.
