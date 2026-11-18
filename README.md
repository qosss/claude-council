# Council

This is a fork of PandaCode: [github.com/aicodeking/pandacode](https://github.com/aicodeking/pandacode). It brings PandaCode's Council feature to Claude Code as a plugin. It is not affiliated with or endorsed by PandaCode.

Independent reviewers score Claude's work out of 10. Claude keeps fixing the work and convening fresh reviewers until every reviewer reaches your target score, or until the round limit stops it.

## Install

In a Claude Code terminal session:

```
/plugin install council --marketplace qosss/claude-council
```

Answer `y` to add the marketplace, then pick a scope (user is the default).

From a shell:

```
claude plugin install council --marketplace qosss/claude-council
```

In the Claude desktop app, click **+** next to the prompt box, then **Plugins**. Choose **Add marketplace**, enter `qosss/claude-council`, then choose **Add plugin**.

Install Council from one place only. Two copies, such as one from this repository and one from an organization's plugin library, would both add `/council` and the reviewer agent.

## Before you turn it on

- **Defaults:** target 9.0, at most 10 rounds, and Claude chooses how many reviewers to use (at least 2).
- **Cost:**
  - Each round seats 2 to 8 lenses, one reviewer subagent each.
  - When a reviewer ends without a score, its lens gets a fresh reviewer. If that one fails too, Claude asks you. A lens never gets more than 3 reviewers in a round.
  - Council encourages Claude to give reviewers different models, which can cost more than your default model.
  - A request that needs several rounds can use many times the tokens of the same request without Council. Lower the round limit or the reviewer count to cap this.
  - Accepting the scores, turning Council off, or a new round opening stops the reviewers still running. A reviewer whose stop is refused, for example by a permission rule, runs on, but its score no longer counts.
- **Reviewers are not sandboxed.**
  - They don't get the Edit, Write, NotebookEdit, MultiEdit or Agent tools, and they are told not to change anything.
  - They keep the other tools, including shell commands and MCP tools, and use them to run tests and inspect the work.
  - They run under your session's permission mode. In the default mode their commands can bring permission prompts. In auto or bypass mode those commands run without asking you.

## Using it

Council starts off in new sessions. Turn it on for the current session with `/council on`. If Claude is working at that moment, Council reviews what the current request changes. Otherwise it reviews changes from your next message on.

`/council new on` turns Council on in every new session, including headless runs such as `claude -p` and scheduled tasks.

A row above the prompt is always there, even with Council off, in a terminal, the desktop app and the mobile app (VS Code has no such row). An open question from Claude Code takes its place for a while, and you can collapse it. It shows Council's state and a **Council…** button that opens the Council pane, as `/council` does.
- Once files change, the row also shows a button to accept the scores or skip the review.
- During a review it shows the round's scores.
- When Claude stops to ask you what to do, it also shows a button to go on.

The pane shows:

- a scorecard with a row for each reviewer's lens. In the desktop app, VS Code and the mobile app it is a chart that also marks each lens's earlier scores. In a terminal it is a text bar of each lens's latest score.
- every round so far
- the settings
- buttons for what can happen next:
  - **Keep fixing**, **Convene reviewers**, **Seat the missing reviewers** or **Review again**, when Claude has stopped to ask you
  - **Accept and finish**, or **Skip review and finish** before any reviewer has scored
  - **Lower target to …**, after a complete round scored below the target, offering a preset target no higher than the lowest score
  - **Raise limit to … rounds**, once the round limit stops Council, offering the next of 3, 5, 10 and 25 rounds, or 10 more past 25

Lower target and Raise limit apply to the current session only.

| Command | What it does |
| --- | --- |
| `/council` | Opens the Council pane. |
| `/council on`, `/council off` | Turns Council on or off for this session. |
| `/council target 9.5` | Sets the score every reviewer must reach (1-10). |
| `/council rounds 5` | Sets how many review rounds one set may use (1-100). |
| `/council reviewers 3` | Sets the reviewers per round (2-8). `/council reviewers auto` lets Claude choose. |
| `/council accept` | Accepts the current scores so Claude can finish. |
| `/council new on`, `/council new off` | Starts new sessions with Council on or off. |
| `/council status` | Shows the current round and scores. |

Changing the target, rounds or reviewers with a command, or in the pane's settings, saves the value as your default for later sessions.

## How it works

1. Before Claude ends a turn in which files changed, it sends out at least two `council:reviewer` subagents at once. Each reviewer has its own lens, such as correctness, security or UX.
2. The bar is the lowest score, not the average. When a reviewer scores below the target, Claude fixes the real problems and convenes fresh reviewers with the same lenses.
3. A finish gate checks this when Claude stops. If work is left, the gate brings Claude back with what remains.
4. If a problem should not be fixed, Claude stops and asks you. You can lower the target, accept the scores or turn Council off.

A new request starts a new set of rounds (the `/council` help calls it a cycle) once the last set has nothing left to do. A message sent while a set still has work left, such as "keep going" after Claude stops to ask you, continues that set. Accepting the scores ends the current set, and the next request is reviewed again. `/clear` and resuming a conversation also start a new set.

Two more cases start a new set:

- **The round limit stopped the set.** Your next message, even "keep going", starts a new set with a fresh round limit. To continue the stopped set instead, press **Raise limit**.
- **You change the target or reviewer count after a set passed.** The work that passed is not reviewed again. The next changes are held to the new value.

Only edits made with the Edit, Write, NotebookEdit and MultiEdit tools count as changes. Files changed through a shell command do not start a review.

## License

PandaCode License (MIT License with an attribution requirement). See [LICENSE](LICENSE).

Parts of this plugin, chiefly `hooks/logic.ts`, are derived from PandaCode, © 2026 PandaCode contributors. The changes made for Claude Code are released under the same license.
