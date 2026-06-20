# Contributing to AI-Safe Plugin

Thank you for taking the time to contribute. AI-Safe Plugin is a privacy tool — contributions that strengthen security, broaden PII coverage, or improve user experience are especially welcome.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Branching & Commits](#branching--commits)
- [Pull Request Process](#pull-request-process)
- [Reporting Bugs](#reporting-bugs)
- [Requesting Features](#requesting-features)
- [Security Vulnerabilities](#security-vulnerabilities)

---

## Code of Conduct

Be respectful. Harassment, discrimination, or hostile behaviour of any kind will not be tolerated.

---

## Getting Started

1. Fork the repository and clone your fork.
2. Follow the [Development Setup](DEVELOPMENT.md) guide.
3. Pick an open issue labelled `good first issue` or `help wanted`.
4. Comment on the issue to claim it before starting work.

---

## Development Setup

See [DEVELOPMENT.md](DEVELOPMENT.md) for the full step-by-step guide including Python server setup, Chrome sideload instructions, and hot-reload tips.

---

## Branching & Commits

- Branch from `main`: `git checkout -b feat/my-feature` or `fix/my-bug`.
- Use [Conventional Commits](https://www.conventionalcommits.org/):
  - `feat:` — new feature
  - `fix:` — bug fix
  - `perf:` — performance improvement
  - `refactor:` — code change that is neither fix nor feature
  - `docs:` — documentation only
  - `chore:` — tooling, build, CI
- Keep commits atomic and descriptive.

---

## Pull Request Process

1. Ensure your branch is up to date with `main` before opening a PR.
2. Fill in the PR template completely.
3. Add or update tests if applicable.
4. Run `node --check content.js background.js popup.js` to validate JS syntax.
5. Self-review your diff before requesting a review.
6. At least one maintainer approval is required to merge.

---

## Reporting Bugs

Use the [Bug Report](.github/ISSUE_TEMPLATE/bug_report.md) template. Include:
- Browser version and OS.
- Steps to reproduce.
- Expected vs actual behaviour.
- Console errors (F12 → Console).

---

## Requesting Features

Use the [Feature Request](.github/ISSUE_TEMPLATE/feature_request.md) template. Explain the problem the feature solves, not just the solution.

---

## Security Vulnerabilities

**Do not open a public issue for security vulnerabilities.** See [SECURITY.md](SECURITY.md) for responsible disclosure instructions.
