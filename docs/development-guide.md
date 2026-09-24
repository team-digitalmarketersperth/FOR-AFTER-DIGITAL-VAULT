# For After — Development Guide

## 1. Prerequisites
- **Node.js**: v22.23.2+ (Manage via NVM for Windows)
- **npm**: v11.x
- **PostgreSQL**: v16
- **Redis**: v7+
- **Git**

## 2. NVM Setup for Windows
To ensure consistent Node versions across the team:
1. Install NVM for Windows:
   ```bash
   winget install CoreyButler.NVMforWindows
   ```
2. Install and use the required Node version:
   ```bash
   nvm install 22.23.2
   nvm use 22.23.2
   ```
3. **IMPORTANT**: If you have an old standalone Node.js MSI installed, uninstall it first. Check with `where.exe node` — it should only point to the NVM path.
4. Upgrade npm:
   ```bash
   npm install -g npm@11
   ```

## 3. Project Setup
1. Clone the repository.
2. Navigate to the backend directory:
   ```bash
   cd for-after-backend
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Copy the environment template:
   ```bash
   cp .env.example .env
   ```
5. Configure `.env` with your `DATABASE_URL`, `REDIS_HOST`, and `REDIS_PORT`.

## 4. Database Setup
1. Create a local PostgreSQL database named `for_after`.
2. Run Prisma migrations to set up the schema:
   ```bash
   npx prisma migrate dev
   ```
3. Generate the Prisma Client:
   ```bash
   npx prisma generate
   ```
4. Verify the database using Prisma Studio:
   ```bash
   npx prisma studio
   ```

## 5. Running the Application
- **Development**: `npm run start:dev` (Runs on port 4000 with hot-reload)
- **Testing**: `npm run test` (Uses Vitest)
- **Build**: `npm run build`
- **Production**: `npm run start:prod`

## 6. Port Mapping
- **Next.js Frontend**: `localhost:3000`
- **NestJS Backend**: `localhost:4000`
- **PostgreSQL**: `localhost:5432`
- **Redis**: `localhost:6379`

## 7. Environment Variables
Ensure the following are set in your `.env`:
```env
APP_ENV=development
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/for_after?schema=public"
REDIS_HOST="localhost"
REDIS_PORT=6379
SESSION_SECRET="your_session_secret"
JWT_SECRET="your_jwt_secret"
STRIPE_SECRET_KEY=""
STRIPE_WEBHOOK_SECRET=""
MUX_TOKEN_ID=""
MUX_TOKEN_SECRET=""
S3_BUCKET=""
S3_REGION=""
POSTMARK_SERVER_TOKEN=""
TWILIO_ACCOUNT_SID=""
TWILIO_AUTH_TOKEN=""
SENTRY_DSN=""
```

## 8. Local Auth Workaround
For local development without completing the full WordPress/Email loop, use the Next.js bypass routes:
- `/dev-login`
- `/dev-register`
These are only available when `NEXT_PUBLIC_APP_ENV=development` is set in the frontend.

## 9. Project Structure
```text
for-after-backend/
├── docs/                 # Project documentation
├── prisma/               # Database schema and migrations
├── src/                  # NestJS source code
│   ├── admin/            
│   ├── auth/             
│   ├── common/           # Shared guards, filters, interceptors
│   ├── delivery/         
│   ├── media/            
│   ├── ...               # Other feature modules
│   ├── main.ts           # Application entry point
│   └── app.module.ts     # Root module
├── test/                 # E2E tests
├── .env                  # Environment variables (ignored)
├── .gitignore
├── package.json
└── tsconfig.json
```

## 10. Dependency Installation Philosophy
- **Phase-gated approach**: Only install packages when actively building the module that requires them.
- Foundation packages (NestJS, Prisma) are pre-installed.
- Future integrations (BullMQ, Stripe, Twilio) should be deferred until their specific features are implemented.

## 11. Known Issues & Fixes
- **npm edgesOut Arborist Bug**: Ensure you are using npm 11.x to avoid this lockfile resolution bug.
- **NVM PATH Conflicts**: Standalone Node installations conflict with NVM on Windows. Uninstall standalone Node.
- **Prisma Version Pinning**: We strictly use Prisma v7 (`@prisma/client@7`, `prisma@7`). Do not upgrade blindly.

## 12. Git Workflow
Ensure your `.gitignore` includes:
```
.env
node_modules/
dist/
src/generated/
```
Commit feature branches, open PRs, and do not commit secrets.

## 13. Coding Standards
- **Modules**: Use ECMAScript Modules (ESM).
- **Testing**: Vitest for unit and E2E tests.
- **Validation**: Use `class-validator` for DTOs.
- **Database**: Strictly use Prisma for data access. Raw SQL only when necessary (e.g., RLS).
