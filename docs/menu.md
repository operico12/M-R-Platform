# Main menu

Added 29 Oct 2026 after Ope's review: the single list of 26 pages was too long. Ope picked a mix
of design 3 (icon bar) and design 5 (pinned and search). Code: `packages/core/src/menu.ts`
(groups, pins, recent pages, search, with tests) and `apps/web/src/Menu.tsx`.

## Layout

- **Icon bar** on the left with seven buttons: Pinned, Today, Assets, Analyse, Improve, Data and
  Admin. A red dot shows when a page in that group has something waiting (open alerts, or
  inspections waiting to send).
- **Page list** beside it shows the chosen group's pages. Opening a page from another group
  switches the list to that group, unless Pinned is shown.
- **Find a page** box at the top of the list. Press `/` anywhere (outside a text box) to jump to
  it; Enter opens the first match. It matches page names first, then other words people use
  (for example "weibull" finds Calculators, "maximo" finds Data import). Ctrl + K still finds a
  calculator.
- **Fold.** The « button at the top of the page list folds it away, leaving only the icon bar,
  so pages get the room. While folded, a group button opens its pages as a pop-out that closes
  when you pick a page, click outside it or press Escape; » keeps the list open again. The choice
  is kept on the device. It starts open on screens 1200 px wide or more, folded on narrower ones.
- On a phone the icon bar is a row across the top and the pages are a row you swipe.

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
