# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1   | :x:                |

## Reporting a Vulnerability

Please report security issues privately through
[GitHub Security Advisories](https://github.com/Taxueovo/Sharable-Agent-Crew/security/advisories/new)
("Report a vulnerability") rather than opening a public issue.

When reporting, include:

- The affected version or commit hash
- A description of the vulnerability and its impact
- Steps to reproduce, if possible

We will acknowledge your report within a few business days and keep you updated
as the issue is investigated. Please do not disclose the issue publicly until we
have had a chance to address it.

## Scope

This project connects to external AI services and may read configuration from
environment files. Never commit credentials, API tokens, or internal
infrastructure details to the repository; `.env` files are excluded via
`.gitignore`.
