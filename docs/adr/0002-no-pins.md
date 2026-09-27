# Pins are removed

Pins kept blocks at the top or the very end of the Context against lost-in-the-middle. They are removed so that a block's position has one rule only, its place in the Context, which Context Policies can reason about without special cases. The environment Note and the project instructions become ordinary Notes right after the Tools Block (the environment Note is refreshed in place, as a new Revision). `Pin`/`Unpin` events in existing Session Logs are still read but ignored on replay, so those blocks fall back to their insertion position.
