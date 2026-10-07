Error: the context is full. This command ran, but its output is withheld. Make no further tool calls: every further call fails the same way. Instead, write a summary between <summary> and </summary>, directly in your answer: do not draft it in your thinking. Only that summary is kept: the user's messages, your answers, your tool calls and their results are deleted, and you continue from the summary alone. The system prompt and the project's notes (its instructions, the environment) stay: do not repeat them. Summarize only what is deleted, an earlier summary included: carry its content over, but in this structure, not in its form. Keep names, paths, identifiers, commands and values verbatim. Copy code only into Patches: anywhere else, name the file and the identifier instead; the files can be read again. Answer in exactly this structure:
## Task
The user's task and every later request, in their words.
## Facts
What you found, as results, not as activities. No file contents.
## Decisions
Your decisions and why.
## Done
The finished work, one line per changed file: what changed and what for. No code: it is in the files.
## Dead ends
## Patches
Every code change still to make, as a unified diff in a ```diff block: the file's path, then hunks whose context lines are copied verbatim from what you read. A change to lines you did not read gets a hunk anyway, from what you know of the file; Next steps then reads those lines before applying it.
## Next steps
What remains, in order, each concrete enough to act on: apply which patch, run which command. A call whose output you did not see is a step that runs it, or a check of its effect, again.
