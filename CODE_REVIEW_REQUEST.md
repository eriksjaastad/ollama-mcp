# CODE_REVIEW: Ollama MCP Telemetry & Standardization

**Date:** 2026-01-01
**Status:** DRAFT
**Author:** Claude (AI Assistant)

---

## 🎯 Definition of Done (DoD)

- [ ] **Telemetry Integrity**: All model runs (single and parallel) must log valid JSON Lines to `~/.ollama-mcp/runs.jsonl`.
- [ ] **Performance Tracking**: Duration (ms) and output size (chars) must be accurately captured.
- [ ] **Concurrency Safety**: `ollama_run_many` must respect the `maxConcurrency` limit (max 8) and log individual job metrics.
- [ ] **Structure Compliance**: Project must have all 8 mandatory scaffolding files and `Documents/` pattern.
- [ ] **Error Handling**: Timeouts (120s) and shell command failures must be caught and logged without crashing the server.

---

## 🔍 Context

This project provides an MCP bridge to local Ollama models. We recently implemented a lightweight telemetry system using JSON Lines and restructured the entire repository to meet the "Master Compliance Checklist" defined in Project Scaffolding. This review aims to verify the robustness of the logging and the standardization of the project structure.

---

## 🛠️ Implementation Details

### 1. Core Server (`src/server.ts`)
Handles MCP tool registration and executes Ollama CLI commands with timeout logic.

### 2. Telemetry Logger (`src/logger.ts`)
Lightweight, append-only logger that writes metrics to `~/.ollama-mcp/runs.jsonl`.

### 3. Analytics Utility (`scripts/analyze-runs.js`)
Node.js script to process logs and provide performance insights.

### 4. Project Structure
Compliant with standard scaffolding: `AGENTS.md`, `CLAUDE.md`, `00_Index_ollama-mcp.md`, etc.

---

## 📋 Feedback Summary
[Pending Review Run]

---

## 🎯 Remediation Plan
[Pending Review Run]

---

*This review follows the project-scaffolding standardization.*

