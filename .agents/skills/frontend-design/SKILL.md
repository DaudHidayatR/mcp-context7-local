---
name: frontend-design
description: >
  A general AI skill covering two workflows that can be used independently or together.

  Trigger Part 1 (frontend only) when the user asks to build, design, or style a
  web interface: pages, components, dashboards, landing pages, forms, or any HTML/CSS/JS
  or React/Vue/Svelte UI.

  Trigger Part 2 (planning only) when the user asks to plan a project, feature, sprint,
  roadmap, or technical architecture without necessarily building anything yet.

  Trigger both parts (combined) when the request spans design and planning together:
  "plan and build", "design the frontend for my app", "roadmap + prototype", or similar.

  Do not over-trigger: a pure coding or debugging question with no design or planning
  scope does not need this skill.
compatibility:
  tools: any code-capable AI agent
  frameworks: HTML/CSS/JS, React, Vue, Svelte, Tailwind (optional)
  planning_formats: markdown, JSON, YAML, plain prose
---

# Frontend + Planning Skill

This skill covers two interleaved workflows. They are documented separately below but often happen together. For hybrid requests like "plan and build a landing page", plan first, then build.

## Part 1 — Frontend Development

### Step 1: Understand the Interface

Before writing code, answer these questions:

- What is this UI for? Purpose, audience, and usage context
- What framework or stack fits? HTML/CSS/JS, React, Vue, Svelte, or the user's stated choice
- What content belongs in it? Text, data, images, forms, navigation, charts, or other elements
- What constraints apply? Responsive behavior, accessibility, performance, brand rules, or implementation limits

If the user has not specified a stack, a reasonable starting default is HTML, CSS, and vanilla JS for static interfaces, or a component framework for interfaces with dynamic state or data. This is a suggestion, not a universal rule.

### Step 2: Choose an Aesthetic Direction

Commit to a clear visual direction before coding and execute it with precision.

Possible directions include:

| Direction | Character |
|-----------|-----------|
| Minimal | White space, one accent color, clean type |
| Editorial | Large typography, magazine-style layout, bold content blocks |
| Brutalist | Raw, high contrast, intentionally sharp edges |
| Soft / Organic | Rounded forms, pastel tones, calm rhythm |
| Data-dense | Compact, utilitarian, built for information throughput |
| Dark / Premium | Deep backgrounds, luminous accents, refined contrast |

Rule: never default to generic.

Avoid:
- Purple-on-white gradient defaults
- Overused font stacks like Inter, Roboto, Arial, or plain system fallbacks as the main voice
- Cookie-cutter card grids with no visual identity

Before building, define:
- Purpose: what problem the interface solves
- Tone: what aesthetic personality it should carry
- Constraints: technical or product limitations
- Differentiation: the one memorable thing a designer would notice

### Step 3: Build the Code

Structure the work in this order:

```text
Layout -> Typography -> Color -> Spacing -> Interactivity -> Polish
```

Frontend execution standards:
- Produce working, runnable code
- Keep the result production-grade and visually intentional
- Match implementation complexity to the chosen aesthetic direction

Typography:
- Use a distinctive display font with a readable body font
- Set a clear hierarchy for heading, subheading, body, label, and helper text
- Import fonts intentionally or choose a strong system stack when appropriate

Color and theme:
- Use CSS variables like `--color-bg`, `--color-text`, and `--color-accent`
- Choose one dominant background, one primary accent, and one secondary support color
- Maintain accessible contrast, especially for body text

Motion:
- Use transitions for hover and focus states
- Use short staggered reveals or load animations when they add meaning
- Keep interaction motion quick and reveal motion controlled

Spatial composition:
- Prefer asymmetry, overlap, diagonal flow, or deliberate density when the concept supports it
- Use CSS Grid for macro layout and Flexbox for internal component structure
- Avoid bland equal-column layouts unless the content truly calls for them

Backgrounds and details:
- Build atmosphere with texture, pattern, translucency, mesh gradients, grain, shadow, or decorative framing
- Make details match the chosen aesthetic instead of adding random decoration

Responsiveness:
- Mobile-first by default
- Design for at least mobile, tablet, and desktop breakpoints

### Step 4: Review Checklist

Before delivering:

- [ ] Code runs without errors
- [ ] The interface has a recognizable visual point of view
- [ ] Responsive behavior works across at least three breakpoints
- [ ] No placeholder filler content remains
- [ ] Accessibility basics are covered: semantic structure, labels, and readable contrast

## Part 2 — Project And Feature Planning

### Step 1: Clarify the Goal

When a user wants a plan, extract:

1. Outcome — what done looks like
2. Scope — expected size in hours, days, or weeks
3. Constraints — team size, deadline, tech stack, dependencies
4. Unknowns — what still needs decisions

If any of these are unclear, ask before planning.

### Step 2: Choose a Planning Format

Match the output shape to the problem:

| Complexity | Format |
|------------|--------|
| Small task | Ordered checklist |
| Feature | User stories and acceptance criteria |
| Sprint | Task table with priority and effort |
| Roadmap | Phases with milestones |
| Architecture | Diagram description and decisions log |

### Step 3: Structure the Plan

A good plan contains:

```text
Goal -> Phases or Milestones -> Tasks -> Dependencies -> Risks
```

Goal:
- Keep it short and outcome-oriented

Phases:
- Foundation
- Core build
- Polish
- Ship

Tasks:
- Use imperative verbs like Build, Write, Configure, Review, Validate
- Include effort, priority, and dependencies when useful

Risks:
- Name a few realistic failure points
- Include a mitigation for each

### Step 4: Deliver the Plan

Default to Markdown with headers and a task table.

Example:

```markdown
| Task | Effort | Priority | Depends on |
|------|--------|----------|------------|
| Design component API | M | P1 | — |
| Build base layout | M | P1 | Design API |
| Add responsive breakpoints | S | P1 | Base layout |
| Write unit tests | M | P2 | Build |
| Performance audit | S | P3 | Tests |
```

If the user wants JSON or YAML instead, preserve the same structure in that format.

## Combined Workflow (Plan + Build)

When a request spans both planning and frontend work:

1. Clarify the goal and constraints
2. Output the plan first
3. Confirm or proceed depending on the agent and context
4. Build the frontend following Part 1
5. Summarize what was built versus the plan

If the agent normally pauses for approval, show the plan first and ask whether to build. If the agent is configured to act immediately, proceed after presenting the plan. When in doubt, present the plan and ask if it should move into implementation.

## Compatibility Notes

This skill is agent-agnostic. It does not rely on:
- Claude-specific runtime behavior
- Codex-specific plugin systems
- Proprietary hooks, slash commands, or platform-only APIs

Any code-capable AI agent can follow it with ordinary conversation, file editing, and code execution tools.
