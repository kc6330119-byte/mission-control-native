# Optional agents

Three more agents for a manager, and a weekly brief that combines them. They are not part of the app or its
sample. All three only read files and answer in the chat.

| File | The question it answers |
|---|---|
| `agents/one-on-one-prep.md` | I'm meeting Sam. What's open, what do I owe, and what should I ask? |
| `agents/commitment-tracker.md` | What have I committed to in my meetings and not closed? |
| `agents/risk-radar.md` | What work risks have come up in my meetings, and how has each changed? |
| `weekly-brief.md` | A section for `CLAUDE.md`. It runs the agents and writes one page: priorities, decisions needed, collisions and a draft escalation. |

## Add them to a workspace

1. Copy the three files in `agents/` into your workspace's `.claude/agents/` folder.
2. For the weekly brief, paste the whole of `weekly-brief.md` at the end of your workspace's `CLAUDE.md`. It
   refers to the two rules in the section "When Kevin asks for one of his agents", so keep that section
   above it.
3. Start a new Claude Code session in the workspace. To check that it has the new agents, ask
   `Which agents in .claude/agents can you use in this project?`

In the app, the Agents page shows a card for each new agent: "Commitment tracker", "One on one prep" and
"Risk radar". The Coach card does not show the weekly-brief rules, because a card shows only the first
numbered list in its file, and the weekly-brief rules are a bulleted list further down.

## Prompts to try

With the sample workspace, give an "as of" date. The sample's newest meeting is Sep 22, 2026, and without a
date the agents count ages to today.

    Use the commitment-tracker agent. What do I owe, as of Sep 22, 2026?
    Use the risk-radar agent. What are the risks, as of Sep 22, 2026?
    Use the one-on-one-prep agent. I'm meeting Sam. As of Sep 22, 2026.
    Give me the weekly brief as of Sep 22, 2026. I'm meeting Sam and Riley this week.

## What to know

- The agents name Kevin, as the sample does: in each `description:` line, in the sentence "In the
  summaries I am Kevin Collins" in commitment-tracker and one-on-one-prep, and in the weekly-brief section. Change
  these to your own name.
- Items marked "(suggested)" are kept apart from what you agreed to.
- commitment-tracker also reads `board/board.json` if the workspace has one. The app creates that file the
  first time you open the Board. A card in the Done column counts as closed.
- risk-radar lists work risks only. It is told never to list a risk about a person.
- The weekly brief is a draft. Read it before you use it, and check any message it drafts before you send
  it. In testing, the agents' answers matched the summaries, but the first brief's draft message said
  something had been told to a person who had not been told. The rules were tightened after that.
- Answers vary a little between runs. For example, two suggestions that repeat each other may be merged in
  one run and listed apart in the next.
- What was tested, in October 2026 with Claude Code 2.1.290 on the sample: commitment-tracker at two dates,
  risk-radar, one-on-one-prep for one person, and the weekly brief twice. Each answer was checked against
  the six summaries.
- Meeting notes and goals about real people are personnel data. Check your employer's rules before you put
  them through any AI tool.
