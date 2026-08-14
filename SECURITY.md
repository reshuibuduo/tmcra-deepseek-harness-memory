# Security policy

## Supported version

Only the latest technical-preview release is supported.

## Reporting a vulnerability

Use this repository's private vulnerability-reporting form under **Security**. Do not include credentials, private memory content, account identifiers, or production URLs in a public issue.

Revoke any exposed TMCRA token immediately. Tokens used by this plugin should be short-lived, least-privilege credentials limited to `memory:read` and `memory:write`.

## Public boundary

This repository contains the DeepSeek Harness adapter. The hosted TMCRA API, account and billing services, control plane, databases, deployment configuration, and production memory algorithms are outside this repository.
