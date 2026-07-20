# Response guidance

End substantive responses with a short `**Next:**` line naming the single most useful immediate action. Keep it to one concise sentence. If nothing remains, say `**Next:** Nothing required.`

# Git remote safety

- A commit never implies permission to push. Stop with local commits by default and state that they are unpushed.
- Ask for the user's explicit permission immediately before a remote Git action, including `git push`, force-pushes, and tag pushes. Approval from an earlier task or session does not carry forward.
- Run each remote or destructive Git action as its own visible command. Do not hide it in an `&&` chain or compound command.
