# FOR AFTER DIGITAL VAULT

A secure digital legacy and posthumous messaging platform built as a full-stack system with a NestJS backend, Prisma/PostgreSQL data layer, Redis-powered sessions and queue processing, and a Next.js frontend for customer, recipient, trusted-contact, and admin flows.

This repository contains both the application and the supporting docs, environment configuration, and project-level documentation needed to run the platform locally.

## Overview

For After is designed to help customers record messages, memories, and personal wishes for the people they love. Those records can be scheduled for release at a future date or after a verified death event, while also supporting recipient access, trusted contact reporting, and admin review workflows.

The project is split into two main applications:

- `for-after-backend` — NestJS API, PostgreSQL/Prisma, Redis, queue workers, auth flows, and release logic
- `for-after-frontend` — Next.js app with customer dashboard, portals, admin portal, and UX flows

## Architecture

```text
+---------------------+
| for-after-frontend  |
| Next.js + React     |
| Customer UI + Admin/|
| Recipient/Trusted   |
| Contact portals     |
+----------+----------+
           |
           | HTTP + Cookies
           v
+---------------------+
| for-after-backend    |
| NestJS API           |
| Prisma/PostgreSQL    |
| Redis sessions/OTP   |
| BullMQ worker        |
+----------+----------+
           |
           +--> Object storage / media services
           +--> Email delivery providers
           +--> Background release jobs
```

## Key capabilities

- Customer registration and login
- People I Love management
- Trusted Contact management
- Draft messages with schedule logic
- Media upload and private storage handling
- Memory Vault and personal life-story/wishes prompts
- Recipient portal access via OTP-based sessions
- Trusted Contact portal for death report intake
- Death verification workflow with safeguards and review
- Admin portal with MFA, audit logging, and queue monitoring
- Background job processing for message releases and scheduled workflows

## Repo structure

```text
FOR-AFTER-DIGITAL-VAULT/
├── .claude/
├── .postman/
├── .vscode/
├── backblaze/
├── for-after-backend/
│   ├── docs/
│   ├── prisma/
│   ├── src/
│   ├── test/
│   ├── postman/
│   ├── .env.example
│   ├── README.md
│   ├── package.json
│   └── ...
├── for-after-frontend/
│   ├── docs/
│   ├── e2e/
│   ├── public/
│   ├── src/
│   ├── .env.example
│   ├── README.md
│   ├── package.json
│   └── ...
├── .gitignore
├── README.md
└── ...
```

## Tech stack

### Backend

- Node.js + TypeScript
- NestJS
- Prisma + PostgreSQL
- Redis
- BullMQ
- Argon2 password hashing
- Helmet + validation + rate limiting
- ImageKit / Backblaze-compatible storage

### Frontend

- Next.js 16
- React 19
- TypeScript
- Tailwind CSS
- shadcn/ui
- TanStack Query
- React Hook Form + Zod
- Playwright + Vitest

## Quick start

### 1) Prerequisites

- Node.js 20+ (backend is developed on Node 22)
- PostgreSQL 16
- Redis 7
- npm

### 2) Start backend

```bash
cd for-after-backend
npm install
cp .env.example .env
# Fill in required environment variables
npx prisma migrate dev
npx prisma generate
npm run start:dev
npm run worker:dev
```

The API typically runs on:

- `http://localhost:4000`

### 3) Start frontend

```bash
cd for-after-frontend
npm install
cp .env.example .env.local
npm run dev
```

The frontend usually runs on:

- `http://localhost:3000`

## Important notes

- The backend and frontend are intentionally separated and communicate over HTTP with session-based auth.
- The repo is structured around multiple principals: Customer, Recipient, Trusted Contact, and Admin.
- Each app has its own README with deeper setup and feature details.
- This repo includes a serious security and compliance-oriented design for private data, scheduled release logic, death verification flow, and admin review controls.

## Documentation

Use the app-specific READMEs for details:

- `for-after-backend/README.md`
- `for-after-frontend/README.md`

The backend also includes detailed product and architecture docs in `for-after-backend/docs/`.

## Project status

This repository appears to be an active implementation of a mature platform rather than a starter project. The codebase already includes:

- full backend domain models and rules
- login/auth systems
- customer-facing vault features
- recipient and trusted-contact portals
- death verification safeguards
- admin TOTP and audit tooling
- automated tests and e2e coverage

## License

This project is currently marked as private and unlicensed in the backend metadata (`UNLICENSED`).

## Summary

This repository is a full-stack, production-style platform for secure digital legacy management. It combines a modern Next.js frontend with a NestJS API, database-backed security-conscious business logic, media storage, scheduled releases, admin workflows, and portal access for multiple user types.

If you want, I can also create a more polished version of this README tailored for:

- GitHub landing page style
- startup/project pitch style
- developer onboarding style
- production documentation style
