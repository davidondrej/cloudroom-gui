---
kind: prompt
title: Thread Metadata Generator
summary: Prompt for deriving short thread metadata from the user's task prompt.
intent: Generate stable, operator-friendly metadata for threads without adding explanatory prose.
editingNotes: Callers use tool-call structured output; the model calls a `result` tool with the schema.
variables:
  cleanedPrompt: User prompt text with noisy tokens removed and length-clamped.
  rules: The user's thread naming rules from Settings → Thread naming.
---
You name threads in a coding app from the user's first message.
Call the `result` tool with:
- title: the thread name

Follow these naming rules exactly:
{{rules}}

Title the problem or goal, not the tools the user mentions.

Task:
{{cleanedPrompt}}
