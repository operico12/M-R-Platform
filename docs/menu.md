# Main menu

Added 29 Oct 2026 after Ope's review: the single list of 26 pages was too long. Ope picked a mix
of design 3 (icon bar) and design 5 (pinned and search). Code: `packages/core/src/menu.ts`
(groups, pins, recent pages, search, with tests) and `apps/web/src/Menu.tsx`.

## Layout

- **Icon bar** on the left, always shown: Find, Pinned, Today, Assets, Analyse, Improve, Data
  and Admin, and at the bottom Day/Night and You. A red dot shows when a page in that group has
  something waiting (open alerts, or inspections waiting to send).
- **Page list.** Hovering over a group (or clicking it, on a touch screen) opens that group's
  pages as a pop-out beside the bar. It closes when the mouse leaves it, when you pick a page,
  click outside it or press Escape. Ope asked on 29 Oct 2026 for the list to go away without
  effort, so this is the default.
- **Keep open.** The » button in the pop-out keeps the list beside the bar instead; « folds it
  again. The choice is kept on the device.
- **You** shows who is signed in, the role, Sign out (live) or the demo role picker, and a link
  to Account settings. **Day/Night** switches the theme in one click.
- **Find** (or `/` anywhere outside a text box) opens the list with the cursor in "Find a page";
  Enter opens the first match. It matches page names first, then other words people use (for
  example "weibull" finds Calculators, "maximo" finds Data import). Ctrl + K still finds a
  calculator.
- On a phone the icon bar is a row across the top and the pages are a row you swipe.
- On a computer each group shows its icon on the left and its name on the right, so the bar fits a short laptop screen without a scroller.

## Groups

| Group | Pages |
| --- | --- |
| Today | Status board, Shop lines, Plant overview, Alerts, TV mode |
| Assets | Units, Components, Condition, Spares, Inspections |
| Analyse | Performance, Downtime analysis, Explorer, RCM, Calculators, Assist |
| Improve | Actions, Root cause analysis, Projects, Work and PM, Weekly pack |
| Data | Data import, Data quality |
| Admin | Console, Sites, API access, Account |

## Pinned and recent

- Each person pins up to 8 pages with the star next to a page. The starting pins are Status
  board, Shop lines, Performance, Actions and Weekly pack.
- Pinned also lists the last 4 pages opened that are not pinned.
- Pins and recent pages are kept on that device, per person and site. They are a convenience,
  not records, so they are not in the audit log and do not follow a person to another device.
- The menu only changes how pages are found. Who can do what on a page still comes from the
  permissions matrix.
