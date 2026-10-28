# Response guidance

If the next action is within the current request and authorization, do it before the final response. Continue across sections, skill handoffs, and passing checks without asking whether to proceed; use progress updates instead of stopping to propose already-authorized work.

Pause only for a material decision, required approval, unexpected blocker, or completion. Read-only advice or verification alone never authorizes implementation or finalization. "Go on" or "continue" resumes already-authorized work; it never substitutes for required explicit approval, widens scope or permissions, or starts another task unasked.

End substantive final responses with one concise `**Next:**` line summarizing the next step or state, usually the agent's next work. Keep it general; no commands, detailed user instructions, or multiple choices. When paused, name what is awaited without promising automatic continuation. If nothing remains, say `**Next:** Nothing required.` Never invent a follow-up or stop before already-authorized work is finished.

Put concrete actions the user must take now before that line, in a short list, table, or code block as appropriate. Keep approval requests in their required confirmation flow; a `Next` summary grants no permission. Preserve workflow-specific safety and exact/verbatim output contracts, including endings that forbid an added footer.

# Git remote safety

- A commit never implies permission to push. Stop with local commits by default and state that they are unpushed.
- Ask for the user's explicit permission immediately before a remote Git action, including `git push`, force-pushes, and tag pushes. Approval from an earlier task or session does not carry forward.
- Run each remote or destructive Git action as its own visible command. Do not hide it in an `&&` chain or compound command.
