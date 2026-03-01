# Test Prompts for Agent Manager

Run these as tasks to exercise the different kanban states.

---

## 1. Quick task (idle → in-progress → completed)

**Title:** Hello world HTML
**Prompt:**
```
Create a file called hello.html with a basic HTML page that says "Hello World" in large centered text on a dark background. Do not ask any questions, just do it.
```

---

## 2. Medium task with tool calls (stays in-progress longer)

**Title:** Fibonacci module
**Prompt:**
```
Create a file called fib.js that exports a function to compute the nth Fibonacci number using memoization. Then create fib.test.js with at least 5 test cases. Then read both files back and confirm they look correct.
```

---

## 3. Triggers AskUserQuestion (input-required)

**Title:** Build a CLI tool
**Prompt:**
```
I want to build a small CLI tool. Before writing any code, ask me what language I want to use and what the tool should do. Present me with a few options.
```

---

## 4. Long-running with many tool calls

**Title:** Express API server
**Prompt:**
```
Create a minimal Express.js REST API with the following endpoints: GET /health, GET /users, POST /users, DELETE /users/:id. Use an in-memory array as the data store. Include proper error handling and status codes. Create all files needed including package.json.
```

---

## 5. Multi-turn conversation

**Title:** Refactor helper
**Prompt:**
```
Read all the files in the src/ directory and give me a summary of the codebase structure. Then wait for my instructions on what to refactor.
```

After it responds, send: `Refactor the largest file to be shorter. Ask me before making changes.`

---

## 6. Parallel test (run 2-3 simultaneously)

Create tasks 1, 3, and 4 at the same time to see multiple cards in different columns.
