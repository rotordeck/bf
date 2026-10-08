# Design Principles: Agent-Oriented CLI Architecture

## The Vision
Rather than building heavy, stateful Model Context Protocol (MCP) servers or embedding custom AI integrations directly into our application, we are adopting a pragmatic **API + CLI + Skills** architecture. 

AI agents natively understand terminal environments, shell syntax, and standard command-line tools. By wrapping our core API in a fast, predictable CLI, we empower agents (and human power users) to interact with our application seamlessly using tools they already understand.

---

## 1. The Three-Layer Architecture

### Layer 1: The API (Foundation)
All core business logic, state management, and data operations must be exposed via a clean, robust API. The CLI should contain *zero* business logic; it is strictly a transport and formatting layer.

### Layer 2: The CLI (Execution)
A lightweight command-line interface that wraps the API. It should be fast to execute, stateless, and adhere strictly to POSIX standards. 

### Layer 3: The Skills (Orchestration)
Lightweight markdown files, system prompts, or documentation provided to the AI agent. These "skills" teach the agent the vocabulary of our CLI, how to chain commands together, and how to handle specific workflows.

---

## 2. Technical Design Rules for the CLI

To ensure AI agents can reliably use the CLI without human intervention, all commands must adhere to the following technical standards:

### Strict Stream Separation
* **`stdout`:** Reserved exclusively for valid data payloads (e.g., successful JSON responses). Never put human-readable loading text, progress bars, or warnings here.
* **`stderr`:** Reserved exclusively for errors, warnings, and diagnostic logs. 

### Machine-Readable Output
* **`--json` Flag:** Every command that returns data must support a `--json` flag. Agents are highly capable of parsing structured JSON, which is far less brittle than using regex to parse human-readable terminal tables.
* **Standard Schemas:** JSON outputs should follow predictable schemas across different commands (e.g., always returning collections as arrays under a `data` key).

### Predictable Exit Codes
Agents rely on exit codes to determine control flow and error handling.
* **`0`**: Success.
* **`1-255`**: Specific, documented failure states. (e.g., `1` for general errors, `2` for validation errors, `3` for network/API timeouts).

### Idempotency and State Safety
* Read operations (GET/List) must have no side effects.
* Write operations (POST/PUT/DELETE) should be idempotent whenever possible. If an agent retries a command because it thinks it failed, it should safely resolve without duplicating data or causing cascading errors.
* **Destructive Actions:** Commands that delete or heavily mutate data must accept a `--force` or `--confirm` flag to prevent agents from accidentally wiping data during exploration.

### Self-Documenting
* **`--help`:** Every command and subcommand must have thorough `--help` text. Agents frequently invoke `help` commands to learn how to use a tool dynamically.
* Include concrete usage examples in the help text, as LLMs heavily index on examples for zero-shot execution.

---

## 3. Designing the "Skills" Layer

The CLI itself is just the tool; the "Skills" are the instructions. For every major workflow, we will create a lightweight markdown file to feed the agent context.

**A Skill Definition should include:**
1. **The Goal:** What the agent is trying to achieve (e.g., "Provisioning a new user").
2. **The Tools:** Which CLI commands to use.
3. **The Workflow:** The step-by-step logic (e.g., "1. Check if user exists with `cli user get`. 2. If not, run `cli user create`.")
4. **Error Handling:** Common pitfalls and how to recover from them.