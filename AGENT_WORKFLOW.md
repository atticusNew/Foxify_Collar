# Agent Workflow for Atticus Options Protection API

This document defines how AI agents should work on this repo to balance speed, safety, and cost.

---

## 1. Models and Cost Rules

### Default Model

- Use **GPT‑5.4 High** as the default model for most tasks.
- This model should be used for:
  - Everyday coding
  - New endpoints
  - Wiring frontend and backend
  - Basic bugfixes
  - Most test updates

### Higher-Cost Models

- **Codex 5.3 High**
  - Use rarely, only when:
    - Repo-wide heavy code generation is required, or
    - Deep debugging of complex code is needed and GPT‑5.4 High is not sufficient.
  - Even when using this model, keep scope tight (folders, not the entire repo).

- **Sonnet 4.5 / Sonnet 4.6 High**
  - Use for short, critical reviews involving:
    - Hedge sizing and risk logic
    - Capital preservation and settlement flows
  - Example tasks:
    - “Review this diff of hedge sizing logic for edge cases and risk.”
    - “Audit this settlement flow for anything that could lose user funds.”
  - Keep context limited to diffs or a few critical files, not the entire repo.

### Models to Avoid as Default

- Do NOT use the following as defaults:
  - Any “High Fast” or “Extra High Fast” variants
  - Any “Opus” variants
- These are only allowed when explicitly requested by the user for time-critical or highly specialized reasoning.

---

## 2. Project Structure (High Level)

*(Update folder names if they differ)*

- `backend/hedging`: hedge sizing, strike selection, execution logic
- `backend/risk`: risk engine, limits, margin, monitoring
- `backend/integrations`: exchange clients (FalconX, etc.)
- `frontend/app`: dashboard and controls for protection tiers
- `tests/hedging`, `tests/risk`, `tests/integrations`: backend tests

When making changes, always prefer working in the smallest relevant folder(s).

---

## 3. General Rules

- Never modify configuration, CI, or deployment files unless explicitly asked.
- Default to small, incremental changes instead of large refactors.
- Always create a **Git branch** and a **Pull Request (PR)** for non-trivial changes.
- Respect scope instructions given in prompts, such as:
  - “Only open and edit files under `backend/risk` and `backend/hedging` for this task.”

---

## 4. Pull Requests (PRs)

A PR is a proposed change bundle that must be reviewed before merging.

### Agent Responsibilities

When creating a PR:

- Put all changes into a dedicated branch.
- Open a PR that clearly shows:
  - Files changed
  - Line-by-line diffs
  - A clear description

The PR description should include:

- What changed
- Why it changed
- How it was tested

### Human Workflow

The expected human flow is:

1. Open the PR in GitHub.
2. Read the description and diffs.
3. Comment or request changes if anything looks off.
4. Only merge after a human has reviewed and approved.

**Rule:** Always create PRs for non-trivial work; never assume changes go directly to the main branch.

---

## 5. Scoping: Which Files to Work On

Agents should not load or modify the entire repo by default.

### Backend Feature Work (Hedging Logic, Risk, APIs)

- Scope:
  - `backend/`
  - or `api/`
  - or specific subfolders like `backend/hedging` and `backend/risk`
- Example instruction:
  - “Work only in `backend/hedging` and `backend/risk`. Do not edit frontend or infra files.”

### Exchange Integration

- Scope:
  - e.g. `backend/integrations/exchange_x`
  - or `backend/integrations/falconx`

### Frontend

- Scope:
  - `frontend/`
  - `frontend/app/`
  - or the appropriate frontend subfolder

Agents should always obey explicit scoping instructions in prompts.

---

## 6. Daily Workflow for Backend Changes

Use this workflow for each backend change or feature.

### Step 1 – Planning (Scoped, Analysis Only)

1. Read only relevant backend folder(s) and matching tests.
2. Summarize current behavior.
3. Propose a step-by-step implementation plan.
4. Do NOT modify code in this step.

Example prompt:

> You are helping me build an options protection API.  
> I want to add/change: [short description].  
> Only look at `backend/hedging` and `backend/risk`.  
> 1) Summarize current behavior.  
> 2) Propose a step-by-step plan to implement the change.

- Use **GPT‑5.4 High** for this step.

### Step 2 – Implementation (Same Model, Small Scope)

1. Implement the first steps of the approved plan.
2. Only edit these locations and their tests if they exist:
   - `backend/hedging/*`
   - `backend/risk/*`
3. Do not touch configuration, CI, or frontend files unless explicitly asked.

Example prompt:

> Implement steps 1 and 2 from your plan.  
> Only edit these files and their tests if they exist:  
> - `backend/hedging/*`  
> - `backend/risk/*`  
> Do not touch configuration, CI, or frontend.

- When finished, the agent should create a PR for the changes.

### Step 3 – Tests (Targeted, Not Whole Repo)

1. Update or add unit tests only for the behavior that changed.
2. Use the existing test style and naming in:
   - `tests/hedging`
   - `tests/risk`

Example prompt:

> Now write or update unit tests for the new behavior in `tests/hedging` and `tests/risk`.  
> Follow the style of existing tests in those folders only.

Agents must not generate tests for the entire project by default.

### Step 4 – Running Tests and Fixing Failures

By default, the **user** runs tests, and the agent fixes failures.

Assumed commands (update if needed):

- Run backend tests for hedging and risk:
  - `pytest tests/hedging tests/risk`
- Run full backend test suite:
  - `pytest tests`
- Run frontend tests:
  - `npm test` (from `frontend/`)

Workflow:

1. The user runs the appropriate command(s).
2. If tests fail, the user provides only failing output.

Example prompt:

> Tests failed with this output:  
> [paste failing tests only]  
> Only edit the files related to these failures and update tests as needed.

This reduces unnecessary token usage and avoids re-running commands repeatedly.

---

## 7. Commands: Who Runs What

- Agents **may suggest** commands but should not run them unless explicitly instructed.
- Preferred pattern:
  - Agent: “Here are the exact commands to run for backend tests for the files I touched.”
  - User: runs those commands locally or in CI.
- Only when the user explicitly requests it should agents run commands in a configured environment.

This pattern keeps costs under control while retaining reproducibility.

---

## 8. Model Usage Cheat Sheet

- **GPT‑5.4 High (Default)**
  - Use for:
    - Everyday coding
    - New endpoints
    - Wiring frontend and backend
    - Basic bugfixes
    - Most tests

- **Codex 5.3 High**
  - Use rarely, for:
    - Large code generation
    - Tricky refactors
    - Cases where GPT‑5.4 High is not sufficient for code structure
  - Always keep scope tight.

- **Sonnet 4.5 / Sonnet 4.6 High**
  - Use for:
    - Reviewing diffs of hedge sizing logic
    - Auditing settlement and balance-related flows
  - Keep context to diffs or a small set of critical files.

If a task is big and critical and involves correctness of risk logic, using Sonnet or Codex High is acceptable. Otherwise, default to GPT‑5.4 High.

---

## 9. Safety & Risk Guidelines

For any code affecting user balances, hedging, leverage, or order routing:

- Check for:
  - Edge cases under extreme volatility
  - Partial fills or failed orders
  - Exchange downtime or API errors
  - Rounding errors and numerical instability
- Prefer explicit checks and clear error handling.
- Surface any design concerns in comments before making large changes.

---

## 10. How to Use This Document

- Agents should read and follow this document when working in this repo.
- When in doubt, ask the user for clarification rather than making broad, risky changes.