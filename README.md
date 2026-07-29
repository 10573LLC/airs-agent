# AIRS Agent

I want to build a portable full-stack web application called AIRS Agent.

AIRS Agent will be a secure, incident-based airspace coordination platform for public-safety agencies. It will allow separate agencies to create temporary incident rooms, share approved airspace information, coordinate drone and crewed-aircraft operations, and end that sharing when the incident closes.

This application must eventually be exportable and operable without Lovable. Before building any screens, create the technical foundation and architecture.

Mandatory requirements:

Connect this project to a GitHub repository that I control.

Use React and TypeScript for the frontend.

Use PostgreSQL for the database.

Structure the backend using standard APIs and portable TypeScript code.

Do not make any essential feature dependent on Lovable-specific services.

Do not use a proprietary builder-only database, authentication system, workflow engine, or connector.

Any temporary managed service must be replaceable through an adapter.

The completed project must eventually be capable of running through Docker outside Lovable.

Use MapLibre GL for the future mapping interface.

Every record must belong to an organization tenant.

Access must be denied by default unless permissions explicitly allow it.

Do not build decorative buttons or placeholder workflows that are not connected to functioning backend operations.

For this first stage, do not build the full application.

Create and present the following for review:

Proposed technical architecture

Frontend and backend structure

Database architecture

Multi-tenant security approach

Authentication approach

Role and permission model

Real-time communication approach

Mapping approach

Connector and API adapter approach

Data-retention approach

Audit-log approach

Local-development and Docker strategy

Portability risks or areas where Lovable-specific dependencies could be introduced

Initial organizations should be completely separated tenants.

Use these demonstration organizations:

Albany Police Department

Albany County

Create the initial role model using:

Agency Administrator

Airspace Supervisor

Remote Pilot in Command

Visual Observer

Dispatcher or RTCC Operator

Incident Commander

Intelligence Analyst

Partner-Agency User

System Auditor

Do not create application pages yet beyond what is necessary to establish the project structure.

Before making major implementation decisions, explain the proposed architecture and identify any requirement that cannot be completed without introducing platform dependency.

After completing this stage, create or update a file in the GitHub repository named:

BUILD_AUDIT.md

This file must be a factual record of what was actually implemented, not a summary of what was requested or planned.

The file must include:

1. Requested requirements

List every requirement from this prompt as a numbered checklist.

For each requirement, mark it as:

COMPLETE

PARTIALLY COMPLETE

NOT STARTED

CANNOT COMPLETE

2. Implementation evidence

For every item marked COMPLETE or PARTIALLY COMPLETE, provide:

Files created or modified

Database tables or migrations created

API routes or backend functions created

Authentication or authorization rules created

Environment variables added

Third-party services or packages used

Exact location in the repository where the work can be reviewed

Do not mark an item COMPLETE unless functioning implementation exists in the repository.

3. Platform dependencies

Identify every dependency on:

Lovable

Lovable Cloud

Supabase

Third-party authentication

Third-party storage

Third-party real-time services

Proprietary connectors

Builder-generated functions

Undocumented external services

For each dependency, explain:

Why it is being used

Whether the application can run without it

How it could be replaced

What data or functionality would be affected if it were removed

4. Portability status

State whether the repository can currently be:

Cloned from GitHub

Installed locally

Started locally

Connected to a local PostgreSQL database

Built for production

Deployed without Lovable

Run through Docker

Mark each item YES, PARTIAL, or NO and explain any limitation.

5. Security status

Document:

Current tenant-isolation method

Current authentication method

Current authorization method

Default-deny behavior

Roles implemented

Audit logging implemented

Known security gaps

Security features that are only planned and not yet operational

Do not claim CJIS, NIST, FedRAMP, or other compliance unless independently validated.

6. Database status

List:

Tables created

Columns created

Primary keys

Foreign keys

Organization or tenant ownership fields

Row-level security rules

Migrations

Seed data

Any tables that lack tenant isolation

7. Testing status

List all tests actually created and run.

Include:

Test file names

What each test verifies

Whether it passed or failed

Any requirements that have no tests

8. Known gaps and next actions

Identify:

Requested work not completed

Placeholder components

Mock data

Buttons without working actions

Hard-coded values

Temporary design decisions

Security concerns

Portability concerns

Recommended next build step

9. Change log

Include:

Date and time

Stage name

Files added

Files modified

Files removed

Database migrations added

Packages added or removed

At the end of every future build request, update this same BUILD_AUDIT.md file. Never overwrite prior stage records. Add a new dated section so the full development history remains available.

Also create:

ARCHITECTURE.md

DATABASE.md

SECURITY.md

LOCAL_SETUP.md

CHANGELOG.md

These files must reflect the application as it actually exists in the repository. Clearly label planned or proposed features as NOT YET IMPLEMENTED.

Before ending your response, provide a concise comparison table showing:

| Requirement | Status | Evidence | Limitation |

Do not rely only on the written response in this chat. The markdown documentation must be saved within the GitHub repository.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/f89154a3-be22-4f51-9771-eb4298787dbc).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
