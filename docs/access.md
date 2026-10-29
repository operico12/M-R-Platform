# Access: account requests, session limits and two-step sign-in

Added 29 Oct 2026 after Ope's review of the sign-in page (A6 follow-up, docs/a6-security.md
section 8). Code: `packages/core/src/access.ts`, `supabase/migrations/20261116000001_access.sql`,
pages **Account** (`#/account`) and **Console, Access**.

## 1. Getting an account

There is still no open sign-up form. A person gets into a site in one of two ways:

1. **Invite** (as before). The Admin adds the work email in Console, Users. The person signs in
   with an email link and lands in the site with the invited role.
2. **Request** (new). The person signs in with an email link. If no site has given them access yet,
   they see **Request access**. They pick a site, give their name and an optional note (what they
   do, who their supervisor is), and send it. The site's Admin approves or declines it.

Rules for requests:

- A site only shows up to people whose **email domain** the site's Admin has listed (setting
  `access.requestDomains`, for example `example-mining.com`). The person proves they own the email
  by opening the sign-in link. Nobody else sees the site's name, and a site with no domains
  listed takes no requests.
- A person has at most one waiting request per site, and sends at most 3 requests a day.
- The Admin approves with a role: Viewer, Technician, Supervisor or Reliability engineer.
  Superintendent and Admin are not given this way; they go through the role change and approval
  flow (docs/approvals.md), as before.
- Declining needs a reason, which the person sees. The person can withdraw a waiting request.
- Requests are never deleted. Approving, declining and withdrawing go to the audit log.

## 2. Session limits

Setting `access.sessionDays` (default 30, 1 to 30) and `access.idleDays` (default 7, 1 to 30),
per site, set by the Admin. Ope set the idle default to a week on 29 Oct 2026: 12 hours signed out
people after every shift and over days off.

- The app signs a person out when their sign-in is older than `sessionDays`, or after
  `idleDays` with no use on that device. They sign in again with a new email link.
- The database also refuses a sign-in older than 30 days, whatever the app does: it reads the
  sign-in time inside the Supabase sign-in token. So the 30-day limit holds even for a client that
  ignores the app's own check.
- On the Supabase Pro plan, the owner can also turn on Supabase's own time-box and inactivity
  timeout (Authentication, Sessions). Those then apply on the server too.

## 3. Two-step sign-in for Admins

- Anyone can turn on two-step sign-in for themselves on the Account page. It uses an
  authenticator app (Microsoft Authenticator, Google Authenticator, 1Password and the like): scan
  the QR code, then type the 6-digit code to confirm. After that, every sign-in asks for a code.
- Setting `access.adminMfa` (default off). When the Admin turns it on, an Admin at that site who
  has not passed the code check in this sign-in acts as a **Viewer** until they do. The
  database decides this from the sign-in token's assurance level (`aal2`), so it cannot be skipped
  from the browser.
- To prevent a lock-out, the setting can only be turned on by an Admin who has already passed
  the code check in this sign-in. A lost phone is fixed by the platform owner in the
  Supabase dashboard (Authentication, Users, remove the factor).

## Later

- Company single sign-on (Microsoft Entra ID or Google Workspace) through Supabase SAML, once IT
  agrees. Leavers are then cut off when IT disables their account.
- Shared shop tablets for technicians without a work email.
