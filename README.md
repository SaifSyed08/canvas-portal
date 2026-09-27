# Canvas Portal

A desktop app where you can ask Claude about your Canvas classes: what's due, what an assignment actually wants, how the rubric grades it, what you missed. Attach a file and tell it to hand it in, and it sets up the submission for you to confirm with one click.

## How it works

- **Canvas.** You sign in once in a normal sign-in window. The portal reads Canvas with that session, the same way the Canvas website does, so it works at schools that turn off API tokens. If you let it save your email and password, it signs back in on its own whenever the session expires (they're encrypted with Windows DPAPI and only readable by your Windows account). If your school uses Duo or another second-factor check, the window pops up for you to approve.
- **Claude.** Each message runs through Claude Code (`claude -p`) with your existing login, so there's no API key. The app hosts a small MCP server on localhost that gives Claude read access to your courses, assignments, rubrics, modules, pages, files, syllabi and announcements.
- **Every tab.** Claude can open any tab in a course's menu. Files, Discussions, Grades, Pages, Quizzes, People and your Inbox go through Canvas's API. If a course hides its Files tab, Claude still gets the files posted in its modules. **Ed Discussion** opens through the course's Ed tab: the portal launches it once in a hidden window, keeps Ed's sign-in in memory, and then reads posts, answers and comments straight from Ed. Tabs with no API, like Gradescope, Panopto or a syllabus tool, load in a hidden window, and Claude reads what the page shows. All of it is read-only. Claude never posts or messages for you.
- **Handing in.** Claude can only *propose* a submission. A card shows the assignment, due date, files, and any resubmission or late warnings, and nothing reaches Canvas until you click **Submit to Canvas**.

## Running it

Needs [Claude Code](https://claude.com/claude-code) installed and signed in.

```
npm install
npm start
```

Your settings, the Canvas session, and attached files live in `%APPDATA%\Canvas Portal`.

## From Claude Code in a terminal

While the portal is open, it serves its Canvas tools on a fixed local address, so Claude Code anywhere on this computer can use them. The portal registers it once as `canvas-portal` (`claude mcp list` shows it). Then just ask: "what's due this week?", "read the Project 1 instructions". A hand-in proposed from the terminal shows up as a card in the portal window, and it still only goes out when you click Submit.
